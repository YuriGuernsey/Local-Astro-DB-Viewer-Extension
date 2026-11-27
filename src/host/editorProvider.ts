// Custom editor for SQLite files: wires documents to their webviews and answers webview requests.
import * as vscode from 'vscode';
import {
  WORKER_METHODS,
  type HostEvent,
  type MutationResult,
  type RequestMessage,
  type WebviewApi,
  type WebviewMethod,
} from '../shared/protocol';
import { readSettings, SqliteDocument } from './document';
import { copyTypes, exportDump, exportSource, pickAndCompare, saveSvg } from './operations';
import type { QueryHistory, RecentDatabases } from './state';
import { webviewHtml } from './webviewHtml';

const MUTATIONS = new Set<WebviewMethod>(['updateCells', 'insertRow', 'deleteRows', 'exec', 'runDdl']);
const WORKER_SET = new Set<string>(WORKER_METHODS);

export class SqliteEditorProvider implements vscode.CustomEditorProvider<SqliteDocument> {
  static readonly viewType = 'localastrodb.editor';

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SqliteDocument>>();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  private readonly _onDidChangeActive = new vscode.EventEmitter<SqliteDocument | undefined>();
  /** The focused database editor changed (or its info did). */
  readonly onDidChangeActive = this._onDidChangeActive.event;

  private readonly docs = new Set<SqliteDocument>();
  private readonly panels = new Map<SqliteDocument, Set<vscode.WebviewPanel>>();
  private readonly ready = new Set<vscode.WebviewPanel>();
  private readonly queued = new WeakMap<vscode.WebviewPanel, HostEvent[]>();
  private lastActive: { doc: SqliteDocument; panel: vscode.WebviewPanel } | undefined;
  private focused = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly recent: RecentDatabases,
    private readonly history: QueryHistory,
  ) {}

  // ---------- documents ----------

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<SqliteDocument> {
    const workerPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'worker.js').fsPath;
    const doc = await SqliteDocument.open(uri, openContext.backupId, workerPath, readSettings());
    doc.onDidEdit((e) => this._onDidChangeCustomDocument.fire(e));
    doc.onDidRequestRevert(() => void this.revertInEditor(doc));
    doc.onDidChangeInfo(() => {
      if (this.lastActive?.doc === doc) this._onDidChangeActive.fire(doc);
    });
    doc.onDidDispose(() => {
      this.docs.delete(doc);
      this.panels.delete(doc);
      if (this.lastActive?.doc === doc) {
        this.lastActive = undefined;
        this._onDidChangeActive.fire(undefined);
      }
    });
    this.docs.add(doc);
    if (!doc.info.openError) {
      void this.recent.add(uri);
      void doc.refreshObjectCount();
    }
    return doc;
  }

  async resolveCustomEditor(doc: SqliteDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    let set = this.panels.get(doc);
    if (!set) this.panels.set(doc, (set = new Set()));
    set.add(panel);

    const subs = [
      doc.onDidEvent((ev) => this.post(panel, ev)),
      panel.webview.onDidReceiveMessage((msg: RequestMessage) => void this.onRequest(doc, panel, msg)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.setActive(doc, panel, true);
        else if (this.lastActive?.panel === panel) {
          this.focused = false;
          this._onDidChangeActive.fire(undefined);
        }
      }),
    ];
    if (panel.active) this.setActive(doc, panel, true);
    panel.onDidDispose(() => {
      subs.forEach((s) => s.dispose());
      this.ready.delete(panel);
      this.panels.get(doc)?.delete(panel);
      if (this.lastActive?.panel === panel) {
        const other = this.panels.get(doc)?.values().next().value;
        this.lastActive = other ? { doc, panel: other } : undefined;
        this.focused = false;
        this._onDidChangeActive.fire(undefined);
      }
    });
  }

  private setActive(doc: SqliteDocument, panel: vscode.WebviewPanel, focused: boolean): void {
    this.lastActive = { doc, panel };
    this.focused = focused;
    this._onDidChangeActive.fire(doc);
  }

  /** The focused database editor, if any. */
  focusedDocument(): SqliteDocument | undefined {
    return this.focused ? this.lastActive?.doc : undefined;
  }

  /** The focused database, or the last one used. */
  activeDocument(): SqliteDocument | undefined {
    return this.lastActive?.doc ?? this.docs.values().next().value;
  }

  allDocuments(): SqliteDocument[] {
    return [...this.docs];
  }

  /** Whether a webview of the document has loaded and asked for its data (used by tests). */
  isWebviewReady(doc: SqliteDocument): boolean {
    return [...(this.panels.get(doc) ?? [])].some((p) => this.ready.has(p));
  }

  findDocument(uri: vscode.Uri): SqliteDocument | undefined {
    return [...this.docs].find((d) => d.uri.toString() === uri.toString());
  }

  saveCustomDocument(doc: SqliteDocument): Thenable<void> {
    return doc.save();
  }

  saveCustomDocumentAs(doc: SqliteDocument, destination: vscode.Uri): Thenable<void> {
    return doc.saveAs(destination);
  }

  revertCustomDocument(doc: SqliteDocument): Thenable<void> {
    return doc.revert();
  }

  backupCustomDocument(doc: SqliteDocument, context: vscode.CustomDocumentBackupContext): Thenable<vscode.CustomDocumentBackup> {
    return doc.backup(context.destination);
  }

  // ---------- navigation from commands ----------

  private post(panel: vscode.WebviewPanel, ev: HostEvent): void {
    if (!this.ready.has(panel)) {
      const q = this.queued.get(panel) ?? [];
      q.push(ev);
      this.queued.set(panel, q);
      return;
    }
    void panel.webview.postMessage(ev);
  }

  /** Reveals the database editor and sends it an event (e.g. switch tab). */
  show(doc: SqliteDocument, ev?: HostEvent): void {
    const panel = this.lastActive?.doc === doc ? this.lastActive.panel : this.panels.get(doc)?.values().next().value;
    if (!panel) return;
    panel.reveal(panel.viewColumn, false);
    if (ev) this.post(panel, ev);
  }

  /** Opens a file in this editor and returns its document. */
  async open(uri: vscode.Uri): Promise<SqliteDocument | undefined> {
    await vscode.commands.executeCommand('vscode.openWith', uri, SqliteEditorProvider.viewType);
    return this.findDocument(uri);
  }

  private async revertInEditor(doc: SqliteDocument): Promise<void> {
    this.show(doc);
    try {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } catch {
      // the content is already reloaded; only the dirty marker remains
    }
  }

  // ---------- webview requests ----------

  private async onRequest(doc: SqliteDocument, panel: vscode.WebviewPanel, msg: RequestMessage): Promise<void> {
    if (msg?.type !== 'request') return;
    try {
      const result = await this.handle(doc, msg.method, msg.params);
      await panel.webview.postMessage({ type: 'response', id: msg.id, result });
    } catch (err) {
      await panel.webview.postMessage({ type: 'response', id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
    if (msg.method === 'init' && !this.ready.has(panel)) {
      this.ready.add(panel);
      for (const ev of this.queued.get(panel) ?? []) void panel.webview.postMessage(ev);
      this.queued.delete(panel);
    }
  }

  private async handle(doc: SqliteDocument, method: WebviewMethod, params: unknown): Promise<unknown> {
    const p = params as never;
    switch (method) {
      case 'init':
        return {
          info: doc.info,
          schema: doc.info.openError ? { tables: [] } : await doc.call('schema', undefined),
          settings: { maxResultRows: readSettings().maxResultRows },
        } satisfies WebviewApi['init']['result'];
      case 'export': {
        const { source, format } = p as WebviewApi['export']['params'];
        return exportSource(doc, source, format);
      }
      case 'exportDump':
        return exportDump(doc);
      case 'copyTypes':
        return copyTypes(doc);
      case 'compareWith':
        return pickAndCompare(doc);
      case 'saveSvg': {
        const { svg, name } = p as WebviewApi['saveSvg']['params'];
        return saveSvg(doc, svg, name);
      }
      case 'copyText':
        await vscode.env.clipboard.writeText((p as WebviewApi['copyText']['params']).text);
        return;
      case 'readClipboard':
        return vscode.env.clipboard.readText();
      case 'confirm': {
        const { message, detail, confirm } = p as WebviewApi['confirm']['params'];
        return (await vscode.window.showWarningMessage(message, { modal: true, detail }, confirm)) === confirm;
      }
      case 'notify': {
        const { message, level } = p as WebviewApi['notify']['params'];
        if (level === 'error') void vscode.window.showErrorMessage(message);
        else if (level === 'warning') void vscode.window.showWarningMessage(message);
        else void vscode.window.showInformationMessage(message);
        return;
      }
      case 'historyList':
        return this.history.list();
      case 'historyAdd':
        return this.history.add((p as WebviewApi['historyAdd']['params']).sql, doc.name);
      case 'historyClear':
        return this.history.clear();
      case 'reopenAsText':
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
        return;
      case 'newDatabase':
        await vscode.commands.executeCommand('localastrodb.newDatabase');
        return;
      default: {
        if (!WORKER_SET.has(method)) throw new Error(`Unknown request: ${method}`);
        const result = await doc.call(method as (typeof WORKER_METHODS)[number], params as never);
        if (MUTATIONS.has(method)) doc.applyMutation(result as MutationResult);
        return result;
      }
    }
  }
}
