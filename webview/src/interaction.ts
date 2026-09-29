/**
 * Pan / zoom and pointer interaction on the diagram SVG.
 *
 * The viewport is a single `<g>` whose transform is `translate(x,y) scale(k)`.
 * Pointer handling distinguishes a click from a drag with a small movement
 * threshold, so dragging anywhere (including on a cell) pans.
 */
import type { SelectionKind } from './state';

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface HitTarget {
  kind: SelectionKind;
  path: string;
  element: Element;
}

export interface InteractionCallbacks {
  onClick(target: HitTarget | undefined, ev: PointerEvent): void;
  onDoubleClick(target: HitTarget | undefined, ev: MouseEvent): void;
  onHover(target: HitTarget | undefined, ev: PointerEvent): void;
  onTransform(t: Transform): void;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 6;
const DRAG_THRESHOLD = 4;

export function hitTest(el: EventTarget | null): HitTarget | undefined {
  if (!(el instanceof Element)) return undefined;
  const hit = el.closest('[data-kind]');
  if (!hit) return undefined;
  const kind = hit.getAttribute('data-kind') as SelectionKind | null;
  const path = hit.getAttribute('data-path');
  if (!kind || path === null) return undefined;
  return { kind, path, element: hit };
}

export class PanZoom {
  private t: Transform = { x: 0, y: 0, k: 1 };
  private svg: SVGSVGElement | undefined;
  private viewport: SVGGElement | undefined;
  private drag: { id: number; sx: number; sy: number; tx: number; ty: number; moved: boolean } | undefined;
  private lastHover: Element | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: InteractionCallbacks,
  ) {
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('pointerdown', this.onPointerDown);
    host.addEventListener('pointermove', this.onPointerMove);
    host.addEventListener('pointerup', this.onPointerUp);
    host.addEventListener('pointercancel', this.onPointerUp);
    host.addEventListener('pointerleave', () => this.setHover(undefined, undefined));
    host.addEventListener('dblclick', (ev) => this.cb.onDoubleClick(hitTest(ev.target), ev));
  }

  /** Switch to a freshly rendered SVG; the caller then sets or fits the view. */
  attach(svg: SVGSVGElement, viewport: SVGGElement): void {
    this.svg = svg;
    this.viewport = viewport;
  }

  get transform(): Transform {
    return { ...this.t };
  }

  set(t: Transform): void {
    this.t = { x: t.x, y: t.y, k: clamp(t.k, MIN_ZOOM, MAX_ZOOM) };
    // Applied synchronously: pointer/wheel events are already coalesced per
    // frame by the browser, and a single attribute write is cheap.
    this.apply();
  }

  /** Fit a scene-space box into the host, never zooming in above `maxK`. */
  fit(box: { x: number; y: number; width: number; height: number }, maxK = 1.25, pad = 24): void {
    const w = this.host.clientWidth || 800;
    const hgt = this.host.clientHeight || 600;
    if (box.width <= 0 || box.height <= 0) return;
    const k = clamp(Math.min((w - 2 * pad) / box.width, (hgt - 2 * pad) / box.height, maxK), MIN_ZOOM, MAX_ZOOM);
    this.set({ k, x: (w - box.width * k) / 2 - box.x * k, y: (hgt - box.height * k) / 2 - box.y * k });
  }

  /** Center on a box keeping the zoom, or zooming in to at least `minK`. */
  centerOn(box: { x: number; y: number; width: number; height: number }, minK = 0.8): void {
    const w = this.host.clientWidth || 800;
    const hgt = this.host.clientHeight || 600;
    let k = Math.max(this.t.k, minK);
    k = Math.min(k, (w * 0.9) / Math.max(box.width, 1), (hgt * 0.9) / Math.max(box.height, 1), MAX_ZOOM);
    k = Math.max(k, MIN_ZOOM);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    this.set({ k, x: w / 2 - cx * k, y: hgt / 2 - cy * k });
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const x = cx ?? this.host.clientWidth / 2;
    const y = cy ?? this.host.clientHeight / 2;
    const k = clamp(this.t.k * factor, MIN_ZOOM, MAX_ZOOM);
    const f = k / this.t.k;
    this.set({ k, x: x - (x - this.t.x) * f, y: y - (y - this.t.y) * f });
  }

  private apply(): void {
    if (!this.viewport) return;
    const { x, y, k } = this.t;
    this.viewport.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${k.toFixed(4)})`);
    this.svg?.classList.toggle('zoomed-out', k < 0.45);
    this.cb.onTransform(this.transform);
  }

  private local(ev: MouseEvent): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private readonly onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const p = this.local(ev);
    // Pinch gestures arrive as ctrl+wheel with small deltas.
    const scale = ev.deltaMode === 1 ? 0.05 : ev.ctrlKey ? 0.01 : 0.0015;
    this.zoomBy(Math.exp(-ev.deltaY * scale), p.x, p.y);
  };

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.button !== 1) return;
    if (!(ev.target instanceof Element) || !ev.target.closest('svg.odin-diagram')) return;
    this.drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, tx: this.t.x, ty: this.t.y, moved: false };
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const d = this.drag;
    if (d && d.id === ev.pointerId) {
      const dx = ev.clientX - d.sx;
      const dy = ev.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        d.moved = true;
        this.host.setPointerCapture(ev.pointerId);
        this.host.classList.add('panning');
        this.setHover(undefined, ev);
      }
      if (d.moved) {
        this.set({ k: this.t.k, x: d.tx + dx, y: d.ty + dy });
        return;
      }
    }
    this.setHover(hitTest(ev.target), ev);
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== ev.pointerId) return;
    this.drag = undefined;
    this.host.classList.remove('panning');
    if (this.host.hasPointerCapture(ev.pointerId)) this.host.releasePointerCapture(ev.pointerId);
    if (!d.moved && ev.type === 'pointerup') this.cb.onClick(hitTest(ev.target), ev);
  };

  private setHover(target: HitTarget | undefined, ev: PointerEvent | undefined): void {
    const el = target?.element;
    if (el !== this.lastHover) {
      this.lastHover?.classList.remove('hover');
      el?.classList.add('hover');
      this.lastHover = el;
    }
    if (ev) this.cb.onHover(target, ev);
    else if (!target) this.cb.onHover(undefined, new PointerEvent('pointerleave'));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
