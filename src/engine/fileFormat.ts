// SQLite file-format helpers: header checks and folding a write-ahead log into the
// main file, so databases in WAL mode open with all committed data.
// Format reference: https://www.sqlite.org/fileformat.html

const MAGIC = 'SQLite format 3\u0000';

export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true; // an empty file is a valid empty database
  if (bytes.length < 100) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

export function isWalMode(bytes: Uint8Array): boolean {
  return bytes.length >= 100 && (bytes[18] === 2 || bytes[19] === 2);
}

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/** WAL checksum over `len` bytes (a multiple of 8), continuing from s0/s1. */
function walChecksum(b: Uint8Array, off: number, len: number, bigEndian: boolean, s: [number, number]): [number, number] {
  let s0 = s[0];
  let s1 = s[1];
  for (let i = off; i < off + len; i += 8) {
    const x0 = bigEndian ? readU32(b, i) : ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
    const x1 = bigEndian ? readU32(b, i + 4) : ((b[i + 7] << 24) | (b[i + 6] << 16) | (b[i + 5] << 8) | b[i + 4]) >>> 0;
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

export interface WalMergeResult {
  bytes: Uint8Array;
  framesApplied: number;
}

/**
 * Applies the committed frames of a WAL file to a copy of the main database file.
 * Frames after the last valid commit (or with stale salts / bad checksums) are ignored,
 * exactly as SQLite does during recovery.
 */
export function mergeWal(main: Uint8Array, wal: Uint8Array): WalMergeResult {
  if (wal.length < 32) return { bytes: main, framesApplied: 0 };
  const magic = readU32(wal, 0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return { bytes: main, framesApplied: 0 };
  const bigEndian = (magic & 1) === 1;
  const pageSize = readU32(wal, 8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return { bytes: main, framesApplied: 0 };
  const salt1 = readU32(wal, 16);
  const salt2 = readU32(wal, 20);
  let sum = walChecksum(wal, 0, 24, bigEndian, [0, 0]);
  if (sum[0] !== readU32(wal, 24) || sum[1] !== readU32(wal, 28)) return { bytes: main, framesApplied: 0 };

  const frameSize = 24 + pageSize;
  const frames: { pgno: number; offset: number }[] = [];
  let committed = 0; // number of frames up to and including the last commit
  let dbPages = 0;
  for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
    if (readU32(wal, off + 8) !== salt1 || readU32(wal, off + 12) !== salt2) break;
    sum = walChecksum(wal, off, 8, bigEndian, sum);
    sum = walChecksum(wal, off + 24, pageSize, bigEndian, sum);
    if (sum[0] !== readU32(wal, off + 16) || sum[1] !== readU32(wal, off + 20)) break;
    frames.push({ pgno: readU32(wal, off), offset: off + 24 });
    const commitSize = readU32(wal, off + 4);
    if (commitSize > 0) {
      committed = frames.length;
      dbPages = commitSize;
    }
  }
  if (committed === 0) return { bytes: main, framesApplied: 0 };

  const out = new Uint8Array(dbPages * pageSize);
  out.set(main.subarray(0, Math.min(main.length, out.length)));
  for (let i = 0; i < committed; i++) {
    const { pgno, offset } = frames[i];
    if (pgno < 1 || pgno > dbPages) continue;
    out.set(wal.subarray(offset, offset + pageSize), (pgno - 1) * pageSize);
  }
  return { bytes: out, framesApplied: committed };
}

export interface PreparedFile {
  bytes: Uint8Array;
  walMode: boolean;
  walFramesApplied: number;
}

/** Normalizes a database file (plus optional -wal contents) so sql.js can load it. */
export function prepareForLoad(main: Uint8Array, wal: Uint8Array | null): PreparedFile {
  const walMode = isWalMode(main);
  let bytes = main;
  let framesApplied = 0;
  if (wal && wal.length > 0) {
    const merged = mergeWal(main, wal);
    bytes = merged.bytes;
    framesApplied = merged.framesApplied;
  }
  if (walMode || framesApplied > 0) {
    if (bytes === main) bytes = main.slice();
    // sql.js has no shared-memory WAL support; the log is folded in, so use rollback mode in memory.
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return { bytes, walMode, walFramesApplied: framesApplied };
}

/** Restores the WAL journal-mode marker on bytes about to be written back. */
export function restoreJournalMode(bytes: Uint8Array, walMode: boolean): Uint8Array {
  if (walMode && bytes.length >= 100) {
    bytes[18] = 2;
    bytes[19] = 2;
  }
  return bytes;
}
