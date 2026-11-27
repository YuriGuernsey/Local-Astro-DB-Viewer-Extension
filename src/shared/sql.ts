// SQL helpers shared by the worker and the webview: quoting, tokenizing,
// statement splitting and read-only classification.
import type { Affinity } from './protocol';

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteString(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'";
}

/** Column affinity from a declared type, following https://sqlite.org/datatype3.html#determination_of_column_affinity */
export function affinityOf(declaredType: string): Affinity {
  const t = declaredType.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'punct' | 'param';

export interface Token {
  type: TokenType;
  text: string;
  from: number;
  to: number;
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** Tokenizes SQL, skipping whitespace and comments. Unterminated strings/comments run to the end. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const from = i;
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: c === "'" ? 'string' : 'quoted', text: sql.slice(from, i), from, to: i });
    } else if (c === '[') {
      const from = i;
      const end = sql.indexOf(']', i);
      i = end < 0 ? n : end + 1;
      tokens.push({ type: 'quoted', text: sql.slice(from, i), from, to: i });
    } else if ((c === 'x' || c === 'X') && sql[i + 1] === "'") {
      const from = i;
      const end = sql.indexOf("'", i + 2);
      i = end < 0 ? n : end + 1;
      tokens.push({ type: 'string', text: sql.slice(from, i), from, to: i });
    } else if (isWordStart(c)) {
      const from = i;
      while (i < n && isWordChar(sql[i])) i++;
      tokens.push({ type: 'word', text: sql.slice(from, i), from, to: i });
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const from = i;
      while (i < n && /[0-9a-fA-FxX._]/.test(sql[i])) {
        if ((sql[i] === 'e' || sql[i] === 'E') && (sql[i + 1] === '+' || sql[i + 1] === '-')) i++;
        i++;
      }
      tokens.push({ type: 'number', text: sql.slice(from, i), from, to: i });
    } else if (c === '?' || c === ':' || c === '@' || c === '$') {
      const from = i;
      i++;
      while (i < n && isWordChar(sql[i])) i++;
      tokens.push({ type: 'param', text: sql.slice(from, i), from, to: i });
    } else {
      const from = i;
      const two = sql.slice(i, i + 2);
      i += ['<=', '>=', '<>', '!=', '==', '||', '<<', '>>', '->'].includes(two) ? (sql.slice(i, i + 3) === '->>' ? 3 : 2) : 1;
      tokens.push({ type: 'punct', text: sql.slice(from, i), from, to: i });
    }
  }
  return tokens;
}

export interface StatementRange {
  /** Offset of the first token of the statement. */
  from: number;
  /** Offset just after the terminating semicolon (or the last token). */
  to: number;
  text: string;
}

/**
 * Splits a script into statements. Semicolons inside strings, comments and
 * CREATE TRIGGER ... BEGIN ... END bodies don't end a statement.
 */
export function splitStatements(sql: string): StatementRange[] {
  const tokens = tokenize(sql);
  const out: StatementRange[] = [];
  let start = -1;
  let words: string[] = [];
  let depth = 0;
  let lastEnd = 0;
  let prevEnd = 0;
  const flush = (end: number) => {
    if (start >= 0) out.push({ from: start, to: end, text: sql.slice(start, end) });
    start = -1;
    words = [];
    depth = 0;
    prevEnd = end;
  };
  // A statement starts at the comments right above it, not at a comment trailing the previous one.
  const startOf = (firstToken: number): number => {
    let i = prevEnd;
    while (i < firstToken && (sql[i] === ' ' || sql[i] === '\t')) i++;
    if (prevEnd > 0 && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 || nl > firstToken ? firstToken : nl + 1;
    }
    while (i < firstToken && /\s/.test(sql[i])) i++;
    return i;
  };
  for (const tok of tokens) {
    if (tok.type === 'punct' && tok.text === ';') {
      const inTrigger = isTrigger(words);
      if (!inTrigger || depth <= 0) {
        if (start >= 0) flush(tok.to);
        else prevEnd = tok.to;
        continue;
      }
    }
    if (start < 0) start = startOf(tok.from);
    lastEnd = tok.to;
    if (tok.type === 'word') {
      const w = tok.text.toUpperCase();
      if (words.length < 4) words.push(w);
      if (isTrigger(words)) {
        if (w === 'BEGIN' || w === 'CASE') depth++;
        else if (w === 'END') depth--;
      }
    }
  }
  if (start >= 0) flush(lastEnd);
  return out;
}

function isTrigger(words: string[]): boolean {
  if (words[0] !== 'CREATE') return false;
  return words[1] === 'TRIGGER' || ((words[1] === 'TEMP' || words[1] === 'TEMPORARY') && words[2] === 'TRIGGER');
}

/** The statement under the cursor, or the closest one before it. */
export function statementAt(sql: string, offset: number): StatementRange | null {
  const statements = splitStatements(sql);
  if (statements.length === 0) return null;
  let previous: StatementRange | null = null;
  for (const s of statements) {
    if (offset >= s.from && offset <= s.to) return s;
    if (s.to <= offset) previous = s;
  }
  if (previous) {
    // Cursor sits after a statement: prefer it unless the next one starts on the same line.
    const next = statements.find((s) => s.from > offset);
    if (next && !sql.slice(offset, next.from).includes('\n') && sql.slice(previous.to, offset).includes('\n')) return next;
    return previous;
  }
  return statements[0];
}

const READ_ONLY_PRAGMAS = new Set([
  'analysis_limit',
  'application_id',
  'auto_vacuum',
  'automatic_index',
  'busy_timeout',
  'cache_size',
  'case_sensitive_like',
  'cell_size_check',
  'collation_list',
  'compile_options',
  'data_version',
  'database_list',
  'encoding',
  'foreign_key_check',
  'foreign_key_list',
  'foreign_keys',
  'freelist_count',
  'function_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'journal_mode',
  'journal_size_limit',
  'legacy_alter_table',
  'locking_mode',
  'max_page_count',
  'mmap_size',
  'module_list',
  'page_count',
  'page_size',
  'pragma_list',
  'query_only',
  'quick_check',
  'recursive_triggers',
  'reverse_unordered_selects',
  'schema_version',
  'secure_delete',
  'stats',
  'synchronous',
  'table_info',
  'table_list',
  'table_xinfo',
  'temp_store',
  'user_version',
]);

/**
 * True when the statement can't change the database. Conservative: anything
 * unknown is treated as a write (which only costs an undo snapshot).
 */
export function isReadOnlyStatement(sql: string): boolean {
  const tokens = tokenize(sql);
  if (tokens.length === 0) return true;
  const first = tokens[0].type === 'word' ? tokens[0].text.toUpperCase() : '';
  if (first === 'SELECT' || first === 'VALUES' || first === 'EXPLAIN') return true;
  if (first === 'WITH') {
    return !tokens.some((t) => t.type === 'word' && /^(INSERT|UPDATE|DELETE|REPLACE)$/i.test(t.text));
  }
  if (first === 'PRAGMA') {
    if (tokens.some((t) => t.type === 'punct' && t.text === '=')) return false;
    let name = tokens[1]?.text ?? '';
    if (tokens[2]?.text === '.') name = tokens[3]?.text ?? '';
    name = name.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
    if (!READ_ONLY_PRAGMAS.has(name)) return false;
    // "PRAGMA foreign_keys(1)" style setters.
    const hasArg = tokens.some((t) => t.type === 'punct' && t.text === '(');
    const takesTableArg = /^(table_|index_|foreign_key_)/.test(name) || name === 'integrity_check' || name === 'quick_check';
    return !hasArg || takesTableArg;
  }
  return false;
}

/** True when a statement can't be undone without a snapshot (VACUUM, setter pragmas). */
export function isOpaqueWrite(sql: string): boolean {
  const tokens = tokenize(sql);
  const first = tokens[0]?.type === 'word' ? tokens[0].text.toUpperCase() : '';
  if (first === 'VACUUM') return true;
  if (first === 'PRAGMA') return !isReadOnlyStatement(sql);
  return false;
}
