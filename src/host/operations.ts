// File-producing operations used both by webview requests and Command Palette commands.
import * as vscode from 'vscode';
import { EXPORT_FORMATS, type CompareResult, type ExportFormat, type ExportSource } from '../shared/protocol';
import type { SqliteDocument } from './document';
import { basename, DB_FILTERS, dirname, readDatabase, writeChunks } from './files';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function offerToOpen(target: vscode.Uri, message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, 'Open File');
  if (choice === 'Open File') await vscode.commands.executeCommand('vscode.open', target);
}

export async function exportSource(doc: SqliteDocument, source: ExportSource, format: ExportFormat): Promise<boolean> {
  const fmt = EXPORT_FORMATS.find((f) => f.id === format)!;
  const base = source.kind === 'table' ? source.table : `${doc.name.replace(/\.[^.]+$/, '')}-query`;
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(dirname(doc.uri), `${base.replace(/[\\/:*?"<>|]+/g, '_')}.${fmt.ext}`),
    filters: { [fmt.label]: [fmt.ext] },
    saveLabel: 'Export',
  });
  if (!target) return false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${base} as ${fmt.label}…` },
      async () => writeChunks(target, await doc.call('exportData', { source, format })),
    );
    void offerToOpen(target, `Exported ${base} to ${basename(target)}.`);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(`Export failed: ${errorText(err)}`);
    return false;
  }
}

export async function exportDump(doc: SqliteDocument): Promise<boolean> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(dirname(doc.uri), `${doc.name.replace(/\.[^.]+$/, '')}.sql`),
    filters: { SQL: ['sql'] },
    saveLabel: 'Export Dump',
  });
  if (!target) return false;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Dumping ${doc.name}…` }, async () => {
      await writeChunks(target, await doc.call('dump', undefined));
    });
    void offerToOpen(target, `Exported ${doc.name} to ${basename(target)}.`);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(`Export failed: ${errorText(err)}`);
    return false;
  }
}

export async function copyTypes(doc: SqliteDocument): Promise<void> {
  const text = await doc.call('typescript', { dbName: doc.name });
  await vscode.env.clipboard.writeText(text);
  const editor = await vscode.workspace.openTextDocument({ language: 'typescript', content: text });
  await vscode.window.showTextDocument(editor, { preview: false });
  void vscode.window.showInformationMessage(`TypeScript types for ${doc.name} copied to the clipboard.`);
}

export async function pickAndCompare(doc: SqliteDocument): Promise<CompareResult | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: dirname(doc.uri),
    filters: DB_FILTERS,
    openLabel: 'Compare',
    title: `Compare ${doc.name} with…`,
  });
  if (!picked?.[0]) return null;
  const other = picked[0];
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Comparing ${doc.name} with ${basename(other)}…` },
    async () => {
      const { prepared } = await readDatabase(other);
      return doc.call('compare', { bytes: prepared.bytes, leftName: doc.name, rightName: basename(other) });
    },
  );
}

export async function saveSvg(doc: SqliteDocument, svg: string, name: string): Promise<boolean> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(dirname(doc.uri), name),
    filters: { SVG: ['svg'] },
    saveLabel: 'Export SVG',
  });
  if (!target) return false;
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(svg));
  void offerToOpen(target, `ER diagram saved to ${basename(target)}.`);
  return true;
}
