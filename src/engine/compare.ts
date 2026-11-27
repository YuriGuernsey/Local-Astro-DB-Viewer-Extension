// Compares the open database ("left") with another database file ("right"):
// tables added/removed, columns added/removed/retyped, and rows added/removed/changed,
// matched by primary key (or rowid). The right database is ATTACHed so the row diff
// runs inside SQLite.
import type { CompareChangedRow, CompareResult, SchemaInfo, TableDiff, TableInfo } from '../shared/protocol';
import { quoteIdent as q } from '../shared/sql';
import { all, fileNameOf, num, scalar, type Database, type SqlJsStatic } from './db';
import { readSchema } from './schema';
import { encodeCell, type RawValue } from './values';

export const COMPARE_ROW_LIMIT = 50;
const RIGHT = 'localastrodb_compare';

const comparable = (t: TableInfo) => (t.type === 'table' || t.type === 'virtual') && !t.name.toLowerCase().startsWith('sqlite_');
const norm = (sql: string | null) => (sql ?? '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();

export function compareDatabases(
  SQL: SqlJsStatic,
  db: Database,
  leftSchema: SchemaInfo,
  otherBytes: Uint8Array,
  leftName: string,
  rightName: string,
): CompareResult {
  const other = new SQL.Database(otherBytes);
  try {
    other.exec('SELECT count(*) FROM sqlite_schema');
    const rightSchema = readSchema(other);
    db.run(`ATTACH ? AS ${RIGHT}`, [fileNameOf(other)]);
    try {
      return diffSchemas(db, leftSchema, rightSchema, leftName, rightName);
    } finally {
      db.run(`DETACH ${RIGHT}`);
    }
  } finally {
    other.close();
  }
}

function diffSchemas(db: Database, left: SchemaInfo, right: SchemaInfo, leftName: string, rightName: string): CompareResult {
  const lt = new Map(left.tables.filter(comparable).map((t) => [t.name.toLowerCase(), t]));
  const rt = new Map(right.tables.filter(comparable).map((t) => [t.name.toLowerCase(), t]));
  const names = [...new Set([...lt.keys(), ...rt.keys()])];
  const tables: TableDiff[] = [];
  for (const key of names) {
    const a = lt.get(key);
    const b = rt.get(key);
    tables.push(diffTable(db, a, b));
  }
  tables.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  const summary = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const t of tables) summary[t.status]++;
  return { left: leftName, right: rightName, tables, summary, rowLimit: COMPARE_ROW_LIMIT };
}

function emptyDiff(name: string): TableDiff {
  return {
    name,
    status: 'same',
    schemaChanged: false,
    columns: { added: [], removed: [], retyped: [] },
    indexes: { added: [], removed: [] },
    rowCountLeft: null,
    rowCountRight: null,
    keyKind: 'none',
    keyColumns: [],
    added: { count: 0, columns: [], rows: [] },
    removed: { count: 0, columns: [], rows: [] },
    changed: { count: 0, columns: [], rows: [] },
  };
}

function countRows(db: Database, schema: string, table: string): number | null {
  try {
    return num(scalar(db, `SELECT count(*) FROM ${schema}.${q(table)}`));
  } catch {
    return null;
  }
}

function diffTable(db: Database, a: TableInfo | undefined, b: TableInfo | undefined): TableDiff {
  const d = emptyDiff((a ?? b)!.name);
  if (a) d.rowCountLeft = countRows(db, 'main', a.name);
  if (b) d.rowCountRight = countRows(db, RIGHT, b.name);
  if (!a || !b) {
    d.status = a ? 'removed' : 'added';
    return d;
  }

  // ---- schema ----
  const la = new Map(a.columns.map((c) => [c.name.toLowerCase(), c]));
  const lb = new Map(b.columns.map((c) => [c.name.toLowerCase(), c]));
  d.columns.removed = a.columns.filter((c) => !lb.has(c.name.toLowerCase())).map((c) => c.name);
  d.columns.added = b.columns.filter((c) => !la.has(c.name.toLowerCase())).map((c) => c.name);
  for (const c of a.columns) {
    const other = lb.get(c.name.toLowerCase());
    if (other && other.type.trim().toUpperCase() !== c.type.trim().toUpperCase()) {
      d.columns.retyped.push({ name: c.name, from: c.type, to: other.type });
    }
  }
  const ia = new Map(a.indexes.filter((i) => i.origin === 'c').map((i) => [i.name.toLowerCase(), i]));
  const ib = new Map(b.indexes.filter((i) => i.origin === 'c').map((i) => [i.name.toLowerCase(), i]));
  d.indexes.removed = [...ia.values()].filter((i) => !ib.has(i.name.toLowerCase())).map((i) => i.name);
  d.indexes.added = [...ib.values()].filter((i) => !ia.has(i.name.toLowerCase())).map((i) => i.name);
  const indexSqlChanged = [...ia.values()].some((i) => {
    const o = ib.get(i.name.toLowerCase());
    return o && norm(o.sql) !== norm(i.sql);
  });
  d.schemaChanged =
    norm(a.sql) !== norm(b.sql) ||
    d.columns.added.length + d.columns.removed.length + d.columns.retyped.length + d.indexes.added.length + d.indexes.removed.length > 0 ||
    indexSqlChanged;

  // ---- rows ----
  try {
    diffRows(db, a, b, d);
  } catch (err) {
    d.error = err instanceof Error ? err.message : String(err);
  }
  const rowsDiffer = d.added.count + d.removed.count + d.changed.count > 0;
  d.status = d.schemaChanged || rowsDiffer || d.error ? 'changed' : 'same';
  return d;
}

function diffRows(db: Database, a: TableInfo, b: TableInfo, d: TableDiff): void {
  const common = a.columns.filter((c) => b.columns.some((o) => o.name.toLowerCase() === c.name.toLowerCase())).map((c) => c.name);
  if (common.length === 0) return;
  const A = `main.${q(a.name)}`;
  const B = `${RIGHT}.${q(b.name)}`;
  const samePk = a.pk.length > 0 && a.pk.length === b.pk.length && a.pk.every((c, i) => c.toLowerCase() === b.pk[i].toLowerCase());
  let keyA: string[];
  let keyB: string[];
  if (samePk) {
    d.keyKind = 'pk';
    d.keyColumns = a.pk;
    keyA = a.pk.map((c) => 'a.' + q(c));
    keyB = b.pk.map((c) => 'b.' + q(c));
  } else if (a.type === 'table' && b.type === 'table' && !a.withoutRowid && !b.withoutRowid && a.rowidName && b.rowidName) {
    d.keyKind = 'rowid';
    d.keyColumns = ['rowid'];
    keyA = ['a.' + q(a.rowidName)];
    keyB = ['b.' + q(b.rowidName)];
  } else {
    d.keyKind = 'row';
    diffWholeRows(db, a, b, common, d);
    return;
  }

  const keySet = new Set(d.keyKind === 'pk' ? d.keyColumns.map((c) => c.toLowerCase()) : []);
  const match = keyA.map((k, i) => `${keyB[i]} IS ${k}`).join(' AND ');
  const matchRev = keyB.map((k, i) => `${keyA[i]} IS ${k}`).join(' AND ');

  // Removed: in left, not in right.
  const colsA = a.columns.filter((c) => !keySet.has(c.name.toLowerCase())).map((c) => c.name);
  const removedFrom = `FROM ${A} a WHERE NOT EXISTS (SELECT 1 FROM ${B} b WHERE ${match})`;
  d.removed.count = num(scalar(db, `SELECT count(*) ${removedFrom}`));
  d.removed.columns = colsA;
  if (d.removed.count) {
    d.removed.rows = all(db, `SELECT ${[...keyA, ...colsA.map((c) => 'a.' + q(c))].join(', ')} ${removedFrom} LIMIT ${COMPARE_ROW_LIMIT}`).map(
      (r) => withKey(r, keyA.length),
    );
  }

  // Added: in right, not in left.
  const colsB = b.columns.filter((c) => !keySet.has(c.name.toLowerCase())).map((c) => c.name);
  const addedFrom = `FROM ${B} b WHERE NOT EXISTS (SELECT 1 FROM ${A} a WHERE ${matchRev})`;
  d.added.count = num(scalar(db, `SELECT count(*) ${addedFrom}`));
  d.added.columns = colsB;
  if (d.added.count) {
    d.added.rows = all(db, `SELECT ${[...keyB, ...colsB.map((c) => 'b.' + q(c))].join(', ')} ${addedFrom} LIMIT ${COMPARE_ROW_LIMIT}`).map(
      (r) => withKey(r, keyB.length),
    );
  }

  // Changed: same key, any common column differs.
  const cmpCols = common.filter((c) => !keySet.has(c.toLowerCase()));
  d.changed.columns = cmpCols;
  if (cmpCols.length === 0) return;
  const differs = cmpCols.map((c) => `a.${q(c)} IS NOT b.${q(c)}`).join(' OR ');
  const changedFrom = `FROM ${A} a JOIN ${B} b ON ${match} WHERE ${differs}`;
  d.changed.count = num(scalar(db, `SELECT count(*) ${changedFrom}`));
  if (d.changed.count) {
    const sel = [...keyA, ...cmpCols.map((c) => 'a.' + q(c)), ...cmpCols.map((c) => 'b.' + q(c))].join(', ');
    d.changed.rows = all(db, `SELECT ${sel} ${changedFrom} LIMIT ${COMPARE_ROW_LIMIT}`).map((r): CompareChangedRow => {
      const k = keyA.length;
      const n = cmpCols.length;
      return {
        key: r.slice(0, k).map((v) => encodeCell(v)),
        before: r.slice(k, k + n).map((v) => encodeCell(v)),
        after: r.slice(k + n, k + 2 * n).map((v) => encodeCell(v)),
      };
    });
  }
}

/** Row = [key..., values...] → [key cell, values...] with composite keys joined for display. */
function withKey(r: RawValue[], keyCount: number) {
  const key = r.slice(0, keyCount).map((v) => encodeCell(v));
  const keyCell = key.length === 1 ? key[0] : key.map((v) => (v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
  return [keyCell, ...r.slice(keyCount).map((v) => encodeCell(v))];
}

/** Tables without a common key: rows only in one side (duplicates collapse, like EXCEPT). */
function diffWholeRows(db: Database, a: TableInfo, b: TableInfo, common: string[], d: TableDiff): void {
  const cols = common.map(q).join(', ');
  const A = `main.${q(a.name)}`;
  const B = `${RIGHT}.${q(b.name)}`;
  const removed = `SELECT ${cols} FROM ${A} EXCEPT SELECT ${cols} FROM ${B}`;
  const added = `SELECT ${cols} FROM ${B} EXCEPT SELECT ${cols} FROM ${A}`;
  d.removed.columns = common;
  d.added.columns = common;
  d.removed.count = num(scalar(db, `SELECT count(*) FROM (${removed})`));
  d.added.count = num(scalar(db, `SELECT count(*) FROM (${added})`));
  if (d.removed.count) d.removed.rows = all(db, `${removed} LIMIT ${COMPARE_ROW_LIMIT}`).map((r) => [null, ...r.map((v) => encodeCell(v))]);
  if (d.added.count) d.added.rows = all(db, `${added} LIMIT ${COMPARE_ROW_LIMIT}`).map((r) => [null, ...r.map((v) => encodeCell(v))]);
}
