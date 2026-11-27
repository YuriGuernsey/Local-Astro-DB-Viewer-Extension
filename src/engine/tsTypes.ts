// "Copy Schema as TypeScript Types": one interface per table and view, plus a
// Database interface mapping table names to row types (handy for Kysely).
import type { ColumnInfo, SchemaInfo, TableInfo } from '../shared/protocol';

const RESERVED = new Set(['Database', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Map', 'Set', 'Record', 'Promise']);

export function tsTypeFor(col: ColumnInfo, strict: boolean): string {
  const t = col.type.trim().toUpperCase();
  if (t === '') return 'unknown';
  if (strict && t === 'ANY') return 'unknown';
  switch (col.affinity) {
    case 'INTEGER':
    case 'REAL':
      return 'number';
    case 'TEXT':
      return 'string';
    case 'BLOB':
      return 'Uint8Array';
    case 'NUMERIC':
      // Dates, times and JSON are stored as text in practice; BOOLEAN as 0/1.
      if (/DATE|TIME|JSON/.test(t)) return 'string';
      return 'number';
  }
}

export function pascalCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!id) id = 'Table';
  if (/^[0-9]/.test(id)) id = '_' + id;
  return id;
}

const isIdentifier = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const prop = (s: string) => (isIdentifier(s) ? s : JSON.stringify(s));

function nullable(col: ColumnInfo, t: TableInfo): boolean {
  if (col.notNull) return false;
  if (col.isRowidAlias) return false;
  if (col.pk > 0 && t.withoutRowid) return false;
  return true;
}

export function schemaToTypeScript(schema: SchemaInfo, dbName: string): string {
  const used = new Set<string>(RESERVED);
  const names = new Map<string, string>();
  const tables = schema.tables.filter((t) => !t.name.startsWith('sqlite_') && t.type !== 'shadow' && t.columns.length > 0);
  for (const t of tables) {
    let id = pascalCase(t.name);
    let n = 2;
    while (used.has(id)) id = pascalCase(t.name) + n++;
    used.add(id);
    names.set(t.name, id);
  }
  const out: string[] = [`// Generated from ${dbName} by Local AstroDB.`, ''];
  for (const t of tables) {
    const kind = t.type === 'view' ? 'view' : t.type === 'virtual' ? 'virtual table' : 'table';
    out.push(`/** ${kind} ${JSON.stringify(t.name)} */`);
    out.push(`export interface ${names.get(t.name)} {`);
    for (const c of t.columns) {
      const notes: string[] = [];
      if (c.pk) notes.push(t.pk.length > 1 ? `primary key (${c.pk})` : 'primary key');
      if (c.generated) notes.push('generated');
      if (c.type) notes.push(c.type);
      const comment = notes.length ? ` // ${notes.join(', ')}` : '';
      const type = tsTypeFor(c, t.strict);
      const isNullable = t.type === 'view' ? !c.notNull : nullable(c, t);
      out.push(`  ${prop(c.name)}: ${type}${isNullable && type !== 'unknown' ? ' | null' : ''};${comment}`);
    }
    out.push('}', '');
  }
  out.push('/** All tables and views, keyed by name (e.g. for Kysely). */');
  out.push('export interface Database {');
  for (const t of tables) out.push(`  ${prop(t.name)}: ${names.get(t.name)};`);
  out.push('}', '');
  return out.join('\n');
}
