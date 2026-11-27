// Export formats (CSV, JSON, SQL, Markdown) and the full-database SQL dump.
// Output is produced as a list of ~1 MB chunks so large exports never build one giant string.
import type { ExportFormat, SchemaInfo } from '../shared/protocol';
import { quoteIdent as q } from '../shared/sql';
import { rowOf, type Database } from './db';
import { rawToText, sqlLiteral, toHex, type RawValue } from './values';

export interface RowSource {
  name: string;
  columns: string[];
  /** Columns that can't be inserted (generated); skipped in SQL INSERTs. */
  generated?: boolean[];
  /** CREATE statement for SQL exports; synthesized when null. */
  createSql: string | null;
  rows(): Iterable<RawValue[]>;
}

const CHUNK = 1 << 20;

class ChunkWriter {
  readonly chunks: string[] = [];
  private buf = '';
  write(s: string): void {
    this.buf += s;
    if (this.buf.length >= CHUNK) {
      this.chunks.push(this.buf);
      this.buf = '';
    }
  }
  end(): string[] {
    if (this.buf) this.chunks.push(this.buf);
    this.buf = '';
    return this.chunks;
  }
}

export function csvField(v: RawValue): string {
  const s = rawToText(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function jsonValue(v: RawValue): string {
  if (v === null) return 'null';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(toHex(v));
}

function mdCell(v: RawValue): string {
  if (v === null) return 'NULL';
  return rawToText(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function exportRows(src: RowSource, format: ExportFormat): string[] {
  const w = new ChunkWriter();
  const cols = src.columns;
  switch (format) {
    case 'csv':
      w.write(cols.map(csvField).join(',') + '\n');
      for (const r of src.rows()) w.write(r.map(csvField).join(',') + '\n');
      break;
    case 'json': {
      const keys = cols.map((c) => JSON.stringify(c));
      let first = true;
      w.write('[');
      for (const r of src.rows()) {
        w.write((first ? '\n' : ',\n') + '  {' + r.map((v, i) => `${keys[i]}: ${jsonValue(v)}`).join(', ') + '}');
        first = false;
      }
      w.write(first ? ']\n' : '\n]\n');
      break;
    }
    case 'sql': {
      const keep = cols.map((_, i) => !src.generated?.[i]);
      const names = cols.filter((_, i) => keep[i]).map(q).join(', ');
      w.write((src.createSql ? src.createSql : `CREATE TABLE ${q(src.name)} (${cols.map(q).join(', ')})`) + ';\n\n');
      for (const r of src.rows()) {
        w.write(`INSERT INTO ${q(src.name)} (${names}) VALUES (${r.filter((_, i) => keep[i]).map(sqlLiteral).join(', ')});\n`);
      }
      break;
    }
    case 'md': {
      const rows = [...src.rows()];
      const numeric = cols.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === 'number' || typeof r[i] === 'bigint'));
      w.write('| ' + cols.map((c) => mdCell(c)).join(' | ') + ' |\n');
      w.write('| ' + numeric.map((n) => (n ? '---:' : '---')).join(' | ') + ' |\n');
      for (const r of rows) w.write('| ' + r.map(mdCell).join(' | ') + ' |\n');
      break;
    }
  }
  return w.end();
}

/** A full SQL dump in the spirit of the sqlite3 shell's .dump command. */
export function dumpDatabase(db: Database, schema: SchemaInfo): string[] {
  const w = new ChunkWriter();
  w.write('-- Local AstroDB dump\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const objects = db.exec("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")[0]?.values ?? [];
  const later: string[] = [];
  let hasSequence = false;

  const writeRows = (table: string, columns: string[]) => {
    if (columns.length === 0) return;
    const names = columns.map(q).join(', ');
    const stmt = db.prepare(`SELECT ${names} FROM ${q(table)}`);
    try {
      while (stmt.step()) w.write(`INSERT INTO ${q(table)} (${names}) VALUES (${rowOf(stmt).map(sqlLiteral).join(', ')});\n`);
    } finally {
      stmt.free();
    }
  };

  for (const [typeV, nameV, sqlV] of objects) {
    const type = String(typeV);
    const name = String(nameV);
    const sql = String(sqlV);
    if (type !== 'table') {
      later.push(`${sql};\n`);
      continue;
    }
    if (name === 'sqlite_sequence') {
      hasSequence = true;
      continue;
    }
    if (name.startsWith('sqlite_')) continue;
    const t = byName.get(name);
    if (t?.type === 'shadow') continue; // recreated by its virtual table
    w.write(`${sql};\n`);
    if (t) writeRows(name, t.columns.filter((c) => !c.generated).map((c) => c.name));
  }
  if (hasSequence) {
    w.write('DELETE FROM sqlite_sequence;\n');
    writeRows('sqlite_sequence', ['name', 'seq']);
  }
  // Indexes, views and triggers keep their creation order (views before INSTEAD OF triggers).
  const rank = (s: string) => (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s) ? 0 : /^CREATE\s+(TEMP\w*\s+)?VIEW/i.test(s) ? 1 : 2);
  later.sort((a, b) => rank(a) - rank(b));
  for (const s of later) w.write(s);
  w.write('COMMIT;\n');
  return w.end();
}
