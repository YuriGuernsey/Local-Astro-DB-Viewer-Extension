// Minimal global store with a Preact hook.
import { useEffect, useState } from 'preact/hooks';
import type { CompareResult, DbInfo, SchemaInfo, Tab, TableInfo } from '../shared/protocol';

export interface AppState {
  info: DbInfo | null;
  schema: SchemaInfo;
  counts: Record<string, number | null>;
  tab: Tab;
  table: string | null;
  /** Main area shows the New Table form instead of the current tab. */
  newTable: boolean;
  /** Bumped whenever data changes (edits, undo, reload): views refetch. */
  dataVersion: number;
  compare: CompareResult | null;
  maxResultRows: number;
  loading: boolean;
}

type Listener = () => void;

let state: AppState = {
  info: null,
  schema: { tables: [] },
  counts: {},
  tab: 'data',
  table: null,
  newTable: false,
  dataVersion: 0,
  compare: null,
  maxResultRows: 100000,
  loading: true,
};
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function useStore<T>(select: (s: AppState) => T): T {
  const [value, setValue] = useState(() => select(state));
  useEffect(() => {
    const update = () => setValue(() => select(state));
    listeners.add(update);
    update();
    return () => void listeners.delete(update);
  }, []);
  return value;
}

export function currentTable(s: AppState = state): TableInfo | null {
  return s.schema.tables.find((t) => t.name === s.table) ?? null;
}

export function isReadOnly(s: AppState = state): boolean {
  return !!s.info?.readOnly;
}
