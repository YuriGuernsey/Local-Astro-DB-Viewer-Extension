import * as vscode from 'vscode';
import initSqlJs, { SqlJsStatic, Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseTreeDataProvider } from './TreeDataProvider';
import * as chokidar from 'chokidar'; // File watcher package

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbPath: string | null = null;
let seedWatcher: chokidar.FSWatcher | null = null;

export async function activate(context: vscode.ExtensionContext) {
  await initSqlJsModule();

  context.subscriptions.push(
    vscode.commands.registerCommand('localastrodb.openDatabase', openDatabase),
    vscode.commands.registerCommand('localastrodb.openQueryEditor', openQueryEditor),
    vscode.commands.registerCommand('localastrodb.refresh', refreshTreeView),
    vscode.commands.registerCommand('localastrodb.viewTableData', viewTableData),
    vscode.commands.registerCommand('localastrodb.addRow', addRow),
    // vscode.commands.registerCommand('localastrodb.deleteRow', deleteRow)
  );

  // Automatically open .astro/content.db if path is configured or found
  const config = vscode.workspace.getConfiguration('localastrodb');
  const databasePath = config.get<string>('databasePath');
  const autoDetectedDbPath = await autoDetectContentDb();

  if (autoDetectedDbPath) {
    await openDatabaseAtPath(autoDetectedDbPath); // Automatically open if detected
  } else if (databasePath && fs.existsSync(databasePath)) {
    await openDatabaseAtPath(databasePath); // Open if configured manually
  }

  // Automatically watch the /db/seed.ts file for changes
  watchSeedFile();
}

// Auto-detect `.astro/content.db` in the root directory
async function autoDetectContentDb(): Promise<string | null> {
  const rootPath = vscode.workspace.rootPath;
  if (!rootPath) {
    return null; // Exit if there's no workspace root
  }

  const contentDbPath = path.join(rootPath, '.astro', 'content.db');
  if (fs.existsSync(contentDbPath)) {
    return contentDbPath;
  }

  return null; // Return null initially if the file isn't found
}

async function initSqlJsModule() {
  if (!SQL) {
    SQL = await initSqlJs({
      // Optional: Specify the location of the sql-wasm.wasm file if needed
      // locateFile: (file) => `path/to/${file}`
    });
  }
}

async function openDatabase() {
  const uri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Database Files': ['db'] },
    openLabel: 'Open SQLite Database'
  });

  if (uri && uri[0]) {
    await openDatabaseAtPath(uri[0].fsPath);
  }
}

async function openDatabaseAtPath(dbFilePath: string) {
  try {
    await initSqlJsModule();
    const fileBuffer = await fs.promises.readFile(dbFilePath);
    db = new SQL!.Database(new Uint8Array(fileBuffer));
    dbPath = dbFilePath;
    vscode.window.showInformationMessage(`Opened database: ${dbPath}`);
    initializeTreeView();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to open database: ${err instanceof Error ? err.message : String(err)}`
    );
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
          const rows = executeQuery(message.query);
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
      #result { padding: 10px; overflow: auto; max-height: 300px; }
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
          const formatted = JSON.stringify(message.data, null, 2);
          document.getElementById('result').innerHTML = '<pre>' + formatted + '</pre>';
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

  try {
    const rows = await getTableData(tableName);
    displayDataInTable(rows, tableName);
  } catch (err) {
    vscode.window.showErrorMessage(`Error fetching data: ${err instanceof Error ? err.message : String(err)}`);
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

  const cspSource = panel.webview.cspSource;
  const htmlContent = getTableViewContent(rows, cspSource, tableName);
  panel.webview.html = htmlContent;

  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === 'saveData') {
        try {
          const data = message.data; // Array of updated rows
          await updateDatabaseRows(tableName, data);
          vscode.window.showInformationMessage('Data saved successfully.');
        } catch (err) {
          if (err instanceof Error) {
            vscode.window.showErrorMessage(`Error saving data: ${err.message}`);
          } else {
            vscode.window.showErrorMessage('An unknown error occurred while saving data.');
          }
        }
      } else if (message.command === 'refreshData') {
        try {
          const refreshedRows = await getTableData(message.tableName);
          panel.webview.html = getTableViewContent(refreshedRows, cspSource, tableName);
        } catch (err) {
          vscode.window.showErrorMessage(`Error refreshing data: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    undefined,
    []
  );
}

function getTableViewContent(rows: any[], cspSource: string, tableName: string): string {
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; script-src 'unsafe-inline'; style-src ${cspSource};">
    <style>
      body { font-family: sans-serif; margin: 0; padding: 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #ddd; padding: 8px; }
      th { background-color: #f2f2f2; }
      button { margin: 5px; padding: 10px; }
    </style>
  </head>
  <body>
    <button id="refreshButton">Refresh</button>
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
      const columns = ${JSON.stringify(Object.keys(rows[0]))};
      const tableName = ${JSON.stringify(tableName)};

      document.getElementById('refreshButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'refreshData', tableName });
      });

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

async function updateDatabaseRows(tableName: string, data: any[]) {
  if (!db) {
    throw new Error('Database not initialized');
  }
  for (const row of data) {
    const columns = Object.keys(row);
    const values = columns.map((col) => row[col]);
    const primaryKeyColumn = columns[0];
    const primaryKeyValue = row[primaryKeyColumn];
    const setClause = columns.map((col) => `${col} = ?`).join(', ');
    const sql = `UPDATE ${tableName} SET ${setClause} WHERE ${primaryKeyColumn} = ?`;
    db.run(sql, [...values, primaryKeyValue]);
  }
  // Save the database to disk
  await saveDatabase();
}


function executeQuery(query: string): any[] {
  if (!db) {
    throw new Error('Database not initialized');
  }
  const results = db.exec(query);
  if (results.length === 0) {
    return [];
  }
  const result = results[0];
  const columns = result.columns;
  const values = result.values;
  const rows = values.map((row: any[]) => {
    const rowObj: any = {};
    row.forEach((value, index) => {
      rowObj[columns[index]] = value;
    });
    return rowObj;
  });
  return rows;
}

async function getTableData(tableName: string): Promise<any[]> {
  const query = `SELECT * FROM ${tableName} LIMIT 100`;
  const rows = executeQuery(query);
  return rows;
}

async function addRow() {
  if (!db) {
    vscode.window.showErrorMessage('No database is currently open. Please open a database first.');
    return;
  }

  const tableNames = db.exec("SELECT name FROM sqlite_master WHERE type='table'");

  if (!tableNames || tableNames.length === 0) {
    vscode.window.showErrorMessage('No tables found in the database.');
    return;
  }

  const tableNamesList = tableNames[0].values.map((row) => row[0] as string);

  const selectedTable = await vscode.window.showQuickPick(tableNamesList, {
    placeHolder: 'Select a table to add a new row'
  });

  if (selectedTable) {
    const columns = await getColumnsForTable(selectedTable);

    // Prompt user to enter values for each column
    const columnValues: any = {};
    for (let column of columns) {
      const value = await vscode.window.showInputBox({
        prompt: `Enter value for ${column}`
      });
      columnValues[column] = value;
    }

    // Insert the row into the table
    await insertRowIntoTable(selectedTable, columnValues);
    vscode.window.showInformationMessage('Row added successfully!');
    refreshTreeView();
  }
}

async function getColumnsForTable(tableName: string): Promise<string[]> {
  const columnsResult = db?.exec(`PRAGMA table_info(${tableName})`);
  return columnsResult ? columnsResult[0].values.map((col) => col[1] as string) : [];
}

async function insertRowIntoTable(tableName: string, columnValues: any) {
  const columns = Object.keys(columnValues);
  const values = columns.map((col) => columnValues[col]);

  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

  db?.run(sql, values);
  await saveDatabase();
}

async function saveDatabase() {
  if (db && dbPath) {
    const data = db.export();
    await fs.promises.writeFile(dbPath, Buffer.from(data));
    vscode.window.showInformationMessage(`Database saved: ${dbPath}`);
  }
}

// Watch the /db/seed.ts file for changes
function watchSeedFile() {
  const seedFilePath = path.join(vscode.workspace.rootPath || '', 'db/seed.ts');
  if (fs.existsSync(seedFilePath)) {
    // Watch the seed file for changes using chokidar
    seedWatcher = chokidar.watch(seedFilePath, { persistent: true });
    
    // @ts-ignore
    seedWatcher.on('change', () => {
      vscode.window.showInformationMessage('Seed file has been updated. Refreshing data...');
      refreshTreeView();  // Refresh data when the seed file is modified
    });
    // @ts-ignore
    seedWatcher.on('error', (error: Error) => {
      vscode.window.showErrorMessage(`Error watching seed file: ${error.message}`);
    });
  } else {
    vscode.window.showErrorMessage('Seed file not found at db/seed.ts');
  }
}

export function deactivate() {
  // Close the seed watcher if it was initialized
  if (seedWatcher) {
    seedWatcher.close();
  }
}
