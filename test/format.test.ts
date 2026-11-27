import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTsv, reformatJson, tsvField } from '../src/webview/format';

describe('clipboard TSV', () => {
  it('round-trips CR/LF inside quoted fields', () => {
    const text = [tsvField('a\r\nb'), tsvField('c')].join('\t') + '\r\n' + 'd\te';
    assert.deepEqual(parseTsv(text), [
      ['a\r\nb', 'c'],
      ['d', 'e'],
    ]);
  });

  it('ignores one trailing line break', () => {
    assert.deepEqual(parseTsv('x\ty\r\n'), [['x', 'y']]);
  });
});

describe('JSON formatting', () => {
  it('keeps numbers, escapes and key order exactly', () => {
    const src = '{"id":9007199254740993,"s":"a\\"b\\\\","n":[1.50,{},[]],"z":null}';
    const pretty = reformatJson(src, true);
    assert.equal(pretty, '{\n  "id": 9007199254740993,\n  "s": "a\\"b\\\\",\n  "n": [\n    1.50,\n    {},\n    []\n  ],\n  "z": null\n}');
    assert.equal(reformatJson(pretty, false), src);
  });
});
