/**
 * Side panel (Properties / Changes tabs), diagnostics popover and tooltip.
 */
import type { ChangeKind } from '../../src/diff/types';
import type { Cell, Design, Diagnostic, IntfPin, Net, Pin, SourceLocation } from '../../src/model/types';
import { guessIntfMode, guessPinDirection, type SiblingHints } from '../../src/model/heuristics';
import { leafName, parentPath } from '../../src/model/query';
import type { ChangeGroup, ChangeItem, DiffContext } from './diff-index';
import { clear, h } from './dom';
import { netKey, type NavTarget, type Selection, shortVlnv, splitNetKey, widthLabel } from './state';

/** Everything the panels need to describe objects. */
export interface ModelContext {
  /** Head design merged with removed objects from base (when diffing). */
  design: Design;
  cells: Map<string, Cell>;
  nets: Map<string, Net>;
  /** Pin/port path -> nets (all scopes) touching it. */
  pinNets: Map<string, Net[]>;
  diff?: DiffContext;
  /** Base design, for "before" values. */
  base?: Design;
}

export interface PanelCallbacks {
  select(target: NavTarget): void;
  reveal(loc: SourceLocation): void;
  enterScope(scope: string): void;
}

export function buildModelContext(design: Design, diff?: DiffContext, base?: Design): ModelContext {
  const cells = new Map(design.cells.map((c) => [c.path, c]));
  const nets = new Map<string, Net>();
  const pinNets = new Map<string, Net[]>();
  for (const n of design.nets) {
    nets.set(netKey(n.scope, n.name), n);
    for (const e of n.endpoints) {
      const list = pinNets.get(e.path) ?? [];
      list.push(n);
      pinNets.set(e.path, list);
    }
  }
  return { design, cells, nets, pinNets, diff, base };
}

type AnyPin = { pin: Pin; intf: false } | { pin: IntfPin; intf: true };

export function lookupPin(ctx: ModelContext, path: string): AnyPin | undefined {
  const owner = parentPath(path);
  const name = leafName(path);
  if (!owner) {
    const p = ctx.design.ports.find((x) => x.name === name);
    if (p) return { pin: p, intf: false };
    const ip = ctx.design.intfPorts.find((x) => x.name === name);
    return ip ? { pin: ip, intf: true } : undefined;
  }
  const cell = ctx.cells.get(owner);
  if (!cell) return undefined;
  const p = cell.pins.find((x) => x.name === name);
  if (p) return { pin: p, intf: false };
  const ip = cell.intfPins.find((x) => x.name === name);
  return ip ? { pin: ip, intf: true } : undefined;
}

/**
 * Declared role of a net endpoint within the net's scope: boundary pins and
 * top-level ports are inverted (an input port drives the nets it touches).
 */
function declaredNetRole(ctx: ModelContext, net: Net, path: string): 'driver' | 'sink' | undefined {
  const p = lookupPin(ctx, path);
  if (!p) return undefined;
  let own: 'driver' | 'sink' | undefined;
  if (p.intf) {
    const m = p.pin.mode;
    own = m === 'Master' || m === 'MirroredSlave' ? 'driver' : m === 'Slave' || m === 'MirroredMaster' ? 'sink' : undefined;
  } else {
    own = p.pin.dir === 'O' ? 'driver' : p.pin.dir === 'I' ? 'sink' : undefined;
  }
  const boundary = parentPath(path) === net.scope;
  if (!own || !boundary) return own;
  return own === 'driver' ? 'sink' : 'driver';
}

/** Hints from the nets a child-cell pin sits on (only nets outside its cell). */
function netHints(ctx: ModelContext, path: string): SiblingHints {
  const hints: SiblingHints = {};
  const owner = parentPath(path);
  for (const net of ctx.pinNets.get(path) ?? []) {
    if (net.scope !== parentPath(owner)) continue;
    for (const e of net.endpoints) {
      if (e.path === path) continue;
      const r = declaredNetRole(ctx, net, e.path);
      if (r === 'driver') hints.netHasDeclaredDriver = true;
      if (r === 'sink') hints.netHasDeclaredSink = true;
    }
  }
  return hints;
}

/**
 * Direction (signal pins) or mode (interface pins) for display: the declared
 * value, or the shared heuristic guess with a "(guessed)" suffix, or `?`.
 */
export function directionLabel(ctx: ModelContext, p: AnyPin): string {
  if (p.intf) {
    if (p.pin.mode) return p.pin.mode;
    const m = guessIntfMode(p.pin);
    return m ? `${m} (guessed)` : '';
  }
  if (p.pin.dir) return p.pin.dir;
  const owner = parentPath(p.pin.path);
  const g = guessPinDirection(p.pin, owner ? ctx.cells.get(owner) : undefined, owner ? netHints(ctx, p.pin.path) : undefined);
  return g ? `${g} (guessed)` : '?';
}

export function statusOf(ctx: ModelContext, sel: Selection): ChangeKind | undefined {
  const idx = ctx.diff?.index;
  if (!idx) return undefined;
  switch (sel.kind) {
    case 'cell':
      return idx.cells.get(sel.path);
    case 'pin':
      return idx.pins.get(sel.path);
    case 'port':
      return idx.ports.get(sel.path);
    case 'net':
      return idx.nets.get(sel.path);
  }
}

function cellKindLabel(c: Cell): string {
  return c.kind === 'ip' ? 'IP' : c.kind === 'module' ? 'Module reference' : c.kind === 'hier' ? 'Hierarchy' : 'Cell';
}

function pinSummary(p: AnyPin): string {
  if (p.intf) return [p.pin.mode, shortVlnv(p.pin.vlnv)].filter(Boolean).join(' · ') || 'interface';
  const dir = p.pin.dir === 'I' ? 'input' : p.pin.dir === 'O' ? 'output' : p.pin.dir === 'IO' ? 'inout' : 'direction unknown';
  return [dir, p.pin.type && p.pin.type !== 'undef' ? p.pin.type : '', widthLabel(p.pin.from, p.pin.to)].filter(Boolean).join(' · ');
}

/** Short multi-line tooltip text for a hovered object. */
export function tooltipLines(ctx: ModelContext, sel: Selection): string[] {
  const st = statusOf(ctx, sel);
  const tag = st ? ` (${st})` : '';
  switch (sel.kind) {
    case 'cell': {
      const c = ctx.cells.get(sel.path);
      if (!c) return [sel.path];
      const sub = c.kind === 'ip' ? shortVlnv(c.vlnv) : c.kind === 'module' ? `module ${c.reference ?? ''}` : cellKindLabel(c);
      const hint = c.kind === 'hier' ? 'Double-click to open' : c.loc ? 'Double-click to go to source' : '';
      return [`${c.path}${tag}`, sub ?? '', `${c.pins.length + c.intfPins.length} pins · ${Object.keys(c.properties).length} properties`, hint].filter(Boolean);
    }
    case 'pin':
    case 'port': {
      const p = lookupPin(ctx, sel.path);
      const nets = ctx.pinNets.get(sel.path) ?? [];
      return [
        `${sel.path}${tag}`,
        p ? pinSummary(p) : '',
        nets.length ? `net: ${nets.map((n) => n.name).join(', ')}` : 'unconnected',
      ].filter(Boolean);
    }
    case 'net': {
      const n = ctx.nets.get(sel.path);
      const { name } = splitNetKey(sel.path);
      if (!n) return [name];
      return [`${n.name}${tag}`, `${n.kind === 'interface' ? 'interface net' : 'net'} · ${n.endpoints.length} endpoints`];
    }
  }
}

// ---------------------------------------------------------------------------

function sourceLink(loc: SourceLocation | undefined, cb: PanelCallbacks): HTMLElement | null {
  if (!loc) return null;
  const b = h('button', { class: 'link', type: 'button', title: `${loc.file}:${loc.line}` }, `Go to source (line ${loc.line})`);
  b.addEventListener('click', () => cb.reveal(loc));
  return b;
}

function statusChip(st: ChangeKind | undefined): HTMLElement | null {
  return st ? h('span', { class: `chip st-${st}` }, st) : null;
}

function section(title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'prop-section' }, h('h3', {}, title), ...body);
}

function kvTable(rows: [string, Node | string][]): HTMLElement {
  return h(
    'table',
    { class: 'kv' },
    h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v)))),
  );
}

function navLink(text: string, target: NavTarget, cb: PanelCallbacks, cls = ''): HTMLElement {
  const b = h('button', { class: `link ${cls}`.trim(), type: 'button' }, text);
  b.addEventListener('click', () => cb.select(target));
  return b;
}

/** Scope in which a pin/port is drawn as a child pin (for navigation). */
function pinScope(path: string): string {
  const owner = parentPath(path);
  return owner ? parentPath(owner) : '';
}

function netList(ctx: ModelContext, nets: Net[], cb: PanelCallbacks): HTMLElement {
  if (!nets.length) return h('p', { class: 'muted' }, 'Not connected');
  return h(
    'ul',
    { class: 'plain' },
    ...nets.map((n) => {
      const key = netKey(n.scope, n.name);
      const st = ctx.diff?.index.nets.get(key);
      return h(
        'li',
        {},
        navLink(n.scope ? `${n.name}  (in ${n.scope})` : n.name, { scope: n.scope, select: { kind: 'net', path: key } }, cb, st ? `st-${st}` : ''),
      );
    }),
  );
}

function renderCell(ctx: ModelContext, c: Cell, cb: PanelCallbacks): HTMLElement[] {
  const out: HTMLElement[] = [];
  const rows: [string, Node | string][] = [['Type', cellKindLabel(c)]];
  if (c.vlnv) rows.push(['VLNV', c.vlnv]);
  if (c.reference) rows.push(['Reference', c.reference]);
  if (c.kind === 'hier') {
    const n = ctx.design.cells.filter((x) => x.parent === c.path).length;
    const open = h('button', { class: 'link', type: 'button' }, `Open hierarchy (${n} cells)`);
    open.addEventListener('click', () => cb.enterScope(c.path));
    rows.push(['Contents', open]);
  }
  out.push(kvTable(rows));

  // Properties with before/after when diffing.
  const changes = ctx.diff?.propertyChanges.get(c.path) ?? [];
  const changed = new Map(changes.map((x) => [x.key, x]));
  const keys = [...new Set([...Object.keys(c.properties), ...changes.map((x) => x.key)])].sort();
  const propRows = keys.map((k) => {
    const ch = changed.get(k);
    let value: Node | string = c.properties[k] ?? '';
    if (ch) {
      value = h(
        'span',
        { class: 'prop-change' },
        h('span', { class: 'before' }, ch.before ?? '∅'),
        ' → ',
        h('span', { class: 'after' }, ch.after ?? '∅'),
      );
    }
    const tr = h('tr', { class: ch ? 'changed' : '' }, h('th', { scope: 'row', title: k }, k), h('td', {}, value));
    return tr;
  });
  out.push(
    section(
      `Properties (${keys.length})`,
      keys.length ? h('table', { class: 'kv props' }, h('tbody', {}, ...propRows)) : h('p', { class: 'muted' }, 'No properties set'),
    ),
  );

  const pins: AnyPin[] = [
    ...c.intfPins.map((pin) => ({ pin, intf: true as const })),
    ...c.pins.map((pin) => ({ pin, intf: false as const })),
  ];
  const pinRows = pins.map((p) => {
    const st = ctx.diff?.index.pins.get(p.pin.path);
    const link = navLink(p.pin.name, { scope: c.parent, select: { kind: 'pin', path: p.pin.path } }, cb, st ? `st-${st}` : '');
    const info = p.intf
      ? [directionLabel(ctx, p), shortVlnv(p.pin.vlnv) ?? ''].filter(Boolean).join(' · ')
      : [directionLabel(ctx, p), p.pin.type && p.pin.type !== 'undef' ? p.pin.type : '', widthLabel(p.pin.from, p.pin.to) ?? '']
          .filter(Boolean)
          .join(' · ');
    return h('tr', {}, h('th', { scope: 'row' }, link), h('td', {}, info, p.pin.inferred ? h('span', { class: 'muted' }, ' (inferred)') : null));
  });
  out.push(section(`Pins (${pins.length})`, pins.length ? h('table', { class: 'kv pins' }, h('tbody', {}, ...pinRows)) : null));

  const nets: Net[] = [];
  const seen = new Set<Net>();
  for (const p of pins) for (const n of ctx.pinNets.get(p.pin.path) ?? []) if (n.scope === c.parent && !seen.has(n)) (seen.add(n), nets.push(n));
  out.push(section(`Connected nets (${nets.length})`, netList(ctx, nets, cb)));
  return out;
}

function renderPin(ctx: ModelContext, path: string, kind: 'pin' | 'port', cb: PanelCallbacks): HTMLElement[] {
  const p = lookupPin(ctx, path);
  const owner = parentPath(path);
  const rows: [string, Node | string][] = [];
  if (owner) rows.push(['Cell', navLink(owner, { scope: parentPath(owner), select: { kind: 'cell', path: owner } }, cb)]);
  if (p?.intf) {
    rows.push(['Kind', kind === 'port' ? 'Interface port' : 'Interface pin']);
    const mode = directionLabel(ctx, p);
    if (mode) rows.push(['Mode', mode]);
    if (p.pin.vlnv) rows.push(['VLNV', p.pin.vlnv]);
  } else if (p) {
    rows.push(['Kind', kind === 'port' ? 'Port' : 'Pin']);
    const dir = directionLabel(ctx, p);
    rows.push(['Direction', dir === '?' ? 'unknown' : dir]);
    if (p.pin.type) rows.push(['Type', p.pin.type]);
    const w = widthLabel(p.pin.from, p.pin.to);
    if (w) rows.push(['Width', `${w} (${Math.abs((p.pin.from ?? 0) - (p.pin.to ?? 0)) + 1} bits)`]);
  }
  if (p?.pin.inferred) rows.push(['Declared', 'no (inferred from connections)']);
  const nets = ctx.pinNets.get(path) ?? [];
  return [kvTable(rows), section(`Connected nets (${nets.length})`, netList(ctx, nets, cb))];
}

function renderNet(ctx: ModelContext, key: string, cb: PanelCallbacks): HTMLElement[] {
  const n = ctx.nets.get(key);
  if (!n) return [h('p', { class: 'muted' }, 'Net not found')];
  const change = ctx.diff?.netChanges.get(key);
  const added = new Set(change?.addedEndpoints ?? []);
  const removed = new Set(change?.removedEndpoints ?? []);
  const rows: [string, Node | string][] = [
    ['Kind', n.kind === 'interface' ? 'Interface net' : 'Signal net'],
    ['Scope', n.scope ? navLink(n.scope, { scope: n.scope }, cb) : '(root)'],
  ];
  const eps = n.endpoints.map((e) => {
    const kind = e.kind === 'port' || e.kind === 'intfPort' ? 'port' : 'pin';
    const sel: Selection = { kind, path: e.path };
    const isBoundary = parentPath(e.path) === n.scope && n.scope !== '';
    const st = added.has(e.path) ? 'added' : removed.has(e.path) ? 'removed' : undefined;
    const p = lookupPin(ctx, e.path);
    return h(
      'li',
      {},
      navLink(e.path, { scope: isBoundary || kind === 'port' ? n.scope : pinScope(e.path), select: sel }, cb, st ? `st-${st}` : ''),
      p ? h('span', { class: 'muted' }, `  ${pinSummary(p)}`) : null,
      statusChip(st),
    );
  });
  return [kvTable(rows), section(`Endpoints (${n.endpoints.length})`, h('ul', { class: 'plain' }, ...eps))];
}

export class SidePanel {
  readonly el: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly propsTab: HTMLButtonElement;
  private readonly changesTab: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly changesBody: HTMLElement;
  private readonly changesList: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly kindFilter: HTMLSelectElement;
  private active: 'props' | 'changes' = 'props';
  private changes: ChangeItem[] = [];
  collapsed = false;

  constructor(
    private readonly cb: PanelCallbacks,
    private readonly onCollapse: (collapsed: boolean) => void,
  ) {
    this.propsTab = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'true', id: 'odin-tab-props' }, 'Properties');
    this.changesTab = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', id: 'odin-tab-changes', hidden: true }, 'Changes');
    const collapse = h('button', { class: 'icon-btn', type: 'button', title: 'Hide panel', 'aria-label': 'Hide side panel' }, '›');
    collapse.addEventListener('click', () => this.setCollapsed(true));
    this.tabs = h('div', { class: 'panel-tabs', role: 'tablist' }, this.propsTab, this.changesTab, h('span', { class: 'spacer' }), collapse);
    this.body = h('div', { class: 'panel-body', role: 'tabpanel', 'aria-labelledby': 'odin-tab-props' });
    this.filterInput = h('input', { type: 'search', class: 'input', placeholder: 'Filter changes', 'aria-label': 'Filter changes' });
    this.kindFilter = h(
      'select',
      { class: 'input', 'aria-label': 'Change kind' },
      h('option', { value: '' }, 'All'),
      h('option', { value: 'added' }, 'Added'),
      h('option', { value: 'removed' }, 'Removed'),
      h('option', { value: 'modified' }, 'Modified'),
    );
    this.changesList = h('div', { class: 'changes-list' });
    this.changesBody = h(
      'div',
      { class: 'panel-body', role: 'tabpanel', 'aria-labelledby': 'odin-tab-changes', hidden: true },
      h('div', { class: 'changes-filter' }, this.filterInput, this.kindFilter),
      this.changesList,
    );
    this.el = h('aside', { class: 'side-panel', 'aria-label': 'Details' }, this.tabs, this.body, this.changesBody);
    this.propsTab.addEventListener('click', () => this.showTab('props'));
    this.changesTab.addEventListener('click', () => this.showTab('changes'));
    this.filterInput.addEventListener('input', () => this.renderChanges());
    this.kindFilter.addEventListener('change', () => this.renderChanges());
    this.tabs.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const next = this.active === 'props' && !this.changesTab.hidden ? 'changes' : 'props';
      this.showTab(next);
      (next === 'props' ? this.propsTab : this.changesTab).focus();
    });
    this.showEmpty();
  }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.onCollapse(c);
  }

  showTab(tab: 'props' | 'changes'): void {
    this.active = tab;
    this.propsTab.setAttribute('aria-selected', String(tab === 'props'));
    this.changesTab.setAttribute('aria-selected', String(tab === 'changes'));
    this.body.hidden = tab !== 'props';
    this.changesBody.hidden = tab !== 'changes';
    if (this.collapsed) this.setCollapsed(false);
  }

  showEmpty(scopeInfo?: string): void {
    clear(this.body);
    this.body.append(
      h('p', { class: 'muted' }, 'Select a cell, pin or net to see its details.'),
      scopeInfo ? h('p', { class: 'muted' }, scopeInfo) : '',
      h(
        'p',
        { class: 'muted small' },
        'Double-click a hierarchy to open it; Backspace goes up. Ctrl/Cmd+click jumps to the source line.',
      ),
    );
  }

  showSelection(ctx: ModelContext, sel: Selection): void {
    clear(this.body);
    const st = statusOf(ctx, sel);
    let title = sel.path;
    let loc: SourceLocation | undefined;
    let content: HTMLElement[] = [];
    let kindLabel: string = sel.kind;
    if (sel.kind === 'cell') {
      const c = ctx.cells.get(sel.path);
      if (!c) return this.showEmpty();
      title = c.name;
      loc = c.loc;
      kindLabel = cellKindLabel(c);
      content = renderCell(ctx, c, this.cb);
    } else if (sel.kind === 'pin' || sel.kind === 'port') {
      title = leafName(sel.path);
      loc = lookupPin(ctx, sel.path)?.pin.loc;
      kindLabel = sel.kind === 'port' ? 'Port' : 'Pin';
      content = renderPin(ctx, sel.path, sel.kind, this.cb);
    } else {
      const n = ctx.nets.get(sel.path);
      title = n?.name ?? splitNetKey(sel.path).name;
      loc = n?.loc;
      kindLabel = 'Net';
      content = renderNet(ctx, sel.path, this.cb);
    }
    const pathText = sel.kind === 'net' ? (splitNetKey(sel.path).scope ? `${splitNetKey(sel.path).scope}/${title}` : title) : sel.path;
    this.body.append(
      h(
        'header',
        { class: 'prop-header' },
        h('div', { class: 'prop-kind' }, kindLabel, statusChip(st)),
        h('h2', { class: 'prop-title', title }, title),
        h('div', { class: 'prop-path', title: pathText }, pathText),
        sourceLink(loc, this.cb),
      ),
      ...content,
    );
    if (this.active !== 'props') this.showTab('props');
  }

  setChanges(items: ChangeItem[] | undefined, label?: string): void {
    this.changes = items ?? [];
    this.changesTab.hidden = !items;
    this.changesTab.textContent = items ? `Changes (${items.length})` : 'Changes';
    if (label) this.changesTab.title = label;
    if (!items && this.active === 'changes') this.showTab('props');
    this.renderChanges();
  }

  private renderChanges(): void {
    clear(this.changesList);
    const q = this.filterInput.value.trim().toLowerCase();
    const kind = this.kindFilter.value;
    const groups = new Map<ChangeGroup, ChangeItem[]>();
    for (const it of this.changes) {
      if (kind && it.kind !== kind) continue;
      if (q && !`${it.label} ${it.detail ?? ''}`.toLowerCase().includes(q)) continue;
      const list = groups.get(it.group) ?? [];
      list.push(it);
      groups.set(it.group, list);
    }
    if (!groups.size) {
      this.changesList.append(h('p', { class: 'muted' }, this.changes.length ? 'No changes match the filter.' : 'No changes.'));
      return;
    }
    for (const [group, items] of groups) {
      const list = h('ul', { class: 'plain change-items' });
      for (const it of items) {
        const btn = h(
          'button',
          { class: `change-item st-${it.kind}`, type: 'button', disabled: !it.target },
          h('span', { class: `dot st-${it.kind}`, 'aria-hidden': 'true' }),
          h('span', { class: 'change-text' }, h('span', { class: 'change-label' }, it.label), it.detail ? h('span', { class: 'change-detail' }, it.detail) : null),
          h('span', { class: 'sr-only' }, ` ${it.kind}`),
        );
        if (it.target) {
          const target = it.target;
          btn.addEventListener('click', () => this.cb.select(target));
        }
        list.append(h('li', {}, btn));
      }
      this.changesList.append(h('details', { open: true, class: 'change-group' }, h('summary', {}, `${group} (${items.length})`), list));
    }
  }
}

export class DiagnosticsPopover {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly onReveal: (loc: SourceLocation) => void) {
    this.list = h('ul', { class: 'plain diag-list', role: 'list' });
    this.el = h('div', { class: 'popover diag-popover', role: 'dialog', 'aria-label': 'Diagnostics', hidden: true }, h('h3', {}, 'Diagnostics'), this.list);
  }

  set(diags: Diagnostic[]): void {
    clear(this.list);
    if (!diags.length) {
      this.list.append(h('li', { class: 'muted' }, 'No diagnostics.'));
      return;
    }
    const order = { error: 0, warning: 1, info: 2 } as const;
    for (const d of [...diags].sort((a, b) => order[a.severity] - order[b.severity])) {
      const text = h('span', { class: 'diag-msg' }, d.message);
      const sev = h('span', { class: `sev sev-${d.severity}` }, d.severity);
      if (d.loc) {
        const loc = d.loc;
        const b = h('button', { class: 'diag-item', type: 'button', title: `${loc.file}:${loc.line}` }, sev, text, h('span', { class: 'muted' }, `line ${loc.line}`));
        b.addEventListener('click', () => this.onReveal(loc));
        this.list.append(h('li', {}, b));
      } else {
        this.list.append(h('li', {}, h('div', { class: 'diag-item' }, sev, text)));
      }
    }
  }

  toggle(show?: boolean): void {
    this.el.hidden = !(show ?? this.el.hidden);
    if (!this.el.hidden) (this.el.querySelector('button') as HTMLButtonElement | null)?.focus();
  }
}

export class Tooltip {
  readonly el: HTMLElement;
  constructor() {
    this.el = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  }
  show(lines: string[], x: number, y: number, bounds: DOMRect): void {
    clear(this.el);
    lines.forEach((l, i) => this.el.append(h('div', { class: i === 0 ? 'tt-title' : 'tt-line' }, l)));
    this.el.hidden = false;
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    const left = Math.min(x + 14, bounds.width - w - 4);
    const top = y + 18 + hh > bounds.height ? y - hh - 10 : y + 18;
    this.el.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }
  hide(): void {
    this.el.hidden = true;
  }
}
