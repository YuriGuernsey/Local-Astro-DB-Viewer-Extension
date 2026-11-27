// Request/response channel to the extension host, plus host events and persisted UI state.
import type { HostEvent, HostMessage, WebviewApi, WebviewMethod } from '../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const listeners = new Set<(ev: HostEvent) => void>();
let nextId = 1;

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'response') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    return;
  }
  for (const l of listeners) l(msg);
});

export function request<M extends WebviewMethod>(method: M, params: WebviewApi[M]['params']): Promise<WebviewApi[M]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ type: 'request', id, method, params });
  });
}

export function onHostEvent(fn: (ev: HostEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Shows an error from a failed request in a VS Code notification. */
export function reportError(err: unknown, prefix = ''): void {
  const message = err instanceof Error ? err.message : String(err);
  void request('notify', { message: prefix ? `${prefix}: ${message}` : message, level: 'error' });
}

export interface PersistedState {
  tab?: string;
  table?: string;
  sql?: string;
  widths?: Record<string, Record<string, number>>;
  sqlEditorHeight?: number;
  showHistory?: boolean;
}

export function loadState(): PersistedState {
  return (vscode.getState() as PersistedState | undefined) ?? {};
}

export function saveState(patch: Partial<PersistedState>): void {
  vscode.setState({ ...loadState(), ...patch });
}
