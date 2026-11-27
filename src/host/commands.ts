import * as vscode from 'vscode';
import { EXPORT_FORMATS, type HostEvent, type Tab } from '../shared/protocol';
import { readSettings, type SqliteDocument } from './document';
import type { SqliteEditorProvider } from './editorProvider';
import { basename, DB_FILTERS, formatBytes, statOrNull } from './files';
import { copyTypes, exportDump, exportSource } from './operations';
import type { SidebarProvider } from './sidebar';
import type { RecentDatabases } from './state';
import { WorkerClient } from './workerClient';

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: SqliteEditorProvider,
  recent: RecentDatabases,
  sidebar: SidebarProvider,
): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }),
    );

  const pickDatabase = async (title = 'Open Database'): Promise<vscode.Uri | undefined> => {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: DB_FILTERS, openLabel: 'Open', title });
    return picked?.[0];
  };

  /** The database a command applies to: the focused or last used one, or one the user opens now. */
  const targetDocument = async (): Promise<SqliteDocument | undefined> => {
    const doc = provider.activeDocument();
    if (doc && !doc.info.openError) return doc;
    const choice = await vscode.window.showInformationMessage('Open a SQLite database first.', 'Open Database…');
    if (choice !== 'Open Database…') return undefined;
    const uri = await pickDatabase();
    return uri ? provider.open(uri) : undefined;
  };

  const navigate = async (tab: Tab, extra: Partial<Extract<HostEvent, { type: 'navigate' }>> = {}) => {
    const doc = await targetDocument();
    if (doc) provider.show(doc, { type: 'navigate', tab, ...extra });
  };

  reg('localastrodb.openDatabase', async () => {
    const uri = await pickDatabase();
    if (uri) await provider.open(uri);
  });

  reg('localastrodb.openWith', async (uri?: vscode.Uri) => {
    uri ??= vscode.window.activeTextEditor?.document.uri ?? (await pickDatabase());
    if (uri) await provider.open(uri);
  });

  reg('localastrodb.openRecent', async (uri: vscode.Uri) => {
    if (!(await statOrNull(uri))) {
      void vscode.window.showWarningMessage(`${basename(uri)} no longer exists.`);
      await recent.remove(uri);
      return;
    }
    await provider.open(uri);
  });

  reg('localastrodb.newDatabase', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, 'database.sqlite') : undefined,
      filters: { 'SQLite database': ['sqlite', 'db', 'sqlite3', 'db3'] },
      saveLabel: 'Create',
      title: 'New SQLite Database',
    });
    if (!target) return;
    const worker = new WorkerClient(vscode.Uri.joinPath(context.extensionUri, 'dist', 'worker.js').fsPath);
    try {
      const settings = readSettings();
      await worker.call('open', { bytes: new Uint8Array(0), options: { ...settings, readOnly: false } });
      await vscode.workspace.fs.writeFile(target, await worker.call('serialize', undefined));
    } finally {
      worker.dispose();
    }
    const doc = await provider.open(target);
    if (doc) provider.show(doc, { type: 'navigate', tab: 'sql' });
  });

  reg('localastrodb.runQuery', () => navigate('sql'));
  reg('localastrodb.showErDiagram', () => navigate('er'));
  reg('localastrodb.compare', () => navigate('compare', { action: 'compare' }));

  reg('localastrodb.exportTable', async (table?: string) => {
    const doc = await targetDocument();
    if (!doc) return;
    if (typeof table !== 'string') {
      const schema = await doc.call('schema', undefined);
      const counts = await doc.call('counts', undefined);
      const pick = await vscode.window.showQuickPick(
        schema.tables
          .filter((t) => t.columns.length > 0)
          .map((t) => ({
            label: t.name,
            description: `${t.type === 'table' ? '' : t.type + ' · '}${counts[t.name] ?? '?'} rows`,
          })),
        { title: `Export from ${doc.name}`, placeHolder: 'Table or view to export' },
      );
      if (!pick) return;
      table = pick.label;
    }
    const format = await vscode.window.showQuickPick(
      EXPORT_FORMATS.map((f) => ({ label: f.label, description: `.${f.ext}`, id: f.id })),
      { title: `Export ${table}`, placeHolder: 'Format' },
    );
    if (format) await exportSource(doc, { kind: 'table', table }, format.id);
  });

  reg('localastrodb.exportDump', async () => {
    const doc = await targetDocument();
    if (doc) await exportDump(doc);
  });

  reg('localastrodb.copyTypes', async () => {
    const doc = await targetDocument();
    if (doc) await copyTypes(doc);
  });

  reg('localastrodb.reload', async () => {
    const doc = await targetDocument();
    if (!doc) return;
    if (doc.isDirty) {
      const ok = await vscode.window.showWarningMessage(
        `Reload ${doc.name} from disk?`,
        { modal: true, detail: 'Your unsaved changes will be lost.' },
        'Reload',
      );
      if (ok !== 'Reload') return;
      provider.show(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      return;
    }
    await doc.reload(false);
    vscode.window.setStatusBarMessage(`$(sync) Reloaded ${doc.name} (${formatBytes(doc.info.size)})`, 3000);
  });

  reg('localastrodb.clearRecent', () => recent.clear());
  reg('localastrodb.refreshSidebar', () => sidebar.refresh());

  // Kept for scripts that used the 1.x command ids.
  reg('localastrodb.openQueryEditor', () => navigate('sql'));
}
