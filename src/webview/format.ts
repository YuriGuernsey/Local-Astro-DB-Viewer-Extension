// Display, editing and clipboard text for cell values.
import type { CellValue, ColumnInfo, InputValue } from '../shared/protocol';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : n.toLocaleString('en-US');
}

export type CellKind = 'null' | 'num' | 'text' | 'blob';

export function cellKind(v: CellValue): CellKind {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'text';
  if ('$i' in v || '$f' in v) return 'num';
  if ('$b' in v) return 'blob';
  return 'text';
}

/** One-line text for the grid. */
export function displayText(v: CellValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300).replace(/\r?\n/g, ' ↵ ') + '…' : v.replace(/\r?\n/g, ' ↵ ');
  if ('$i' in v) return v.$i;
  if ('$f' in v) return v.$f;
  if ('$b' in v) return `BLOB · ${formatBytes(v.n)}`;
  return v.$t.slice(0, 300).replace(/\r?\n/g, ' ↵ ') + '…';
}

/** Whether the value is complete (not a truncated preview). */
export function isComplete(v: CellValue): boolean {
  if (v === null || typeof v !== 'object') return true;
  if ('$t' in v) return false;
  if ('$b' in v) return v.$b.length / 2 === v.n;
  return true;
}

/** Text shown in an editor for a complete value. */
export function editText(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if ('$i' in v) return v.$i;
  if ('$f' in v) return v.$f;
  if ('$b' in v) return v.$b;
  return v.$t;
}

/** Plain text for the clipboard. */
export function copyText(v: CellValue): string {
  return v === null ? '' : editText(v);
}

export function tsvField(s: string): string {
  return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Parses TSV (as copied from spreadsheets) into rows of fields. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  while (i < t.length) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === '\t') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else {
      field += c;
      i++;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

const BIG_INT = /^[-+]?\d{16,}$/;

/** Converts typed text into a value to write. Big integers keep full precision. */
export function inputFromText(text: string, col: ColumnInfo | undefined): InputValue {
  if (col && (col.affinity === 'INTEGER' || col.affinity === 'NUMERIC') && BIG_INT.test(text.trim())) {
    const n = Number(text);
    if (!Number.isSafeInteger(n)) return { $i: text.trim().replace(/^\+/, '') };
  }
  return text;
}

export function isNumericColumn(col: ColumnInfo): boolean {
  return col.affinity === 'INTEGER' || col.affinity === 'REAL' || col.affinity === 'NUMERIC';
}

export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export function sameValue(a: CellValue, b: InputValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof b === 'string') return typeof a !== 'object' && String(a) === b;
  if (typeof b === 'number') return a === b;
  if ('$i' in b) return typeof a === 'object' && '$i' in a && a.$i === b.$i;
  if ('$b' in b) return typeof a === 'object' && '$b' in a && a.$b === b.$b && a.n === b.$b.length / 2;
  return false;
}
