// Integration test run inside a real VS Code instance (see scripts/integration.sh).
// Exercises the custom editor, the worker thread, save / undo / redo, external reloads,
// WAL databases, settings and commands.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { SqliteDocument } from '../../src/host/document';
import { WorkerClient } from '../../src/host/workerClient';
import { musicSql } from '../fixtures/musicDb';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeout = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

function tabFor(uri: vscode.Uri): vscode.Tab | undefined {
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      if (t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === uri.toString()) return t;
    }
  }
  return undefined;
}

export async function run(): Promise<void> {
  const root = join(__dirname, '..');
  const wasm = readFileSync(join(__dirname, 'sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
  const dir = mkdtempSync(join(tmpdir(), 'localastrodb-it-'));
  const file = join(dir, 'music.sqlite');
  {
    const db = new SQL.Database();
    db.exec(musicSql());
    writeFileSync(file, db.export());
    db.close();
  }
  const readDisk = (path: string, sql: string) => {
    const bytes = readFileSync(path);
    bytes[18] = 1;
    bytes[19] = 1;
    const db = new SQL.Database(bytes);
    try {
      return db.exec(sql)[0]?.values ?? [];
    } finally {
      db.close();
    }
  };

  // Fresh profiles may open the chat view; its input would receive the undo/redo commands.
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
  const focusEditor = () => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  const command = async (id: string) => {
    await focusEditor();
    await vscode.commands.executeCommand(id);
  };
  const ext = vscode.extensions.getExtension<ExtensionApi>('Yurialvesguernsey.localastrodb')!;
  const api = await ext.activate();
  const uri = vscode.Uri.file(file);
  const results: string[] = [];
  let failed = false;
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push(`  ✔ ${name}`);
    } catch (err) {
      failed = true;
      results.push(`  ✖ ${name}\n${err instanceof Error ? err.stack : String(err)}`);
    }
  };
  let doc!: SqliteDocument;
  const cell = async (d: SqliteDocument, table: string, id: number, col: number) => (await d.call('getRow', { table, key: [id] }))?.[col];

  await step('opens .sqlite files in the custom editor by default and loads the webview', async () => {
    await vscode.commands.executeCommand('vscode.open', uri);
    doc = await waitFor(() => api.provider.findDocument(uri), 'document');
    assert.equal(doc.info.openError, undefined);
    assert.match(doc.info.sqliteVersion, /^3\.\d+\.\d+$/);
    assert.equal(doc.readOnly, false);
    await waitFor(() => api.provider.isWebviewReady(doc), 'webview to load under its CSP and request data');
    const schema = await doc.call('schema', undefined);
    assert.equal(schema.tables.length, 8);
  });

  await step('edits mark the editor dirty, save writes to disk, undo/redo work', async () => {
    doc.applyMutation(await doc.call('updateCells', { table: 'genres', changes: [{ key: [1], column: 'name', value: 'Rock & Roll' }] }));
    await waitFor(() => tabFor(uri)?.isDirty, 'dirty tab');
    await command('workbench.action.files.save');
    await waitFor(() => tabFor(uri) && !tabFor(uri)!.isDirty, 'saved tab');
    assert.deepEqual(readDisk(file, 'SELECT name FROM genres WHERE id = 1'), [['Rock & Roll']]);
    await command('undo');
    await waitFor(async () => (await cell(doc, 'genres', 1, 1)) === 'Rock', 'undo');
    await waitFor(() => tabFor(uri)?.isDirty, 'dirty after undo');
    await command('redo');
    await waitFor(async () => (await cell(doc, 'genres', 1, 1)) === 'Rock & Roll', 'redo');
    await waitFor(() => tabFor(uri) && !tabFor(uri)!.isDirty, 'clean after redo');
  });

  await step('SQL that changes data is undoable; revert restores the file', async () => {
    const r = await doc.call('exec', { sql: 'DELETE FROM genres WHERE id = 8; CREATE TABLE extra (a);' });
    doc.applyMutation(r);
    assert.ok(r.edit && r.schemaChanged);
    await command('undo');
    await waitFor(async () => (await doc.call('count', { table: 'genres', filters: {}, search: '', sort: null })) === 8, 'undo of SQL');
    await command('redo');
    await waitFor(async () => (await doc.call('count', { table: 'genres', filters: {}, search: '', sort: null })) === 7, 'redo of SQL');
    await command('workbench.action.files.revert');
    await waitFor(async () => (await doc.call('count', { table: 'genres', filters: {}, search: '', sort: null })) === 8, 'revert');
    await waitFor(() => tabFor(uri) && !tabFor(uri)!.isDirty, 'clean after revert');
  });

  await step('reloads automatically when another program changes the file', async () => {
    const bytes = readFileSync(file);
    const db = new SQL.Database(bytes);
    db.run("UPDATE genres SET name = 'Changed elsewhere' WHERE id = 2");
    writeFileSync(file, db.export());
    db.close();
    await waitFor(async () => (await cell(doc, 'genres', 2, 1)) === 'Changed elsewhere', 'external reload', 10000);
  });

  await step('Copy Schema as TypeScript Types copies and opens the interfaces', async () => {
    await vscode.commands.executeCommand('vscode.open', uri);
    await vscode.commands.executeCommand('localastrodb.copyTypes');
    const text = await vscode.env.clipboard.readText();
    assert.match(text, /export interface Genres \{/);
    assert.equal(vscode.window.activeTextEditor?.document.languageId, 'typescript');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await step('the read-only setting applies to open databases', async () => {
    await vscode.workspace.getConfiguration('localastrodb').update('openReadOnly', true, vscode.ConfigurationTarget.Global);
    await waitFor(() => doc.readOnly, 'read-only');
    await assert.rejects(doc.call('updateCells', { table: 'genres', changes: [{ key: [1], column: 'name', value: 'x' }] }), /read-only/);
    await vscode.workspace.getConfiguration('localastrodb').update('openReadOnly', false, vscode.ConfigurationTarget.Global);
    await waitFor(() => !doc.readOnly, 'writable again');
  });

  await step('WAL databases show the log and save without stale -wal files', async () => {
    copyFileSync(join(root, 'test', 'fixtures', 'wal.db'), join(dir, 'wal.db'));
    copyFileSync(join(root, 'test', 'fixtures', 'wal.db-wal'), join(dir, 'wal.db-wal'));
    const walUri = vscode.Uri.file(join(dir, 'wal.db'));
    await vscode.commands.executeCommand('vscode.open', walUri);
    const walDoc = await waitFor(() => api.provider.findDocument(walUri), 'wal document');
    const rows = (await walDoc.call('exec', { sql: 'SELECT v FROM t ORDER BY id' })).results[0].rows;
    assert.deepEqual(rows, [['updated in wal'], ['in wal']]);
    walDoc.applyMutation(await walDoc.call('updateCells', { table: 't', changes: [{ key: [2], column: 'v', value: 'saved' }] }));
    await waitFor(() => tabFor(walUri)?.isDirty, 'dirty wal tab');
    await command('workbench.action.files.save');
    await waitFor(() => tabFor(walUri) && !tabFor(walUri)!.isDirty, 'saved wal');
    assert.equal(existsSync(join(dir, 'wal.db-wal')), false);
    assert.equal(readFileSync(join(dir, 'wal.db'))[18], 2, 'journal mode stays WAL');
    assert.deepEqual(readDisk(join(dir, 'wal.db'), 'SELECT v FROM t ORDER BY id'), [['updated in wal'], ['saved']]);
  });

  await step('files that are not SQLite show an error instead of failing', async () => {
    const bad = vscode.Uri.file(join(dir, 'notes.db'));
    writeFileSync(bad.fsPath, 'just some text, definitely not a database\n'.repeat(10));
    await vscode.commands.executeCommand('vscode.open', bad);
    const badDoc = await waitFor(() => api.provider.findDocument(bad), 'bad document');
    assert.match(badDoc.info.openError ?? '', /not a SQLite database/);
  });

  await step('New Database produces a valid empty SQLite file', async () => {
    const worker = new WorkerClient(join(root, 'dist', 'worker.js'));
    try {
      await worker.call('open', { bytes: new Uint8Array(0), options: { readOnly: false, undoBudgetBytes: 1 << 20, maxResultRows: 10 } });
      const bytes = await worker.call('serialize', undefined);
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), 'SQLite format 3');
      const created = vscode.Uri.file(join(dir, 'new.sqlite'));
      writeFileSync(created.fsPath, bytes);
      await vscode.commands.executeCommand('vscode.open', created);
      const newDoc = await waitFor(() => api.provider.findDocument(created), 'new document');
      assert.equal(newDoc.info.openError, undefined);
      assert.equal((await newDoc.call('schema', undefined)).tables.length, 0);
    } finally {
      worker.dispose();
    }
  });

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log(`\nLocal AstroDB integration tests\n${results.join('\n')}\n`);
  writeFileSync(join(__dirname, 'integration-results.txt'), results.join('\n') + '\n');
  if (failed) throw new Error('Integration tests failed');
}
