import * as vscode from 'vscode';
import { pickAndLoadBase } from './compare';
import { isBlockDesignDocument } from './detect';
import { errorMessage, log } from './log';
import { DesignPanel } from './panel';

/**
 * Resolve the source document a command should act on:
 * explicit URI argument (menus) > focused Odin panel > active text editor.
 */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const active = DesignPanel.active();
  if (active) return active.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

/** Existing panel for the target, or undefined with a message to the user. */
function existingPanel(arg: unknown): DesignPanel | undefined {
  const uri = targetUri(arg);
  const panel = uri ? DesignPanel.get(uri) : DesignPanel.active();
  if (!panel) void vscode.window.showInformationMessage('Odin: no block design diagram is open for this file.');
  return panel;
}

async function openPanel(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<DesignPanel | undefined> {
  const existing = DesignPanel.get(uri);
  if (existing) {
    DesignPanel.show(context, uri);
    return existing;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  if (!isBlockDesignDocument(doc)) {
    void vscode.window.showWarningMessage(
      `Odin: ${vscode.workspace.asRelativePath(uri)} does not look like a supported block design (e.g. a Vivado write_bd_tcl export).`,
    );
    return undefined;
  }
  return DesignPanel.show(context, uri);
}

function guard<A extends unknown[]>(name: string, fn: (...args: A) => Promise<void> | void) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      log.error(`Command ${name} failed`, err);
      void vscode.window.showErrorMessage(`Odin: ${errorMessage(err)}`);
    }
  };
}

export function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, guard(id, fn)));
  };

  reg('odin.visualize', async (arg) => {
    // From the palette while a diagram is focused, `targetUri` resolves to that
    // diagram's source, so the command just reveals it.
    const uri = targetUri(arg);
    if (!uri) {
      void vscode.window.showInformationMessage('Odin: open a block design .tcl file first.');
      return;
    }
    await openPanel(context, uri);
  });

  /** `odin.compare [uri] [ref]`: a ref argument skips the picker (for scripting). */
  reg('odin.compare', async (arg, ref) => {
    const uri = targetUri(arg);
    if (!uri) {
      void vscode.window.showInformationMessage('Odin: open a block design .tcl file first.');
      return;
    }
    const panel = DesignPanel.get(uri) ?? (await openPanel(context, uri));
    if (!panel) return;
    const base = await pickAndLoadBase(uri, typeof ref === 'string' && ref.trim() ? ref.trim() : undefined);
    if (!base) return;
    log.info(`Comparing ${uri.toString()} against ${base.label}`);
    panel.setBase(base);
  });

  reg('odin.clearCompare', (arg) => existingPanel(arg)?.clearBase());
  reg('odin.exportSvg', (arg) => existingPanel(arg)?.requestExportSvg());
  reg('odin.refresh', async (arg) => {
    await existingPanel(arg)?.refresh();
  });
  reg('odin.openSource', async (arg) => {
    await existingPanel(arg)?.openSource();
  });
  reg('odin.showLog', () => log.show());
}
