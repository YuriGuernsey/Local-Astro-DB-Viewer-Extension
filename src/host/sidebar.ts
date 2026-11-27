// Activity Bar view: one-click actions, recent and workspace databases, and the most-used settings.
import * as vscode from 'vscode';
import { basename, DB_EXTENSIONS, dirname } from './files';
import type { RecentDatabases } from './state';

type Node =
  | { kind: 'action'; label: string; icon: string; command: string; tooltip: string }
  | { kind: 'group'; id: 'recent' | 'workspace' | 'settings'; label: string }
  | { kind: 'file'; uri: vscode.Uri; group: 'recent' | 'workspace' }
  | { kind: 'empty'; label: string }
  | { kind: 'setting'; key: string; label: string; tooltip: string; defaultValue: boolean }
  | { kind: 'moreSettings' };

const ACTIONS: Node[] = [
  { kind: 'action', label: 'Open a database…', icon: 'folder-opened', command: 'localastrodb.openDatabase', tooltip: 'Open a .db, .sqlite, .sqlite3 or .db3 file' },
  { kind: 'action', label: 'New database', icon: 'new-file', command: 'localastrodb.newDatabase', tooltip: 'Create an empty SQLite database' },
  { kind: 'action', label: 'Run SQL query', icon: 'play', command: 'localastrodb.runQuery', tooltip: 'Open the SQL editor of the current database' },
  { kind: 'action', label: 'Show ER diagram', icon: 'type-hierarchy', command: 'localastrodb.showErDiagram', tooltip: 'Diagram built from the foreign keys' },
  { kind: 'action', label: 'Compare with another database…', icon: 'diff', command: 'localastrodb.compare', tooltip: 'Schema and row differences' },
  { kind: 'action', label: 'Export table…', icon: 'export', command: 'localastrodb.exportTable', tooltip: 'CSV, JSON, SQL or Markdown' },
  { kind: 'action', label: 'Export SQL dump…', icon: 'file-code', command: 'localastrodb.exportDump', tooltip: 'The whole database as SQL statements' },
  { kind: 'action', label: 'Copy schema as TypeScript types', icon: 'symbol-interface', command: 'localastrodb.copyTypes', tooltip: 'One interface per table and view' },
];

const SETTINGS: Node[] = [
  { kind: 'setting', key: 'openReadOnly', label: 'Open read-only', tooltip: 'Open databases read-only (no edits, no schema changes).', defaultValue: false },
  { kind: 'setting', key: 'statusBar.enabled', label: 'Status bar info', tooltip: 'Show size, table count and SQLite version in the status bar.', defaultValue: true },
  {
    kind: 'setting',
    key: 'showOpenAsTextHint',
    label: 'Open-as-text hint',
    tooltip: 'Offer to open SQLite files that were opened in the text editor.',
    defaultValue: true,
  },
  { kind: 'moreSettings' },
];

export class SidebarProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private workspaceDbs: vscode.Uri[] | null = null;

  constructor(private readonly recent: RecentDatabases) {
    recent.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  attach(view: vscode.TreeView<Node>): vscode.Disposable {
    return view.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        if (node.kind !== 'setting') continue;
        await vscode.workspace
          .getConfiguration('localastrodb')
          .update(node.key, state === vscode.TreeItemCheckboxState.Checked, vscode.ConfigurationTarget.Global);
      }
    });
  }

  refresh(): void {
    this.workspaceDbs = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return [
        ...ACTIONS,
        { kind: 'group', id: 'recent', label: 'Recent databases' },
        { kind: 'group', id: 'workspace', label: 'Workspace databases' },
        { kind: 'group', id: 'settings', label: 'Settings' },
      ];
    }
    if (node.kind !== 'group') return [];
    if (node.id === 'settings') return SETTINGS;
    if (node.id === 'recent') {
      const list = this.recent.list();
      return list.length ? list.map((uri) => ({ kind: 'file', uri, group: 'recent' })) : [{ kind: 'empty', label: 'No recent databases' }];
    }
    if (!vscode.workspace.workspaceFolders?.length) return [{ kind: 'empty', label: 'No folder open' }];
    this.workspaceDbs ??= (
      await vscode.workspace.findFiles(`**/*.{${DB_EXTENSIONS.join(',')}}`, '**/node_modules/**', 200)
    ).sort((a, b) => a.path.localeCompare(b.path));
    return this.workspaceDbs.length
      ? this.workspaceDbs.map((uri) => ({ kind: 'file', uri, group: 'workspace' }))
      : [{ kind: 'empty', label: 'No databases found' }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'action': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.command = { command: node.command, title: node.label };
        item.tooltip = node.tooltip;
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(
          node.label,
          node.id === 'workspace' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = `${node.id}Group`;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(basename(node.uri));
        item.iconPath = new vscode.ThemeIcon('database');
        item.resourceUri = node.uri;
        const dir = vscode.workspace.asRelativePath(dirname(node.uri), true);
        item.description = node.group === 'workspace' ? vscode.workspace.asRelativePath(dirname(node.uri), false) : dir;
        item.tooltip = node.uri.scheme === 'file' ? node.uri.fsPath : node.uri.toString();
        item.command = { command: 'localastrodb.openRecent', title: 'Open', arguments: [node.uri] };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(node.label);
        item.description = '';
        return item;
      }
      case 'setting': {
        const item = new vscode.TreeItem(node.label);
        const value = vscode.workspace.getConfiguration('localastrodb').get<boolean>(node.key, node.defaultValue);
        item.checkboxState = value ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        item.tooltip = node.tooltip;
        return item;
      }
      case 'moreSettings': {
        const item = new vscode.TreeItem('More settings…');
        item.iconPath = new vscode.ThemeIcon('settings-gear');
        item.command = { command: 'workbench.action.openSettings', title: 'Settings', arguments: ['localastrodb'] };
        return item;
      }
    }
  }
}
