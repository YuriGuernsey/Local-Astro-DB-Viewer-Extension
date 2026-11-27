// One open database file. Owns the SQLite worker, turns engine edits into VS Code
// undo/redo entries, and implements save / save as / revert / hot-exit backups.
import { constants as fsConstants, promises as fsp } from 'node:fs';
import * as vscode from 'vscode';
import type { EngineApi, EngineMethod } from '../engine/dispatch';
import { isSqliteFile, restoreJournalMode } from '../engine/fileFormat';
import type { DbInfo, HostEvent, MutationResult } from '../shared/protocol';
import { basename, dirname, escapeGlob, readDatabase, sibling, statOrNull } from './files';
import { WorkerClient } from './workerClient';

export interface DocumentSettings {
  readOnly: boolean;
  undoBudgetBytes: number;
  maxResultRows: number;
}

export function readSettings(): DocumentSettings {
  const c = vscode.workspace.getConfiguration('localastrodb');
  return {
    readOnly: c.get<boolean>('openReadOnly', false),
    undoBudgetBytes: Math.max(16, c.get<number>('undoMemoryLimitMB', 512)) * 1024 * 1024,
    maxResultRows: Math.max(100, c.get<number>('maxResultRows', 100000)),
  };
}

export class SqliteDocument implements vscode.CustomDocument {
  info!: DbInfo;
  /** Number of tables and views, for the status bar. */
  tableCount = 0;
  viewCount = 0;
  private worker: WorkerClient | null = null;
  private walMode = false;
  /** Read-only because of the file itself (permissions, file system), independent of settings. */
  private fileReadOnlyReason: string | undefined;
  private diskSignature = '';
  private version = 0;
  private savedVersion = 0;
  private watcher: vscode.FileSystemWatcher | undefined;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private readonly _onDidEdit = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SqliteDocument>>();
  readonly onDidEdit = this._onDidEdit.event;
  private readonly _onDidEvent = new vscode.EventEmitter<HostEvent>();
  /** Events for the webviews showing this document. */
  readonly onDidEvent = this._onDidEvent.event;
  private readonly _onDidChangeInfo = new vscode.EventEmitter<void>();
  readonly onDidChangeInfo = this._onDidChangeInfo.event;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;
  private readonly _onDidRequestRevert = new vscode.EventEmitter<void>();
  /** Fired after an external reload discarded unsaved edits: VS Code's dirty state must be reverted too. */
  readonly onDidRequestRevert = this._onDidRequestRevert.event;

  private constructor(
    readonly uri: vscode.Uri,
    private readonly workerPath: string,
  ) {}

  static async open(uri: vscode.Uri, backupId: string | undefined, workerPath: string, settings: DocumentSettings): Promise<SqliteDocument> {
    const doc = new SqliteDocument(uri, workerPath);
    await doc.initialize(backupId, settings);
    doc.watch();
    return doc;
  }

  get name(): string {
    return basename(this.uri);
  }

  get isDirty(): boolean {
    return this.version !== this.savedVersion;
  }

  get readOnly(): boolean {
    return this.info.readOnly;
  }

  private async initialize(backupId: string | undefined, settings: DocumentSettings): Promise<void> {
    this.info = {
      fileName: this.name,
      uri: this.uri.toString(),
      size: 0,
      sqliteVersion: '',
      pageSize: 0,
      encoding: '',
      readOnly: true,
    };
    try {
      const stat = await statOrNull(this.uri);
      this.info.size = stat?.size ?? 0;
      this.fileReadOnlyReason = await this.detectFileReadOnly(stat);
      const { raw, prepared } = await readDatabase(this.uri);
      if (!isSqliteFile(raw)) throw new Error('This file is not a SQLite database.');
      this.walMode = prepared.walMode;
      let bytes = prepared.bytes;
      if (backupId) bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(backupId));
      this.worker = new WorkerClient(this.workerPath);
      const readOnly = settings.readOnly || !!this.fileReadOnlyReason;
      const engine = await this.worker.call('open', {
        bytes,
        options: { readOnly, undoBudgetBytes: settings.undoBudgetBytes, maxResultRows: settings.maxResultRows },
      });
      Object.assign(this.info, engine);
      this.info.readOnly = readOnly;
      this.info.readOnlyReason = this.fileReadOnlyReason ?? (settings.readOnly ? 'Opened read-only (localastrodb.openReadOnly).' : undefined);
      this.diskSignature = await this.computeSignature();
      if (backupId) this.version = 1; // restored from a hot-exit backup: unsaved
    } catch (err) {
      this.worker?.dispose();
      this.worker = null;
      this.info.openError = err instanceof Error ? err.message : String(err);
    }
  }

  private async detectFileReadOnly(stat: vscode.FileStat | null): Promise<string | undefined> {
    if (vscode.workspace.fs.isWritableFileSystem(this.uri.scheme) === false) return 'The file system is read-only.';
    if (stat?.permissions !== undefined && (stat.permissions & vscode.FilePermission.Readonly) !== 0) return 'The file is read-only.';
    if (this.uri.scheme === 'file') {
      try {
        await fsp.access(this.uri.fsPath, fsConstants.W_OK);
      } catch {
        return 'The file is read-only.';
      }
    }
    return undefined;
  }

  private requireWorker(): WorkerClient {
    if (!this.worker) throw new Error(this.info.openError ?? 'The database is not open.');
    return this.worker;
  }

  call<M extends EngineMethod>(method: M, params: EngineApi[M]['params']): Promise<EngineApi[M]['result']> {
    return this.requireWorker().call(method, params);
  }

  /** Records a change made by the engine as an undoable VS Code edit and refreshes the views. */
  applyMutation(result: MutationResult): void {
    if (result.edit) {
      const { id, label } = result.edit;
      this.version++;
      this._onDidEdit.fire({
        document: this,
        label,
        undo: () => this.step(id, 'undo'),
        redo: () => this.step(id, 'redo'),
      });
    }
    if (result.edit || result.schemaChanged) this.changed(result.schemaChanged);
  }

  private async step(id: number, dir: 'undo' | 'redo'): Promise<void> {
    this.version += dir === 'undo' ? -1 : 1;
    try {
      const outcome = await this.call(dir, { id });
      if (!outcome.ok && outcome.message) void vscode.window.showWarningMessage(outcome.message);
      this.changed(outcome.schemaChanged);
    } catch (err) {
      void vscode.window.showErrorMessage(`${dir === 'undo' ? 'Undo' : 'Redo'} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.changed(true);
    }
  }

  private changed(schema: boolean): void {
    this._onDidEvent.fire({ type: 'changed', schema });
    if (schema) void this.refreshObjectCount();
  }

  async refreshObjectCount(): Promise<void> {
    if (!this.worker) return;
    try {
      const { tables } = await this.call('schema', undefined);
      this.viewCount = tables.filter((t) => t.type === 'view').length;
      this.tableCount = tables.length - this.viewCount;
      this._onDidChangeInfo.fire();
    } catch {
      // ignore: the status bar just keeps the previous count
    }
  }

  // ---------- saving ----------

  async save(): Promise<void> {
    await this.saveAs(this.uri);
    this.savedVersion = this.version;
  }

  async saveAs(target: vscode.Uri): Promise<void> {
    const bytes = await this.call('serialize', undefined);
    const sameFile = target.toString() === this.uri.toString();
    if (sameFile) {
      restoreJournalMode(bytes, this.walMode);
      await vscode.workspace.fs.writeFile(target, bytes);
      if (this.walMode) {
        // The log was folded in at load time; stale frames must not be replayed over the new content.
        for (const suffix of ['-wal', '-shm']) {
          try {
            await vscode.workspace.fs.delete(sibling(target, suffix));
          } catch {
            // not present
          }
        }
      }
      this.info.size = bytes.length;
      this.diskSignature = await this.computeSignature();
      this._onDidChangeInfo.fire();
    } else {
      await vscode.workspace.fs.writeFile(target, bytes);
    }
  }

  async revert(): Promise<void> {
    await this.reload(false);
    this.version = this.savedVersion;
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    const bytes = await this.call('serialize', undefined);
    await vscode.workspace.fs.writeFile(destination, bytes);
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // already gone
        }
      },
    };
  }

  /** Reloads from disk. `external`: the file was changed by another program (undo history becomes stale). */
  async reload(external: boolean): Promise<void> {
    const { prepared } = await readDatabase(this.uri);
    this.walMode = prepared.walMode;
    await this.call('load', { bytes: prepared.bytes, invalidateEdits: external });
    this.info.size = (await statOrNull(this.uri))?.size ?? this.info.size;
    this.diskSignature = await this.computeSignature();
    this._onDidEvent.fire({ type: 'reloaded' });
    this._onDidChangeInfo.fire();
    void this.refreshObjectCount();
  }

  async setReadOnly(settingReadOnly: boolean): Promise<void> {
    if (!this.worker) return;
    const readOnly = settingReadOnly || !!this.fileReadOnlyReason;
    if (readOnly === this.info.readOnly) return;
    await this.call('setReadOnly', { readOnly });
    this.info.readOnly = readOnly;
    this.info.readOnlyReason = this.fileReadOnlyReason ?? (settingReadOnly ? 'Opened read-only (localastrodb.openReadOnly).' : undefined);
    this._onDidEvent.fire({ type: 'readOnly', readOnly, reason: this.info.readOnlyReason });
    this._onDidChangeInfo.fire();
  }

  async setLimits(settings: DocumentSettings): Promise<void> {
    if (this.worker) await this.call('setLimits', { undoBudgetBytes: settings.undoBudgetBytes, maxResultRows: settings.maxResultRows });
  }

  // ---------- external changes ----------

  private async computeSignature(): Promise<string> {
    const main = await statOrNull(this.uri);
    const wal = await statOrNull(sibling(this.uri, '-wal'));
    return `${main?.mtime}:${main?.size}|${wal?.mtime}:${wal?.size}`;
  }

  private watch(): void {
    if (!this.worker) return;
    const pattern = new vscode.RelativePattern(dirname(this.uri), `${escapeGlob(this.name)}{,-wal}`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const schedule = () => {
      clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => void this.checkExternalChange(), 400);
    };
    this.watcher.onDidChange(schedule);
    this.watcher.onDidCreate(schedule);
  }

  private async checkExternalChange(): Promise<void> {
    if (this.disposed || !(await statOrNull(this.uri))) return;
    const sig = await this.computeSignature();
    if (sig === this.diskSignature) return;
    this.diskSignature = sig;
    if (!this.isDirty) {
      try {
        await this.reload(true);
        vscode.window.setStatusBarMessage(`$(sync) ${this.name} was changed on disk and reloaded`, 4000);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not reload ${this.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${this.name} was changed by another program. Reload it and discard your unsaved changes?`,
      'Reload',
      'Keep My Changes',
    );
    if (choice === 'Reload') {
      await this.reload(true);
      this.savedVersion = this.version;
      this._onDidRequestRevert.fire();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.checkTimer);
    this.watcher?.dispose();
    this.worker?.dispose();
    this.worker = null;
    this._onDidDispose.fire();
    this._onDidEdit.dispose();
    this._onDidEvent.dispose();
    this._onDidChangeInfo.dispose();
    this._onDidDispose.dispose();
    this._onDidRequestRevert.dispose();
  }
}
