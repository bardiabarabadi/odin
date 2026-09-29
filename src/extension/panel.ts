/**
 * One `DesignPanel` per source document. The same controller drives both the
 * panel opened by `odin.visualize` and the "Open With…" custom editor; only
 * the way the `WebviewPanel` is obtained differs.
 */
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { findAdapter } from '../adapters';
import { diffDesigns } from '../diff';
import type { Design, SourceLocation } from '../model/types';
import type { HostToWebviewMessage, ViewState, WebviewToHostMessage } from '../shared/protocol';
import type { BaseRevision } from './compare';
import { errorMessage, log } from './log';

/** viewType of the custom editor (Open With… > Odin Block Design). */
export const CUSTOM_EDITOR_VIEW_TYPE = 'odin.blockDesign';
/** viewType of the panel opened by the `odin.visualize` command. */
export const PANEL_VIEW_TYPE = 'odin.blockDesignPanel';

const PANEL_FOCUSED_KEY = 'odin.panelFocused';
const HAS_COMPARISON_KEY = 'odin.hasComparison';
const STATE_KEY_PREFIX = 'odin.viewState:';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('odin');
}

function nonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

function isWebviewMessage(msg: unknown): msg is WebviewToHostMessage {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}

export class DesignPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, DesignPanel>();
  private static activePanel: DesignPanel | undefined;

  /** Panel for a source document, if one is open. */
  static get(uri: vscode.Uri): DesignPanel | undefined {
    return DesignPanel.panels.get(uri.toString());
  }

  /** The panel that currently has focus, if any. */
  static active(): DesignPanel | undefined {
    return DesignPanel.activePanel;
  }

  static disposeAll(): void {
    for (const p of [...DesignPanel.panels.values()]) p.dispose();
  }

  /** Reveal the existing panel for `uri` or open a new one beside the editor. */
  static show(context: vscode.ExtensionContext, uri: vscode.Uri): DesignPanel {
    const existing = DesignPanel.get(uri);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return existing;
    }
    const editor = vscode.window.activeTextEditor;
    const sourceColumn = editor && editor.document.uri.toString() === uri.toString() ? editor.viewColumn : undefined;
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      `Odin: ${path.posix.basename(uri.path)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distRoot] },
    );
    const icon = vscode.Uri.joinPath(context.extensionUri, 'media', 'odin.svg');
    panel.iconPath = { light: icon, dark: icon };
    return new DesignPanel(context, uri, panel, sourceColumn, false);
  }

  /** Adopt a webview panel handed to us by the custom editor provider. */
  static attach(context: vscode.ExtensionContext, uri: vscode.Uri, panel: vscode.WebviewPanel): DesignPanel {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    };
    return new DesignPanel(context, uri, panel, undefined, true);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private design: Design | undefined;
  private base: BaseRevision | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private sourceColumn: vscode.ViewColumn | undefined,
    readonly isCustomEditor: boolean,
  ) {
    const key = uri.toString();
    DesignPanel.panels.get(key)?.dispose();
    DesignPanel.panels.set(key, this);

    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg: unknown) => {
        if (isWebviewMessage(msg)) void this.onMessage(msg);
      }),
      panel.onDidChangeViewState((e) => this.onViewState(e.webviewPanel.active)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.toString() === key && config().get<boolean>('autoRefreshOnSave', true)) void this.refresh();
      }),
    );
    this.onViewState(panel.active);
    log.info(`Opened ${isCustomEditor ? 'custom editor' : 'panel'} for ${key}`);
  }

  get hasComparison(): boolean {
    return this.base !== undefined;
  }

  get label(): string {
    return path.posix.basename(this.uri.path);
  }

  // ---------------------------------------------------------------- public API

  /** Re-read and re-parse the source document, then re-send design (+ diff). */
  async refresh(): Promise<void> {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(this.uri);
    } catch (err) {
      this.post({ type: 'parseError', message: `Cannot open ${this.label}: ${errorMessage(err)}` });
      return;
    }
    const started = Date.now();
    try {
      const text = doc.getText();
      const adapter = findAdapter(text, doc.fileName);
      if (!adapter) {
        this.design = undefined;
        this.post({ type: 'parseError', message: `${this.label} is not a recognized block design.` });
        return;
      }
      const design = adapter.parse(text, doc.fileName);
      const diagnostics = design.diagnostics ?? [];
      const errors = diagnostics.filter((d) => d.severity === 'error');
      log.info(
        `Parsed ${this.label} (${adapter.displayName}) in ${Date.now() - started} ms: ` +
          `${design.cells.length} cells, ${design.nets.length} nets, ${diagnostics.length} diagnostics`,
      );
      // Parsers never throw; a design with nothing in it plus an error means
      // the parse failed. Anything else is shown, with diagnostics in the UI.
      if (design.cells.length === 0 && errors.length > 0) {
        this.design = undefined;
        const first = errors[0];
        const where = first.loc ? `${path.posix.basename(first.loc.file.replace(/\\/g, '/'))}:${first.loc.line}: ` : '';
        this.post({ type: 'parseError', message: `${where}${first.message}` });
        return;
      }
      this.design = design;
    } catch (err) {
      log.error(`Parsing ${this.label} failed`, err);
      this.design = undefined;
      this.post({ type: 'parseError', message: `Failed to parse ${this.label}: ${errorMessage(err)}` });
      return;
    }
    this.sendDesign();
    this.sendDiff();
  }

  setBase(base: BaseRevision): void {
    this.base = base;
    this.updateContextKeys();
    if (this.sendDiff()) this.panel.reveal(undefined, true);
  }

  clearBase(): void {
    this.base = undefined;
    this.updateContextKeys();
    this.post({ type: 'clearDiff' });
  }

  requestExportSvg(): void {
    if (!this.ready) {
      void vscode.window.showWarningMessage('Odin: the diagram is still loading.');
      return;
    }
    this.post({ type: 'requestExportSvg' });
  }

  focus(objectPath: string): void {
    this.post({ type: 'focus', path: objectPath });
  }

  async openSource(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.uri);
    await vscode.window.showTextDocument(doc, { viewColumn: this.editorColumn(this.uri) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const key = this.uri.toString();
    if (DesignPanel.panels.get(key) === this) DesignPanel.panels.delete(key);
    if (DesignPanel.activePanel === this) {
      DesignPanel.activePanel = undefined;
      this.updateContextKeys();
    }
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  // ---------------------------------------------------------------- internals

  private post(msg: HostToWebviewMessage): void {
    // Messages sent before `ready` would be lost; `ready` triggers a full resend.
    if (!this.ready || this.disposed) return;
    void this.panel.webview.postMessage(msg);
  }

  private sendDesign(): void {
    if (!this.design) return;
    this.post({ type: 'design', payload: { design: this.design, label: this.label, parsedAt: Date.now() } });
  }

  /** Returns false when the diff could not be computed. */
  private sendDiff(): boolean {
    if (!this.base || !this.design) return true;
    try {
      const diff = diffDesigns(this.base.design, this.design, {
        baseLabel: this.base.label,
        headLabel: `${this.label} (working copy)`,
      });
      this.post({ type: 'diff', payload: { base: this.base.design, diff, baseLabel: this.base.label } });
      return true;
    } catch (err) {
      log.error('Computing the diff failed', err);
      this.base = undefined;
      this.updateContextKeys();
      this.post({ type: 'clearDiff' });
      void vscode.window.showErrorMessage(`Odin: comparison failed: ${errorMessage(err)}`);
      return false;
    }
  }

  private onViewState(active: boolean): void {
    if (active) {
      DesignPanel.activePanel = this;
    } else if (DesignPanel.activePanel === this) {
      DesignPanel.activePanel = undefined;
    }
    this.updateContextKeys();
  }

  private updateContextKeys(): void {
    const active = DesignPanel.activePanel;
    void vscode.commands.executeCommand('setContext', PANEL_FOCUSED_KEY, active !== undefined);
    void vscode.commands.executeCommand('setContext', HAS_COMPARISON_KEY, active?.hasComparison ?? false);
  }

  private get stateKey(): string {
    return STATE_KEY_PREFIX + this.uri.toString();
  }

  private initialState(): Partial<ViewState> {
    const defaults: ViewState = {
      scope: '',
      hideClockResetNets: config().get<boolean>('hideClockResetNetsByDefault', false),
      hideUnconnectedPins: config().get<boolean>('hideUnconnectedPinsByDefault', false),
    };
    const stored = this.context.workspaceState.get<Partial<ViewState>>(this.stateKey) ?? {};
    return { ...defaults, ...stored };
  }

  private async onMessage(msg: WebviewToHostMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'restoreState', state: this.initialState() });
          await this.refresh();
          break;
        case 'revealSource':
          await this.revealSource(msg.loc);
          break;
        case 'exportSvg':
          await this.saveSvg(msg.svg, msg.suggestedName);
          break;
        case 'requestCompare':
          await vscode.commands.executeCommand('odin.compare', this.uri);
          break;
        case 'stateChanged':
          await this.context.workspaceState.update(this.stateKey, msg.state);
          break;
        case 'notify': {
          const text = `Odin: ${msg.message}`;
          if (msg.level === 'error') void vscode.window.showErrorMessage(text);
          else if (msg.level === 'warning') void vscode.window.showWarningMessage(text);
          else void vscode.window.showInformationMessage(text);
          break;
        }
        default: {
          const unknown: never = msg;
          log.warn(`Unknown webview message: ${JSON.stringify(unknown)}`);
        }
      }
    } catch (err) {
      log.error(`Handling webview message "${msg.type}" failed`, err);
      void vscode.window.showErrorMessage(`Odin: ${errorMessage(err)}`);
    }
  }

  /** Map a `SourceLocation.file` string back to a URI. */
  private resolveLocFile(file: string | undefined): vscode.Uri {
    if (!file) return this.uri;
    if (file === this.uri.toString() || (this.uri.scheme === 'file' && file === this.uri.fsPath)) return this.uri;
    // A URI string (`file://…`, `odin-git:…`); a Windows drive path like `C:\x`
    // has a single-letter "scheme" and is excluded by the length requirement.
    if (/^[a-z][a-z0-9+.-]+:/i.test(file)) {
      try {
        return vscode.Uri.parse(file, true);
      } catch {
        // fall through and treat as a path
      }
    }
    if (path.isAbsolute(file)) return vscode.Uri.file(file);
    if (this.uri.scheme === 'file') return vscode.Uri.file(path.resolve(path.dirname(this.uri.fsPath), file));
    return this.uri;
  }

  /** Column of a visible editor showing `uri`, else the originating column, else beside. */
  private editorColumn(uri: vscode.Uri): vscode.ViewColumn {
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (visible?.viewColumn) return visible.viewColumn;
    if (this.sourceColumn && this.sourceColumn !== this.panel.viewColumn) return this.sourceColumn;
    return vscode.ViewColumn.Beside;
  }

  private async revealSource(loc: SourceLocation): Promise<void> {
    const target = this.resolveLocFile(loc.file);
    const doc = await vscode.workspace.openTextDocument(target);
    const last = Math.max(0, doc.lineCount - 1);
    const startLine = Math.min(Math.max(0, loc.line - 1), last);
    const endLine = Math.min(Math.max(startLine, (loc.endLine ?? loc.line) - 1), last);
    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    const column = this.editorColumn(target);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: column,
      selection: range,
      preserveFocus: false,
    });
    if (target.toString() === this.uri.toString() && editor.viewColumn) this.sourceColumn = editor.viewColumn;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private async saveSvg(svg: string, suggestedName: string | undefined): Promise<void> {
    const rawName = (suggestedName && path.basename(suggestedName)) || `${this.design?.name ?? 'design'}.svg`;
    const name = rawName.toLowerCase().endsWith('.svg') ? rawName : `${rawName}.svg`;
    let dir: vscode.Uri | undefined;
    if (this.uri.scheme === 'file') dir = vscode.Uri.file(path.dirname(this.uri.fsPath));
    else dir = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: dir ? vscode.Uri.joinPath(dir, name) : undefined,
      filters: { 'SVG image': ['svg'] },
      saveLabel: 'Export SVG',
      title: 'Odin: export diagram as SVG',
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(svg, 'utf8'));
    log.info(`Exported SVG to ${target.toString()}`);
    const choice = await vscode.window.showInformationMessage(
      `Odin: diagram exported to ${path.posix.basename(target.path)}.`,
      'Open',
    );
    if (choice === 'Open') await vscode.commands.executeCommand('vscode.open', target);
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const n = nonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>Odin</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
