import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function write(level: string, message: string): void {
  channel?.appendLine(`${stamp()} [${level}] ${message}`);
}

/** Minimal logger backed by the "Odin" output channel. */
export const log = {
  init(context: vscode.ExtensionContext): void {
    if (!channel) {
      channel = vscode.window.createOutputChannel('Odin');
      context.subscriptions.push(channel);
    }
  },
  info(message: string): void {
    write('info', message);
  },
  warn(message: string): void {
    write('warn', message);
  },
  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.stack ?? err.message}` : err !== undefined ? `: ${String(err)}` : '';
    write('error', message + detail);
  },
  show(): void {
    channel?.show(true);
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
