// Types shared by the SQLite worker, the extension host and the webview.
// Everything here must be JSON-serializable: it crosses the webview boundary.

/** A cell value as shown in the UI. */
export type CellValue =
  | null
  | number
  | string
  /** Integer outside the JavaScript safe range, as decimal digits. */
  | { $i: string }
  /** Non-finite REAL ("Infinity" / "-Infinity"). */
  | { $f: string }
  /** BLOB: hex of the first bytes (all of them in "full" mode when small enough) and the total size. */
  | { $b: string; n: number }
  /** TEXT truncated for display: the prefix and the total length. */
  | { $t: string; n: number };

/** A value sent by the UI to be written to the database. */
export type InputValue = null | number | string | { $i: string } | { $b: string };

export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC';
export type ObjectType = 'table' | 'view' | 'virtual' | 'shadow';

export interface ColumnInfo {
  cid: number;
  name: string;
  /** Declared type as written in the schema (may be empty). */
  type: string;
  affinity: Affinity;
  notNull: boolean;
  /** Default value as SQL text, or null. */
  defaultValue: string | null;
  /** 1-based position in the primary key, 0 when not part of it. */
  pk: number;
  /** Generated (VIRTUAL or STORED) column: read-only. */
  generated: boolean;
  /** INTEGER PRIMARY KEY column of a rowid table (an alias for the rowid). */
  isRowidAlias: boolean;
}

export interface ForeignKeyInfo {
  id: number;
  table: string;
  from: string[];
  /** Referenced columns; empty when the parent's primary key is implied. */
  to: string[];
  onUpdate: string;
  onDelete: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  /** c = CREATE INDEX, u = UNIQUE constraint, pk = PRIMARY KEY constraint. */
  origin: 'c' | 'u' | 'pk';
  partial: boolean;
  columns: string[];
  sql: string | null;
}

export interface TriggerInfo {
  name: string;
  sql: string;
}

export interface TableInfo {
  name: string;
  type: ObjectType;
  sql: string | null;
  columns: ColumnInfo[];
  withoutRowid: boolean;
  strict: boolean;
  /** Name that selects the rowid (rowid, _rowid_ or oid), null when there is none. */
  rowidName: string | null;
  /** Primary key columns in key order. */
  pk: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
  /** Views, virtual tables and tables without a usable key can't be edited. */
  readOnly: boolean;
  readOnlyReason?: string;
  /** Error raised while reading the definition (e.g. unknown virtual table module). */
  error?: string;
}

export interface SchemaInfo {
  /** Tables (including virtual/shadow) and views, sorted by name. */
  tables: TableInfo[];
}

export interface DbInfo {
  fileName: string;
  uri: string;
  /** Size of the file on disk, in bytes. */
  size: number;
  sqliteVersion: string;
  pageSize: number;
  encoding: string;
  readOnly: boolean;
  readOnlyReason?: string;
  /** Set when the file is not a SQLite database (or could not be opened). */
  openError?: string;
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
  /** Column position, for result sets that repeat a column name. */
  index?: number;
}

export interface RowsQuery {
  table: string;
  /** Per-column filter expressions (see filters.ts for the syntax). */
  filters: Record<string, string>;
  /** Free-text search across every column. */
  search: string;
  sort: SortSpec | null;
}

/** A row in the data grid. `k` identifies the row (rowid or primary key values); null for views. */
export interface GridRow {
  k: CellValue[] | null;
  v: CellValue[];
}

export interface RowRange {
  /** First row index (inclusive). */
  from: number;
  /** Last row index (exclusive). */
  to: number;
}

export interface EditInfo {
  id: number;
  label: string;
}

export interface MutationResult {
  /** The undoable edit created by the operation, or null when nothing changed. */
  edit: EditInfo | null;
  schemaChanged: boolean;
}

export interface ResultSetInfo {
  id: number;
  sql: string;
  columns: string[];
  /** Rows kept (may be lower than the number produced when truncated). */
  total: number;
  truncated: boolean;
  /** Rows changed by INSERT/UPDATE/DELETE statements. */
  rowsModified: number;
  timeMs: number;
  /** First rows, so small results need no extra round-trip. */
  rows: CellValue[][];
}

export interface ExecError {
  message: string;
  /** Index of the failing statement in the batch. */
  statementIndex: number;
  sql: string;
}

export interface ExecResult extends MutationResult {
  results: ResultSetInfo[];
  error: ExecError | null;
  timeMs: number;
  /** Notes such as "an open transaction was committed". */
  notes: string[];
}

export type ExportFormat = 'csv' | 'json' | 'sql' | 'md';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'sql', label: 'SQL (CREATE + INSERT)', ext: 'sql' },
  { id: 'md', label: 'Markdown', ext: 'md' },
];

export type ExportSource =
  | { kind: 'table'; table: string; query?: RowsQuery }
  /** `sort` is the order shown in the grid (null for the query's own order). */
  | { kind: 'result'; resultId: number; sort?: SortSpec | null };

// ---------- Compare ----------

export interface CompareRowSet {
  count: number;
  columns: string[];
  rows: CellValue[][];
}

export interface CompareChangedRow {
  key: CellValue[];
  before: CellValue[];
  after: CellValue[];
  /** Per column: whether the stored values differ (previews may look identical). */
  changed: boolean[];
}

export interface TableDiff {
  name: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  schemaChanged: boolean;
  columns: { added: string[]; removed: string[]; retyped: { name: string; from: string; to: string }[] };
  indexes: { added: string[]; removed: string[] };
  rowCountLeft: number | null;
  rowCountRight: number | null;
  /** How rows are matched: by primary key, by rowid, or by whole-row equality. */
  keyKind: 'pk' | 'rowid' | 'row' | 'none';
  keyColumns: string[];
  added: CompareRowSet;
  removed: CompareRowSet;
  changed: { count: number; columns: string[]; rows: CompareChangedRow[] };
  error?: string;
}

export interface CompareResult {
  left: string;
  right: string;
  tables: TableDiff[];
  summary: { added: number; removed: number; changed: number; same: number };
  rowLimit: number;
}

// ---------- Webview <-> host messages ----------

export type Tab = 'data' | 'structure' | 'sql' | 'er' | 'compare';

export interface HistoryEntry {
  sql: string;
  db: string;
  ts: number;
}

export interface InitPayload {
  info: DbInfo;
  schema: SchemaInfo;
  settings: WebviewSettings;
}

export interface WebviewSettings {
  maxResultRows: number;
}

/** Requests sent by the webview. `result` is the response type. */
export interface WebviewApi {
  init: { params: void; result: InitPayload };
  schema: { params: void; result: SchemaInfo };
  counts: { params: void; result: Record<string, number | null> };
  count: { params: RowsQuery; result: number };
  rows: { params: RowsQuery & { offset: number; limit: number }; result: GridRow[] };
  rowsForRanges: { params: { query: RowsQuery; ranges: RowRange[]; full: boolean }; result: GridRow[] };
  getRow: { params: { table: string; key: CellValue[] }; result: CellValue[] | null };
  findRow: { params: { query: RowsQuery; key: CellValue[] }; result: number };
  updateCells: {
    params: { table: string; changes: { key: CellValue[]; column: string; value: InputValue }[] };
    result: MutationResult;
  };
  insertRow: { params: { table: string; values: Record<string, InputValue> }; result: MutationResult & { key: CellValue[] | null } };
  deleteRows: { params: { table: string; keys: CellValue[][] }; result: MutationResult };
  exec: { params: { sql: string }; result: ExecResult };
  /** `full`: complete values instead of grid previews (for the clipboard). */
  resultRows: { params: { resultId: number; offset: number; limit: number; sort: SortSpec | null; full?: boolean }; result: CellValue[][] };
  /** Schema change. `inverse` (when known) undoes it cheaply; otherwise a snapshot is used. */
  runDdl: { params: { statements: string[]; label: string; inverse?: string[] }; result: MutationResult };

  // Host-only requests (UI, files, clipboard).
  export: { params: { source: ExportSource; format: ExportFormat }; result: boolean };
  exportDump: { params: void; result: boolean };
  copyTypes: { params: void; result: void };
  compareWith: { params: void; result: CompareResult | null };
  saveSvg: { params: { svg: string; name: string }; result: boolean };
  copyText: { params: { text: string }; result: void };
  readClipboard: { params: void; result: string };
  confirm: { params: { message: string; detail?: string; confirm: string }; result: boolean };
  notify: { params: { message: string; level: 'info' | 'warning' | 'error' }; result: void };
  historyList: { params: void; result: HistoryEntry[] };
  historyAdd: { params: { sql: string }; result: HistoryEntry[] };
  historyClear: { params: void; result: HistoryEntry[] };
  reopenAsText: { params: void; result: void };
  newDatabase: { params: void; result: void };
}

export type WebviewMethod = keyof WebviewApi;

export interface RequestMessage {
  type: 'request';
  id: number;
  method: WebviewMethod;
  params: unknown;
}

export interface ResponseMessage {
  type: 'response';
  id: number;
  result?: unknown;
  error?: string;
}

/** Events pushed by the host. */
export type HostEvent =
  | { type: 'changed'; schema: boolean }
  | { type: 'reloaded' }
  | { type: 'navigate'; tab: Tab; table?: string; action?: 'compare' }
  | { type: 'readOnly'; readOnly: boolean; reason?: string };

export type HostMessage = ResponseMessage | HostEvent;

/** Methods executed by the SQLite worker on behalf of the webview. */
export const WORKER_METHODS = [
  'schema',
  'counts',
  'count',
  'rows',
  'rowsForRanges',
  'getRow',
  'findRow',
  'updateCells',
  'insertRow',
  'deleteRows',
  'exec',
  'resultRows',
  'runDdl',
] as const satisfies readonly WebviewMethod[];
