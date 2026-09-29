import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { REVISION_SCHEME, RevisionContentProvider } from './compare';
import { BlockDesignEditorProvider } from './customEditor';
import { BlockDesignDetector } from './detect';
import { log } from './log';
import { DesignPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  log.init(context);
  log.info(`Activating Odin ${String(context.extension.packageJSON.version ?? '')}`);
  context.subscriptions.push(
    new BlockDesignDetector(),
    vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, new RevisionContentProvider()),
    BlockDesignEditorProvider.register(context),
    { dispose: () => DesignPanel.disposeAll() },
  );
  registerCommands(context);
}

export function deactivate(): void {
  DesignPanel.disposeAll();
}
