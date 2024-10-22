// src/TreeDataProvider.ts

import * as vscode from 'vscode';
import * as sqlite3 from 'sqlite3';

export class DatabaseTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> =
    new vscode.EventEmitter<TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private db: sqlite3.Database) {}

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    const dbAll = <T>(sql: string, params?: any[]): Promise<T[]> => {
      return new Promise<T[]>((resolve, reject) => {
        this.db.all(sql, params || [], (err, rows: T[]) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        });
      });
    };

    try {
      if (!element) {
        // No parent, return tables
        const tables = await dbAll<TableInfo>(`SELECT name FROM sqlite_master WHERE type='table'`);

        return tables.map(
          (table) => new TreeItem(table.name, vscode.TreeItemCollapsibleState.Collapsed, 'table')
        );
      } else if (element.contextValue === 'table') {
        // Return columns for the table
        const columns = await dbAll<ColumnInfo>(`PRAGMA table_info(${element.label})`);

        return columns.map(
          (col) =>
            new TreeItem(
              col.name,
              vscode.TreeItemCollapsibleState.None,
              'column',
              col
            )
        );
      } else {
        return [];
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error fetching data: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

interface TableInfo {
  name: string;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: any;
  pk: number;
}

class TreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly columnInfo?: ColumnInfo
  ) {
    super(label, collapsibleState);

    if (contextValue === 'table') {
      this.iconPath = new vscode.ThemeIcon('database');
      this.command = {
        command: 'localastrodb.viewTableData',
        title: 'View Table Data',
        arguments: [label],
      };
    } else if (contextValue === 'column') {
      this.iconPath = new vscode.ThemeIcon('symbol-field');
      if (columnInfo) {
        this.description = columnInfo.type;
        this.tooltip = `Type: ${columnInfo.type}
Not Null: ${columnInfo.notnull ? 'Yes' : 'No'}
Default Value: ${columnInfo.dflt_value !== null ? columnInfo.dflt_value : 'None'}
Primary Key: ${columnInfo.pk ? 'Yes' : 'No'}
Auto Increment: ${columnInfo.pk && columnInfo.type.toLowerCase() === 'integer' ? 'Yes' : 'No'}`;
      }
    }
  }
}
