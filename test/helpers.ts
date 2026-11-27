import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from '../src/engine/db';
import { DbSession, type SessionOptions } from '../src/engine/session';
import { musicSql } from './fixtures/musicDb';

let sqlPromise: Promise<SqlJsStatic> | null = null;

export function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const wasm = readFileSync(join(__dirname, 'sql-wasm.wasm'));
    sqlPromise = initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
  }
  return sqlPromise;
}

export async function bytesFromSql(sql: string): Promise<Uint8Array> {
  const SQL = await loadSql();
  const db = new SQL.Database();
  db.exec(sql);
  const bytes = db.export();
  db.close();
  return bytes;
}

let musicBytes: Uint8Array | null = null;

export async function musicDb(): Promise<Uint8Array> {
  musicBytes ??= await bytesFromSql(musicSql());
  return musicBytes.slice();
}

export async function session(bytes: Uint8Array, opts: Partial<SessionOptions> = {}): Promise<DbSession> {
  const SQL = await loadSql();
  return new DbSession(SQL, bytes, { readOnly: false, undoBudgetBytes: 64 * 1024 * 1024, maxResultRows: 100000, ...opts });
}

export async function musicSession(opts: Partial<SessionOptions> = {}): Promise<DbSession> {
  return session(await musicDb(), opts);
}

export const fixture = (name: string) => readFileSync(join(__dirname, '..', 'test', 'fixtures', name));
