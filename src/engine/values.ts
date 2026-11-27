// Conversion between raw SQLite values (as returned by sql.js with useBigInt) and the
// JSON-safe CellValue / InputValue used by the UI.
import type { Affinity, CellValue, InputValue } from '../shared/protocol';

/** A raw value read from or written to SQLite. */
export type RawValue = null | number | bigint | string | Uint8Array;

/** Text longer than this is truncated in the grid. */
export const GRID_TEXT_LIMIT = 2000;
/** Bytes of a BLOB previewed in the grid. */
export const GRID_BLOB_LIMIT = 48;
/** BLOBs up to this size are sent whole to the row panel. */
export const FULL_BLOB_LIMIT = 1024 * 1024;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export function toHex(bytes: Uint8Array, limit = Infinity): string {
  const n = Math.min(bytes.length, limit);
  let s = '';
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(text: string): Uint8Array {
  let hex = text.trim();
  const m = /^[xX]'([\s\S]*)'$/.exec(hex);
  if (m) hex = m[1];
  else if (/^0x/i.test(hex)) hex = hex.slice(2);
  hex = hex.replace(/[\s:-]/g, '');
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('Invalid hex value.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function encodeCell(v: unknown, mode: 'grid' | 'full' = 'grid'): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : { $i: v.toString() };
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.isNaN(v) ? null : { $f: v > 0 ? 'Infinity' : '-Infinity' };
  if (typeof v === 'string') {
    return mode === 'grid' && v.length > GRID_TEXT_LIMIT ? { $t: v.slice(0, GRID_TEXT_LIMIT), n: v.length } : v;
  }
  if (v instanceof Uint8Array) {
    return { $b: toHex(v, mode === 'grid' ? GRID_BLOB_LIMIT : FULL_BLOB_LIMIT), n: v.length };
  }
  return String(v);
}

/** Decodes a key or value previously produced by encodeCell (keys are never truncated). */
export function decodeCell(v: CellValue): RawValue {
  if (v === null || typeof v === 'number' || typeof v === 'string') return v;
  if ('$i' in v) return BigInt(v.$i);
  if ('$f' in v) return v.$f.startsWith('-') ? -Infinity : Infinity;
  if ('$b' in v) {
    if (v.$b.length / 2 !== v.n) throw new Error('Cannot use a truncated BLOB as a key.');
    return fromHex(v.$b);
  }
  if ('$t' in v) throw new Error('Cannot use truncated text as a key.');
  return null;
}

const NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const INTEGER_RE = /^[-+]?\d+$/;

/**
 * Decodes a value typed in the UI. Strings are bound as text and SQLite applies the
 * column affinity; for columns without a declared type, numeric-looking text is stored
 * as a number, which is what people expect when typing in a grid.
 */
export function decodeInput(v: InputValue, affinity: Affinity, declaredType: string): RawValue {
  if (v === null || typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (affinity === 'BLOB' && declaredType.trim() === '' && NUMBER_RE.test(v.trim())) {
      return parseNumber(v.trim());
    }
    return v;
  }
  if ('$i' in v) return BigInt(v.$i);
  if ('$b' in v) return fromHex(v.$b);
  return null;
}

export function parseNumber(text: string): number | bigint {
  if (INTEGER_RE.test(text)) {
    const b = BigInt(text);
    return b <= MAX_SAFE && b >= MIN_SAFE ? Number(b) : b;
  }
  return Number(text);
}

/**
 * Placeholder for a bound value. sql.js binds bigint as text, so 64-bit integers go
 * through CAST(? AS INTEGER), which converts exactly.
 */
export function placeholder(v: RawValue): string {
  return typeof v === 'bigint' ? 'CAST(? AS INTEGER)' : '?';
}

/** Value as accepted by sql.js bind(): bigint becomes its decimal text (see placeholder()). */
export function bindable(v: RawValue): null | number | string | Uint8Array {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/** SQL literal for dumps and INSERT exports. */
export function sqlLiteral(v: RawValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NULL';
    if (!Number.isFinite(v)) return v > 0 ? '9e999' : '-9e999';
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
  return "X'" + toHex(v) + "'";
}

/** Plain-text rendering used by CSV, Markdown and clipboard copies. */
export function rawToText(v: RawValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : '-Infinity';
  return toHex(v);
}

/** SQLite's cross-type ordering: NULL < numbers < text < blobs. */
export function compareRaw(a: RawValue, b: RawValue): number {
  const rank = (v: RawValue) => (v === null ? 0 : typeof v === 'number' || typeof v === 'bigint' ? 1 : typeof v === 'string' ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) {
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
      const na = Number(a);
      const nb = Number(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    return (a as number) - (b as number);
  }
  if (ra === 2) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  const ba = a as Uint8Array;
  const bb = b as Uint8Array;
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return ba[i] - bb[i];
  return ba.length - bb.length;
}
