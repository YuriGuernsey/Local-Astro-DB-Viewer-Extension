// Persistent per-user state: recently opened databases and SQL query history.
import * as vscode from 'vscode';
import type { HistoryEntry } from '../shared/protocol';

const RECENT_KEY = 'localastrodb.recent';
const HISTORY_KEY = 'localastrodb.history';
const MAX_RECENT = 10;
const MAX_HISTORY = 200;

export class RecentDatabases {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): vscode.Uri[] {
    return this.state.get<string[]>(RECENT_KEY, []).map((s) => vscode.Uri.parse(s));
  }

  async add(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const next = [key, ...this.state.get<string[]>(RECENT_KEY, []).filter((s) => s !== key)].slice(0, MAX_RECENT);
    await this.state.update(RECENT_KEY, next);
    this._onDidChange.fire();
  }

  async remove(uri: vscode.Uri): Promise<void> {
    await this.state.update(
      RECENT_KEY,
      this.state.get<string[]>(RECENT_KEY, []).filter((s) => s !== uri.toString()),
    );
    this._onDidChange.fire();
  }

  async clear(): Promise<void> {
    await this.state.update(RECENT_KEY, []);
    this._onDidChange.fire();
  }
}

export class QueryHistory {
  constructor(private readonly state: vscode.Memento) {}

  list(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  async add(sql: string, db: string): Promise<HistoryEntry[]> {
    const text = sql.trim();
    if (!text) return this.list();
    const rest = this.list().filter((e) => !(e.sql === text && e.db === db));
    const next = [{ sql: text, db, ts: Date.now() }, ...rest].slice(0, MAX_HISTORY);
    await this.state.update(HISTORY_KEY, next);
    return next;
  }

  async clear(): Promise<HistoryEntry[]> {
    await this.state.update(HISTORY_KEY, []);
    return [];
  }
}
