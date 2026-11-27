import { useMemo, useRef, useState } from 'preact/hooks';
import type { Tab, TableInfo } from '../shared/protocol';
import { selectTable, setTab } from './actions';
import { Icon } from './components/common';
import { formatBytes, formatCount } from './format';
import { request } from './rpc';
import { setState, useStore } from './store';
import { CompareView } from './views/CompareView';
import { DataView } from './views/DataView';
import { ErView } from './views/ErView';
import { NewTableView } from './views/NewTableView';
import { SqlView } from './views/SqlView';
import { StructureView } from './views/StructureView';

const TABS: { id: Tab; label: string }[] = [
  { id: 'data', label: 'Data' },
  { id: 'structure', label: 'Structure' },
  { id: 'sql', label: 'SQL' },
  { id: 'er', label: 'ER Diagram' },
  { id: 'compare', label: 'Compare' },
];

export function App() {
  const loading = useStore((s) => s.loading);
  const info = useStore((s) => s.info);
  if (loading) return <div class="splash">Opening database…</div>;
  if (!info) return <div class="splash">The database could not be opened.</div>;
  if (info.openError) return <OpenError fileName={info.fileName} message={info.openError} />;
  return (
    <div class="app">
      <TopBar />
      <Sidebar />
      <Main />
    </div>
  );
}

function OpenError({ fileName, message }: { fileName: string; message: string }) {
  return (
    <div class="splash">
      <div class="open-error">
        <h2>Can't open {fileName}</h2>
        <p>{message}</p>
        <div class="row-gap">
          <button class="btn primary" onClick={() => void request('reopenAsText', undefined)}>
            Open with the text editor
          </button>
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  const info = useStore((s) => s.info)!;
  const tab = useStore((s) => s.tab);
  const newTable = useStore((s) => s.newTable);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab=${next.id}]`)?.focus();
  };
  return (
    <header class="topbar">
      <div class="file-info" title={decodeURIComponent(info.uri)}>
        <Icon name="db" />
        <b>{info.fileName}</b>
        <span class="muted">
          {formatBytes(info.size)} · SQLite {info.sqliteVersion}
        </span>
        {info.readOnly && (
          <span class="pill" title={info.readOnlyReason}>
            read-only
          </span>
        )}
      </div>
      <nav class="tabs" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {TABS.map((t) => {
          const selected = t.id === tab && !newTable;
          return (
            <button
              role="tab"
              data-tab={t.id}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              class={selected ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
      <div class="topbar-end" />
    </header>
  );
}

function Sidebar() {
  const schema = useStore((s) => s.schema);
  const counts = useStore((s) => s.counts);
  const table = useStore((s) => s.table);
  const newTable = useStore((s) => s.newTable);
  const readOnly = useStore((s) => !!s.info?.readOnly);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const f = filter.trim().toLowerCase();
  const visible = useMemo(() => schema.tables.filter((t) => !f || t.name.toLowerCase().includes(f)), [schema, f]);
  const tables = visible.filter((t) => t.type !== 'view');
  const views = visible.filter((t) => t.type === 'view');
  const ordered = [...tables, ...views];

  const onKeyDown = (e: KeyboardEvent) => {
    const i = ordered.findIndex((t) => t.name === table);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(ordered.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ordered.length - 1;
    if (next >= 0 && ordered[next]) {
      e.preventDefault();
      selectTable(ordered[next].name);
      listRef.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(ordered[next].name)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const item = (t: TableInfo) => {
    const selected = t.name === table && !newTable;
    return (
      <div
        role="option"
        aria-selected={selected}
        data-name={t.name}
        class={selected ? 'side-item selected' : 'side-item'}
        title={t.readOnlyReason ? `${t.name} — ${t.readOnlyReason}` : t.name}
        onClick={() => selectTable(t.name)}
      >
        <Icon name={t.type === 'view' ? 'view' : t.type === 'virtual' ? 'virtual' : 'table'} />
        <span class="side-name">{t.name}</span>
        <span class="side-count">{formatCount(counts[t.name])}</span>
      </div>
    );
  };

  return (
    <aside class="sidebar">
      <input
        class="input sidebar-filter"
        placeholder="Filter tables"
        aria-label="Filter tables"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            listRef.current?.focus();
          }
        }}
      />
      <div class="sidebar-list" role="listbox" aria-label="Tables and views" tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
        <div class="side-section">
          Tables <span>{tables.length}</span>
        </div>
        {tables.map(item)}
        {tables.length === 0 && <div class="side-empty">{f ? 'No match' : 'No tables yet'}</div>}
        {views.length > 0 && (
          <div class="side-section">
            Views <span>{views.length}</span>
          </div>
        )}
        {views.map(item)}
      </div>
      <footer class="sidebar-footer">
        {!readOnly && (
          <button class="btn" onClick={() => setState({ newTable: true })} title="Create a table">
            + New table
          </button>
        )}
        <button class="btn" onClick={() => setTab('sql')} title="Open the SQL editor">
          SQL
        </button>
      </footer>
    </aside>
  );
}

/** Views stay mounted once shown, so the grid position and SQL editor survive tab switches. */
function Main() {
  const tab = useStore((s) => s.tab);
  const newTable = useStore((s) => s.newTable);
  const mounted = useRef(new Set<Tab>());
  mounted.current.add(tab);
  const show = (t: Tab) => !newTable && tab === t;
  return (
    <main class="main">
      {newTable && <NewTableView />}
      {mounted.current.has('data') && (
        <div class="view" hidden={!show('data')}>
          <DataView visible={show('data')} />
        </div>
      )}
      {mounted.current.has('structure') && (
        <div class="view" hidden={!show('structure')}>
          <StructureView />
        </div>
      )}
      {mounted.current.has('sql') && (
        <div class="view" hidden={!show('sql')}>
          <SqlView visible={show('sql')} />
        </div>
      )}
      {mounted.current.has('er') && (
        <div class="view" hidden={!show('er')}>
          <ErView visible={show('er')} />
        </div>
      )}
      {mounted.current.has('compare') && (
        <div class="view" hidden={!show('compare')}>
          <CompareView />
        </div>
      )}
    </main>
  );
}
