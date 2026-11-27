// Builders for the schema-editing statements, shared by the Structure view (live preview) and tests.
import { quoteIdent as q, quoteString, tokenize } from './sql';

export interface NewColumnDef {
  name: string;
  type: string;
  pk: boolean;
  autoincrement: boolean;
  notNull: boolean;
  unique: boolean;
  /** Default as typed by the user: a literal, keyword, or expression in parentheses. Empty for none. */
  defaultValue: string;
  references: { table: string; column: string } | null;
}

export interface NewTableDef {
  name: string;
  columns: NewColumnDef[];
  withoutRowid: boolean;
  strict: boolean;
}

export const COMMON_TYPES = ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATETIME', 'JSON'];
export const STRICT_TYPES = ['INTEGER', 'INT', 'TEXT', 'REAL', 'BLOB', 'ANY'];

const DEFAULT_KEYWORDS = /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i;

/** Formats a user-entered default: literals and keywords pass through, anything else becomes a string literal. */
export function formatDefault(input: string): string {
  const v = input.trim();
  if (v === '') return '';
  if (DEFAULT_KEYWORDS.test(v)) return v.toUpperCase();
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v) || /^0x[0-9a-f]+$/i.test(v)) return v;
  if (/^'.*'$/s.test(v) && tokenize(v).length === 1) return v;
  if (/^[xX]'[0-9a-fA-F]*'$/.test(v)) return v;
  if (v.startsWith('(') && v.endsWith(')')) return v;
  return quoteString(v);
}

export function columnDefSql(c: NewColumnDef, inlinePk: boolean): string {
  let s = q(c.name);
  if (c.type.trim()) s += ' ' + c.type.trim();
  if (inlinePk && c.pk) {
    s += ' PRIMARY KEY';
    if (c.autoincrement) s += ' AUTOINCREMENT';
  }
  if (c.notNull) s += ' NOT NULL';
  if (c.unique) s += ' UNIQUE';
  const d = formatDefault(c.defaultValue);
  if (d) s += ' DEFAULT ' + d;
  if (c.references && c.references.table) {
    s += ' REFERENCES ' + q(c.references.table);
    if (c.references.column) s += ' (' + q(c.references.column) + ')';
  }
  return s;
}

export function createTableSql(def: NewTableDef): string {
  const pkCols = def.columns.filter((c) => c.pk);
  const inlinePk = pkCols.length === 1;
  const lines = def.columns.map((c) => columnDefSql(c, inlinePk));
  if (pkCols.length > 1) lines.push('PRIMARY KEY (' + pkCols.map((c) => q(c.name)).join(', ') + ')');
  const options: string[] = [];
  if (def.withoutRowid) options.push('WITHOUT ROWID');
  if (def.strict) options.push('STRICT');
  return `CREATE TABLE ${q(def.name)} (\n  ${lines.join(',\n  ')}\n)${options.length ? ' ' + options.join(', ') : ''}`;
}

export function validateTableDef(def: NewTableDef, existing: string[]): string | null {
  if (!def.name.trim()) return 'Enter a table name.';
  if (existing.some((n) => n.toLowerCase() === def.name.trim().toLowerCase())) return `"${def.name}" already exists.`;
  if (def.columns.length === 0) return 'Add at least one column.';
  const seen = new Set<string>();
  for (const c of def.columns) {
    if (!c.name.trim()) return 'Every column needs a name.';
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) return `Duplicate column "${c.name}".`;
    seen.add(key);
    if (c.autoincrement && !(c.pk && /^integer$/i.test(c.type.trim()))) return 'AUTOINCREMENT needs a single INTEGER PRIMARY KEY.';
  }
  const pk = def.columns.filter((c) => c.pk);
  if (def.withoutRowid && pk.length === 0) return 'WITHOUT ROWID tables need a primary key.';
  if (pk.some((c) => c.autoincrement) && pk.length > 1) return 'AUTOINCREMENT needs a single INTEGER PRIMARY KEY.';
  if (def.strict && def.columns.some((c) => !STRICT_TYPES.includes(c.type.trim().toUpperCase()))) {
    return 'STRICT tables only allow INT, INTEGER, REAL, TEXT, BLOB and ANY.';
  }
  return null;
}

export function addColumnSql(table: string, c: NewColumnDef): string {
  return `ALTER TABLE ${q(table)} ADD COLUMN ${columnDefSql({ ...c, pk: false, unique: false }, false)}`;
}

export function renameTableSql(table: string, newName: string): string {
  return `ALTER TABLE ${q(table)} RENAME TO ${q(newName)}`;
}

export function renameColumnSql(table: string, column: string, newName: string): string {
  return `ALTER TABLE ${q(table)} RENAME COLUMN ${q(column)} TO ${q(newName)}`;
}

export function dropColumnSql(table: string, column: string): string {
  return `ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`;
}

export function dropObjectSql(kind: 'table' | 'view' | 'index' | 'trigger', name: string): string {
  return `DROP ${kind.toUpperCase()} ${q(name)}`;
}

export function defaultIndexName(table: string, columns: string[]): string {
  const base = `idx_${table}${columns.length ? '_' + columns.join('_') : ''}`;
  return base.replace(/[^A-Za-z0-9_]+/g, '_');
}

export function createIndexSql(name: string, table: string, columns: string[], unique: boolean): string {
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(table)} (${columns.map(q).join(', ')})`;
}

export function emptyColumn(name = '', type = 'TEXT'): NewColumnDef {
  return { name, type, pk: false, autoincrement: false, notNull: false, unique: false, defaultValue: '', references: null };
}
