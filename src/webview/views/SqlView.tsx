import { useEffect, useRef, useState } from 'preact/hooks';
import { EXPORT_FORMATS, type ExecResult, type HistoryEntry, type ResultSetInfo, type SortSpec } from '../../shared/protocol';
import { quoteIdent, statementAt } from '../../shared/sql';
import { Icon, MenuButton, modKey } from '../components/common';
import { copyText, formatCount, tsvField } from '../format';
import { VirtualGrid } from '../grid/VirtualGrid';
import { loadState, reportError, request, saveState } from '../rpc';
import { createSqlEditor, type SqlEditor } from '../sqlEditor';
import { getState, useStore } from '../store';

function initialSql(): string {
  const saved = loadState().sql;
  if (saved !== undefined) return saved;
  const first = getState().schema.tables.find((t) => t.type !== 'view');
  return first ? `SELECT * FROM ${quoteIdent(first.name)} LIMIT 100;\n` : '';
}

function formatMs(ms: number): string {
  return ms < 1 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function summary(r: ExecResult): string {
  const sets = r.results;
  if (sets.length === 1) {
    const s = sets[0];
    if (s.columns.length) return `${formatCount(s.total)} row${s.total === 1 ? '' : 's'}${s.truncated ? ' (truncated)' : ''}`;
    return `${formatCount(s.rowsModified)} row${s.rowsModified === 1 ? '' : 's'} changed`;
  }
  const changed = sets.reduce((n, s) => n + s.rowsModified, 0);
  return `${sets.length} statements${changed ? ` · ${formatCount(changed)} rows changed` : ''}`;
}

export function SqlView({ visible }: { visible: boolean }) {
  const schema = useStore((s) => s.schema);
  const table = useStore((s) => s.table);
  const editorHost = useRef<HTMLDivElement>(null);
  const gridHost = useRef<HTMLDivElement>(null);
  const editor = useRef<SqlEditor | null>(null);
  const grid = useRef<VirtualGrid | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [activeSet, setActiveSet] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(loadState().showHistory ?? true);
  const [editorHeight, setEditorHeight] = useState(loadState().sqlEditorHeight ?? 220);
  const live = useRef({ result, activeSet, sort });
  live.current = { result, activeSet, sort };

  const run = async (all: boolean) => {
    const ed = editor.current;
    if (!ed || running) return;
    const text = ed.getText();
    const sql = all ? text : (ed.selection() ?? statementAt(text, ed.cursor())?.text ?? '');
    if (!sql.trim()) return;
    setRunning(true);
    try {
      const r = await request('exec', { sql });
      setResult(r);
      const firstWithRows = r.results.findIndex((s) => s.columns.length > 0);
      setActiveSet(firstWithRows >= 0 ? firstWithRows : 0);
      setSort(null);
      setHistory(await request('historyAdd', { sql }));
    } catch (err) {
      setResult({ results: [], error: { message: err instanceof Error ? err.message : String(err), statementIndex: 0, sql }, timeMs: 0, edit: null, schemaChanged: false, notes: [] });
    } finally {
      setRunning(false);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    editor.current = createSqlEditor(editorHost.current!, {
      doc: initialSql(),
      schema: getState().schema,
      defaultTable: getState().table,
      onRun: (all) => void runRef.current(all),
      onChange: (text) => {
        clearTimeout(timer);
        timer = setTimeout(() => saveState({ sql: text }), 400);
      },
    });
    const g = new VirtualGrid({
      editable: false,
      filters: false,
      handlers: {
        onSort: (col) => {
          const set = live.current.result?.results[live.current.activeSet];
          if (!set) return;
          const name = set.columns[col];
          const cur = live.current.sort;
          setSort(cur?.column !== name ? { column: name, dir: 'asc' } : cur.dir === 'asc' ? { column: name, dir: 'desc' } : null);
        },
        onCopy: () => void copyResult(),
      },
    });
    gridHost.current!.append(g.el);
    grid.current = g;
    void request('historyList', undefined).then(setHistory);
    editor.current.focus();
    return () => {
      editor.current?.view.destroy();
      g.dispose();
    };
  }, []);

  useEffect(() => editor.current?.setSchema(schema, table), [schema, table]);
  useEffect(() => {
    if (visible) setTimeout(() => editor.current?.focus(), 0);
  }, [visible]);

  const set: ResultSetInfo | undefined = result?.results[activeSet];

  // Show the active result set in the grid.
  useEffect(() => {
    const g = grid.current!;
    if (!set || set.columns.length === 0) {
      g.setColumns([]);
      g.setSource({ total: 0, fetch: async () => [] });
      return;
    }
    const sortCol = sort ? set.columns.indexOf(sort.column) : -1;
    g.setColumns(
      set.columns.map((name, i) => {
        const sample = set.rows.find((r) => r[i] !== null)?.[i];
        const numeric = typeof sample === 'number' || (typeof sample === 'object' && sample !== null && '$i' in sample);
        return { name, type: '', readOnly: true, numeric, width: Math.max(numeric ? 90 : 140, Math.min(320, name.length * 8 + 48)) };
      }),
      {},
      sortCol >= 0 ? { col: sortCol, dir: sort!.dir } : null,
    );
    g.setSource({
      total: set.total,
      fetch: async (offset, limit) => {
        const rows = !sort && offset + limit <= set.rows.length ? set.rows.slice(offset, offset + limit) : await request('resultRows', { resultId: set.id, offset, limit, sort });
        return rows.map((v) => ({ k: null, v }));
      },
    });
    g.setEmptyText('No rows');
  }, [set, sort]);

  const copyResult = async () => {
    const { result: r, activeSet: i, sort: s } = live.current;
    const rs = r?.results[i];
    const g = grid.current;
    if (!rs || !g) return;
    const ranges = g.selectedCount() ? g.selectedRanges() : [{ from: g.active.row, to: g.active.row + 1 }];
    const lines: string[] = [];
    for (const range of ranges) {
      const rows = await request('resultRows', { resultId: rs.id, offset: range.from, limit: range.to - range.from, sort: s });
      for (const row of rows) lines.push(g.selectedCount() ? row.map((v) => tsvField(copyText(v))).join('\t') : copyText(row[g.active.col]));
    }
    await request('copyText', { text: lines.join('\n') });
  };

  const startDrag = (e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = editorHeight;
    document.body.classList.add('resizing-v');
    const move = (ev: MouseEvent) => setEditorHeight(Math.max(80, Math.min(window.innerHeight - 160, start + ev.clientY - startY)));
    const up = (ev: MouseEvent) => {
      document.body.classList.remove('resizing-v');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saveState({ sqlEditorHeight: Math.max(80, start + ev.clientY - startY) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const exportItems = EXPORT_FORMATS.map((f) => ({
    label: f.label,
    hint: `.${f.ext}`,
    disabled: !set || set.columns.length === 0,
    onSelect: () => set && void request('export', { source: { kind: 'result', resultId: set.id }, format: f.id }).catch((err) => reportError(err, 'Export failed')),
  }));

  return (
    <div class={showHistory ? 'sql-view with-history' : 'sql-view'}>
      <div class="sql-main">
        <div class="toolbar">
          <div class="toolbar-actions left">
            <button class="btn primary" disabled={running} onClick={() => void run(false)} title={`Run the statement at the cursor or the selection (${modKey}Enter)`}>
              <Icon name="play" /> Run
            </button>
            <button class="btn" disabled={running} onClick={() => void run(true)} title={`Run everything (Shift+${modKey}Enter)`}>
              Run all
            </button>
            <MenuButton label="Export results" items={exportItems} disabled={!set || set.columns.length === 0} />
          </div>
          <div class="toolbar-actions">
            <button
              class={showHistory ? 'btn toggled' : 'btn'}
              aria-pressed={showHistory}
              onClick={() => {
                setShowHistory(!showHistory);
                saveState({ showHistory: !showHistory });
              }}
            >
              History
            </button>
          </div>
        </div>
        <div class="sql-editor" style={{ height: `${editorHeight}px` }} ref={editorHost} />
        <div class="splitter" role="separator" aria-orientation="horizontal" onMouseDown={startDrag} />
        <div class="sql-status" aria-live="polite">
          {running && <span class="muted">Running…</span>}
          {!running && result && !result.error && (
            <span class="ok">
              ✓ {summary(result)} · {formatMs(result.timeMs)}
            </span>
          )}
          {!running && result?.error && (
            <span class="err">
              ✗ {result.error.message}
              {result.results.length > 0 || result.error.statementIndex > 0 ? ` (statement ${result.error.statementIndex + 1})` : ''}
            </span>
          )}
          {!running && result?.edit && <span class="muted">· {modKey}Z to undo</span>}
          {result?.notes.map((n) => (
            <span class="muted">· {n}</span>
          ))}
          {!result && !running && (
            <span class="muted">
              {modKey}Enter runs the statement at the cursor · Shift+{modKey}Enter runs all · Ctrl+Space completes
            </span>
          )}
        </div>
        {result && result.results.length > 1 && (
          <div class="result-tabs" role="tablist">
            {result.results.map((s, i) => (
              <button role="tab" aria-selected={i === activeSet} class={i === activeSet ? 'tab active' : 'tab'} onClick={() => setActiveSet(i)} title={s.sql}>
                {i + 1}. {s.columns.length ? `${formatCount(s.total)} rows` : `${formatCount(s.rowsModified)} changed`}
              </button>
            ))}
          </div>
        )}
        <div class="grid-host results" ref={gridHost} hidden={!set || set.columns.length === 0} />
        {set && set.columns.length === 0 && (
          <div class="placeholder small">
            <p>
              Statement ran: {formatCount(set.rowsModified)} row{set.rowsModified === 1 ? '' : 's'} changed in {formatMs(set.timeMs)}.
            </p>
          </div>
        )}
        {set?.truncated && <div class="error-bar">Only the first {formatCount(set.total)} rows are kept (localastrodb.maxResultRows).</div>}
      </div>
      {showHistory && (
        <aside class="history" aria-label="Query history">
          <div class="history-head">
            <b>History</b>
            <button class="link" disabled={history.length === 0} onClick={() => void request('historyClear', undefined).then(setHistory)}>
              Clear
            </button>
          </div>
          <div class="history-list">
            {history.length === 0 && <p class="muted pad">Queries you run appear here.</p>}
            {history.map((h) => (
              <button
                class="history-item"
                title="Load into the editor"
                onClick={() => {
                  editor.current?.setText(h.sql);
                  editor.current?.focus();
                }}
              >
                <pre>{h.sql.split('\n').slice(0, 4).join('\n')}</pre>
                <span class="muted">
                  {h.db} · {new Date(h.ts).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
