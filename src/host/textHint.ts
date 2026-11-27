// When a SQLite database ends up in the text editor, offer to open it in the viewer.
import { promises as fsp } from 'node:fs';
import * as vscode from 'vscode';
import { isSqliteFile } from '../engine/fileFormat';
import { basename, isDatabaseName, readOrNull } from './files';

async function readHeader(uri: vscode.Uri): Promise<Uint8Array | null> {
  if (uri.scheme === 'file') {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(uri.fsPath, 'r');
      const buf = new Uint8Array(100);
      const { bytesRead } = await handle.read(buf, 0, 100, 0);
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
  return readOrNull(uri);
}

export function registerTextHint(context: vscode.ExtensionContext): void {
  const offered = new Set<string>();
  const check = async (editor: vscode.TextEditor | undefined) => {
    const uri = editor?.document.uri;
    if (!uri || !isDatabaseName(uri.path) || offered.has(uri.toString())) return;
    const config = vscode.workspace.getConfiguration('localastrodb');
    if (!config.get<boolean>('showOpenAsTextHint', true)) return;
    const header = await readHeader(uri);
    if (!header || header.length < 100 || !isSqliteFile(header)) return;
    offered.add(uri.toString());
    const open = 'Open with Local AstroDB Viewer';
    const never = "Don't Show Again";
    const choice = await vscode.window.showInformationMessage(`${basename(uri)} is a SQLite database.`, open, never);
    if (choice === open) await vscode.commands.executeCommand('vscode.openWith', uri, 'localastrodb.editor');
    else if (choice === never) await config.update('showOpenAsTextHint', false, vscode.ConfigurationTarget.Global);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => void check(e)));
  void check(vscode.window.activeTextEditor);
}
