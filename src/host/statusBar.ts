import * as vscode from 'vscode';
import type { SqliteDocument } from './document';
import type { SqliteEditorProvider } from './editorProvider';
import { formatBytes } from './files';

/** Size, table count and SQLite version of the focused database. */
export class DbStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('localastrodb.status', vscode.StatusBarAlignment.Right, 100);
  private readonly sub: vscode.Disposable;

  constructor(private readonly provider: SqliteEditorProvider) {
    this.item.name = 'Local AstroDB';
    this.item.command = 'localastrodb.runQuery';
    this.sub = provider.onDidChangeActive(() => this.update());
  }

  update(): void {
    const enabled = vscode.workspace.getConfiguration('localastrodb').get<boolean>('statusBar.enabled', true);
    const doc: SqliteDocument | undefined = this.provider.focusedDocument();
    if (!enabled || !doc || doc.info.openError) {
      this.item.hide();
      return;
    }
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const parts = [plural(doc.tableCount, 'table'), formatBytes(doc.info.size), `SQLite ${doc.info.sqliteVersion}`];
    this.item.text = `$(database) ${parts.join(' · ')}${doc.readOnly ? ' $(lock)' : ''}`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**${doc.name}**`,
        `${plural(doc.tableCount, 'table')}, ${plural(doc.viewCount, 'view')}`,
        `${formatBytes(doc.info.size)} on disk · page size ${doc.info.pageSize} · ${doc.info.encoding}`,
        doc.readOnly ? `Read-only: ${doc.info.readOnlyReason ?? ''}` : '',
        '',
        'Click to open the SQL editor',
      ]
        .filter((l, i, a) => l !== '' || a[i - 1] !== '')
        .join('  \n'),
    );
    this.item.show();
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
