// Reads the schema of a database: tables, views, columns, keys, indexes and triggers.
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ObjectType, SchemaInfo, TableInfo, TriggerInfo } from '../shared/protocol';
import { affinityOf, quoteIdent } from '../shared/sql';
import { all, num, type Database } from './db';

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function readSchema(db: Database): SchemaInfo {
  const list = all(db, "SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = 'main'");
  const sqlRows = all(db, "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table','view','trigger','index')");
  const sqlByName = new Map<string, string | null>();
  const triggersByTable = new Map<string, TriggerInfo[]>();
  const indexSql = new Map<string, string | null>();
  for (const [type, name, tbl, sql] of sqlRows) {
    if (type === 'table' || type === 'view') sqlByName.set(str(name), sql === null ? null : str(sql));
    else if (type === 'trigger') {
      const key = str(tbl).toLowerCase();
      const arr = triggersByTable.get(key) ?? [];
      arr.push({ name: str(name), sql: str(sql) });
      triggersByTable.set(key, arr);
    } else indexSql.set(str(name), sql === null ? null : str(sql));
  }

  const tables: TableInfo[] = [];
  for (const [nameV, typeV, wrV, strictV] of list) {
    const name = str(nameV);
    if (name === 'sqlite_schema' || name === 'sqlite_temp_schema' || name === 'sqlite_master') continue;
    const type = str(typeV) as ObjectType;
    tables.push(
      readTable(db, name, type, num(wrV) === 1, num(strictV) === 1, sqlByName.get(name) ?? null, triggersByTable.get(name.toLowerCase()) ?? [], indexSql),
    );
  }
  const order = (t: TableInfo) => (t.type === 'view' ? 1 : 0);
  tables.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { tables };
}

function readTable(
  db: Database,
  name: string,
  type: ObjectType,
  withoutRowid: boolean,
  strict: boolean,
  sql: string | null,
  triggers: TriggerInfo[],
  indexSql: Map<string, string | null>,
): TableInfo {
  const info: TableInfo = {
    name,
    type,
    sql,
    columns: [],
    withoutRowid,
    strict,
    rowidName: null,
    pk: [],
    foreignKeys: [],
    indexes: [],
    triggers,
    readOnly: false,
  };
  try {
    const cols = all(db, `SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, 'main')`, [name]);
    for (const [cid, cname, ctype, notnull, dflt, pk, hidden] of cols) {
      const h = num(hidden);
      if (h === 1) continue; // hidden virtual-table column
      info.columns.push({
        cid: num(cid),
        name: str(cname),
        type: str(ctype),
        affinity: affinityOf(str(ctype)),
        notNull: num(notnull) === 1,
        defaultValue: dflt === null ? null : str(dflt),
        pk: num(pk),
        generated: h === 2 || h === 3,
        isRowidAlias: false,
      });
    }
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err);
  }

  info.pk = info.columns
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

  if (type === 'table' || type === 'shadow') {
    if (!withoutRowid) {
      const names = new Set(info.columns.map((c) => c.name.toLowerCase()));
      info.rowidName = ['rowid', '_rowid_', 'oid'].find((n) => !names.has(n)) ?? null;
      if (info.pk.length === 1) {
        const col = info.columns.find((c) => c.name === info.pk[0]);
        if (col && col.type.toUpperCase() === 'INTEGER') col.isRowidAlias = true;
      }
    }
    try {
      info.foreignKeys = readForeignKeys(db, name);
      info.indexes = readIndexes(db, name, indexSql);
    } catch (err) {
      info.error ??= err instanceof Error ? err.message : String(err);
    }
  }

  if (type === 'view') {
    info.readOnly = true;
    info.readOnlyReason = 'Views are read-only.';
  } else if (type === 'virtual') {
    info.readOnly = true;
    info.readOnlyReason = 'Virtual tables are read-only.';
  } else if (info.error) {
    info.readOnly = true;
    info.readOnlyReason = info.error;
  } else if (!info.rowidName && info.pk.length === 0) {
    info.readOnly = true;
    info.readOnlyReason = 'This table has no rowid or primary key to identify rows.';
  }
  return info;
}

function readForeignKeys(db: Database, table: string): ForeignKeyInfo[] {
  const rows = all(db, `SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq`, [table]);
  const byId = new Map<number, ForeignKeyInfo>();
  for (const [id, , parent, from, to, onUpdate, onDelete] of rows) {
    const key = num(id);
    let fk = byId.get(key);
    if (!fk) {
      fk = { id: key, table: str(parent), from: [], to: [], onUpdate: str(onUpdate), onDelete: str(onDelete) };
      byId.set(key, fk);
    }
    fk.from.push(str(from));
    if (to !== null) fk.to.push(str(to));
  }
  return [...byId.values()];
}

function readIndexes(db: Database, table: string, indexSql: Map<string, string | null>): IndexInfo[] {
  const rows = all(db, `SELECT name, "unique", origin, partial FROM pragma_index_list(?, 'main')`, [table]);
  return rows.map(([name, unique, origin, partial]) => {
    const iname = str(name);
    const cols = all(db, `SELECT cid, name FROM pragma_index_info(?, 'main') ORDER BY seqno`, [iname]).map(([cid, cname]) =>
      cname === null ? (num(cid) === -1 ? 'rowid' : '<expression>') : str(cname),
    );
    return {
      name: iname,
      unique: num(unique) === 1,
      origin: str(origin) as IndexInfo['origin'],
      partial: num(partial) === 1,
      columns: cols,
      sql: indexSql.get(iname) ?? null,
    };
  });
}

export function findTable(schema: SchemaInfo, name: string): TableInfo | undefined {
  return schema.tables.find((t) => t.name === name) ?? schema.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

/** Columns that can be written (not generated). */
export function writableColumns(t: TableInfo): ColumnInfo[] {
  return t.columns.filter((c) => !c.generated);
}

/** SELECT list for the visible columns of a table. */
export function selectList(t: TableInfo, alias = ''): string {
  const prefix = alias ? alias + '.' : '';
  return t.columns.map((c) => prefix + quoteIdent(c.name)).join(', ') || '*';
}
