/**
 * Bridge to the extension host. Inside VS Code the page gets
 * `acquireVsCodeApi()`; in the standalone dev harness (or a plain browser) it
 * may be missing, in which case we fall back to a console/localStorage shim so
 * the UI still works.
 */
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/shared/protocol';

export interface HostApi {
  postMessage(msg: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
  /** True when running inside a VS Code webview (or a harness faking one). */
  readonly connected: boolean;
}

interface RawVsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => RawVsCodeApi;
  }
}

const STORAGE_KEY = 'odin.webview.state';

function standaloneApi(): HostApi {
  return {
    connected: false,
    postMessage(msg) {
      console.info('[odin] -> host (standalone)', msg);
      if (msg.type === 'exportSvg') downloadText(msg.suggestedName, msg.svg, 'image/svg+xml');
    },
    getState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        return undefined;
      }
    },
    setState(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* storage unavailable: ignore */
      }
    },
  };
}

export function downloadText(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let cached: HostApi | undefined;

/** `acquireVsCodeApi` may only be called once per page, so cache the result. */
export function getHostApi(): HostApi {
  if (cached) return cached;
  if (typeof window.acquireVsCodeApi === 'function') {
    const raw = window.acquireVsCodeApi();
    cached = {
      connected: true,
      postMessage: (msg) => raw.postMessage(msg),
      getState: () => raw.getState(),
      setState: (s) => raw.setState(s),
    };
  } else {
    cached = standaloneApi();
  }
  return cached;
}

/** Subscribe to host messages. Returns an unsubscribe function. */
export function onHostMessage(handler: (msg: HostToWebviewMessage) => void): () => void {
  const listener = (ev: MessageEvent): void => {
    const data: unknown = ev.data;
    if (data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string') {
      handler(data as HostToWebviewMessage);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
