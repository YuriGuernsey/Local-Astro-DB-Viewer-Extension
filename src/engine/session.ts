// A database open in memory, plus everything the editor does with it: paging rows,
// editing with undo/redo, running SQL, comparing and exporting.
// Environment-agnostic: runs in the Node worker and in the browser test harness.
import type {
  CellValue,
  ColumnInfo,
  CompareResult,
  EditInfo,
  ExecError,
  ExecResult,
  ExportFormat,
  ExportSource,
  GridRow,
  InputValue,
  MutationResult,
  ResultSetInfo,
  RowRange,
  RowsQuery,
  SchemaInfo,
  SortSpec,
  TableInfo,
} from '../shared/protocol';
import { isOpaqueWrite, isReadOnlyStatement, quoteIdent as q, splitStatements } from '../shared/sql';
import { compareDatabases } from './compare';
import { all, num, one, rowOf, scalar, transaction, type Database, type SqlJsStatic } from './db';
import { exportRows, dumpDatabase, type RowSource } from './exporters';
import { buildWhere, keyColumns, orderBy, type Where } from './filters';
import { findTable, readSchema, selectList } from './schema';
import { schemaToTypeScript } from './tsTypes';
import { compareRaw, decodeCell, decodeInput, encodeCell, placeholder, type RawValue } from './values';

export interface SessionOptions {
  readOnly: boolean;
  /** Memory budget for snapshot-based undo, in bytes. */
  undoBudgetBytes: number;
  /** Rows kept per SQL result set. */
  maxResultRows: number;
}

export interface UndoOutcome {
  ok: boolean;
  message?: string;
  schemaChanged: boolean;
}

interface EditRecord {
  label: string;
  schema: boolean;
  undoable: boolean;
  undo(): void;
  redo(): void;
  /** Snapshot memory held by the edit. */
  bytes(): number;
  /** Releases snapshots (the edit then can't be undone). */
  drop?(): void;
  expired: boolean;
  stale: boolean;
}

interface StoredResult {
  columns: string[];
  rows: RawValue[][];
  sort: SortSpec | null;
  order: number[] | null;
}

/** Rows sent along with a result set, so small results need no extra request. */
const FIRST_PAGE = 200;
/** Upper bound for copy/select-all operations. */
const MAX_RANGE_ROWS = 200_000;

export class DbSession {
  private db: Database;
  private schemaCache: SchemaInfo | null = null;
  private readonly edits = new Map<number, EditRecord>();
  private nextEditId = 1;
  private readonly results = new Map<number, StoredResult>();
  private nextResultId = 1;

  constructor(
    private readonly SQL: SqlJsStatic,
    bytes: Uint8Array,
    private opts: SessionOptions,
  ) {
    this.db = this.open(bytes);
  }

  // ---------- lifecycle ----------

  private open(bytes: Uint8Array): Database {
    const db = new this.SQL.Database(bytes);
    try {
      // Fails with "file is not a database" for anything that isn't SQLite.
      db.exec('SELECT count(*) FROM sqlite_schema');
      if (this.opts.readOnly) db.run('PRAGMA query_only = 1');
    } catch (err) {
      db.close();
      throw err;
    }
    return db;
  }

  /** Replaces the database content (revert or reload from disk). */
  load(bytes: Uint8Array, invalidateEdits: boolean): void {
    this.replace(bytes);
    this.results.clear();
    if (invalidateEdits) {
      for (const e of this.edits.values()) {
        e.stale = true;
        e.drop?.();
      }
    }
  }

  private replace(bytes: Uint8Array): void {
    const next = this.open(bytes);
    this.db.close();
    this.db = next;
    this.schemaCache = null;
  }

  setReadOnly(readOnly: boolean): void {
    this.opts = { ...this.opts, readOnly };
    this.db.run(`PRAGMA query_only = ${readOnly ? 1 : 0}`);
  }

  setLimits(undoBudgetBytes: number, maxResultRows: number): void {
    this.opts = { ...this.opts, undoBudgetBytes, maxResultRows };
  }

  close(): void {
    this.db.close();
  }

  serialize(): Uint8Array {
    return this.db.export();
  }

  info(): { sqliteVersion: string; pageSize: number; encoding: string } {
    return {
      sqliteVersion: String(scalar(this.db, 'SELECT sqlite_version()')),
      pageSize: num(scalar(this.db, 'PRAGMA page_size')),
      encoding: String(scalar(this.db, 'PRAGMA encoding')),
    };
  }

  // ---------- schema & reading ----------

  schema(): SchemaInfo {
    return (this.schemaCache ??= readSchema(this.db));
  }

  private table(name: string): TableInfo {
    const t = findTable(this.schema(), name);
    if (!t) throw new Error(`No such table: ${name}`);
    if (t.columns.length === 0) throw new Error(t.error ?? `Cannot read the columns of "${name}".`);
    return t;
  }

  private writable(name: string): TableInfo {
    if (this.opts.readOnly) throw new Error('The database is open read-only.');
    const t = this.table(name);
    if (t.readOnly) throw new Error(t.readOnlyReason ?? `"${name}" is read-only.`);
    return t;
  }

  private column(t: TableInfo, name: string): ColumnInfo {
    const c = t.columns.find((col) => col.name === name);
    if (!c) throw new Error(`No such column: ${t.name}.${name}`);
    return c;
  }

  private keyWhere(t: TableInfo, key: RawValue[]): Where {
    const cols = keyColumns(t);
    if (cols.length === 0 || key.length !== cols.length) throw new Error(`Rows of "${t.name}" cannot be identified.`);
    return { sql: cols.map((c, i) => `${q(c)} = ${placeholder(key[i])}`).join(' AND '), params: key };
  }

  counts(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const t of this.schema().tables) {
      try {
        out[t.name] = num(scalar(this.db, `SELECT count(*) FROM ${q(t.name)}`));
      } catch {
        out[t.name] = null;
      }
    }
    return out;
  }

  count(query: RowsQuery): number {
    const t = this.table(query.table);
    const where = buildWhere(t, query.filters, query.search);
    return num(scalar(this.db, `SELECT count(*) FROM ${q(t.name)}${where.sql ? ' WHERE ' + where.sql : ''}`, where.params));
  }

  rows(query: RowsQuery & { offset: number; limit: number }): GridRow[] {
    return this.selectRows(this.table(query.table), query, query.offset, query.limit, 'grid');
  }

  private selectRows(t: TableInfo, query: RowsQuery, offset: number, limit: number, mode: 'grid' | 'full'): GridRow[] {
    const where = buildWhere(t, query.filters, query.search);
    const keys = keyColumns(t);
    const cols = [...keys.map(q), selectList(t)].join(', ');
    const sql = `SELECT ${cols} FROM ${q(t.name)}${where.sql ? ' WHERE ' + where.sql : ''}${orderBy(t, query.sort)} LIMIT ? OFFSET ?`;
    return all(this.db, sql, [...where.params, limit, offset]).map((r) => ({
      k: keys.length ? r.slice(0, keys.length).map((v) => encodeCell(v, 'full')) : null,
      v: r.slice(keys.length).map((v) => encodeCell(v, mode)),
    }));
  }

  rowsForRanges(query: RowsQuery, ranges: RowRange[], full: boolean): GridRow[] {
    const t = this.table(query.table);
    const out: GridRow[] = [];
    for (const r of ranges) {
      const limit = Math.min(r.to - r.from, MAX_RANGE_ROWS - out.length);
      if (limit <= 0) break;
      out.push(...this.selectRows(t, query, r.from, limit, full ? 'full' : 'grid'));
    }
    return out;
  }

  getRow(table: string, key: CellValue[]): CellValue[] | null {
    const t = this.table(table);
    const w = this.keyWhere(t, key.map(decodeCell));
    const r = one(this.db, `SELECT ${selectList(t)} FROM ${q(t.name)} WHERE ${w.sql}`, w.params);
    return r ? r.map((v) => encodeCell(v, 'full')) : null;
  }

  /** Position of a row under the current filters and sort, or -1. */
  findRow(query: RowsQuery, key: CellValue[]): number {
    const t = this.table(query.table);
    const keys = keyColumns(t);
    if (!keys.length) return -1;
    const k = key.map(decodeCell);
    const where = buildWhere(t, query.filters, query.search);
    const order = orderBy(t, query.sort).trim();
    const sql =
      `SELECT rn FROM (SELECT ${keys.map((c, i) => `${q(c)} AS k${i}`).join(', ')}, row_number() OVER (${order}) - 1 AS rn ` +
      `FROM ${q(t.name)}${where.sql ? ' WHERE ' + where.sql : ''}) WHERE ${keys.map((_, i) => `k${i} = ${placeholder(k[i])}`).join(' AND ')}`;
    const r = one(this.db, sql, [...where.params, ...k]);
    return r ? num(r[0]) : -1;
  }

  // ---------- edits ----------

  private register(rec: Omit<EditRecord, 'expired' | 'stale'>): EditInfo {
    const id = this.nextEditId++;
    this.edits.set(id, { ...rec, expired: false, stale: false });
    this.enforceBudget(id);
    return { id, label: rec.label };
  }

  /** Drops the oldest snapshots once the undo memory budget is exceeded. */
  private enforceBudget(keepId: number): void {
    let total = 0;
    for (const e of this.edits.values()) total += e.bytes();
    if (total <= this.opts.undoBudgetBytes) return;
    for (const [id, e] of this.edits) {
      if (total <= this.opts.undoBudgetBytes) break;
      const size = e.bytes();
      if (id === keepId || !e.drop || size === 0) continue;
      e.drop();
      e.expired = true;
      total -= size;
    }
  }

  private dbSize(): number {
    return num(scalar(this.db, 'PRAGMA page_count')) * num(scalar(this.db, 'PRAGMA page_size'));
  }

  /** Copy of the database for undo, or null when it doesn't fit the undo budget. */
  private takeSnapshot(): Uint8Array | null {
    return this.dbSize() > this.opts.undoBudgetBytes ? null : this.db.export();
  }

  private snapshotEdit(label: string, schema: boolean, before: Uint8Array | null, redoFn: () => void): EditInfo {
    if (!before) {
      return this.register({ label, schema, undoable: false, undo() {}, redo() {}, bytes: () => 0 });
    }
    let beforeSnap: Uint8Array | null = before;
    let after: Uint8Array | null = null;
    return this.register({
      label,
      schema,
      undoable: true,
      undo: () => {
        if (!beforeSnap) throw new Error('This change can no longer be undone.');
        after = this.db.export();
        this.replace(beforeSnap);
      },
      redo: () => {
        if (after) this.replace(after);
        else transaction(this.db, redoFn);
      },
      bytes: () => (beforeSnap?.length ?? 0) + (after?.length ?? 0),
      drop: () => {
        beforeSnap = null;
        after = null;
      },
    });
  }

  /** Applies a change whose side effects (triggers, data loss) need a snapshot to undo. */
  private snapshotMutation(label: string, schema: boolean, apply: () => void): MutationResult {
    const before = this.takeSnapshot();
    transaction(this.db, apply);
    if (schema) this.schemaCache = null;
    return { edit: this.snapshotEdit(label, schema, before, apply), schemaChanged: schema };
  }

  private inverseEdit(label: string, schema: boolean, undo: () => void, redo: () => void): EditInfo {
    return this.register({
      label,
      schema,
      undoable: true,
      undo: () => transaction(this.db, undo),
      redo: () => transaction(this.db, redo),
      bytes: () => 0,
    });
  }

  undo(id: number): UndoOutcome {
    return this.applyEdit(id, 'undo');
  }

  redo(id: number): UndoOutcome {
    return this.applyEdit(id, 'redo');
  }

  private applyEdit(id: number, dir: 'undo' | 'redo'): UndoOutcome {
    const e = this.edits.get(id);
    const verb = dir === 'undo' ? 'undone' : 'redone';
    if (!e) return { ok: false, message: `This change can no longer be ${verb}.`, schemaChanged: false };
    if (e.stale) {
      return { ok: false, message: `The database was reloaded from disk, so this change can no longer be ${verb}.`, schemaChanged: false };
    }
    if (e.expired) {
      return {
        ok: false,
        message: `"${e.label}" can no longer be ${verb}: the undo memory limit (localastrodb.undoMemoryLimitMB) was reached.`,
        schemaChanged: false,
      };
    }
    if (!e.undoable) {
      return { ok: false, message: `"${e.label}" was too large to snapshot, so it can't be ${verb}.`, schemaChanged: false };
    }
    if (dir === 'undo') e.undo();
    else e.redo();
    if (e.schema) this.schemaCache = null;
    this.enforceBudget(id);
    return { ok: true, schemaChanged: e.schema };
  }

  /** Columns needed to recreate a row exactly: the rowid (unless aliased) and every writable column. */
  private fullRowColumns(t: TableInfo): string[] {
    const cols = t.columns.filter((c) => !c.generated).map((c) => c.name);
    if (!t.withoutRowid && t.rowidName && !t.columns.some((c) => c.isRowidAlias)) return [t.rowidName, ...cols];
    return cols;
  }

  private insertFull(t: TableInfo, names: string[], values: RawValue[]): void {
    this.db.run(
      `INSERT INTO ${q(t.name)} (${names.map(q).join(', ')}) VALUES (${values.map(placeholder).join(', ')})`,
      values.map((v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  }

  private deleteByKey(t: TableInfo, key: RawValue[]): void {
    const w = this.keyWhere(t, key);
    const stmt = this.db.prepare(`DELETE FROM ${q(t.name)} WHERE ${w.sql}`);
    try {
      stmt.bind(w.params.map((v) => (typeof v === 'bigint' ? v.toString() : v)));
      stmt.step();
    } finally {
      stmt.free();
    }
  }

  updateCells(table: string, changes: { key: CellValue[]; column: string; value: InputValue }[]): MutationResult {
    const t = this.writable(table);
    const keys = keyColumns(t);
    const ops = changes.map((ch) => {
      const col = this.column(t, ch.column);
      if (col.generated) throw new Error(`"${col.name}" is a generated column and can't be edited.`);
      return {
        col,
        key: ch.key.map(decodeCell),
        value: decodeInput(ch.value, col.affinity, col.type),
        old: null as RawValue,
        newKey: [] as RawValue[],
      };
    });
    if (ops.length === 0) return { edit: null, schemaChanged: false };
    const label = ops.length === 1 ? `Edit ${t.name}.${ops[0].col.name}` : `Edit ${ops.length} cells in ${t.name}`;
    const returning = keys.map(q).join(', ');
    const set = (col: ColumnInfo, key: RawValue[], value: RawValue): RawValue[] => {
      const w = this.keyWhere(t, key);
      const r = one(this.db, `UPDATE ${q(t.name)} SET ${q(col.name)} = ${placeholder(value)} WHERE ${w.sql} RETURNING ${returning}`, [
        value,
        ...w.params,
      ]);
      if (!r) throw new Error(`Row not found in "${t.name}". It may have been changed or deleted.`);
      return r;
    };
    const forward = (first: boolean) => {
      for (const op of ops) {
        if (first) {
          const w = this.keyWhere(t, op.key);
          const cur = one(this.db, `SELECT ${q(op.col.name)} FROM ${q(t.name)} WHERE ${w.sql}`, w.params);
          if (!cur) throw new Error(`Row not found in "${t.name}". It may have been changed or deleted.`);
          op.old = cur[0];
        }
        op.newKey = set(op.col, op.key, op.value);
      }
    };
    const backward = () => {
      for (const op of [...ops].reverse()) set(op.col, op.newKey, op.old);
    };
    if (t.triggers.length) return this.snapshotMutation(label, false, () => forward(true));
    transaction(this.db, () => forward(true));
    return { edit: this.inverseEdit(label, false, backward, () => forward(false)), schemaChanged: false };
  }

  insertRow(table: string, values: Record<string, InputValue>): MutationResult & { key: CellValue[] | null } {
    const t = this.writable(table);
    const cols = Object.entries(values).map(([name, v]) => {
      const col = this.column(t, name);
      if (col.generated) throw new Error(`"${col.name}" is a generated column and can't be set.`);
      return { col, value: decodeInput(v, col.affinity, col.type) };
    });
    const keys = keyColumns(t);
    const full = this.fullRowColumns(t);
    const insert = cols.length
      ? `INSERT INTO ${q(t.name)} (${cols.map((c) => q(c.col.name)).join(', ')}) VALUES (${cols.map((c) => placeholder(c.value)).join(', ')})`
      : `INSERT INTO ${q(t.name)} DEFAULT VALUES`;
    let key: RawValue[] = [];
    let row: RawValue[] = [];
    const first = () => {
      const r = one(this.db, `${insert} RETURNING ${[...keys, ...full].map(q).join(', ')}`, cols.map((c) => c.value));
      if (!r) throw new Error('The row was not inserted.');
      key = r.slice(0, keys.length);
      row = r.slice(keys.length);
    };
    const label = `Insert row into ${t.name}`;
    let result: MutationResult;
    if (t.triggers.length) result = this.snapshotMutation(label, false, first);
    else {
      transaction(this.db, first);
      result = {
        edit: this.inverseEdit(
          label,
          false,
          () => this.deleteByKey(t, key),
          () => this.insertFull(t, full, row),
        ),
        schemaChanged: false,
      };
    }
    return { ...result, key: keys.length ? key.map((v) => encodeCell(v, 'full')) : null };
  }

  deleteRows(table: string, keys: CellValue[][]): MutationResult {
    const t = this.writable(table);
    const decoded = keys.map((k) => k.map(decodeCell));
    if (decoded.length === 0) return { edit: null, schemaChanged: false };
    const full = this.fullRowColumns(t);
    let rows: RawValue[][] = [];
    const first = () => {
      rows = [];
      for (const k of decoded) {
        const w = this.keyWhere(t, k);
        const r = one(this.db, `DELETE FROM ${q(t.name)} WHERE ${w.sql} RETURNING ${full.map(q).join(', ')}`, w.params);
        if (r) rows.push(r);
      }
    };
    const label = decoded.length === 1 ? `Delete row from ${t.name}` : `Delete ${decoded.length} rows from ${t.name}`;
    if (t.triggers.length) return this.snapshotMutation(label, false, first);
    transaction(this.db, first);
    if (rows.length === 0) return { edit: null, schemaChanged: false };
    const deleted = rows;
    return {
      edit: this.inverseEdit(
        label,
        false,
        () => {
          for (const r of deleted) this.insertFull(t, full, r);
        },
        () => {
          for (const k of decoded) this.deleteByKey(t, k);
        },
      ),
      schemaChanged: false,
    };
  }

  /** Schema change from the Structure view. */
  runDdl(statements: string[], label: string, inverse?: string[]): MutationResult {
    if (this.opts.readOnly) throw new Error('The database is open read-only.');
    const apply = () => {
      for (const s of statements) this.db.run(s);
    };
    if (inverse && inverse.length) {
      transaction(this.db, apply);
      this.schemaCache = null;
      const undo = () => {
        for (const s of inverse) this.db.run(s);
      };
      return { edit: this.inverseEdit(label, true, undo, apply), schemaChanged: true };
    }
    return this.snapshotMutation(label, true, apply);
  }

  // ---------- SQL ----------

  private signature(): { changes: string; schema: string } {
    const r = one(
      this.db,
      'SELECT total_changes(), (SELECT schema_version FROM pragma_schema_version), (SELECT user_version FROM pragma_user_version), (SELECT application_id FROM pragma_application_id)',
    )!;
    return { changes: `${r[0]}:${r[2]}:${r[3]}`, schema: String(r[1]) };
  }

  private inTransaction(): boolean {
    try {
      this.db.run('BEGIN');
    } catch {
      return true;
    }
    this.db.run('ROLLBACK');
    return false;
  }

  exec(sql: string): ExecResult {
    this.results.clear();
    const statements = splitStatements(sql);
    const readOnlyBatch = statements.every((s) => isReadOnlyStatement(s.text));
    if (!readOnlyBatch && this.opts.readOnly) {
      throw new Error('The database is open read-only. Only statements that read data can run.');
    }
    const opaque = statements.some((s) => isOpaqueWrite(s.text));
    const before = readOnlyBatch ? null : this.takeSnapshot();
    const tooLarge = !readOnlyBatch && before === null;
    const sig0 = this.signature();
    const t0 = performance.now();
    const results: ResultSetInfo[] = [];
    let error: ExecError | null = null;
    let index = 0;
    try {
      for (const stmt of this.db.iterateStatements(sql)) {
        const s0 = performance.now();
        const changes0 = num(scalar(this.db, 'SELECT total_changes()'));
        const columns = stmt.getColumnNames();
        const rows: RawValue[][] = [];
        let truncated = false;
        while (stmt.step()) {
          if (rows.length < this.opts.maxResultRows) rows.push(rowOf(stmt));
          else truncated = true;
        }
        const text = stmt.getSQL();
        stmt.free();
        const changed = num(scalar(this.db, 'SELECT total_changes()')) !== changes0;
        const id = this.nextResultId++;
        this.results.set(id, { columns, rows, sort: null, order: null });
        results.push({
          id,
          sql: text,
          columns,
          total: rows.length,
          truncated,
          rowsModified: changed ? this.db.getRowsModified() : 0,
          timeMs: performance.now() - s0,
          rows: rows.slice(0, FIRST_PAGE).map((r) => r.map((v) => encodeCell(v))),
        });
        index++;
      }
    } catch (err) {
      error = {
        message: err instanceof Error ? err.message : String(err),
        statementIndex: index,
        sql: statements[index]?.text ?? '',
      };
    }
    const notes: string[] = [];
    if (this.inTransaction()) {
      if (error) {
        this.db.run('ROLLBACK');
        notes.push('The open transaction was rolled back because of the error.');
      } else {
        this.db.run('COMMIT');
        notes.push('The open transaction was committed. Use Undo to revert it.');
      }
    }
    const sig1 = this.signature();
    const schemaChanged = sig1.schema !== sig0.schema || (opaque && !error);
    const changed = schemaChanged || sig1.changes !== sig0.changes || opaque;
    if (schemaChanged) this.schemaCache = null;
    let edit: EditInfo | null = null;
    if (changed && !this.opts.readOnly) {
      edit = this.snapshotEdit('Run SQL', schemaChanged, before, () => {
        this.db.exec(sql);
      });
      if (tooLarge) notes.push('The database is larger than the undo memory limit, so this change cannot be undone.');
    }
    return { results, error, timeMs: performance.now() - t0, edit, schemaChanged, notes };
  }

  resultRows(resultId: number, offset: number, limit: number, sort: SortSpec | null): CellValue[][] {
    const r = this.results.get(resultId);
    if (!r) throw new Error('This result is no longer available. Run the query again.');
    const order = this.resultOrder(r, sort);
    const out: CellValue[][] = [];
    for (let i = offset; i < Math.min(offset + limit, r.rows.length); i++) {
      out.push(r.rows[order ? order[i] : i].map((v) => encodeCell(v)));
    }
    return out;
  }

  private resultOrder(r: StoredResult, sort: SortSpec | null): number[] | null {
    if (!sort) return null;
    if (r.sort && r.sort.column === sort.column && r.sort.dir === sort.dir) return r.order;
    const col = r.columns.indexOf(sort.column);
    if (col < 0) return null;
    const dir = sort.dir === 'desc' ? -1 : 1;
    const order = r.rows.map((_, i) => i);
    order.sort((a, b) => dir * compareRaw(r.rows[a][col], r.rows[b][col]) || a - b);
    r.sort = sort;
    r.order = order;
    return order;
  }

  // ---------- compare / export ----------

  compare(other: Uint8Array, leftName: string, rightName: string): CompareResult {
    return compareDatabases(this.SQL, this.db, this.schema(), other, leftName, rightName);
  }

  private rowSource(source: ExportSource): RowSource {
    if (source.kind === 'result') {
      const r = this.results.get(source.resultId);
      if (!r) throw new Error('This result is no longer available. Run the query again.');
      const order = r.order;
      return {
        name: 'query_results',
        columns: r.columns,
        createSql: null,
        *rows() {
          for (let i = 0; i < r.rows.length; i++) yield r.rows[order ? order[i] : i];
        },
      };
    }
    const t = this.table(source.table);
    const query: RowsQuery = source.query ?? { table: t.name, filters: {}, search: '', sort: null };
    const where = buildWhere(t, query.filters, query.search);
    const sql = `SELECT ${selectList(t)} FROM ${q(t.name)}${where.sql ? ' WHERE ' + where.sql : ''}${orderBy(t, query.sort)}`;
    const db = this.db;
    return {
      name: t.name,
      columns: t.columns.map((c) => c.name),
      generated: t.columns.map((c) => c.generated),
      createSql: t.type === 'table' ? t.sql : null,
      *rows() {
        const stmt = db.prepare(sql);
        try {
          if (where.params.length) stmt.bind(where.params.map((v) => (typeof v === 'bigint' ? v.toString() : v)));
          while (stmt.step()) yield rowOf(stmt);
        } finally {
          stmt.free();
        }
      },
    };
  }

  exportData(source: ExportSource, format: ExportFormat): string[] {
    return exportRows(this.rowSource(source), format);
  }

  dump(): string[] {
    return dumpDatabase(this.db, this.schema());
  }

  typescript(dbName: string): string {
    return schemaToTypeScript(this.schema(), dbName);
  }
}
