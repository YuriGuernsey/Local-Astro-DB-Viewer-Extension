// src/extension.ts
import * as vscode from 'vscode';
import * as sqlite3 from 'sqlite3';
import { promisify } from 'util';
import * as path from 'path';
import { DatabaseTreeDataProvider } from './TreeDataProvider';

let db: sqlite3.Database | null = null;
let dbPath: string | null = null;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('localastrodbViewer.openDatabase', openDatabase),
    vscode.commands.registerCommand('localastrodbViewer.openQueryEditor', openQueryEditor),
    vscode.commands.registerCommand('localastrodbViewer.refresh', refreshTreeView),
    vscode.commands.registerCommand('localastrodbViewer.viewTableData', viewTableData)
  );
}

async function openDatabase() {
  const uri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Database Files': ['db'] }
  });

  if (uri && uri[0]) {
    dbPath = uri[0].fsPath;
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        vscode.window.showErrorMessage(`Failed to open database: ${err.message}`);
        return;
      }
      vscode.window.showInformationMessage(`Opened database: ${dbPath}`);
      initializeTreeView();
    });
  }
}

function initializeTreeView() {
  if (db) {
    const treeDataProvider = new DatabaseTreeDataProvider(db);
    vscode.window.registerTreeDataProvider('localastrodbTreeView', treeDataProvider);
    treeDataProvider.refresh();
  }
}

function refreshTreeView() {
  if (db) {
    const treeDataProvider = new DatabaseTreeDataProvider(db);
    vscode.window.registerTreeDataProvider('localastrodbTreeView', treeDataProvider);
    treeDataProvider.refresh();
  } else {
    vscode.window.showErrorMessage('No database is currently open. Please open a database first.');
  }
}

async function openQueryEditor() {
  if (!db) {
    vscode.window.showErrorMessage('No database is currently open. Please open a database first.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'localastrodbQueryEditor',
    'Query Editor',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  const cspSource = panel.webview.cspSource;
  const htmlContent = getQueryEditorContent(cspSource);
  panel.webview.html = htmlContent;

  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === 'executeQuery') {
        try {
          const dbAll = <T>(sql: string) => promisify(db!.all.bind(db))(sql) as Promise<T[]>;
          const rows = await dbAll<any>(message.query);

          panel.webview.postMessage({ command: 'queryResult', data: rows });
        } catch (err) {
          if (err instanceof Error) {
            panel.webview.postMessage({ command: 'queryError', error: err.message });
          } else {
            panel.webview.postMessage({ command: 'queryError', error: 'An unknown error occurred.' });
          }
        }
      }
    },
    undefined,
    []
  );
}

function getQueryEditorContent(cspSource: string): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Query Editor</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; script-src 'unsafe-inline' https://unpkg.com ${cspSource}; style-src 'unsafe-inline' https://unpkg.com ${cspSource}; font-src https://unpkg.com;">
    <style>
      body { font-family: sans-serif; margin: 0; padding: 0; }
      #editor { width: 100%; height: calc(100vh - 50px); }
      button { width: 100%; height: 50px; font-size: 16px; }
      #result { padding: 10px; }
    </style>
  </head>
  <body>
    <div id="editor"></div>
    <button onclick="executeQuery()">Execute Query</button>
    <div id="result"></div>

    <script src="https://unpkg.com/monaco-editor@0.34.1/min/vs/loader.js"></script>
    <script>
      const vscode = acquireVsCodeApi();
      let editor;

      require.config({ paths: { 'vs': 'https://unpkg.com/monaco-editor@0.34.1/min/vs' }});
      require(['vs/editor/editor.main'], function() {
        editor = monaco.editor.create(document.getElementById('editor'), {
          value: '-- Enter your SQL query here',
          language: 'sql',
          theme: 'vs-dark'
        });
      });

      function executeQuery() {
        const query = editor.getValue();
        vscode.postMessage({ command: 'executeQuery', query });
      }

      window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'queryResult') {
          document.getElementById('result').innerHTML = '<pre>' + JSON.stringify(message.data, null, 2) + '</pre>';
        } else if (message.command === 'queryError') {
          document.getElementById('result').innerHTML = '<pre style="color: red;">' + message.error + '</pre>';
        }
      });
    </script>
  </body>
  </html>
  `;
}

async function viewTableData(tableName: string) {
  if (!db) {
    vscode.window.showErrorMessage('No database is currently open. Please open a database first.');
    return;
  }

  const query = `SELECT * FROM ${tableName} LIMIT 100`;
  const dbAll = <T>(sql: string) => promisify(db!.all.bind(db))(sql) as Promise<T[]>;

  try {
    const rows = await dbAll<any>(query);
    displayDataInTable(rows, tableName);
  } catch (err) {
    if (err instanceof Error) {
      vscode.window.showErrorMessage(`Error fetching data: ${err.message}`);
    } else {
      vscode.window.showErrorMessage('An unknown error occurred.');
    }
  }
}

function displayDataInTable(rows: any[], tableName: string) {
  const panel = vscode.window.createWebviewPanel(
    'localastrodbTableView',
    `Table: ${tableName}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(vscode.extensions.getExtension('your-publisher-name.localastrodb-viewer')!.extensionPath, 'media', 'styles.css'))
  );

  const cspSource = panel.webview.cspSource;
  panel.webview.html = getWebviewContent(rows, styleUri, cspSource);

  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === 'saveData') {
        try {
          const data = message.data; // Array of updated rows
          await updateDatabaseRows(db!, tableName, data);
          vscode.window.showInformationMessage('Data saved successfully.');
        } catch (err) {
          if (err instanceof Error) {
            vscode.window.showErrorMessage(`Error saving data: ${err.message}`);
          } else {
            vscode.window.showErrorMessage('An unknown error occurred while saving data.');
          }
        }
      }
    },
    undefined,
    []
  );
}

function getWebviewContent(rows: any[], styleUri: vscode.Uri, cspSource: string): string {
  if (rows.length === 0) {
    return `<html><body><h3>No data available.</h3></body></html>`;
  }

  const columns = Object.keys(rows[0]);

  const tableHeader = columns.map((col) => `<th>${col}</th>`).join('');
  const tableRows = rows
    .map((row) => {
      const cells = columns.map((col) => `<td contenteditable="true">${row[col]}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Table View</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; script-src ${cspSource} 'unsafe-inline'; style-src ${cspSource};">
    <link href="${styleUri}" rel="stylesheet">
  </head>
  <body>
    <table>
      <thead>
        <tr>${tableHeader}</tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
    <button onclick="saveChanges()">Save Changes</button>
    <script>
      const vscode = acquireVsCodeApi();
      const columns = ${JSON.stringify(columns)};
      
      function saveChanges() {
        const table = document.querySelector('table');
        const data = [];
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          const rowData = {};
          cells.forEach((cell, index) => {
            rowData[columns[index]] = cell.innerText;
          });
          data.push(rowData);
        });
        vscode.postMessage({ command: 'saveData', data: data });
      }
    </script>
  </body>
  </html>
  `;
}

async function updateDatabaseRows(db: sqlite3.Database, tableName: string, data: any[]) {
  for (const row of data) {
    const columns = Object.keys(row);
    const assignments = columns.map((col) => `${col}=?`).join(', ');
    const values = columns.map((col) => row[col]);
    // Assuming the first column is a primary key
    const primaryKeyValue = row[columns[0]];
    const sql = `UPDATE ${tableName} SET ${assignments} WHERE ${columns[0]}=?`;
    // Include the value for the WHERE clause at the end
    await dbRun(db, sql, [...values, primaryKeyValue]);
  }
}

function dbRun(db: sqlite3.Database, sql: string, params: any[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    db.run(sql, params, function (err: Error | null) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function deactivate() {}
