import { useEffect, useRef, useState } from 'preact/hooks';
import { EXPORT_FORMATS, type CellValue, type GridRow, type RowRange, type RowsQuery, type TableInfo } from '../../shared/protocol';
import { Icon, MenuButton, modKey } from '../components/common';
import { copyText, formatCount, inputFromText, isComplete, isNumericColumn, parseTsv, sameValue, tsvField } from '../format';
import { VirtualGrid, type GridColumn } from '../grid/VirtualGrid';
import { loadState, reportError, request, saveState } from '../rpc';
import { currentTable, useStore } from '../store';
import { RowPanel, type RowPanelTarget } from './RowPanel';

const emptyQuery = (table: string): RowsQuery => ({ table, filters: {}, search: '', sort: null });

function defaultWidth(name: string, type: string, numeric: boolean, badge: boolean): number {
  const base = numeric ? 96 : 170;
  // Header shows: [badge] name type ▲
  const header = name.length * 7.5 + type.length * 6 + (badge ? 18 : 0) + 44;
  return Math.round(Math.max(base, Math.min(300, header)));
}

export function gridColumns(t: TableInfo): GridColumn[] {
  const widths = loadState().widths?.[t.name] ?? {};
  const fk = new Map<string, string>();
  for (const f of t.foreignKeys) f.from.forEach((c, i) => fk.set(c, `${f.table}.${f.to[i] ?? 'id'}`));
  return t.columns.map((c) => ({
    name: c.name,
    type: c.type,
    numeric: isNumericColumn(c),
    badge: c.pk ? 'pk' : fk.has(c.name) ? 'fk' : undefined,
    badgeTitle: c.pk ? 'Primary key' : fk.has(c.name) ? `References ${fk.get(c.name)}` : c.generated ? 'Generated column (read-only)' : undefined,
    readOnly: c.generated,
    width: widths[c.name] ?? defaultWidth(c.name, c.type, isNumericColumn(c), c.pk > 0 || fk.has(c.name)),
  }));
}

export function DataView({ visible }: { visible: boolean }) {
  const table = useStore((s) => currentTable(s));
  const dbReadOnly = useStore((s) => !!s.info?.readOnly);
  const dataVersion = useStore((s) => s.dataVersion);
  const counts = useStore((s) => s.counts);
  const hostRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<VirtualGrid | null>(null);
  const queries = useRef(new Map<string, RowsQuery>());
  const loadGen = useRef(0);
  const [query, setQuery] = useState<RowsQuery | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selection, setSelection] = useState({ count: 0, row: 0, col: 0 });
  const [panel, setPanel] = useState<RowPanelTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editable = !!table && !table.readOnly && !dbReadOnly;
  const live = useRef({ table, query, editable });
  live.current = { table, query, editable };

  const load = async (q: RowsQuery, keepPosition: boolean) => {
    const gen = ++loadGen.current;
    try {
      const count = await request('count', q);
      if (gen !== loadGen.current) return;
      setError(null);
      setTotal(count);
      const grid = gridRef.current!;
      const source = { total: count, fetch: (offset: number, limit: number) => request('rows', { ...q, offset, limit }) };
      if (keepPosition) {
        grid.setSource(source, true);
      } else grid.setSource(source);
      grid.setEmptyText(Object.values(q.filters).some((f) => f.trim()) || q.search.trim() ? 'No rows match the filters' : 'This table is empty');
    } catch (err) {
      if (gen !== loadGen.current) return;
      setTotal(0);
      setError(err instanceof Error ? err.message : String(err));
      gridRef.current?.setSource({ total: 0, fetch: async () => [] });
    }
  };

  const updateQuery = (q: RowsQuery) => {
    queries.current.set(q.table, q);
    setQuery(q);
    void load(q, false);
  };

  // ----- grid callbacks (read the latest state through `live`) -----
  const keysFor = async (ranges: RowRange[]) => {
    const q = live.current.query!;
    const rows = await request('rowsForRanges', { query: q, ranges, full: false });
    return rows.map((r) => r.k!).filter(Boolean);
  };

  const write = async (changes: { key: CellValue[]; column: string; value: ReturnType<typeof inputFromText> }[]) => {
    const t = live.current.table!;
    try {
      await request('updateCells', { table: t.name, changes });
    } catch (err) {
      reportError(err, 'Edit failed');
      gridRef.current?.refresh();
    }
  };

  const copySelection = async () => {
    const grid = gridRef.current!;
    const q = live.current.query;
    if (!q) return;
    try {
      let text: string;
      if (grid.selectedCount() > 0) {
        const rows = await request('rowsForRanges', { query: q, ranges: grid.selectedRanges(), full: true });
        text = rows.map((r) => r.v.map((v) => tsvField(copyText(v))).join('\t')).join('\n');
      } else {
        const { row, col } = grid.active;
        const data = grid.getRow(row);
        if (!data) return;
        let v = data.v[col];
        if (!isComplete(v)) {
          const full = data.k ? await request('getRow', { table: q.table, key: data.k }) : null;
          v = full ? full[col] : v;
        }
        text = copyText(v);
      }
      await request('copyText', { text });
    } catch (err) {
      reportError(err, 'Copy failed');
    }
  };

  const paste = async (row: number, col: number) => {
    const { table: t, editable: canEdit } = live.current;
    if (!t || !canEdit) return;
    try {
      const text = await request('readClipboard', undefined);
      const block = parseTsv(text);
      const grid = gridRef.current!;
      const height = Math.min(block.length, grid.total - row);
      if (height <= 0) return;
      const keyRows = height === 1 && grid.getRow(row)?.k ? [grid.getRow(row)!] : await request('rowsForRanges', { query: live.current.query!, ranges: [{ from: row, to: row + height }], full: false });
      const changes: { key: CellValue[]; column: string; value: ReturnType<typeof inputFromText> }[] = [];
      block.slice(0, height).forEach((fields, r) => {
        const key = keyRows[r]?.k;
        if (!key) return;
        // A single value pasted into one cell keeps embedded tabs/newlines.
        const values = block.length === 1 && fields.length > 1 && t.columns.length - col === 1 ? [text] : fields;
        values.forEach((f, c) => {
          const column = t.columns[col + c];
          if (!column || column.generated) return;
          changes.push({ key, column: column.name, value: inputFromText(f, column) });
        });
      });
      if (changes.length) await write(changes);
    } catch (err) {
      reportError(err, 'Paste failed');
    }
  };

  const deleteRanges = async (ranges: RowRange[]) => {
    const { table: t, editable: canEdit } = live.current;
    if (!t || !canEdit) return;
    try {
      const keys = await keysFor(ranges);
      if (!keys.length) return;
      if (keys.length > 1000) {
        const ok = await request('confirm', { message: `Delete ${keys.length.toLocaleString('en-US')} rows from ${t.name}?`, detail: 'You can undo this.', confirm: 'Delete' });
        if (!ok) return;
      }
      await request('deleteRows', { table: t.name, keys });
      gridRef.current?.clearSelection();
    } catch (err) {
      reportError(err, 'Delete failed');
    }
  };

  useEffect(() => {
    const grid = new VirtualGrid({
      editable: false,
      filters: true,
      handlers: {
        onSort: (col) => {
          const { table: t, query: q } = live.current;
          if (!t || !q) return;
          const name = t.columns[col].name;
          const sort =
            q.sort?.column !== name ? { column: name, dir: 'asc' as const } : q.sort.dir === 'asc' ? { column: name, dir: 'desc' as const } : null;
          grid.setSort(sort ? { col, dir: sort.dir } : null);
          updateQuery({ ...q, sort });
        },
        onFilter: (col, value) => {
          const { table: t, query: q } = live.current;
          if (!t || !q) return;
          const filters = { ...q.filters, [t.columns[col].name]: value };
          if (!value.trim()) delete filters[t.columns[col].name];
          updateQuery({ ...q, filters });
        },
        onBeforeEdit: (row, col, data) => {
          const t = live.current.table!;
          const column = t.columns[col];
          if (column.generated) {
            void request('notify', { message: `"${column.name}" is a generated column and can't be edited.`, level: 'info' });
            return false;
          }
          const v = data.v[col];
          if (!isComplete(v) || (v !== null && typeof v === 'object' && '$b' in v)) {
            setPanel({ mode: 'edit', row, key: data.k!, focus: column.name });
            return false;
          }
          return true;
        },
        onCommit: (row, col, text, data) => {
          const t = live.current.table!;
          const column = t.columns[col];
          const value = inputFromText(text, column);
          if (sameValue(data.v[col], value) || !data.k) return;
          grid.patchCell(row, col, typeof value === 'object' && value !== null && '$i' in value ? value : (value as CellValue));
          void write([{ key: data.k, column: column.name, value }]);
        },
        onSetNull: (row, col, data) => {
          const t = live.current.table!;
          if (data.v[col] === null || !data.k) return;
          grid.patchCell(row, col, null);
          void write([{ key: data.k, column: t.columns[col].name, value: null }]);
        },
        onOpenRow: (row, data) => {
          if (data?.k) setPanel({ mode: 'edit', row, key: data.k });
          else if (data) setPanel({ mode: 'view', row, values: data.v });
        },
        onDeleteRows: (ranges) => void deleteRanges(ranges),
        onCopy: () => void copySelection(),
        onPaste: (row, col) => void paste(row, col),
        onSelectionChange: () => setSelection({ count: grid.selectedCount(), row: grid.active.row, col: grid.active.col }),
        onResize: (col, width) => {
          const t = live.current.table;
          if (!t) return;
          const widths = loadState().widths ?? {};
          saveState({ widths: { ...widths, [t.name]: { ...(widths[t.name] ?? {}), [t.columns[col].name]: width } } });
        },
        onSearch: () => searchRef.current?.focus(),
      },
    });
    hostRef.current!.append(grid.el);
    gridRef.current = grid;
    return () => grid.dispose();
  }, []);

  // Table switched.
  useEffect(() => {
    const grid = gridRef.current!;
    setPanel(null);
    if (!table) {
      grid.setColumns([]);
      grid.setSource({ total: 0, fetch: async () => [] });
      setQuery(null);
      setTotal(null);
      return;
    }
    const q = queries.current.get(table.name) ?? emptyQuery(table.name);
    // Drop filters/sort on columns that no longer exist.
    const names = new Set(table.columns.map((c) => c.name));
    const filters = Object.fromEntries(Object.entries(q.filters).filter(([k]) => names.has(k)));
    const sort = q.sort && names.has(q.sort.column) ? q.sort : null;
    const fixed = { ...q, filters, sort };
    queries.current.set(table.name, fixed);
    setQuery(fixed);
    grid.setEditable(editable);
    const sortCol = sort ? table.columns.findIndex((c) => c.name === sort.column) : -1;
    grid.setColumns(gridColumns(table), filters, sortCol >= 0 ? { col: sortCol, dir: sort!.dir } : null);
    void load(fixed, false);
  }, [table?.name, table?.sql, table?.columns.length]);

  useEffect(() => {
    gridRef.current?.setEditable(editable);
  }, [editable]);

  // Data changed (edit, undo, reload).
  const firstVersion = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === firstVersion.current || !query) return;
    void load(query, true);
  }, [dataVersion]);

  // Ctrl/Cmd+F focuses the search box while the view is visible.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const onSearch = (value: string) => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const q = live.current.query;
      if (q) updateQuery({ ...q, search: value });
    }, 250);
  };

  const afterInsert = async (key: CellValue[] | null) => {
    const q = live.current.query;
    if (!key || !q) return;
    try {
      const index = await request('findRow', { query: q, key });
      if (index >= 0) {
        const count = await request('count', q);
        gridRef.current?.refresh(count);
        gridRef.current?.setActive(index, 0);
        gridRef.current?.focus();
      }
    } catch {
      // the new row is outside the current filter
    }
  };

  if (!table) {
    return (
      <div class="placeholder">
        <p>This database has no tables yet.</p>
      </div>
    );
  }

  const filtered = !!query && (Object.values(query.filters).some((f) => f.trim()) || !!query.search.trim());
  const unfiltered = counts[table.name];
  const kind = table.type === 'view' ? 'view' : table.type === 'virtual' ? 'virtual table' : table.withoutRowid ? 'table · without rowid' : 'table';
  const activeCol = table.columns[selection.col];

  return (
    <div class="data-view">
      <div class="toolbar">
        <div class="toolbar-title">
          <Icon name={table.type === 'view' ? 'view' : 'table'} />
          <b>{table.name}</b>
          <span class="muted">{kind}</span>
          {table.readOnly && (
            <span class="pill" title={table.readOnlyReason}>
              read-only
            </span>
          )}
        </div>
        <div class="search">
          <Icon name="search" />
          <input
            ref={searchRef}
            class="input"
            placeholder={`Search all columns (${modKey}F)`}
            aria-label="Search all columns"
            defaultValue={query?.search ?? ''}
            key={table.name}
            onInput={(e) => onSearch((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                (e.target as HTMLInputElement).value = '';
                onSearch('');
              } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                gridRef.current?.focus();
              }
            }}
          />
        </div>
        <div class="toolbar-actions">
          {editable && (
            <button class="btn" onClick={() => setPanel({ mode: 'insert' })} title="Insert a row">
              + Row
            </button>
          )}
          {editable && (
            <button
              class="btn"
              disabled={selection.count === 0}
              onClick={() => void deleteRanges(gridRef.current!.selectedRanges())}
              title="Delete the selected rows (Delete)"
            >
              Delete{selection.count > 0 ? ` ${formatCount(selection.count)}` : ''}
            </button>
          )}
          <MenuButton
            label="Export"
            title={filtered ? 'Export the filtered rows' : 'Export the table'}
            items={[
              ...EXPORT_FORMATS.map((f) => ({
                label: f.label,
                hint: `.${f.ext}`,
                onSelect: () =>
                  void request('export', { source: { kind: 'table', table: table.name, query: filtered ? query! : undefined }, format: f.id }).catch((err) =>
                    reportError(err, 'Export failed'),
                  ),
              })),
              { label: 'Whole database as SQL dump', hint: '.sql', onSelect: () => void request('exportDump', undefined) },
              { label: 'Schema as TypeScript types', onSelect: () => void request('copyTypes', undefined).catch((err) => reportError(err)) },
            ]}
          />
          <button class="btn icon-btn" title="Reload rows" aria-label="Reload rows" onClick={() => query && void load(query, true)}>
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div class="grid-host" ref={hostRef} />
      {error && <div class="error-bar">{error}</div>}
      <div class="statusbar">
        <span>
          {total === null ? '…' : filtered ? `${formatCount(total)} of ${formatCount(unfiltered)} rows` : `${formatCount(total)} rows`}
        </span>
        {selection.count > 0 && <span>{formatCount(selection.count)} selected</span>}
        {total ? (
          <span class="muted">
            Row {formatCount(selection.row + 1)}
            {activeCol ? ` · ${activeCol.name}` : ''}
          </span>
        ) : null}
        <span class="spacer" />
        <span class="muted hint">
          {editable ? `Enter edit · Space row · Del NULL/delete · ${modKey}Z undo` : table.readOnlyReason ?? (dbReadOnly ? 'Read-only' : '')}
        </span>
      </div>
      {panel && (
        <RowPanel
          table={table}
          target={panel}
          readOnly={!editable}
          onClose={() => {
            setPanel(null);
            gridRef.current?.focus();
          }}
          onInserted={(key) => void afterInsert(key)}
          onNavigate={(delta) => {
            if (panel.mode === 'insert') return;
            const grid = gridRef.current!;
            const next = panel.row + delta;
            if (next < 0 || next >= grid.total) return;
            grid.setActive(next);
            const data = grid.getRow(next);
            if (data?.k) setPanel({ mode: 'edit', row: next, key: data.k });
            else if (data) setPanel({ mode: 'view', row: next, values: data.v });
          }}
        />
      )}
    </div>
  );
}

export type { GridRow };
