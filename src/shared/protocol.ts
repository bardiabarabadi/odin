/**
 * Message protocol between the extension host and the diagram webview.
 * Both sides import this file; keep it free of Node and DOM APIs.
 */
import type { Design } from '../model/types';
import type { DesignDiff } from '../diff/types';
import type { SourceLocation } from '../model/types';

/** Persisted per-panel UI state (restored on reload / VS Code restart). */
export interface ViewState {
  /** Hierarchy scope currently displayed (`""` = root). */
  scope: string;
  hideClockResetNets: boolean;
  hideUnconnectedPins: boolean;
  showDiffOnly?: boolean;
}

export interface DesignPayload {
  design: Design;
  /** Label shown in the toolbar, e.g. `top.tcl`. */
  label: string;
  /** Millisecond timestamp of the parse, for "stale" indicators. */
  parsedAt: number;
}

export interface DiffPayload {
  base: Design;
  diff: DesignDiff;
  baseLabel: string;
}

/** Extension host -> webview. */
export type HostToWebviewMessage =
  | { type: 'design'; payload: DesignPayload }
  | { type: 'diff'; payload: DiffPayload }
  | { type: 'clearDiff' }
  | { type: 'restoreState'; state: Partial<ViewState> }
  | { type: 'requestExportSvg' }
  | { type: 'focus'; path: string }
  | { type: 'parseError'; message: string };

/** Webview -> extension host. */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'revealSource'; loc: SourceLocation }
  | { type: 'exportSvg'; svg: string; suggestedName: string }
  | { type: 'requestCompare' }
  | { type: 'stateChanged'; state: ViewState }
  | { type: 'notify'; level: 'info' | 'warning' | 'error'; message: string };
