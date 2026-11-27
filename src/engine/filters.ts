// Translates the grid's per-column filters and free-text search into a WHERE clause.
//
// Filter syntax (per column):
//   abc      contains "abc" (case-insensitive for ASCII)
//   =abc     equals            !=abc   not equal (NULLs included)
//   >5 <5 >=5 <=10            comparisons (numbers compare numerically)
//   null     IS NULL           !null   IS NOT NULL
//   empty    empty string      !empty  anything but the empty string
//   !abc     does not contain "abc"
import type { ColumnInfo, SortSpec, TableInfo } from '../shared/protocol';
import { quoteIdent as q } from '../shared/sql';
import { parseNumber, placeholder, type RawValue } from './values';

export interface Where {
  sql: string;
  params: RawValue[];
}

const NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

function likePattern(text: string): string {
  return '%' + text.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

function operand(text: string, col: ColumnInfo | undefined): RawValue {
  const v = text.trim();
  const quoted = /^'(.*)'$/s.exec(v) ?? /^"(.*)"$/s.exec(v);
  if (quoted) return quoted[1];
  if (NUMBER_RE.test(v) && col?.affinity !== 'TEXT') return parseNumber(v);
  return v;
}

/** One filter expression → SQL condition, or null when the filter is empty. */
export function filterCondition(column: string, filter: string, col?: ColumnInfo): Where | null {
  const f = filter.trim();
  if (!f) return null;
  const c = q(column);
  const lower = f.toLowerCase();
  if (lower === 'null') return { sql: `${c} IS NULL`, params: [] };
  if (lower === '!null') return { sql: `${c} IS NOT NULL`, params: [] };
  if (lower === 'empty') return { sql: `${c} = ''`, params: [] };
  if (lower === '!empty') return { sql: `${c} IS NOT ''`, params: [] };
  const m = /^(>=|<=|!=|<>|==|=|>|<)([\s\S]*)$/.exec(f);
  if (m) {
    const value = operand(m[2], col);
    const ph = placeholder(value);
    switch (m[1]) {
      case '=':
      case '==':
        return { sql: `${c} = ${ph}`, params: [value] };
      case '!=':
      case '<>':
        return { sql: `${c} IS NOT ${ph}`, params: [value] };
      default:
        return { sql: `${c} ${m[1]} ${ph}`, params: [value] };
    }
  }
  if (f.startsWith('!') && f.length > 1) {
    return { sql: `(${c} IS NULL OR ${c} NOT LIKE ? ESCAPE '\\')`, params: [likePattern(f.slice(1))] };
  }
  return { sql: `${c} LIKE ? ESCAPE '\\'`, params: [likePattern(f)] };
}

export function buildWhere(t: TableInfo, filters: Record<string, string>, search: string): Where {
  const parts: string[] = [];
  const params: RawValue[] = [];
  for (const [column, filter] of Object.entries(filters)) {
    const col = t.columns.find((c) => c.name === column);
    if (!col) continue;
    const cond = filterCondition(column, filter, col);
    if (cond) {
      parts.push(cond.sql);
      params.push(...cond.params);
    }
  }
  const s = search.trim();
  if (s && t.columns.length) {
    const pattern = likePattern(s);
    parts.push('(' + t.columns.map((col) => `${q(col.name)} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (let i = 0; i < t.columns.length; i++) params.push(pattern);
  }
  return { sql: parts.join(' AND '), params };
}

/** Columns that identify a row: the rowid, or the primary key of a WITHOUT ROWID table. */
export function keyColumns(t: TableInfo): string[] {
  if (t.type === 'view' || t.type === 'virtual') return [];
  if (!t.withoutRowid && t.rowidName) return [t.rowidName];
  return t.pk;
}

export function orderBy(t: TableInfo, sort: SortSpec | null): string {
  const keys = keyColumns(t).map(q);
  const parts: string[] = [];
  if (sort && t.columns.some((c) => c.name === sort.column)) {
    parts.push(`${q(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  // The key keeps paging stable when the sort column has duplicates.
  parts.push(...keys);
  return parts.length ? ' ORDER BY ' + parts.join(', ') : '';
}
