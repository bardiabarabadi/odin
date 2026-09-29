/**
 * Self-contained SVG export: clones the live diagram, copies the *computed*
 * presentation properties onto every element as attributes (so no CSS
 * variables or external stylesheet are needed), drops interaction-only
 * elements and resets the pan/zoom transform to the full scene.
 */
import { normalizeColor, uiFontFamily } from './theme';
import type { RenderHandles } from './render';

/** Inherited SVG presentation properties: written only where they differ from the parent. */
const INHERITED = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'text-decoration',
] as const;

const DROP_SELECTOR = '.wire-hit, .hit, .select-ring, title';

export interface ExportOptions {
  title: string;
  background?: string;
}

export function exportSvg(h: RenderHandles, opts: ExportOptions): string {
  const live = h.svg;
  const clone = live.cloneNode(true) as SVGSVGElement;

  // Walk live and clone in lock-step (same structure) before dropping nodes.
  const liveEls = [live, ...live.querySelectorAll('*')];
  const cloneEls = [clone, ...clone.querySelectorAll('*')];
  const computed = new Map<Element, Record<string, string>>();
  for (let i = 0; i < liveEls.length; i++) {
    const src = liveEls[i];
    const dst = cloneEls[i];
    if (!(src instanceof SVGElement) || !(dst instanceof SVGElement)) continue;
    const cs = getComputedStyle(src);
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      dst.setAttribute('display', 'none');
      continue;
    }
    const values: Record<string, string> = {};
    const parent = src === live ? undefined : computed.get(src.parentElement as Element);
    for (const p of INHERITED) {
      let v = cs.getPropertyValue(p);
      if (p === 'fill' || p === 'stroke') v = normalizeColor(v);
      if (p === 'text-decoration') v = v.includes('line-through') ? 'line-through' : 'none';
      values[p] = v;
      if (v && (!parent || parent[p] !== v)) dst.setAttribute(p, v);
    }
    computed.set(src, values);
    const opacity = cs.getPropertyValue('opacity');
    if (opacity && opacity !== '1') dst.setAttribute('opacity', opacity);
    dst.removeAttribute('class');
    dst.removeAttribute('data-kind');
    dst.removeAttribute('data-path');
    dst.removeAttribute('tabindex');
  }
  clone.querySelectorAll(DROP_SELECTOR).forEach((el) => el.remove());
  clone.querySelectorAll('[display="none"]').forEach((el) => el.remove());

  const pad = 8;
  const width = Math.ceil(h.width + 2 * pad);
  const height = Math.ceil(h.height + 2 * pad);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${-pad} ${-pad} ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.removeAttribute('class');
  clone.removeAttribute('tabindex');
  clone.removeAttribute('style');
  const vp = clone.querySelector('g');
  vp?.removeAttribute('transform');

  const doc = clone.ownerDocument;
  const ns = 'http://www.w3.org/2000/svg';
  const title = doc.createElementNS(ns, 'title');
  title.textContent = opts.title;
  const style = doc.createElementNS(ns, 'style');
  const family = uiFontFamily().replace(/[<>]/g, '');
  style.textContent = `text{font-family:${family};}`;
  clone.insertBefore(style, clone.firstChild);
  clone.insertBefore(title, clone.firstChild);
  if (opts.background) {
    const bg = doc.createElementNS(ns, 'rect');
    bg.setAttribute('x', String(-pad));
    bg.setAttribute('y', String(-pad));
    bg.setAttribute('width', String(width));
    bg.setAttribute('height', String(height));
    bg.setAttribute('fill', normalizeColor(opts.background));
    clone.insertBefore(bg, style.nextSibling);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}
