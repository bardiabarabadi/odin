import * as vscode from 'vscode';
import { findAdapter } from '../adapters';
import { log } from './log';

export const IS_BLOCK_DESIGN_KEY = 'odin.isBlockDesign';
const DEBOUNCE_MS = 300;

/** Cheap content sniff: does this document look like a supported block design? */
export function isBlockDesignDocument(doc: vscode.TextDocument): boolean {
  try {
    return findAdapter(doc.getText(), doc.fileName) !== undefined;
  } catch (err) {
    log.error(`Detection failed for ${doc.uri.toString()}`, err);
    return false;
  }
}

/**
 * Maintains the `odin.isBlockDesign` context key for the active text editor.
 * Runs the adapter sniff only (never a full parse).
 */
export class BlockDesignDetector implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: boolean | undefined;

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.schedule();
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc === vscode.window.activeTextEditor?.document) this.schedule();
      }),
    );
    this.update();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.update();
    }, DEBOUNCE_MS);
  }

  private update(): void {
    const editor = vscode.window.activeTextEditor;
    // Keep the previous value while a non-text editor (e.g. our own panel) is
    // focused, so editor/title items do not flicker.
    if (!editor) return;
    const value = isBlockDesignDocument(editor.document);
    if (value === this.current) return;
    this.current = value;
    void vscode.commands.executeCommand('setContext', IS_BLOCK_DESIGN_KEY, value);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
