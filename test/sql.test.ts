import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeTableDef,
  addColumnSql,
  createIndexSql,
  createTableSql,
  defaultIndexName,
  emptyColumn,
  formatDefault,
  validateTableDef,
} from '../src/shared/ddl';
import { affinityOf, isReadOnlyStatement, referenceableColumns, splitStatements, statementAt } from '../src/shared/sql';
import type { TableInfo } from '../src/shared/protocol';
import { filterCondition } from '../src/engine/filters';

describe('splitStatements', () => {
  it('splits on semicolons outside strings and comments', () => {
    const sql = "select ';' as a; -- c;\nselect \"x;y\" from t /* ; */; select 3";
    assert.deepEqual(
      splitStatements(sql).map((s) => s.text),
      ["select ';' as a;", 'select "x;y" from t /* ; */;', 'select 3'],
    );
  });

  it('keeps trigger bodies together', () => {
    const sql = `CREATE TRIGGER tr AFTER INSERT ON t BEGIN
      UPDATE t SET v = CASE WHEN new.v IS NULL THEN 1 ELSE 2 END;
      INSERT INTO log VALUES (1);
    END; SELECT 1;`;
    const parts = splitStatements(sql);
    assert.equal(parts.length, 2);
    assert.match(parts[0].text, /END;$/);
    assert.equal(parts[1].text, 'SELECT 1;');
  });

  it('treats BEGIN as a transaction outside triggers', () => {
    assert.equal(splitStatements('BEGIN; INSERT INTO t VALUES (1); COMMIT;').length, 3);
  });

  it('includes the comments above a statement', () => {
    const sql = '-- first\nselect 1; -- trailing\n\n/* about two */\nselect 2;';
    assert.deepEqual(
      splitStatements(sql).map((s) => s.text),
      ['-- first\nselect 1;', '/* about two */\nselect 2;'],
    );
  });

  it('finds the statement at the cursor', () => {
    const sql = 'select 1;\nselect 2;\n\nselect 3;';
    assert.equal(statementAt(sql, 3)?.text, 'select 1;');
    assert.equal(statementAt(sql, 9)?.text, 'select 1;');
    assert.equal(statementAt(sql, 12)?.text, 'select 2;');
    assert.equal(statementAt(sql, sql.length)?.text, 'select 3;');
  });
});

describe('isReadOnlyStatement', () => {
  it('classifies statements', () => {
    assert.equal(isReadOnlyStatement('  -- hi\n SELECT * FROM t'), true);
    assert.equal(isReadOnlyStatement('WITH x AS (SELECT 1) SELECT * FROM x'), true);
    assert.equal(isReadOnlyStatement('WITH x AS (SELECT 1) DELETE FROM t'), false);
    assert.equal(isReadOnlyStatement('PRAGMA table_info(t)'), true);
    assert.equal(isReadOnlyStatement('PRAGMA main.table_info(t)'), true);
    assert.equal(isReadOnlyStatement('PRAGMA user_version = 3'), false);
    assert.equal(isReadOnlyStatement('PRAGMA foreign_keys(1)'), false);
    assert.equal(isReadOnlyStatement('PRAGMA optimize'), false);
    assert.equal(isReadOnlyStatement('UPDATE t SET a = 1'), false);
    assert.equal(isReadOnlyStatement('EXPLAIN QUERY PLAN SELECT 1'), true);
  });
});

describe('affinity', () => {
  it('follows SQLite rules', () => {
    assert.equal(affinityOf('INTEGER'), 'INTEGER');
    assert.equal(affinityOf('VARCHAR(20)'), 'TEXT');
    assert.equal(affinityOf(''), 'BLOB');
    assert.equal(affinityOf('DOUBLE PRECISION'), 'REAL');
    assert.equal(affinityOf('DATETIME'), 'NUMERIC');
    assert.equal(affinityOf('DECIMAL(10,5)'), 'NUMERIC');
    assert.equal(affinityOf('FLOATING POINT'), 'INTEGER'); // the documented quirk
  });
});

describe('filters', () => {
  it('parses the filter syntax', () => {
    assert.deepEqual(filterCondition('a', 'abc'), { sql: `"a" LIKE ? ESCAPE '\\'`, params: ['%abc%'] });
    assert.deepEqual(filterCondition('a', '=abc'), { sql: '"a" = ?', params: ['abc'] });
    assert.deepEqual(filterCondition('a', '!=abc'), { sql: '"a" IS NOT ?', params: ['abc'] });
    assert.deepEqual(filterCondition('a', '>5'), { sql: '"a" > ?', params: [5] });
    assert.deepEqual(filterCondition('a', '<=10.5'), { sql: '"a" <= ?', params: [10.5] });
    assert.deepEqual(filterCondition('a', 'null'), { sql: '"a" IS NULL', params: [] });
    assert.deepEqual(filterCondition('a', '!null'), { sql: '"a" IS NOT NULL', params: [] });
    assert.deepEqual(filterCondition('a', 'empty'), { sql: `"a" = ''`, params: [] });
    assert.deepEqual(filterCondition('a', '50%_'), { sql: `"a" LIKE ? ESCAPE '\\'`, params: ['%50\\%\\_%'] });
    assert.equal(filterCondition('a', '   '), null);
    assert.deepEqual(filterCondition('a', '=9223372036854775807'), { sql: '"a" = CAST(? AS INTEGER)', params: [9223372036854775807n] });
  });
});

describe('ddl', () => {
  it('builds CREATE TABLE with a live preview shape', () => {
    const id = { ...emptyColumn('id', 'INTEGER'), pk: true, autoincrement: true };
    const name = { ...emptyColumn('name', 'TEXT'), notNull: true, defaultValue: 'unknown' };
    const price = { ...emptyColumn('price', 'REAL'), defaultValue: '0.99' };
    const artist = { ...emptyColumn('artist_id', 'INTEGER'), references: { table: 'artists', column: 'id' } };
    const sql = createTableSql({ name: 'songs', columns: [id, name, price, artist], withoutRowid: false, strict: false });
    assert.equal(
      sql,
      `CREATE TABLE "songs" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "name" TEXT NOT NULL DEFAULT 'unknown',\n  "price" REAL DEFAULT 0.99,\n  "artist_id" INTEGER REFERENCES "artists" ("id")\n)`,
    );
  });

  it('builds composite keys and options', () => {
    const a = { ...emptyColumn('a', 'INTEGER'), pk: true };
    const b = { ...emptyColumn('b', 'TEXT'), pk: true };
    assert.equal(
      createTableSql({ name: 't', columns: [a, b], withoutRowid: true, strict: true }),
      'CREATE TABLE "t" (\n  "a" INTEGER,\n  "b" TEXT,\n  PRIMARY KEY ("a", "b")\n) WITHOUT ROWID, STRICT',
    );
  });

  it('validates definitions', () => {
    assert.equal(validateTableDef({ name: '', columns: [], withoutRowid: false, strict: false }, []), 'Enter a table name.');
    assert.match(validateTableDef({ name: 'Tracks', columns: [emptyColumn('a')], withoutRowid: false, strict: false }, ['tracks'])!, /already exists/);
    assert.equal(validateTableDef({ name: 'x', columns: [emptyColumn('a')], withoutRowid: false, strict: false }, []), null);
  });

  it('rejects AUTOINCREMENT with WITHOUT ROWID', () => {
    const id = { ...emptyColumn('id', 'INTEGER'), pk: true, autoincrement: true };
    assert.match(validateTableDef({ name: 't', columns: [id], withoutRowid: true, strict: false }, [])!, /WITHOUT ROWID/);
  });

  it('compares identifiers with ASCII-only case folding, like SQLite', () => {
    assert.equal(validateTableDef({ name: 'ärger', columns: [emptyColumn('a')], withoutRowid: false, strict: false }, ['Ärger']), null);
    assert.match(validateTableDef({ name: 'TRACKS', columns: [emptyColumn('a')], withoutRowid: false, strict: false }, ['tracks'])!, /already exists/);
    assert.equal(validateTableDef({ name: 't', columns: [emptyColumn('É'), emptyColumn('é')], withoutRowid: false, strict: false }, []), null);
  });

  it('normalizes names before building SQL', () => {
    const def = normalizeTableDef({ name: ' t ', columns: [emptyColumn(' code ', ' TEXT ')], withoutRowid: false, strict: false });
    assert.equal(createTableSql(def), 'CREATE TABLE "t" (\n  "code" TEXT\n)');
  });

  it('offers only single-column keys as foreign key targets', () => {
    const t = (pk: string[], indexes: TableInfo['indexes'] = []) =>
      ({ columns: ['a', 'b', 'c'].map((name) => ({ name })), pk, indexes }) as unknown as TableInfo;
    assert.deepEqual(referenceableColumns(t(['a', 'b'])), []);
    assert.deepEqual(referenceableColumns(t(['a'])), ['a']);
    assert.deepEqual(referenceableColumns(t(['a', 'b'], [{ name: 'u', unique: true, origin: 'u', partial: false, columns: ['c'], sql: null }])), ['c']);
  });

  it('formats defaults', () => {
    assert.equal(formatDefault('42'), '42');
    assert.equal(formatDefault('current_timestamp'), 'CURRENT_TIMESTAMP');
    assert.equal(formatDefault("'x'"), "'x'");
    assert.equal(formatDefault("it's"), "'it''s'");
    assert.equal(formatDefault('(datetime())'), '(datetime())');
  });

  it('builds index and column statements', () => {
    assert.equal(defaultIndexName('tracks', ['name', 'milliseconds']), 'idx_tracks_name_milliseconds');
    assert.equal(
      createIndexSql('idx_tracks_name_milliseconds', 'tracks', ['name', 'milliseconds'], false),
      'CREATE INDEX "idx_tracks_name_milliseconds" ON "tracks" ("name", "milliseconds")',
    );
    assert.equal(addColumnSql('t', { ...emptyColumn('c', 'INTEGER'), notNull: true, defaultValue: '0' }), 'ALTER TABLE "t" ADD COLUMN "c" INTEGER NOT NULL DEFAULT 0');
  });
});
