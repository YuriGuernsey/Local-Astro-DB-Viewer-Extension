import { useState } from 'preact/hooks';
import { createTableSql, dropObjectSql, emptyColumn, validateTableDef, type NewColumnDef, type NewTableDef } from '../../shared/ddl';
import { SqlBlock } from '../components/common';
import { reportError, request } from '../rpc';
import { setState, useStore } from '../store';
import { ReferencesInput, TypeInput } from './StructureView';

export function NewTableView() {
  const existing = useStore((s) => s.schema.tables.map((t) => t.name));
  const [def, setDef] = useState<NewTableDef>({
    name: '',
    columns: [{ ...emptyColumn('id', 'INTEGER'), pk: true }, emptyColumn('name', 'TEXT')],
    withoutRowid: false,
    strict: false,
  });
  const [busy, setBusy] = useState(false);
  const error = validateTableDef(def, existing);
  const sql = createTableSql({ ...def, name: def.name.trim() || 'new_table', columns: def.columns.map((c) => ({ ...c, name: c.name.trim() || '…' })) });

  const setColumn = (i: number, patch: Partial<NewColumnDef>) =>
    setDef((d) => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const move = (i: number, delta: number) =>
    setDef((d) => {
      const cols = d.columns.slice();
      const j = i + delta;
      if (j < 0 || j >= cols.length) return d;
      [cols[i], cols[j]] = [cols[j], cols[i]];
      return { ...d, columns: cols };
    });

  const create = async () => {
    if (error || busy) return;
    setBusy(true);
    const name = def.name.trim();
    try {
      await request('runDdl', { statements: [createTableSql({ ...def, name })], label: `Create table ${name}`, inverse: [dropObjectSql('table', name)] });
      setState({ newTable: false, table: name, tab: 'structure' });
    } catch (err) {
      reportError(err, 'Create table');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      class="new-table"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setState({ newTable: false });
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void create();
      }}
    >
      <div class="toolbar">
        <div class="toolbar-title">
          <b>New table</b>
        </div>
      </div>
      <div class="structure-body">
        <div class="form-row">
          <input
            class="input wide"
            placeholder="Table name"
            aria-label="Table name"
            autoFocus
            value={def.name}
            onInput={(e) => setDef((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))}
          />
        </div>
        <table class="struct-table new-cols">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th title="Primary key">PK</th>
              <th title="AUTOINCREMENT">Auto</th>
              <th title="NOT NULL">Not null</th>
              <th>Unique</th>
              <th>Default</th>
              <th>References</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {def.columns.map((c, i) => (
              <tr>
                <td>
                  <input class="input" aria-label={`Column ${i + 1} name`} value={c.name} onInput={(e) => setColumn(i, { name: (e.target as HTMLInputElement).value })} />
                </td>
                <td>
                  <TypeInput value={c.type} onChange={(type) => setColumn(i, { type })} />
                </td>
                <td>
                  <input type="checkbox" aria-label="Primary key" checked={c.pk} onChange={(e) => setColumn(i, { pk: (e.target as HTMLInputElement).checked, autoincrement: false })} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Autoincrement"
                    disabled={!c.pk || !/^integer$/i.test(c.type.trim())}
                    checked={c.autoincrement}
                    onChange={(e) => setColumn(i, { autoincrement: (e.target as HTMLInputElement).checked })}
                  />
                </td>
                <td>
                  <input type="checkbox" aria-label="Not null" checked={c.notNull} onChange={(e) => setColumn(i, { notNull: (e.target as HTMLInputElement).checked })} />
                </td>
                <td>
                  <input type="checkbox" aria-label="Unique" checked={c.unique} onChange={(e) => setColumn(i, { unique: (e.target as HTMLInputElement).checked })} />
                </td>
                <td>
                  <input class="input" aria-label="Default" placeholder="—" value={c.defaultValue} onInput={(e) => setColumn(i, { defaultValue: (e.target as HTMLInputElement).value })} />
                </td>
                <td>
                  <ReferencesInput value={c.references} onChange={(references) => setColumn(i, { references })} />
                </td>
                <td class="actions-col">
                  <button class="link" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button class="link" aria-label="Move down" title="Move down" disabled={i === def.columns.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button
                    class="link danger"
                    aria-label="Remove column"
                    title="Remove column"
                    onClick={() => setDef((d) => ({ ...d, columns: d.columns.filter((_, j) => j !== i) }))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="row-gap">
          <button class="btn" onClick={() => setDef((d) => ({ ...d, columns: [...d.columns, emptyColumn('', 'TEXT')] }))}>
            + Column
          </button>
          <label class="check">
            <input type="checkbox" checked={def.withoutRowid} onChange={(e) => setDef((d) => ({ ...d, withoutRowid: (e.target as HTMLInputElement).checked }))} /> WITHOUT ROWID
          </label>
          <label class="check">
            <input type="checkbox" checked={def.strict} onChange={(e) => setDef((d) => ({ ...d, strict: (e.target as HTMLInputElement).checked }))} /> STRICT
          </label>
        </div>
        <h3 class="section-title">SQL preview</h3>
        <SqlBlock sql={sql} />
        <div class="row-gap">
          <button class="btn primary" disabled={!!error || busy} onClick={() => void create()}>
            Create table
          </button>
          <button class="btn" onClick={() => setState({ newTable: false })}>
            Cancel
          </button>
          {error && <span class="muted">{error}</span>}
        </div>
      </div>
    </div>
  );
}
