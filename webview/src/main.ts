/**
 * Webview entry point: builds the UI shell, handles host messages and owns
 * the application state. Rendering and layout are delegated to the other
 * modules (see README.md for the data flow).
 */
import './styles.css';
import type { DiffPayload, HostToWebviewMessage, ViewState } from '../../src/shared/protocol';
import type { Design, SourceLocation } from '../../src/model/types';
import { parentPath } from '../../src/model/query';
import { buildDiffContext, listChanges, mergeDesigns, type DiffContext } from './diff-index';
import { h } from './dom';
import { exportSvg } from './export-svg';
import { buildGraph, layoutKey, type MeasureText } from './graph';
import { PanZoom, type HitTarget, type Transform } from './interaction';
import { LayoutCache, type LaidOutScene } from './layout';
import {
  buildModelContext,
  DiagnosticsPopover,
  lookupPin,
  type ModelContext,
  SidePanel,
  Tooltip,
  tooltipLines,
} from './panels';
import { applyHighlight, renderScene, selectionBox, type RenderHandles } from './render';
import { buildSearchIndex, type SearchItem } from './search';
import { debounce, DEFAULT_VIEW_STATE, mergeViewState, netKey, type NavTarget, type Selection } from './state';
import { createCanvasMeasurer, onThemeChange, uiFontFamily } from './theme';
import { Toolbar, type ToggleName } from './toolbar';
import { getHostApi, onHostMessage } from './vscode-api';

interface PersistedState {
  view?: Partial<ViewState>;
}

class App {
  private readonly api = getHostApi();
  private view: ViewState;

  private head: Design | undefined;
  private label = '';
  private diffPayload: DiffPayload | undefined;
  private diffCtx: DiffContext | undefined;
  /** Head design, merged with removed objects when a diff is loaded. */
  private design: Design | undefined;
  private model: ModelContext | undefined;
  private searchIndex: SearchItem[] = [];
  private version = 0;

  private readonly layouts = new LayoutCache();
  private measure: MeasureText;
  private fontFamily: string;
  private scene: LaidOutScene | undefined;
  private sceneKey = '';
  private handles: RenderHandles | undefined;
  private renderToken = 0;
  private selection: Selection | undefined;
  private pendingFocus: Selection | undefined;
  private readonly transforms = new Map<string, Transform>();

  // DOM
  private readonly toolbar: Toolbar;
  private readonly banner: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly status: HTMLElement;
  private readonly panel: SidePanel;
  private readonly reopen: HTMLButtonElement;
  private readonly diagnostics: DiagnosticsPopover;
  private readonly tooltip = new Tooltip();
  private readonly panZoom: PanZoom;

  private readonly notifyState = debounce(() => {
    this.api.postMessage({ type: 'stateChanged', state: { ...this.view } });
  }, 250);

  constructor(root: HTMLElement) {
    const saved = this.api.getState() as PersistedState | undefined;
    this.view = mergeViewState(DEFAULT_VIEW_STATE, saved?.view);
    this.measure = createCanvasMeasurer();
    this.fontFamily = uiFontFamily();

    this.toolbar = new Toolbar({
      navigate: (scope) => this.setScope(scope),
      pick: (item) => this.navigateTo({ scope: item.scope, select: item.select }),
      toggle: (name, value) => this.setToggle(name, value),
      fit: () => this.fit(),
      exportSvg: () => this.doExport(),
      compare: () => this.api.postMessage({ type: 'requestCompare' }),
      toggleDiagnostics: () => this.diagnostics.toggle(),
      showChanges: () => this.panel.showTab('changes'),
    });

    this.bannerText = h('span', { class: 'banner-text' });
    const dismiss = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss' }, '×');
    dismiss.addEventListener('click', () => (this.banner.hidden = true));
    this.banner = h('div', { class: 'banner error', role: 'alert', hidden: true }, h('strong', {}, 'Parse error: '), this.bannerText, dismiss);

    this.emptyState = h('div', { class: 'empty-state' }, 'Waiting for a design…');
    this.loading = h('div', { class: 'loading', hidden: true, 'aria-live': 'polite' }, 'Laying out…');
    this.status = h('div', { class: 'status', 'aria-live': 'polite' });
    const zoomBtn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const zoom = h(
      'div',
      { class: 'zoom-controls', role: 'group', 'aria-label': 'Zoom' },
      zoomBtn('+', 'Zoom in (+)', () => this.panZoom.zoomBy(1.25)),
      zoomBtn('−', 'Zoom out (-)', () => this.panZoom.zoomBy(0.8)),
      zoomBtn('⤢', 'Fit (0)', () => this.fit()),
    );
    this.reopen = h('button', { class: 'btn panel-reopen', type: 'button', hidden: true, 'aria-label': 'Show side panel' }, '‹ Details');
    this.reopen.addEventListener('click', () => this.panel.setCollapsed(false));
    this.canvas = h('div', { class: 'canvas' }, this.emptyState, this.loading, zoom, this.status, this.tooltip.el, this.reopen);

    this.panel = new SidePanel(
      {
        select: (t) => this.navigateTo(t),
        reveal: (loc) => this.reveal(loc),
        enterScope: (s) => this.setScope(s),
      },
      (collapsed) => (this.reopen.hidden = !collapsed),
    );
    this.diagnostics = new DiagnosticsPopover((loc) => this.reveal(loc));

    root.append(this.toolbar.el, this.banner, h('div', { class: 'main' }, this.canvas, this.panel.el), this.diagnostics.el);

    this.panZoom = new PanZoom(this.canvas, {
      onClick: (t, ev) => this.onClick(t, ev),
      onDoubleClick: (t, ev) => this.onDoubleClick(t, ev),
      onHover: (t, ev) => this.onHover(t, ev),
      onTransform: (t) => this.transforms.set(this.transformKey(), t),
    });

    document.addEventListener('keydown', (ev) => this.onKey(ev));
    document.addEventListener('pointerdown', (ev) => {
      if (!this.diagnostics.el.hidden && ev.target instanceof Node && !this.diagnostics.el.contains(ev.target) && !(ev.target as Element).closest?.('.diag-btn')) {
        this.diagnostics.toggle(false);
      }
    });
    onThemeChange(() => {
      const f = uiFontFamily();
      if (f === this.fontFamily) return;
      this.fontFamily = f;
      this.measure = createCanvasMeasurer();
      this.invalidate();
      this.refresh();
    });
    onHostMessage((m) => this.onMessage(m));
    this.updateToolbar();
    this.api.postMessage({ type: 'ready' });
  }

  // ---- host messages --------------------------------------------------------

  private onMessage(m: HostToWebviewMessage): void {
    switch (m.type) {
      case 'design':
        this.head = m.payload.design;
        this.label = m.payload.label;
        this.banner.hidden = true;
        this.rebuildModel();
        break;
      case 'diff':
        this.diffPayload = m.payload;
        this.diffCtx = buildDiffContext(m.payload.diff);
        this.rebuildModel();
        break;
      case 'clearDiff':
        this.diffPayload = undefined;
        this.diffCtx = undefined;
        this.view.showDiffOnly = false;
        this.rebuildModel();
        break;
      case 'restoreState':
        this.view = mergeViewState(this.view, m.state);
        this.validateScope();
        this.persist(false);
        this.refresh();
        break;
      case 'focus': {
        const t = this.resolveFocus(m.path);
        if (t) this.navigateTo(t);
        else this.api.postMessage({ type: 'notify', level: 'warning', message: `Odin: "${m.path}" was not found in the design.` });
        break;
      }
      case 'parseError':
        this.bannerText.textContent = m.message;
        this.banner.hidden = false;
        break;
      case 'requestExportSvg':
        this.doExport();
        break;
    }
  }

  private rebuildModel(): void {
    if (!this.head) {
      this.refresh();
      return;
    }
    const d = this.diffPayload && this.diffCtx ? mergeDesigns(this.head, this.diffPayload.base, this.diffCtx) : this.head;
    this.design = d;
    this.model = buildModelContext(d, this.diffCtx, this.diffPayload?.base);
    this.searchIndex = buildSearchIndex(d);
    this.diagnostics.set(this.head.diagnostics ?? []);
    this.panel.setChanges(this.diffPayload ? listChanges(this.diffPayload.diff) : undefined, this.diffLabel());
    this.invalidate();
    this.validateScope();
    if (this.selection && !this.selectionExists(this.selection)) this.selection = undefined;
    this.refresh();
  }

  private diffLabel(): string | undefined {
    const d = this.diffPayload?.diff;
    return d ? `${d.baseLabel || this.diffPayload?.baseLabel} → ${d.headLabel}` : undefined;
  }

  private invalidate(): void {
    this.version++;
    this.layouts.clear();
    this.sceneKey = '';
  }

  // ---- state ----------------------------------------------------------------

  private validateScope(): void {
    if (!this.model) return;
    const s = this.view.scope;
    if (s && this.model.cells.get(s)?.kind !== 'hier') this.view.scope = '';
  }

  private persist(notify = true): void {
    const st: PersistedState = { view: { ...this.view } };
    this.api.setState(st);
    if (notify) this.notifyState();
  }

  private setScope(scope: string, focus?: Selection): void {
    if (this.model && scope && this.model.cells.get(scope)?.kind !== 'hier') return;
    const changed = scope !== this.view.scope;
    this.view.scope = scope;
    this.pendingFocus = focus;
    if (changed) {
      this.selection = focus;
      this.persist();
    } else if (focus) {
      this.selection = focus;
    }
    this.tooltip.hide();
    this.refresh();
  }

  private setToggle(name: ToggleName, value: boolean): void {
    this.view[name] = value;
    this.persist();
    this.refresh();
  }

  private selectionExists(sel: Selection): boolean {
    const m = this.model;
    if (!m) return false;
    if (sel.kind === 'cell') return m.cells.has(sel.path);
    if (sel.kind === 'net') return m.nets.has(sel.path);
    return !!lookupPin(m, sel.path);
  }

  private resolveFocus(path: string): NavTarget | undefined {
    const m = this.model;
    if (!m) return undefined;
    if (path === '') return { scope: '' };
    const cell = m.cells.get(path);
    if (cell) return { scope: cell.parent, select: { kind: 'cell', path } };
    const pin = lookupPin(m, path);
    if (pin) {
      const owner = parentPath(path);
      return owner ? { scope: parentPath(owner), select: { kind: 'pin', path } } : { scope: '', select: { kind: 'port', path } };
    }
    const net = m.design.nets.find((n) => (n.scope ? `${n.scope}/${n.name}` : n.name) === path) ?? m.design.nets.find((n) => n.name === path);
    if (net) return { scope: net.scope, select: { kind: 'net', path: netKey(net.scope, net.name) } };
    return undefined;
  }

  private navigateTo(t: NavTarget): void {
    if (t.scope !== this.view.scope) {
      this.setScope(t.scope, t.select);
      return;
    }
    if (t.select) {
      this.select(t.select);
      this.centerOnSelection();
    }
  }

  private select(sel: Selection | undefined): void {
    this.selection = sel;
    if (this.handles && this.scene) applyHighlight(this.handles, this.scene, sel);
    if (sel && this.model) this.panel.showSelection(this.model, sel);
    else this.panel.showEmpty(this.scopeSummary());
  }

  private centerOnSelection(): void {
    if (!this.selection || !this.handles || !this.scene) return;
    const box = selectionBox(this.handles, this.scene, this.selection);
    if (box) this.panZoom.centerOn(box);
  }

  // ---- rendering --------------------------------------------------------------

  private transformKey(): string {
    return `${this.view.scope}|${this.view.hideClockResetNets ? 1 : 0}${this.view.hideUnconnectedPins ? 1 : 0}`;
  }

  private updateToolbar(): void {
    this.toolbar.update({
      designName: this.head?.name ?? '',
      label: this.label,
      scope: this.view.scope,
      toggles: {
        hideClockResetNets: this.view.hideClockResetNets,
        hideUnconnectedPins: this.view.hideUnconnectedPins,
        showDiffOnly: !!this.view.showDiffOnly,
      },
      diffLoaded: !!this.diffPayload,
      diffLabel: this.diffLabel(),
      diagnostics: this.head?.diagnostics ?? [],
      searchIndex: this.searchIndex,
    });
  }

  private refresh(): void {
    this.updateToolbar();
    if (!this.design) {
      this.emptyState.hidden = false;
      return;
    }
    void this.renderScope();
  }

  private async renderScope(): Promise<void> {
    const design = this.design;
    if (!design) return;
    const opts = {
      scope: this.view.scope,
      hideClockReset: this.view.hideClockResetNets,
      hideUnconnected: this.view.hideUnconnectedPins,
      diff: this.diffCtx,
      measure: this.measure,
    };
    const key = layoutKey(opts, this.version);
    const diffOnly = !!this.diffCtx && !!this.view.showDiffOnly;
    if (this.handles && key === this.sceneKey) {
      // Same geometry: only update cheap presentation state.
      this.handles.svg.classList.toggle('diff-only', diffOnly);
      this.afterRender();
      return;
    }
    const token = ++this.renderToken;
    const slow = setTimeout(() => (this.loading.hidden = false), 120);
    let scene: LaidOutScene;
    try {
      scene = await this.layouts.get(key, () => buildGraph(design, opts));
    } catch (err) {
      clearTimeout(slow);
      this.loading.hidden = true;
      this.bannerText.textContent = `Layout failed: ${err instanceof Error ? err.message : String(err)}`;
      this.banner.hidden = false;
      return;
    } finally {
      clearTimeout(slow);
    }
    if (token !== this.renderToken) return;
    this.loading.hidden = true;

    const handles = renderScene(scene, {
      diffActive: !!this.diffCtx,
      diffOnly,
      ariaLabel: `Block diagram of ${this.view.scope || design.name}`,
    });
    this.handles?.svg.remove();
    this.canvas.prepend(handles.svg);
    this.handles = handles;
    this.scene = scene;
    this.sceneKey = key;
    const saved = this.transforms.get(this.transformKey());
    this.panZoom.attach(handles.svg, handles.viewport);
    if (saved) this.panZoom.set(saved);
    else this.fit();

    const nodes = scene.graph.nodes.size;
    this.emptyState.hidden = nodes > 0;
    this.emptyState.textContent = nodes > 0 ? '' : 'This scope is empty.';
    this.afterRender();
  }

  private afterRender(): void {
    if (!this.scene || !this.handles) return;
    if (this.selection && !this.selectionExists(this.selection)) this.selection = undefined;
    this.select(this.selection);
    if (this.pendingFocus) {
      this.pendingFocus = undefined;
      this.centerOnSelection();
    }
    this.renderStatus();
  }

  private scopeSummary(): string | undefined {
    const g = this.scene?.graph;
    if (!g) return undefined;
    const cells = [...g.nodes.values()].filter((n) => n.kind === 'cell').length;
    return `${this.view.scope || this.head?.name || 'root'}: ${cells} cells, ${g.nets.size} nets.`;
  }

  private renderStatus(): void {
    const s = this.scene;
    if (!s) return;
    const g = s.graph;
    const cells = [...g.nodes.values()].filter((n) => n.kind === 'cell').length;
    const parts = [`${cells} cells`, `${g.nets.size} nets`];
    if (g.hiddenNets) parts.push(`${g.hiddenNets} nets hidden`);
    if (g.hiddenPins) parts.push(`${g.hiddenPins} pins hidden`);
    parts.push(`layout ${s.elapsed} ms`);
    this.status.textContent = parts.join(' · ');
  }

  private fit(): void {
    if (!this.handles) return;
    this.panZoom.fit({ x: 0, y: 0, width: this.handles.width, height: this.handles.height });
  }

  // ---- interaction ----------------------------------------------------------

  private toSelection(t: HitTarget): Selection {
    return { kind: t.kind, path: t.path };
  }

  private locOf(sel: Selection): SourceLocation | undefined {
    const m = this.model;
    if (!m) return undefined;
    if (sel.kind === 'cell') return m.cells.get(sel.path)?.loc;
    if (sel.kind === 'net') return m.nets.get(sel.path)?.loc;
    return lookupPin(m, sel.path)?.pin.loc;
  }

  private reveal(loc: SourceLocation): void {
    this.api.postMessage({ type: 'revealSource', loc });
  }

  private onClick(t: HitTarget | undefined, ev: PointerEvent): void {
    this.diagnostics.toggle(false);
    if (!t) {
      this.select(undefined);
      return;
    }
    const sel = this.toSelection(t);
    if (ev.ctrlKey || ev.metaKey) {
      const loc = this.locOf(sel);
      if (loc) this.reveal(loc);
    }
    this.select(sel);
  }

  private onDoubleClick(t: HitTarget | undefined, ev: MouseEvent): void {
    if (!t) {
      if (!(ev.target instanceof Element) || ev.target.closest('svg.odin-diagram')) this.fit();
      return;
    }
    const sel = this.toSelection(t);
    if (sel.kind === 'cell' && this.model?.cells.get(sel.path)?.kind === 'hier') {
      this.setScope(sel.path);
      return;
    }
    const loc = this.locOf(sel);
    if (loc) this.reveal(loc);
  }

  private onHover(t: HitTarget | undefined, ev: PointerEvent): void {
    if (!t || !this.model || ev.type === 'pointerleave') {
      this.tooltip.hide();
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    this.tooltip.show(tooltipLines(this.model, this.toSelection(t)), ev.clientX - r.left, ev.clientY - r.top, r);
  }

  private goUp(): void {
    if (!this.view.scope) return;
    const from = this.view.scope;
    this.setScope(parentPath(from), { kind: 'cell', path: from });
  }

  private onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      this.toolbar.focusSearch();
      return;
    }
    if (typing) return;
    if (ev.key === 'Escape') {
      if (!this.diagnostics.el.hidden) this.diagnostics.toggle(false);
      else this.select(undefined);
      return;
    }
    // Leave keys alone while a button/link has focus, except the diagram ones.
    const onControl = !!target && target !== document.body && !target.closest('.canvas');
    if ((ev.key === 'Backspace' && !onControl) || (ev.altKey && ev.key === 'ArrowUp')) {
      ev.preventDefault();
      this.goUp();
      return;
    }
    if (onControl || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    switch (ev.key) {
      case '+':
      case '=':
        this.panZoom.zoomBy(1.25);
        break;
      case '-':
      case '_':
        this.panZoom.zoomBy(0.8);
        break;
      case '0':
        this.fit();
        break;
      case '/':
        ev.preventDefault();
        this.toolbar.focusSearch();
        break;
      case 'Enter':
        if (this.selection?.kind === 'cell' && this.model?.cells.get(this.selection.path)?.kind === 'hier') this.setScope(this.selection.path);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        ev.preventDefault();
        const t = this.panZoom.transform;
        const step = 60;
        const dx = ev.key === 'ArrowLeft' ? step : ev.key === 'ArrowRight' ? -step : 0;
        const dy = ev.key === 'ArrowUp' ? step : ev.key === 'ArrowDown' ? -step : 0;
        this.panZoom.set({ ...t, x: t.x + dx, y: t.y + dy });
        break;
      }
      default:
        return;
    }
  }

  private doExport(): void {
    if (!this.handles || !this.head) {
      this.api.postMessage({ type: 'notify', level: 'warning', message: 'Odin: nothing to export yet.' });
      return;
    }
    const bg = getComputedStyle(this.canvas).backgroundColor;
    // Export without transient selection / hover styling.
    const hovered = [...this.handles.svg.querySelectorAll('.hover')];
    hovered.forEach((el) => el.classList.remove('hover'));
    if (this.scene) applyHighlight(this.handles, this.scene, undefined);
    let svg: string;
    try {
      svg = exportSvg(this.handles, {
        title: `${this.head.name}${this.view.scope ? ` / ${this.view.scope}` : ''}`,
        background: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : undefined,
      });
    } finally {
      if (this.scene) applyHighlight(this.handles, this.scene, this.selection);
    }
    const scopePart = this.view.scope ? `_${this.view.scope.replace(/[\\/]+/g, '_')}` : '';
    this.api.postMessage({ type: 'exportSvg', svg, suggestedName: `${this.head.name}${scopePart}.svg` });
  }
}

function boot(): void {
  let root = document.getElementById('odin-app') ?? document.getElementById('app');
  if (!root) {
    root = document.createElement('div');
    root.id = 'odin-app';
    document.body.appendChild(root);
  }
  root.classList.add('odin-app');
  new App(root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
