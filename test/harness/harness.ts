// Browser harness: runs the real webview against the real engine (sql.js in the page),
// replacing the VS Code extension host with an in-page mock. Used for visual QA.
import initSqlJs from 'sql.js';
import { createDispatcher, type Dispatch } from '../../src/engine/dispatch';
import type { HistoryEntry, HostEvent, MutationResult, RequestMessage } from '../../src/shared/protocol';
import { WORKER_METHODS } from '../../src/shared/protocol';
import { musicSql } from '../fixtures/musicDb';

const params = new URLSearchParams(location.search);
if (params.get('theme') === 'light') document.body.className = 'vscode-light';

const log: string[] = [];
(window as any).__harness = { log, undo: () => undo(), redo: () => redo(), ready: false };

let dispatch: Dispatch;
const undoStack: number[] = [];
const redoStack: number[] = [];
let history: HistoryEntry[] = [];
let clipboard = '';
let state: unknown = undefined;

function emit(ev: HostEvent) {
  window.postMessage(ev, '*');
}

async function undo() {
  const id = undoStack.pop();
  if (id === undefined) return;
  const r = dispatch('undo', { id });
  redoStack.push(id);
  emit({ type: 'changed', schema: r.schemaChanged });
}

async function redo() {
  const id = redoStack.pop();
  if (id === undefined) return;
  const r = dispatch('redo', { id });
  undoStack.push(id);
  emit({ type: 'changed', schema: r.schemaChanged });
}

const ready = (async () => {
  const SQL = await initSqlJs({ locateFile: (f: string) => f });
  const make = (sql: string) => {
    const db = new SQL.Database();
    db.exec(sql);
    const bytes = db.export();
    db.close();
    return bytes;
  };
  const tracks = Number(params.get('tracks') ?? 1200);
  const bytes = make(musicSql(tracks));
  dispatch = createDispatcher(SQL);
  const engine = dispatch('open', { bytes, options: { readOnly: params.get('ro') === '1', undoBudgetBytes: 256 << 20, maxResultRows: 100000 } });
  // The "other" database for Compare: a modified copy.
  const otherDispatch = createDispatcher(SQL);
  otherDispatch('open', { bytes: bytes.slice(), options: { readOnly: false, undoBudgetBytes: 1 << 20, maxResultRows: 10 } });
  otherDispatch('exec', {
    sql: `DELETE FROM customers WHERE id > 57; INSERT INTO genres VALUES (9, 'Highlife');
      UPDATE tracks SET unit_price = 1.49 WHERE id IN (97, 194, 291, 388, 485, 582, 679, 776, 873, 970, 1067, 1164);
      ALTER TABLE artists ADD COLUMN website TEXT;`,
  });
  const other = otherDispatch('serialize', undefined);
  (window as any).__harness.ready = true;
  return { engine, size: bytes.length, other };
})();

async function handle(method: string, p: any): Promise<unknown> {
  const { engine, size, other } = await ready;
  switch (method) {
    case 'init':
      return {
        info: { fileName: 'music.sqlite', uri: 'file:///music.sqlite', size, ...engine, readOnly: params.get('ro') === '1' },
        schema: dispatch('schema', undefined),
        settings: { maxResultRows: 100000 },
      };
    case 'compareWith':
      return dispatch('compare', { bytes: other.slice(), leftName: 'music.sqlite', rightName: 'music-backup.sqlite' });
    case 'export':
      log.push(`export ${JSON.stringify(p)} → ${dispatch('exportData', p).join('').length} chars`);
      return true;
    case 'exportDump':
      log.push(`dump → ${dispatch('dump', undefined).join('').length} chars`);
      return true;
    case 'copyTypes':
      log.push(dispatch('typescript', { dbName: 'music.sqlite' }));
      return;
    case 'saveSvg':
      log.push(`svg ${p.svg.length} chars`);
      (window as any).__harness.svg = p.svg;
      return true;
    case 'copyText':
      clipboard = p.text;
      log.push(`copy ${JSON.stringify(p.text.slice(0, 200))}`);
      return;
    case 'readClipboard':
      return clipboard;
    case 'confirm':
      log.push(`confirm ${p.message}`);
      return true;
    case 'notify':
      log.push(`notify[${p.level}] ${p.message}`);
      return;
    case 'historyList':
      return history;
    case 'historyAdd':
      history = [{ sql: p.sql, db: 'music.sqlite', ts: Date.now() }, ...history.filter((h) => h.sql !== p.sql)];
      return history;
    case 'historyClear':
      history = [];
      return history;
    case 'reopenAsText':
    case 'newDatabase':
      return;
  }
  if (!(WORKER_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown request ${method}`);
  const result = dispatch(method as never, p as never) as unknown;
  if (['updateCells', 'insertRow', 'deleteRows', 'exec', 'runDdl'].includes(method)) {
    const m = result as MutationResult;
    if (m.edit) {
      undoStack.push(m.edit.id);
      redoStack.length = 0;
      log.push(`edit ${m.edit.label}`);
    }
    if (m.edit || m.schemaChanged) setTimeout(() => emit({ type: 'changed', schema: m.schemaChanged }), 0);
  }
  return result;
}

(window as any).acquireVsCodeApi = () => ({
  postMessage(msg: RequestMessage) {
    handle(msg.method, msg.params).then(
      (result) => window.postMessage({ type: 'response', id: msg.id, result }, '*'),
      (err) => window.postMessage({ type: 'response', id: msg.id, error: err instanceof Error ? err.message : String(err) }, '*'),
    );
  },
  getState: () => state,
  setState: (s: unknown) => {
    state = s;
  },
});

// VS Code routes Cmd/Ctrl+Z to the custom editor when focus is outside text inputs.
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    void (e.shiftKey ? redo() : undo());
  }
});
