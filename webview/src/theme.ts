/**
 * Theme helpers. Colours come from VS Code CSS variables (see styles.css);
 * this module only deals with fonts for text measurement, colour
 * normalisation for SVG export, and theme-change notifications.
 */
import type { FontRole, MeasureText } from './graph';
import { approximateMeasure } from './graph';

export const FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, "Helvetica Neue", Arial, sans-serif';

/** Font sizes/weights per role; keep in sync with the `.odin-diagram` rules in styles.css. */
export const FONT_SPEC: Record<FontRole, { size: number; weight: number }> = {
  title: { size: 12, weight: 600 },
  subtitle: { size: 10.5, weight: 400 },
  pin: { size: 11, weight: 400 },
  port: { size: 11, weight: 500 },
};

export function uiFontFamily(): string {
  const f = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim();
  return f || FONT_FALLBACK;
}

/** Canvas-based text measurement with a per-string cache. */
export function createCanvasMeasurer(): MeasureText {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return approximateMeasure;
  const family = uiFontFamily();
  const cache = new Map<string, number>();
  return (text, role) => {
    const key = `${role}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const spec = FONT_SPEC[role];
    ctx.font = `${spec.weight} ${spec.size}px ${family}`;
    const w = Math.ceil(ctx.measureText(text).width);
    cache.set(key, w);
    return w;
  };
}

export function isHighContrast(): boolean {
  const c = document.body.classList;
  return c.contains('vscode-high-contrast') || c.contains('vscode-high-contrast-light');
}

/**
 * Normalise a computed colour to something every SVG consumer understands
 * (`rgb()`/`rgba()`); modern Chromium reports `color-mix()` results as
 * `color(srgb r g b / a)`.
 */
export function normalizeColor(value: string): string {
  const m = /^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.e+-]+%?))?\)$/.exec(value.trim());
  if (!m) return value;
  const ch = (v: string): number => Math.round(Math.max(0, Math.min(1, Number(v))) * 255);
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return a >= 1 ? `rgb(${ch(m[1])}, ${ch(m[2])}, ${ch(m[3])})` : `rgba(${ch(m[1])}, ${ch(m[2])}, ${ch(m[3])}, ${a})`;
}

/** Calls `cb` when VS Code switches theme (it swaps classes on <body>). */
export function onThemeChange(cb: () => void): void {
  new MutationObserver(() => cb()).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
}
