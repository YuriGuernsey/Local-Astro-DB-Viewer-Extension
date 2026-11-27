// Method table of the SQLite engine. The Node worker and the browser harness both
// route their messages through it.
import type { CompareResult, ExportFormat, ExportSource, WebviewApi } from '../shared/protocol';
import { WORKER_METHODS } from '../shared/protocol';
import type { SqlJsStatic } from './db';
import { DbSession, type SessionOptions, type UndoOutcome } from './session';

type WorkerWebviewApi = Pick<WebviewApi, (typeof WORKER_METHODS)[number]>;

export interface EngineInfo {
  sqliteVersion: string;
  pageSize: number;
  encoding: string;
}

/** Requests understood by the engine: the webview's data methods plus host-only operations. */
export interface EngineApi extends WorkerWebviewApi {
  open: { params: { bytes: Uint8Array; options: SessionOptions }; result: EngineInfo };
  load: { params: { bytes: Uint8Array; invalidateEdits: boolean }; result: void };
  serialize: { params: void; result: Uint8Array };
  info: { params: void; result: EngineInfo };
  undo: { params: { id: number }; result: UndoOutcome };
  redo: { params: { id: number }; result: UndoOutcome };
  setReadOnly: { params: { readOnly: boolean }; result: void };
  setLimits: { params: { undoBudgetBytes: number; maxResultRows: number }; result: void };
  compare: { params: { bytes: Uint8Array; leftName: string; rightName: string }; result: CompareResult };
  exportData: { params: { source: ExportSource; format: ExportFormat }; result: string[] };
  dump: { params: void; result: string[] };
  typescript: { params: { dbName: string }; result: string };
  close: { params: void; result: void };
}

export type EngineMethod = keyof EngineApi;
export type Dispatch = <M extends EngineMethod>(method: M, params: EngineApi[M]['params']) => EngineApi[M]['result'];

export function createDispatcher(SQL: SqlJsStatic): Dispatch {
  let session: DbSession | null = null;
  const s = () => {
    if (!session) throw new Error('No database is open.');
    return session;
  };
  const handlers: { [M in EngineMethod]: (p: EngineApi[M]['params']) => EngineApi[M]['result'] } = {
    open: (p) => {
      session?.close();
      session = null;
      session = new DbSession(SQL, p.bytes, p.options);
      return session.info();
    },
    load: (p) => s().load(p.bytes, p.invalidateEdits),
    serialize: () => s().serialize(),
    info: () => s().info(),
    undo: (p) => s().undo(p.id),
    redo: (p) => s().redo(p.id),
    setReadOnly: (p) => s().setReadOnly(p.readOnly),
    setLimits: (p) => s().setLimits(p.undoBudgetBytes, p.maxResultRows),
    compare: (p) => s().compare(p.bytes, p.leftName, p.rightName),
    exportData: (p) => s().exportData(p.source, p.format),
    dump: () => s().dump(),
    typescript: (p) => s().typescript(p.dbName),
    close: () => {
      session?.close();
      session = null;
    },
    schema: () => s().schema(),
    counts: () => s().counts(),
    count: (p) => s().count(p),
    rows: (p) => s().rows(p),
    rowsForRanges: (p) => s().rowsForRanges(p.query, p.ranges, p.full),
    getRow: (p) => s().getRow(p.table, p.key),
    findRow: (p) => s().findRow(p.query, p.key),
    updateCells: (p) => s().updateCells(p.table, p.changes),
    insertRow: (p) => s().insertRow(p.table, p.values),
    deleteRows: (p) => s().deleteRows(p.table, p.keys),
    exec: (p) => s().exec(p.sql),
    resultRows: (p) => s().resultRows(p.resultId, p.offset, p.limit, p.sort, p.full),
    runDdl: (p) => s().runDdl(p.statements, p.label, p.inverse),
  };
  return ((method: EngineMethod, params: unknown) => {
    const h = handlers[method] as ((p: unknown) => unknown) | undefined;
    if (!h) throw new Error(`Unknown method: ${String(method)}`);
    return h(params);
  }) as Dispatch;
}
