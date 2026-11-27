// Worker thread hosting one database. Keeps SQLite work off the extension host thread,
// so a slow query never freezes VS Code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import initSqlJs from 'sql.js';
import { createDispatcher, type Dispatch, type EngineMethod } from './dispatch';

interface Request {
  id: number;
  method: EngineMethod;
  params: unknown;
}

const port = parentPort;
if (!port) throw new Error('worker.js must run as a worker thread');

const wasm = readFileSync(join(__dirname, 'sql-wasm.wasm'));
const ready: Promise<Dispatch> = initSqlJs({
  wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
}).then(createDispatcher);

// Requests are handled strictly in order: SQLite work is synchronous anyway.
let queue: Promise<void> = Promise.resolve();

port.on('message', (msg: Request) => {
  queue = queue.then(async () => {
    try {
      const dispatch = await ready;
      const result = dispatch(msg.method, msg.params as never) as unknown;
      const transfer =
        result instanceof Uint8Array && result.byteOffset === 0 && result.byteLength === result.buffer.byteLength
          ? [result.buffer as ArrayBuffer]
          : [];
      port.postMessage({ id: msg.id, result }, transfer);
    } catch (err) {
      port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
});
