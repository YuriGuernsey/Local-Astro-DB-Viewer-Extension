import { createWriteStream } from 'node:fs';
import * as vscode from 'vscode';
import { prepareForLoad, type PreparedFile } from '../engine/fileFormat';

export const DB_EXTENSIONS = ['db', 'sqlite', 'sqlite3', 'db3'];
export const DB_FILTERS: Record<string, string[]> = { 'SQLite databases': DB_EXTENSIONS, 'All files': ['*'] };

export function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

export function dirname(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

export function sibling(uri: vscode.Uri, suffix: string): vscode.Uri {
  return uri.with({ path: uri.path + suffix });
}

export function isDatabaseName(path: string): boolean {
  return new RegExp(`\\.(${DB_EXTENSIONS.join('|')})$`, 'i').test(path);
}

export async function statOrNull(uri: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
}

export async function readOrNull(uri: vscode.Uri): Promise<Uint8Array | null> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return null;
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  return code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT';
}

/** The -wal file, or null when there is none. Other read errors propagate: skipping the log would hide commits. */
async function readWal(uri: vscode.Uri): Promise<Uint8Array | null> {
  try {
    return await vscode.workspace.fs.readFile(sibling(uri, '-wal'));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function signature(uri: vscode.Uri): Promise<string> {
  const main = await statOrNull(uri);
  const wal = await statOrNull(sibling(uri, '-wal'));
  return `${main?.mtime}:${main?.size}|${wal?.mtime}:${wal?.size}`;
}

/**
 * Reads a database file together with its -wal file, folded into one image. If either file
 * changes while they are read (say, a checkpoint moves the log into the main file), the pair
 * is read again so the image is never a mix of two states.
 */
export async function readDatabase(uri: vscode.Uri): Promise<{ raw: Uint8Array; prepared: PreparedFile }> {
  for (let attempt = 0; ; attempt++) {
    const before = await signature(uri);
    const raw = await vscode.workspace.fs.readFile(uri);
    const wal = await readWal(uri);
    if (attempt >= 4 || (await signature(uri)) === before) return { raw, prepared: prepareForLoad(raw, wal) };
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
}

/** Writes text chunks to a file, streaming when the target is on a local (or remote-host) disk. */
export async function writeChunks(target: vscode.Uri, chunks: string[]): Promise<void> {
  if (target.scheme === 'file') {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(target.fsPath);
      out.on('error', reject);
      out.on('finish', resolve);
      for (const c of chunks) out.write(c);
      out.end();
    });
    return;
  }
  const enc = new TextEncoder();
  const parts = chunks.map((c) => enc.encode(c));
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    total.set(p, off);
    off += p.length;
  }
  await vscode.workspace.fs.writeFile(target, total);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Escapes glob metacharacters in a file name for RelativePattern. */
export function escapeGlob(name: string): string {
  return name.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}
