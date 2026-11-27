// Thin typed helpers over sql.js that always read 64-bit integers as BigInt.
import type { Database, SqlJsStatic, Statement } from 'sql.js';
import { bindable, type RawValue } from './values';

export type { Database, SqlJsStatic, Statement };

/** Current row of a stepped statement, with INTEGER values as bigint. */
export function rowOf(stmt: Statement): RawValue[] {
  return (stmt as unknown as { get(p: null, c: { useBigInt: boolean }): RawValue[] }).get(null, { useBigInt: true });
}

export function bindAll(stmt: Statement, params: readonly RawValue[]): void {
  if (params.length) stmt.bind(params.map(bindable));
}

export function all(db: Database, sql: string, params: readonly RawValue[] = []): RawValue[][] {
  const stmt = db.prepare(sql);
  try {
    bindAll(stmt, params);
    const rows: RawValue[][] = [];
    while (stmt.step()) rows.push(rowOf(stmt));
    return rows;
  } finally {
    stmt.free();
  }
}

export function one(db: Database, sql: string, params: readonly RawValue[] = []): RawValue[] | undefined {
  const stmt = db.prepare(sql);
  try {
    bindAll(stmt, params);
    return stmt.step() ? rowOf(stmt) : undefined;
  } finally {
    stmt.free();
  }
}

export function scalar(db: Database, sql: string, params: readonly RawValue[] = []): RawValue {
  return one(db, sql, params)?.[0] ?? null;
}

export function num(v: RawValue): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
}

export function run(db: Database, sql: string, params: readonly RawValue[] = []): void {
  const stmt = db.prepare(sql);
  try {
    bindAll(stmt, params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

/** Runs `fn` in a transaction, rolling back when it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.run('SAVEPOINT sqlite_viewer_tx');
  try {
    const result = fn();
    db.run('RELEASE sqlite_viewer_tx');
    return result;
  } catch (err) {
    db.run('ROLLBACK TO sqlite_viewer_tx');
    db.run('RELEASE sqlite_viewer_tx');
    throw err;
  }
}

/** The in-memory file name sql.js uses for a database (needed for ATTACH). */
export function fileNameOf(db: Database): string {
  return (db as unknown as { filename: string }).filename;
}
