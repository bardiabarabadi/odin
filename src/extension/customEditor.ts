import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE, DesignPanel } from './panel';

/** "Open With… > Odin Block Design": reuses the `DesignPanel` controller. */
export class BlockDesignEditorProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(CUSTOM_EDITOR_VIEW_TYPE, new BlockDesignEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
    DesignPanel.attach(this.context, document.uri, webviewPanel);
  }
}
