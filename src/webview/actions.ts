// App-level actions: loading, host events, navigation.
import type { Tab } from '../shared/protocol';
import { loadState, onHostEvent, reportError, request, saveState } from './rpc';
import { getState, setState } from './store';

let countsTimer: ReturnType<typeof setTimeout> | undefined;

export async function initApp(): Promise<void> {
  try {
    const r = await request('init', undefined);
    const saved = loadState();
    const tables = r.schema.tables;
    const table = tables.find((t) => t.name === saved.table)?.name ?? tables.find((t) => t.type !== 'view')?.name ?? tables[0]?.name ?? null;
    const tab = (['data', 'structure', 'sql', 'er', 'compare'] as Tab[]).includes(saved.tab as Tab) ? (saved.tab as Tab) : 'data';
    setState({
      info: r.info,
      schema: r.schema,
      table,
      tab: tab === 'compare' ? 'data' : tab,
      maxResultRows: r.settings.maxResultRows,
      loading: false,
    });
    if (!r.info.openError) void loadCounts();
  } catch (err) {
    setState({ loading: false, info: null });
    reportError(err, 'Could not open the database');
  }
}

export async function loadCounts(): Promise<void> {
  try {
    setState({ counts: await request('counts', undefined) });
  } catch {
    // counts are informative only
  }
}

function scheduleCounts(): void {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => void loadCounts(), 300);
}

export async function refreshSchema(): Promise<void> {
  const schema = await request('schema', undefined);
  setState((s) => {
    const exists = schema.tables.some((t) => t.name === s.table);
    return { schema, table: exists ? s.table : (schema.tables[0]?.name ?? null) };
  });
}

export function selectTable(name: string, tab?: Tab): void {
  const s = getState();
  const next: Tab = tab ?? (s.tab === 'structure' ? 'structure' : 'data');
  setState({ table: name, tab: next, newTable: false });
  saveState({ table: name, tab: next });
}

export function setTab(tab: Tab): void {
  setState({ tab, newTable: false });
  saveState({ tab });
}

export async function runCompare(): Promise<void> {
  setTab('compare');
  try {
    const result = await request('compareWith', undefined);
    if (result) setState({ compare: result });
  } catch (err) {
    reportError(err, 'Compare failed');
  }
}

export function listenToHost(): void {
  onHostEvent((ev) => {
    switch (ev.type) {
      case 'changed':
        if (ev.schema) void refreshSchema().catch(() => undefined);
        setState((s) => ({ dataVersion: s.dataVersion + 1 }));
        scheduleCounts();
        break;
      case 'reloaded':
        void refreshSchema().catch(() => undefined);
        setState((s) => ({ dataVersion: s.dataVersion + 1, compare: null }));
        scheduleCounts();
        break;
      case 'navigate':
        setState((s) => ({ tab: ev.tab, newTable: false, table: ev.table ?? s.table }));
        saveState({ tab: ev.tab });
        if (ev.action === 'compare') void runCompare();
        break;
      case 'readOnly':
        setState((s) => ({ info: s.info ? { ...s.info, readOnly: ev.readOnly, readOnlyReason: ev.reason } : s.info }));
        break;
    }
  });
}
