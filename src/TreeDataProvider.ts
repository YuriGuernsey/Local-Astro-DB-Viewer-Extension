// src/TreeDataProvider.ts

import * as vscode from 'vscode';
import { Database, SqlValue } from 'sql.js';

export class DatabaseTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | void> = new vscode.EventEmitter<
    TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor(private db: Database) {}

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!this.db) {
      return [];
    }
    try {
      if (!element) {
        // Root level: List all tables
        const tablesResult = this.db.exec("SELECT name FROM sqlite_master WHERE type='table'");
        if (tablesResult.length === 0) {
          return [];
        }
        const tables = tablesResult[0].values.map((row) => row[0] as string);
        return tables.map((tableName) => {
          return new TreeItem(
            tableName,
            vscode.TreeItemCollapsibleState.Collapsed,
            'table'
          );
        });
      } else if (element.contextValue === 'table') {
        // Child level: List all columns in the table
        const columnsResult = this.db.exec(`PRAGMA table_info(${element.label})`);
        if (columnsResult.length === 0) {
          return [];
        }
        const columnsData = columnsResult[0];
        const columns = columnsData.values.map((row) => {
          const [cid, name, type, notnull, dflt_value, pk] = row;
          const columnInfo: ColumnInfo = {
            cid: cid as number | null,
            name: name as string | null,
            type: type as string | null,
            notnull: notnull as number | null,
            dflt_value: dflt_value,
            pk: pk as number | null,
          };
          return columnInfo;
        });
        return columns.map((col) => {
          return new TreeItem(
            col.name || 'Unnamed Column',
            vscode.TreeItemCollapsibleState.None,
            'column',
            col
          );
        });
      } else {
        return [];
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Error fetching data: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

interface ColumnInfo {
  cid: number | null;
  name: string | null;
  type: string | null;
  notnull: number | null;
  dflt_value: any;
  pk: number | null;
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
        this.description = columnInfo.type || 'Unknown';
        this.tooltip = `Type: ${columnInfo.type || 'Unknown'}
Not Null: ${columnInfo.notnull ? 'Yes' : 'No'}
Default Value: ${columnInfo.dflt_value !== null ? columnInfo.dflt_value : 'None'}
Primary Key: ${columnInfo.pk ? 'Yes' : 'No'}`;
      }
    }
  }
}
