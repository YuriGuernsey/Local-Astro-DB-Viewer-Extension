// Promise-based client for the SQLite worker thread (dist/worker.js).
import { Worker } from 'node:worker_threads';
import type { EngineApi, EngineMethod } from '../engine/dispatch';

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

export class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;

  constructor(scriptPath: string) {
    this.worker = new Worker(scriptPath);
    this.worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    this.worker.on('error', (err) => this.fail(err));
    this.worker.on('exit', (code) => this.fail(new Error(`The database worker stopped unexpectedly (exit code ${code}).`)));
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  call<M extends EngineMethod>(method: M, params: EngineApi[M]['params']): Promise<EngineApi[M]['result']> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, params });
    });
  }

  dispose(): void {
    this.fail(new Error('The database was closed.'));
    void this.worker.terminate();
  }
}
