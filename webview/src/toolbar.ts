/**
 * Toolbar: breadcrumb, search, toggles, actions, diff legend and diagnostics
 * indicator. Holds no application state; it renders what `update()` is given
 * and reports user intent through callbacks.
 */
import type { Diagnostic } from '../../src/model/types';
import { clear, h } from './dom';
import { type SearchItem, searchItems } from './search';

export interface ToolbarCallbacks {
  navigate(scope: string): void;
  pick(item: SearchItem): void;
  toggle(name: ToggleName, value: boolean): void;
  fit(): void;
  exportSvg(): void;
  compare(): void;
  toggleDiagnostics(): void;
  showChanges(): void;
}

export type ToggleName = 'hideClockResetNets' | 'hideUnconnectedPins' | 'showDiffOnly';

export interface ToolbarModel {
  designName: string;
  label: string;
  scope: string;
  toggles: Record<ToggleName, boolean>;
  diffLoaded: boolean;
  diffLabel?: string;
  diagnostics: Diagnostic[];
  searchIndex: SearchItem[];
}

const TOGGLES: { name: ToggleName; label: string; title: string }[] = [
  { name: 'hideClockResetNets', label: 'Hide clk/rst', title: 'Hide clock and reset nets' },
  { name: 'hideUnconnectedPins', label: 'Hide unconnected', title: 'Hide pins without a visible connection' },
  { name: 'showDiffOnly', label: 'Diff only', title: 'Dim everything that did not change' },
];

export class Toolbar {
  readonly el: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly toggleBtns = new Map<ToggleName, HTMLButtonElement>();
  private readonly legend: HTMLElement;
  private readonly diagBtn: HTMLButtonElement;
  private readonly changesBtn: HTMLButtonElement;
  private model: ToolbarModel | undefined;
  private hits: SearchItem[] = [];
  private active = -1;

  constructor(private readonly cb: ToolbarCallbacks) {
    this.crumbs = h('nav', { class: 'breadcrumb', 'aria-label': 'Hierarchy' });
    this.crumbs.addEventListener('keydown', (ev) => this.crumbKeys(ev));

    this.searchInput = h('input', {
      class: 'input search-input',
      type: 'search',
      placeholder: 'Search cells, pins, nets…',
      'aria-label': 'Search design',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'odin-search-results',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.results = h('ul', { class: 'search-results', id: 'odin-search-results', role: 'listbox', hidden: true });
    this.searchInput.addEventListener('input', () => this.runSearch());
    this.searchInput.addEventListener('keydown', (ev) => this.searchKeys(ev));
    this.searchInput.addEventListener('focus', () => this.runSearch());
    this.searchInput.addEventListener('blur', () => setTimeout(() => this.closeResults(), 150));
    const search = h('div', { class: 'search' }, this.searchInput, this.results);

    const toggles = h('div', { class: 'toggles', role: 'group', 'aria-label': 'Filters' });
    for (const t of TOGGLES) {
      const b = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false', title: t.title }, t.label);
      b.addEventListener('click', () => {
        const next = b.getAttribute('aria-pressed') !== 'true';
        this.cb.toggle(t.name, next);
      });
      this.toggleBtns.set(t.name, b);
      toggles.append(b);
    }

    const btn = (label: string, title: string, fn: () => void, cls = 'btn'): HTMLButtonElement => {
      const b = h('button', { class: cls, type: 'button', title, 'aria-label': title }, label);
      b.addEventListener('click', fn);
      return b;
    };

    this.legend = h(
      'div',
      { class: 'legend', 'aria-label': 'Diff legend', hidden: true },
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch st-added', 'aria-hidden': 'true' }), 'added'),
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch st-removed', 'aria-hidden': 'true' }), 'removed'),
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch st-modified', 'aria-hidden': 'true' }), 'modified'),
    );
    this.changesBtn = btn('Changes', 'Show the list of changes', () => this.cb.showChanges(), 'btn subtle');
    this.changesBtn.hidden = true;
    this.diagBtn = btn('0', 'Diagnostics', () => this.cb.toggleDiagnostics(), 'btn diag-btn');
    this.diagBtn.setAttribute('aria-haspopup', 'dialog');

    const actions = h(
      'div',
      { class: 'actions' },
      btn('Fit', 'Fit diagram to view (0)', () => this.cb.fit()),
      btn('Export SVG', 'Export the current view as SVG', () => this.cb.exportSvg()),
      btn('Compare…', 'Compare with another revision', () => this.cb.compare(), 'btn primary'),
    );

    this.el = h(
      'header',
      { class: 'toolbar', role: 'toolbar', 'aria-label': 'Diagram toolbar' },
      h('div', { class: 'tb-row' }, this.crumbs, h('span', { class: 'spacer' }), search),
      h('div', { class: 'tb-row' }, toggles, this.legend, this.changesBtn, h('span', { class: 'spacer' }), this.diagBtn, actions),
    );
    // role=toolbar implies a single tab stop in theory; we keep native tab
    // order for simplicity since the controls are heterogeneous.
  }

  update(m: ToolbarModel): void {
    this.model = m;
    this.renderCrumbs(m);
    for (const [name, b] of this.toggleBtns) b.setAttribute('aria-pressed', String(!!m.toggles[name]));
    const diffToggle = this.toggleBtns.get('showDiffOnly');
    if (diffToggle) diffToggle.hidden = !m.diffLoaded;
    this.legend.hidden = !m.diffLoaded;
    this.legend.title = m.diffLabel ?? '';
    this.changesBtn.hidden = !m.diffLoaded;
    const problems = m.diagnostics.filter((d) => d.severity !== 'info');
    const errors = m.diagnostics.filter((d) => d.severity === 'error').length;
    this.diagBtn.textContent = `${errors ? '⛔' : '⚠'} ${problems.length}`;
    this.diagBtn.classList.toggle('has-errors', errors > 0);
    this.diagBtn.classList.toggle('has-warnings', problems.length > 0 && errors === 0);
    this.diagBtn.setAttribute('aria-label', `Diagnostics: ${errors} errors, ${problems.length - errors} warnings`);
    this.diagBtn.title = `${problems.length} problem(s), ${m.diagnostics.length} total`;
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  private renderCrumbs(m: ToolbarModel): void {
    clear(this.crumbs);
    const parts = m.scope ? m.scope.split('/') : [];
    const list = h('ol', {});
    const items: { label: string; scope: string }[] = [{ label: m.designName || 'design', scope: '' }];
    parts.forEach((_, i) => items.push({ label: parts[i], scope: parts.slice(0, i + 1).join('/') }));
    items.forEach((it, i) => {
      const current = i === items.length - 1;
      const b = h(
        'button',
        { class: 'crumb', type: 'button', 'aria-current': current ? 'location' : undefined, title: it.scope || m.label },
        it.label,
      );
      b.addEventListener('click', () => this.cb.navigate(it.scope));
      list.append(h('li', {}, b));
    });
    this.crumbs.append(list);
  }

  private crumbKeys(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') return;
    const btns = [...this.crumbs.querySelectorAll<HTMLButtonElement>('button.crumb')];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    ev.preventDefault();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? btns.length - 1 : ev.key === 'ArrowLeft' ? Math.max(0, i - 1) : Math.min(btns.length - 1, i + 1);
    btns[next].focus();
  }

  private runSearch(): void {
    const q = this.searchInput.value.trim();
    this.hits = q && this.model ? searchItems(this.model.searchIndex, q, 40) : [];
    this.active = this.hits.length ? 0 : -1;
    this.renderResults();
  }

  private renderResults(): void {
    clear(this.results);
    const open = !!this.searchInput.value.trim();
    this.results.hidden = !open;
    this.searchInput.setAttribute('aria-expanded', String(open));
    if (!open) return;
    if (!this.hits.length) {
      this.results.append(h('li', { class: 'muted empty', role: 'option', 'aria-disabled': 'true' }, 'No matches'));
      this.searchInput.removeAttribute('aria-activedescendant');
      return;
    }
    const designName = this.model?.designName ?? '';
    this.hits.forEach((it, i) => {
      const li = h(
        'li',
        { id: `odin-sr-${i}`, role: 'option', class: i === this.active ? 'active' : '', 'aria-selected': String(i === this.active) },
        h('span', { class: `kind kind-${it.kind}` }, it.kind),
        h('span', { class: 'sr-name' }, it.name),
        h('span', { class: 'sr-scope' }, it.kind === 'cell' ? it.scope || designName : it.path),
        it.detail ? h('span', { class: 'sr-detail' }, it.detail) : null,
      );
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.choose(i);
      });
      this.results.append(li);
    });
    if (this.active >= 0) {
      this.searchInput.setAttribute('aria-activedescendant', `odin-sr-${this.active}`);
      this.results.children[this.active]?.scrollIntoView({ block: 'nearest' });
    }
  }

  private searchKeys(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!this.hits.length) return;
      ev.preventDefault();
      const d = ev.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + d + this.hits.length) % this.hits.length;
      this.renderResults();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (this.active >= 0) this.choose(this.active);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (this.searchInput.value) {
        this.searchInput.value = '';
        this.runSearch();
      } else this.searchInput.blur();
    }
  }

  private choose(i: number): void {
    const it = this.hits[i];
    if (!it) return;
    this.closeResults();
    this.cb.pick(it);
  }

  private closeResults(): void {
    this.results.hidden = true;
    this.searchInput.setAttribute('aria-expanded', 'false');
  }
}
