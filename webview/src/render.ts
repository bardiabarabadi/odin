/**
 * SVG rendering of a laid-out scene, built with plain DOM APIs.
 *
 * Every interactive element carries `data-kind` (`cell` | `pin` | `port` |
 * `net`) and `data-path` (model path, or net key for nets). interaction.ts
 * relies only on these attributes, never on the element structure.
 *
 * Styling is done with classes (styles.css); geometry with SVG attributes.
 */
import type { ChangeKind } from '../../src/diff/types';
import { GEOM, type NodeView, type PinView } from './graph';
import type { LaidOutScene, Point } from './layout';
import type { Selection } from './state';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface RenderHandles {
  svg: SVGSVGElement;
  /** Group that receives the pan/zoom transform. */
  viewport: SVGGElement;
  netLayer: SVGGElement;
  width: number;
  height: number;
  /** Node group by model path (cells and boundary ports). */
  nodeEls: Map<string, SVGGElement>;
  /** Pin group by model path (boundary nodes are registered here too). */
  pinEls: Map<string, SVGGElement>;
  netEls: Map<string, SVGGElement>;
  /** Elements currently carrying highlight classes, for cheap clearing. */
  flagged: Set<Element>;
}

export interface RenderOptions {
  diffActive: boolean;
  diffOnly: boolean;
  ariaLabel: string;
}

type Attrs = Record<string, string | number | undefined>;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  if (parent) parent.appendChild(el);
  return el;
}

function statusClasses(status: ChangeKind | undefined, diffActive: boolean, hasInnerChanges = false): string[] {
  if (!diffActive) return [];
  if (status) return [`st-${status}`, ...(status === 'removed' ? ['ghost'] : [])];
  return hasInnerChanges ? ['st-inner'] : ['unchanged'];
}

function polylineD(points: Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`).join(' ');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function drawPinLabel(g: SVGGElement, pv: PinView, x: number, anchor: 'start' | 'end'): void {
  const t = svgEl('text', { class: 'pin-label', x, y: pv.y, 'text-anchor': anchor, 'dominant-baseline': 'central' }, g);
  t.textContent = pv.name;
  if (pv.width) {
    const span = svgEl('tspan', { class: 'pin-width' }, t);
    span.textContent = ` ${pv.width}`;
  }
}

/** Direction marker on a pin stub. `tipX` is the outer end of the stub. */
function drawPinMarker(g: SVGGElement, pv: PinView, edgeX: number, outward: 1 | -1): void {
  const y = pv.y;
  const mid = edgeX + (outward * GEOM.stub) / 2;
  if (pv.intf) {
    // Vivado shows interface pins with a small "+" box.
    svgEl('rect', { class: 'pin-intf-box', x: mid - 4, y: y - 4, width: 8, height: 8, rx: 1 }, g);
    svgEl('path', { class: 'pin-intf-plus', d: `M${mid - 2.5} ${y}H${mid + 2.5}M${mid} ${y - 2.5}V${y + 2.5}` }, g);
    return;
  }
  if (pv.role === 'bidir') {
    svgEl('path', { class: 'pin-arrow', d: `M${mid - 3.5} ${y}L${mid} ${y - 3.5}L${mid + 3.5} ${y}L${mid} ${y + 3.5}Z` }, g);
    return;
  }
  if (pv.role === 'unknown') return;
  // Arrow points in the direction of signal flow (always rightwards in the
  // canonical layout, but computed from role and side for robustness).
  const intoBlock = pv.role === 'sink';
  // Towards the block for sinks, away from it for sources.
  const pointsRight = (intoBlock ? -outward : outward) > 0;
  const cx = mid;
  const d = pointsRight
    ? `M${cx - 2.5} ${y - 3.5}L${cx + 2.5} ${y}L${cx - 2.5} ${y + 3.5}Z`
    : `M${cx + 2.5} ${y - 3.5}L${cx - 2.5} ${y}L${cx + 2.5} ${y + 3.5}Z`;
  svgEl('path', { class: 'pin-arrow', d }, g);
}

function drawCellPin(parent: SVGGElement, node: NodeView, pv: PinView, opts: RenderOptions): SVGGElement {
  const cls = ['pin', pv.side === 'WEST' ? 'side-w' : 'side-e', `role-${pv.role}`];
  if (pv.intf) cls.push('intf');
  if (pv.width) cls.push('vector');
  cls.push(...statusClasses(pv.status, opts.diffActive && !!pv.status, false));
  const g = svgEl('g', { class: cls.join(' '), 'data-kind': 'pin', 'data-path': pv.path }, parent);
  const west = pv.side === 'WEST';
  const x0 = west ? 0 : node.width;
  const x1 = west ? -GEOM.stub : node.width + GEOM.stub;
  // Generous invisible hit area covering stub + label half of the block.
  svgEl(
    'rect',
    {
      class: 'hit',
      x: west ? -GEOM.stub : node.width / 2,
      y: pv.y - GEOM.pinPitch / 2,
      width: node.width / 2 + GEOM.stub,
      height: GEOM.pinPitch,
    },
    g,
  );
  svgEl('line', { class: 'pin-stub', x1: x0, y1: pv.y, x2: x1, y2: pv.y }, g);
  drawPinMarker(g, pv, x0, west ? -1 : 1);
  drawPinLabel(g, pv, west ? GEOM.padX : node.width - GEOM.padX, west ? 'start' : 'end');
  return g;
}

function drawHierGlyph(parent: SVGGElement, x: number, y: number): void {
  const g = svgEl('g', { class: 'hier-glyph', transform: `translate(${x},${y})` }, parent);
  svgEl('rect', { x: 0, y: 0, width: 7, height: 4, rx: 0.5 }, g);
  svgEl('path', { d: 'M2 4V11.5H5M2 7.5H5', fill: 'none' }, g);
  svgEl('rect', { x: 5, y: 5.5, width: 7, height: 4, rx: 0.5 }, g);
  svgEl('rect', { x: 5, y: 9.5, width: 7, height: 4, rx: 0.5 }, g);
}

function drawCell(layer: SVGGElement, node: NodeView, pos: Point, opts: RenderOptions, h: RenderHandles): void {
  const cls = ['node', 'cell', `kind-${node.cellKind ?? 'unknown'}`, ...statusClasses(node.status, opts.diffActive, !!node.changeCount)];
  const g = svgEl(
    'g',
    {
      class: cls.join(' '),
      'data-kind': 'cell',
      'data-path': node.path,
      transform: `translate(${round(pos.x)},${round(pos.y)})`,
    },
    layer,
  );
  const { width: w, height: hgt } = node;
  const r = 4;
  svgEl('rect', { class: 'cell-body', x: 0, y: 0, width: w, height: hgt, rx: r }, g);
  svgEl('path', { class: 'cell-header', d: `M0 ${r}A${r} ${r} 0 0 1 ${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${GEOM.headerH}H0Z` }, g);
  svgEl('line', { class: 'cell-sep', x1: 0, y1: GEOM.headerH, x2: w, y2: GEOM.headerH }, g);
  let tx = GEOM.padX;
  if (node.cellKind === 'hier') {
    drawHierGlyph(g, GEOM.padX, 7);
    tx += GEOM.glyphW;
  }
  const title = svgEl('text', { class: 'cell-title', x: tx, y: 14, 'dominant-baseline': 'central' }, g);
  title.textContent = node.name;
  if (node.subtitle) {
    const sub = svgEl('text', { class: 'cell-subtitle', x: GEOM.padX, y: 29, 'dominant-baseline': 'central' }, g);
    sub.textContent = node.subtitle;
  }
  svgEl('rect', { class: 'cell-outline', x: 0, y: 0, width: w, height: hgt, rx: r }, g);
  svgEl('rect', { class: 'select-ring', x: -4, y: -4, width: w + 8, height: hgt + 8, rx: r + 3 }, g);
  for (const pv of node.pins) h.pinEls.set(pv.path, drawCellPin(g, node, pv, opts));
  if (node.changeCount) {
    const b = svgEl('g', { class: 'change-badge', transform: `translate(${w - 13},13)` }, g);
    svgEl('circle', { r: 9 }, b);
    const t = svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 0.5 }, b);
    t.textContent = node.changeCount > 99 ? '99+' : String(node.changeCount);
    const tt = svgEl('title', {}, b);
    tt.textContent = `${node.changeCount} change${node.changeCount === 1 ? '' : 's'} inside`;
  }
  h.nodeEls.set(node.path, g);
}

function portShape(w: number, h: number, bidir: boolean): string {
  const t = GEOM.portTip;
  if (bidir) return `M${t} 0H${w - t}L${w} ${h / 2}L${w - t} ${h}H${t}L0 ${h / 2}Z`;
  return `M0 0H${w - t}L${w} ${h / 2}L${w - t} ${h}H0Z`;
}

function drawBoundary(layer: SVGGElement, node: NodeView, pos: Point, opts: RenderOptions, h: RenderHandles, scoped: boolean): void {
  const pv = node.pins[0];
  const role = node.boundaryRole ?? 'unknown';
  const cls = ['node', 'port', `role-${role}`, ...statusClasses(node.status, opts.diffActive)];
  if (node.intf) cls.push('intf');
  if (pv?.width) cls.push('vector');
  const g = svgEl(
    'g',
    {
      class: cls.join(' '),
      'data-kind': scoped ? 'pin' : 'port',
      'data-path': node.path,
      transform: `translate(${round(pos.x)},${round(pos.y)})`,
    },
    layer,
  );
  const { width: w, height: hgt } = node;
  svgEl('path', { class: 'port-shape', d: portShape(w, hgt, role === 'bidir' || role === 'unknown') }, g);
  svgEl('rect', { class: 'select-ring', x: -4, y: -4, width: w + 8, height: hgt + 8, rx: 3 }, g);
  const label = svgEl(
    'text',
    { class: 'port-label', x: GEOM.portNodePad, y: hgt / 2, 'dominant-baseline': 'central' },
    g,
  );
  label.textContent = node.name;
  if (pv?.width) {
    const span = svgEl('tspan', { class: 'pin-width' }, label);
    span.textContent = ` ${pv.width}`;
  }
  if (pv) {
    const x0 = pv.side === 'EAST' ? w : 0;
    const x1 = pv.side === 'EAST' ? w + GEOM.stub : -GEOM.stub;
    svgEl('line', { class: 'pin-stub', x1: x0, y1: hgt / 2, x2: x1, y2: hgt / 2 }, g);
    h.pinEls.set(pv.path, g);
  }
  h.nodeEls.set(node.path, g);
}

export function renderScene(scene: LaidOutScene, opts: RenderOptions): RenderHandles {
  const { graph } = scene;
  const svg = svgEl('svg', {
    class: `odin-diagram${opts.diffActive ? ' diff-active' : ''}${opts.diffOnly ? ' diff-only' : ''}`,
    role: 'img',
    'aria-label': opts.ariaLabel,
    tabindex: 0,
  });
  const viewport = svgEl('g', { class: 'viewport' }, svg);
  const netLayer = svgEl('g', { class: 'layer-nets' }, viewport);
  const nodeLayer = svgEl('g', { class: 'layer-nodes' }, viewport);
  const handles: RenderHandles = {
    svg,
    viewport,
    netLayer,
    width: scene.width,
    height: scene.height,
    nodeEls: new Map(),
    pinEls: new Map(),
    netEls: new Map(),
    flagged: new Set(),
  };

  for (const node of graph.nodes.values()) {
    const pos = scene.nodePos.get(node.id) ?? { x: 0, y: 0 };
    if (node.kind === 'cell') drawCell(nodeLayer, node, pos, opts, handles);
    else drawBoundary(nodeLayer, node, pos, opts, handles, graph.scope !== '');
  }

  for (const net of graph.nets.values()) {
    if (!net.edgeIds.length) continue;
    const cls = ['net', net.kind === 'interface' ? 'intf' : 'sig', ...statusClasses(net.status, opts.diffActive)];
    if (net.clockOrReset) cls.push('clkrst');
    const g = svgEl('g', { class: cls.join(' '), 'data-kind': 'net', 'data-path': net.key }, netLayer);
    const hits: string[] = [];
    const junctions = new Map<string, Point>();
    for (const id of net.edgeIds) {
      const route = scene.edgeRoutes.get(id);
      const edge = graph.edges.get(id);
      if (!route || !edge) continue;
      for (const line of route.polylines) {
        const d = polylineD(line);
        const ecls = ['wire'];
        if (opts.diffActive && edge.status && edge.status !== net.status) ecls.push(`est-${edge.status}`);
        svgEl('path', { class: ecls.join(' '), d }, g);
        hits.push(d);
      }
      for (const p of route.junctions) junctions.set(`${p.x},${p.y}`, p);
    }
    svgEl('path', { class: 'wire-hit', d: hits.join(' ') }, g);
    for (const p of junctions.values()) svgEl('circle', { class: 'junction', cx: round(p.x), cy: round(p.y), r: net.kind === 'interface' ? 3.5 : 2.6 }, g);
    handles.netEls.set(net.key, g);
  }
  return handles;
}

function flag(h: RenderHandles, el: Element | undefined, cls: string): void {
  if (!el) return;
  el.classList.add(cls);
  h.flagged.add(el);
}

/** Apply selection highlight classes (`selected`, `hl`, `hl-soft`). */
export function applyHighlight(h: RenderHandles, scene: LaidOutScene, sel: Selection | undefined): void {
  for (const el of h.flagged) el.classList.remove('selected', 'hl', 'hl-soft', 'hl-owner');
  h.flagged.clear();
  h.svg.classList.toggle('has-selection', !!sel);
  if (!sel) return;
  const g = scene.graph;
  const highlightNet = (key: string, cls: 'hl' | 'hl-soft'): void => {
    const netEl = h.netEls.get(key);
    flag(h, netEl, cls);
    if (netEl) h.netLayer.appendChild(netEl); // bring to front
    if (cls === 'hl') for (const p of g.nets.get(key)?.endpoints ?? []) flag(h, h.pinEls.get(p), 'hl');
  };
  if (sel.kind === 'net') {
    highlightNet(sel.path, 'hl');
  } else if (sel.kind === 'pin' || sel.kind === 'port') {
    flag(h, h.pinEls.get(sel.path), 'selected');
    for (const key of g.pinNets.get(sel.path) ?? []) highlightNet(key, 'hl');
  } else if (sel.kind === 'cell') {
    flag(h, h.nodeEls.get(sel.path), 'selected');
    const node = g.nodes.get(g.nodeByPath.get(sel.path) ?? '');
    for (const pv of node?.pins ?? []) for (const key of g.pinNets.get(pv.path) ?? []) highlightNet(key, 'hl-soft');
  }
}

/** Bounding box (scene coordinates) of the element for a selection. */
export function selectionBox(
  h: RenderHandles,
  scene: LaidOutScene,
  sel: Selection,
): { x: number; y: number; width: number; height: number } | undefined {
  const g = scene.graph;
  const nodeBox = (path: string): { x: number; y: number; width: number; height: number } | undefined => {
    const id = g.nodeByPath.get(path);
    const node = id ? g.nodes.get(id) : undefined;
    const pos = id ? scene.nodePos.get(id) : undefined;
    return node && pos ? { x: pos.x, y: pos.y, width: node.width, height: node.height } : undefined;
  };
  if (sel.kind === 'cell' || sel.kind === 'port') return nodeBox(sel.path);
  if (sel.kind === 'pin') {
    const pv = g.pins.get(sel.path);
    if (!pv) return undefined;
    const node = g.nodes.get(pv.nodeId);
    const pos = scene.nodePos.get(pv.nodeId);
    if (!node || !pos) return undefined;
    return { x: pos.x + pv.x - 40, y: pos.y + pv.y - 20, width: 80, height: 40 };
  }
  const el = h.netEls.get(sel.path);
  if (!el) return undefined;
  try {
    const b = el.getBBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  } catch {
    return undefined;
  }
}
