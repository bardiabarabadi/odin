/**
 * Shared webview state types and small helpers. No DOM access here so the
 * module can be imported from pure code (graph building, tests).
 */
import type { ViewState } from '../../src/shared/protocol';

export type SelectionKind = 'cell' | 'pin' | 'port' | 'net';

/**
 * What is currently selected. `path` is the model path of the object, except
 * for nets where it is the net key (`scope + '::' + name`, see `netKey`).
 */
export interface Selection {
  kind: SelectionKind;
  path: string;
}

/** A place in the design the UI can navigate to: a scope plus an object in it. */
export interface NavTarget {
  scope: string;
  select?: Selection;
}

export const DEFAULT_VIEW_STATE: ViewState = {
  scope: '',
  hideClockResetNets: false,
  hideUnconnectedPins: false,
  showDiffOnly: false,
};

/** Merge a partial (possibly untrusted) view state onto a complete one. */
export function mergeViewState(base: ViewState, patch: Partial<ViewState> | undefined | null): ViewState {
  const out: ViewState = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.scope === 'string') out.scope = patch.scope;
  if (typeof patch.hideClockResetNets === 'boolean') out.hideClockResetNets = patch.hideClockResetNets;
  if (typeof patch.hideUnconnectedPins === 'boolean') out.hideUnconnectedPins = patch.hideUnconnectedPins;
  if (typeof patch.showDiffOnly === 'boolean') out.showDiffOnly = patch.showDiffOnly;
  return out;
}

/** Key used for nets everywhere in the webview (same as `DiffIndex.nets`). */
export function netKey(scope: string, name: string): string {
  return `${scope}::${name}`;
}

export function splitNetKey(key: string): { scope: string; name: string } {
  const i = key.indexOf('::');
  return i < 0 ? { scope: '', name: key } : { scope: key.slice(0, i), name: key.slice(i + 2) };
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
}

/** `xilinx.com:ip:axi_gpio:2.0` -> `axi_gpio v2.0`. Unknown shapes are returned as-is. */
export function shortVlnv(vlnv: string | undefined): string | undefined {
  if (!vlnv) return undefined;
  const parts = vlnv.split(':');
  if (parts.length === 4) return `${parts[2]} v${parts[3]}`;
  return vlnv;
}

export function widthLabel(from: number | undefined, to: number | undefined): string | undefined {
  if (from === undefined && to === undefined) return undefined;
  return `[${from ?? to}:${to ?? from}]`;
}
