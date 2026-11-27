import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSqliteFile, prepareForLoad, restoreJournalMode } from '../src/engine/fileFormat';
import type { RowsQuery } from '../src/shared/protocol';
import { bytesFromSql, fixture, loadSql, musicDb, musicSession, session } from './helpers';

const q = (table: string, extra: Partial<RowsQuery> = {}): RowsQuery => ({ table, filters: {}, search: '', sort: null, ...extra });

describe('schema', () => {
  it('reads tables, views, keys and indexes', async () => {
    const s = await musicSession();
    const schema = s.schema();
    assert.deepEqual(
      schema.tables.map((t) => `${t.type}:${t.name}`),
      ['table:albums', 'table:artists', 'table:customers', 'table:genres', 'table:invoice_items', 'table:invoices', 'table:tracks', 'view:top_tracks'],
    );
    const tracks = schema.tables.find((t) => t.name === 'tracks')!;
    assert.equal(tracks.rowidName, 'rowid');
    assert.deepEqual(tracks.pk, ['id']);
    assert.equal(tracks.columns[0].isRowidAlias, true);
    assert.equal(tracks.columns.find((c) => c.name === 'unit_price')!.defaultValue, '0.99');
    assert.deepEqual(
      tracks.foreignKeys.map((f) => `${f.from.join()}->${f.table}.${f.to.join()}`).sort(),
      ['album_id->albums.id', 'genre_id->genres.id'],
    );
    assert.deepEqual(tracks.indexes.map((i) => [i.name, i.origin, i.columns.join()]), [['idx_tracks_album', 'c', 'album_id']]);
    const items = schema.tables.find((t) => t.name === 'invoice_items')!;
    assert.equal(items.withoutRowid, true);
    assert.equal(items.rowidName, null);
    assert.deepEqual(items.pk, ['invoice_id', 'track_id']);
    const view = schema.tables.find((t) => t.name === 'top_tracks')!;
    assert.equal(view.readOnly, true);
    assert.deepEqual(view.columns.map((c) => c.name), ['name', 'album', 'sold']);
  });

  it('counts rows of every table and view', async () => {
    const s = await musicSession();
    const counts = s.counts();
    assert.equal(counts.tracks, 1200);
    assert.equal(counts.genres, 8);
    assert.equal(counts.top_tracks, 20);
  });
});

describe('reading rows', () => {
  it('pages, sorts, filters and searches', async () => {
    const s = await musicSession();
    const page = s.rows({ ...q('tracks'), offset: 100, limit: 50 });
    assert.equal(page.length, 50);
    assert.deepEqual(page[0].k, [101]);
    assert.equal(page[0].v[0], 101);

    const sorted = s.rows({ ...q('tracks', { sort: { column: 'milliseconds', dir: 'desc' } }), offset: 0, limit: 5 });
    const ms = sorted.map((r) => r.v[4] as number);
    assert.deepEqual([...ms].sort((a, b) => b - a), ms);

    const g3 = s.count(q('tracks', { filters: { genre_id: '=3' } }));
    assert.ok(g3 > 0 && g3 < 1200);
    assert.equal(s.count(q('tracks', { filters: { metadata: 'null' } })) + s.count(q('tracks', { filters: { metadata: '!null' } })), 1200);
    assert.ok(s.count(q('tracks', { filters: { milliseconds: '>400000' } })) > 0);
    const zombie = s.count(q('tracks', { search: 'ZOMBIE' }));
    assert.ok(zombie > 0);
    assert.equal(s.count(q('tracks', { search: 'zombie', filters: { name: '!zombie' } })), 0);
  });

  it('keys WITHOUT ROWID rows by primary key and finds a row position', async () => {
    const s = await musicSession();
    const rows = s.rows({ ...q('invoice_items'), offset: 0, limit: 3 });
    assert.equal(rows[0].k!.length, 2);
    assert.equal(s.findRow(q('tracks'), [500]), 499);
    assert.equal(s.findRow(q('tracks', { filters: { id: '>100' } }), [500]), 399);
    assert.equal(s.findRow(q('tracks', { filters: { id: '<100' } }), [500]), -1);
  });

  it('returns views without keys', async () => {
    const s = await musicSession();
    const rows = s.rows({ ...q('top_tracks'), offset: 0, limit: 100 });
    assert.equal(rows.length, 20);
    assert.equal(rows[0].k, null);
  });
});

describe('editing with undo/redo', () => {
  it('updates cells and undoes them', async () => {
    const s = await musicSession();
    const res = s.updateCells('tracks', [{ key: [1], column: 'name', value: 'Renamed' }]);
    assert.ok(res.edit);
    assert.equal(s.getRow('tracks', [1])![3], 'Renamed');
    const before = (await musicSession()).getRow('tracks', [1])![3];
    assert.equal(s.undo(res.edit!.id).ok, true);
    assert.equal(s.getRow('tracks', [1])![3], before);
    s.redo(res.edit!.id);
    assert.equal(s.getRow('tracks', [1])![3], 'Renamed');
  });

  it('follows the row when the INTEGER PRIMARY KEY changes', async () => {
    const s = await musicSession();
    const res = s.updateCells('tracks', [{ key: [5], column: 'id', value: '50000' }]);
    assert.equal(s.getRow('tracks', [5]), null);
    assert.equal(s.getRow('tracks', [50000])![0], 50000);
    s.undo(res.edit!.id);
    assert.equal(s.getRow('tracks', [5])![0], 5);
    assert.equal(s.getRow('tracks', [50000]), null);
  });

  it('applies column affinity to typed text', async () => {
    const s = await musicSession();
    s.updateCells('tracks', [{ key: [2], column: 'milliseconds', value: '1234' }]);
    assert.equal(s.getRow('tracks', [2])![4], 1234);
    s.updateCells('tracks', [{ key: [2], column: 'metadata', value: null }]);
    assert.equal(s.getRow('tracks', [2])![6], null);
  });

  it('inserts with defaults and a generated rowid, undo and redo keep the same id', async () => {
    const s = await musicSession();
    const res = s.insertRow('tracks', { name: 'New song' });
    assert.deepEqual(res.key, [1201]);
    const row = s.getRow('tracks', [1201])!;
    assert.equal(row[5], 0.99);
    s.undo(res.edit!.id);
    assert.equal(s.getRow('tracks', [1201]), null);
    s.redo(res.edit!.id);
    assert.equal(s.getRow('tracks', [1201])![3], 'New song');
  });

  it('deletes rows and restores them exactly', async () => {
    const s = await musicSession();
    const original = s.getRow('invoice_items', s.rows({ ...q('invoice_items'), offset: 0, limit: 1 })[0].k!);
    const keys = s.rows({ ...q('invoice_items'), offset: 0, limit: 10 }).map((r) => r.k!);
    const res = s.deleteRows('invoice_items', keys);
    assert.equal(s.count(q('invoice_items')), 378 - 10);
    s.undo(res.edit!.id);
    assert.equal(s.count(q('invoice_items')), 378);
    assert.deepEqual(s.getRow('invoice_items', keys[0]), original);
    s.redo(res.edit!.id);
    assert.equal(s.count(q('invoice_items')), 368);
  });

  it('refuses edits on views and in read-only mode', async () => {
    const s = await musicSession();
    assert.throws(() => s.updateCells('top_tracks', [{ key: [1], column: 'name', value: 'x' }]), /read-only/);
    const ro = await musicSession({ readOnly: true });
    assert.throws(() => ro.updateCells('tracks', [{ key: [1], column: 'name', value: 'x' }]), /read-only/);
    assert.throws(() => ro.exec('DELETE FROM tracks'), /read-only/);
    assert.equal(ro.exec('SELECT count(*) FROM tracks').results[0].rows[0][0], 1200);
  });

  it('handles 64-bit integers, blobs and generated columns', async () => {
    const s = await session(
      await bytesFromSql(`CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER, data BLOB, x, doubled INTEGER GENERATED ALWAYS AS (big * 2) VIRTUAL);
        INSERT INTO t (id, big, data) VALUES (1, 1, x'00ff10');`),
    );
    s.updateCells('t', [{ key: [1], column: 'big', value: { $i: '9223372036854775807' } }]);
    assert.deepEqual(s.getRow('t', [1])![1], { $i: '9223372036854775807' });
    assert.deepEqual(s.getRow('t', [1])![2], { $b: '00ff10', n: 3 });
    s.updateCells('t', [{ key: [1], column: 'data', value: { $b: 'cafe' } }]);
    assert.deepEqual(s.getRow('t', [1])![2], { $b: 'cafe', n: 2 });
    s.updateCells('t', [{ key: [1], column: 'x', value: '42' }]);
    assert.equal(s.exec("SELECT typeof(x) FROM t").results[0].rows[0][0], 'integer');
    assert.throws(() => s.updateCells('t', [{ key: [1], column: 'doubled', value: 1 }]), /generated/);
    const big = s.insertRow('t', { id: { $i: '9007199254740993' } });
    assert.deepEqual(big.key, [{ $i: '9007199254740993' }]);
    const del = s.deleteRows('t', [[{ $i: '9007199254740993' }]]);
    s.undo(del.edit!.id);
    assert.ok(s.getRow('t', [{ $i: '9007199254740993' }]));
  });

  it('uses snapshots for tables with triggers', async () => {
    const s = await session(
      await bytesFromSql(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE log (msg TEXT);
        CREATE TRIGGER tr AFTER UPDATE ON t BEGIN INSERT INTO log VALUES ('changed ' || new.v); END;
        INSERT INTO t VALUES (1, 'a');`),
    );
    const res = s.updateCells('t', [{ key: [1], column: 'v', value: 'b' }]);
    assert.equal(s.count(q('log')), 1);
    s.undo(res.edit!.id);
    assert.equal(s.count(q('log')), 0);
    assert.equal(s.getRow('t', [1])![1], 'a');
    s.redo(res.edit!.id);
    assert.equal(s.count(q('log')), 1);
  });

  it('tables with a column named rowid use _rowid_', async () => {
    const s = await session(await bytesFromSql(`CREATE TABLE t (rowid TEXT, v TEXT); INSERT INTO t VALUES ('a', 'b');`));
    assert.equal(s.schema().tables[0].rowidName, '_rowid_');
    const rows = s.rows({ ...q('t'), offset: 0, limit: 10 });
    s.updateCells('t', [{ key: rows[0].k!, column: 'v', value: 'c' }]);
    assert.deepEqual(s.rows({ ...q('t'), offset: 0, limit: 10 })[0].v, ['a', 'c']);
  });
});

describe('running SQL', () => {
  it('returns result sets with timing and row counts', async () => {
    const s = await musicSession();
    const r = s.exec(`-- Best-selling genres
      SELECT g.name AS genre, count(*) AS tracks_sold, round(sum(i.unit_price * i.quantity), 2) AS revenue
      FROM invoice_items i JOIN tracks t ON t.id = i.track_id JOIN genres g ON g.id = t.genre_id
      GROUP BY g.name ORDER BY revenue DESC; SELECT 1 AS one;`);
    assert.equal(r.error, null);
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results[0].columns, ['genre', 'tracks_sold', 'revenue']);
    assert.equal(r.results[0].total, 8);
    assert.equal(r.edit, null);
    const sorted = s.resultRows(r.results[0].id, 0, 8, { column: 'genre', dir: 'asc' }).map((row) => row[0]);
    assert.deepEqual(sorted, [...sorted].sort());
  });

  it('makes data and schema changes undoable', async () => {
    const s = await musicSession();
    const r = s.exec('UPDATE tracks SET unit_price = 1.49 WHERE id <= 12; CREATE TABLE extra (a);');
    assert.equal(r.error, null);
    assert.equal(r.results[0].rowsModified, 12);
    assert.ok(r.edit);
    assert.equal(r.schemaChanged, true);
    assert.ok(s.schema().tables.some((t) => t.name === 'extra'));
    s.undo(r.edit!.id);
    assert.ok(!s.schema().tables.some((t) => t.name === 'extra'));
    assert.equal(s.exec('SELECT count(*) FROM tracks WHERE unit_price = 1.49').results[0].rows[0][0], 0);
    s.redo(r.edit!.id);
    assert.equal(s.exec('SELECT count(*) FROM tracks WHERE unit_price = 1.49').results[0].rows[0][0], 12);
  });

  it('stops at the failing statement and reports it', async () => {
    const s = await musicSession();
    const r = s.exec('DELETE FROM genres WHERE id = 8; SELECT * FROM nope; DELETE FROM genres;');
    assert.equal(r.error?.statementIndex, 1);
    assert.match(r.error!.message, /no such table/);
    assert.equal(s.count(q('genres')), 7);
    assert.ok(r.edit);
  });

  it('commits a transaction left open, or rolls it back after an error', async () => {
    const s = await musicSession();
    const ok = s.exec('BEGIN; DELETE FROM genres WHERE id = 1;');
    assert.match(ok.notes[0], /committed/);
    assert.equal(s.count(q('genres')), 7);
    const bad = s.exec('BEGIN; DELETE FROM genres; SELECT * FROM nope;');
    assert.match(bad.notes[0], /rolled back/);
    assert.equal(s.count(q('genres')), 7);
  });

  it('reports pragma setters as changes', async () => {
    const s = await musicSession();
    const r = s.exec('PRAGMA user_version = 7');
    assert.ok(r.edit);
    s.undo(r.edit!.id);
    assert.equal(s.exec('PRAGMA user_version').results[0].rows[0][0], 0);
  });

  it('expires old snapshots beyond the undo budget', async () => {
    const bytes = await musicDb();
    const s = await session(bytes, { undoBudgetBytes: bytes.length * 2 + 10 });
    const a = s.exec('DELETE FROM genres WHERE id = 1');
    const b = s.exec('DELETE FROM genres WHERE id = 2');
    s.undo(b.edit!.id); // holds before + after of b
    const outcome = s.undo(a.edit!.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message!, /undo memory limit/);
  });

  it('runs DDL with an inverse or a snapshot', async () => {
    const s = await musicSession();
    const r = s.runDdl(['CREATE INDEX "idx_x" ON "tracks" ("name")'], 'Create index', ['DROP INDEX "idx_x"']);
    assert.ok(s.schema().tables.find((t) => t.name === 'tracks')!.indexes.some((i) => i.name === 'idx_x'));
    s.undo(r.edit!.id);
    assert.ok(!s.schema().tables.find((t) => t.name === 'tracks')!.indexes.some((i) => i.name === 'idx_x'));
    const drop = s.runDdl(['ALTER TABLE "tracks" DROP COLUMN "metadata"'], 'Drop column');
    assert.ok(!s.schema().tables.find((t) => t.name === 'tracks')!.columns.some((c) => c.name === 'metadata'));
    s.undo(drop.edit!.id);
    assert.ok(s.schema().tables.find((t) => t.name === 'tracks')!.columns.some((c) => c.name === 'metadata'));
  });
});

describe('compare', () => {
  it('finds added, removed and changed rows and schema changes', async () => {
    const left = await musicSession();
    const right = await musicSession();
    right.exec(`DELETE FROM customers WHERE id > 57; INSERT INTO genres VALUES (9, 'Highlife');
      UPDATE tracks SET unit_price = 1.49 WHERE id IN (97, 194, 291); ALTER TABLE artists ADD COLUMN website TEXT;`);
    const result = left.compare(right.serialize(), 'music.sqlite', 'music-backup.sqlite');
    const byName = Object.fromEntries(result.tables.map((t) => [t.name, t]));
    assert.equal(byName.customers.removed.count, 3);
    assert.equal(byName.customers.rowCountLeft, 60);
    assert.equal(byName.customers.rowCountRight, 57);
    assert.equal(byName.genres.added.count, 1);
    assert.deepEqual(byName.genres.added.rows[0], [9, 'Highlife']);
    assert.equal(byName.tracks.changed.count, 3);
    const changed = byName.tracks.changed;
    const priceIdx = changed.columns.indexOf('unit_price');
    assert.equal(changed.rows[0].after[priceIdx], 1.49);
    assert.equal(byName.artists.schemaChanged, true);
    assert.deepEqual(byName.artists.columns.added, ['website']);
    assert.equal(byName.albums.status, 'same');
    assert.deepEqual(result.summary, { added: 0, removed: 0, changed: 4, same: 3 });
    // The comparison database is detached afterwards.
    assert.equal(left.exec('PRAGMA database_list').results[0].rows.length, 1);
  });

  it('reports tables added and removed', async () => {
    const left = await session(await bytesFromSql('CREATE TABLE a (x); CREATE TABLE b (y);'));
    const right = await bytesFromSql('CREATE TABLE b (y); CREATE TABLE c (z);');
    const r = left.compare(right, 'l', 'r');
    assert.deepEqual(
      r.tables.map((t) => `${t.name}:${t.status}`),
      ['a:removed', 'b:same', 'c:added'],
    );
  });
});

describe('export', () => {
  it('exports CSV, JSON, SQL and Markdown', async () => {
    const s = await session(
      await bytesFromSql(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB, big INTEGER);
        INSERT INTO t VALUES (1, 'plain', NULL, 9223372036854775807), (2, 'with, "quotes"' || char(10) || 'and newline', x'0a0b', -1);`),
    );
    const src = { kind: 'table' as const, table: 't' };
    assert.equal(
      s.exportData(src, 'csv').join(''),
      'id,name,data,big\n1,plain,,9223372036854775807\n2,"with, ""quotes""\nand newline",0a0b,-1\n',
    );
    const json = JSON.parse(s.exportData(src, 'json').join(''));
    assert.equal(json[1].name, 'with, "quotes"\nand newline');
    assert.match(s.exportData(src, 'json').join(''), /"big": 9223372036854775807/);
    const sql = s.exportData(src, 'sql').join('');
    assert.match(sql, /^CREATE TABLE t \(/);
    assert.match(sql, /INSERT INTO "t" \("id", "name", "data", "big"\) VALUES \(2, 'with, "quotes"\nand newline', X'0a0b', -1\);/);
    const md = s.exportData(src, 'md').join('');
    assert.match(md, /^\| id \| name \| data \| big \|\n\| ---: \| --- \| --- \| ---: \|/);
    assert.match(md, /with, "quotes"<br>and newline/);
  });

  it('dumps a database that re-imports identically', async () => {
    const s = await musicSession();
    const dump = s.dump().join('');
    assert.match(dump, /^-- Local AstroDB dump\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;/);
    assert.match(dump, /COMMIT;\n$/);
    const SQL = await loadSql();
    const copy = new SQL.Database();
    copy.exec(dump);
    for (const t of ['tracks', 'invoice_items', 'customers']) {
      assert.equal(copy.exec(`SELECT count(*) FROM ${t}`)[0].values[0][0], s.counts()[t]);
    }
    assert.equal(copy.exec('SELECT count(*) FROM top_tracks')[0].values[0][0], 20);
    assert.equal(copy.exec("SELECT count(*) FROM sqlite_schema WHERE name = 'idx_tracks_album'")[0].values[0][0], 1);
  });

  it('exports query results in their sorted order', async () => {
    const s = await musicSession();
    const r = s.exec('SELECT id, name FROM genres');
    s.resultRows(r.results[0].id, 0, 10, { column: 'name', dir: 'desc' });
    const csv = s.exportData({ kind: 'result', resultId: r.results[0].id }, 'csv').join('');
    assert.equal(csv.split('\n')[1], '7,Soul');
  });
});

describe('TypeScript types', () => {
  it('maps SQLite types and nullability', async () => {
    const s = await musicSession();
    const ts = s.typescript('music.sqlite');
    assert.match(ts, /export interface Tracks \{\n {2}id: number; \/\/ primary key, INTEGER\n {2}album_id: number \| null; \/\/ INTEGER\n/);
    assert.match(ts, /name: string; \/\/ TEXT\n/);
    assert.match(ts, /export interface InvoiceItems \{\n {2}invoice_id: number; \/\/ primary key \(1\), INTEGER/);
    assert.match(ts, /export interface TopTracks \{/);
    assert.match(ts, /export interface Database \{\n {2}albums: Albums;/);
  });
});

describe('file format', () => {
  it('folds a WAL file into the database', async () => {
    const main = new Uint8Array(fixture('wal.db'));
    const wal = new Uint8Array(fixture('wal.db-wal'));
    const prepared = prepareForLoad(main, wal);
    assert.equal(prepared.walMode, true);
    assert.ok(prepared.walFramesApplied > 0);
    const s = await session(prepared.bytes);
    assert.deepEqual(s.exec('SELECT * FROM t ORDER BY id').results[0].rows, [
      [1, 'updated in wal'],
      [2, 'in wal'],
    ]);
    const out = restoreJournalMode(s.serialize(), true);
    assert.equal(out[18], 2);
    const withoutWal = await session(prepareForLoad(main, null).bytes);
    assert.deepEqual(withoutWal.exec('SELECT * FROM t').results[0].rows, [[1, 'checkpointed']]);
  });

  it('recognizes SQLite files', async () => {
    assert.equal(isSqliteFile(await musicDb()), true);
    assert.equal(isSqliteFile(new Uint8Array(0)), true);
    assert.equal(isSqliteFile(new TextEncoder().encode('x'.repeat(200))), false);
    await assert.rejects(session(new TextEncoder().encode('not a database'.repeat(100))), /not a database/);
  });
});
