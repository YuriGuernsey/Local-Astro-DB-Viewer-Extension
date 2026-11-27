import * as vscode from 'vscode';
import { registerCommands } from './host/commands';
import { readSettings } from './host/document';
import { SqliteEditorProvider } from './host/editorProvider';
import { SidebarProvider } from './host/sidebar';
import { QueryHistory, RecentDatabases } from './host/state';
import { DbStatusBar } from './host/statusBar';
import { registerTextHint } from './host/textHint';

export interface ExtensionApi {
  /** Exposed for the integration tests. */
  provider: SqliteEditorProvider;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const recent = new RecentDatabases(context.globalState);
  const history = new QueryHistory(context.globalState);
  const provider = new SqliteEditorProvider(context, recent, history);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(SqliteEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );

  const sidebar = new SidebarProvider(recent);
  const treeView = vscode.window.createTreeView('localastrodbTreeView', { treeDataProvider: sidebar });
  context.subscriptions.push(treeView, sidebar.attach(treeView));

  const status = new DbStatusBar(provider);
  context.subscriptions.push(status);

  registerCommands(context, provider, recent, sidebar);
  registerTextHint(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('localastrodb')) return;
      const settings = readSettings();
      for (const doc of provider.allDocuments()) {
        if (e.affectsConfiguration('localastrodb.openReadOnly')) void doc.setReadOnly(settings.readOnly);
        if (e.affectsConfiguration('localastrodb.undoMemoryLimitMB') || e.affectsConfiguration('localastrodb.maxResultRows')) {
          void doc.setLimits(settings);
        }
      }
      status.update();
      sidebar.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sidebar.refresh()),
  );
  return { provider };
}

export function deactivate(): void {
  // Documents (and their worker threads) are disposed by VS Code when their editors close.
}
