import { useEffect, useState } from 'preact/hooks';
import {
  addColumnSql,
  COMMON_TYPES,
  createIndexSql,
  defaultIndexName,
  dropColumnSql,
  dropObjectSql,
  emptyColumn,
  renameColumnSql,
  renameTableSql,
  type NewColumnDef,
} from '../../shared/ddl';
import type { TableInfo } from '../../shared/protocol';
import { Icon, SqlBlock } from '../components/common';
import { reportError, request } from '../rpc';
import { currentTable, setState, useStore } from '../store';
import { selectTable } from '../actions';

type Form = { kind: 'column' } | { kind: 'index' } | { kind: 'rename' } | null;

async function runDdl(statements: string[], label: string, inverse?: string[]): Promise<boolean> {
  try {
    await request('runDdl', { statements, label, inverse });
    return true;
  } catch (err) {
    reportError(err, label);
    return false;
  }
}

async function confirm(message: string, detail: string, label: string): Promise<boolean> {
  return request('confirm', { message, detail, confirm: label });
}

export function StructureView() {
  const table = useStore((s) => currentTable(s));
  const readOnly = useStore((s) => !!s.info?.readOnly);
  const [form, setForm] = useState<Form>(null);
  useEffect(() => setForm(null), [table?.name]);

  if (!table) return <div class="placeholder">Select a table.</div>;
  const isView = table.type === 'view';
  const canAlter = !readOnly && table.type === 'table';
  const canDrop = !readOnly && (table.type === 'table' || table.type === 'view' || table.type === 'virtual');
  const kind = isView ? 'view' : table.type === 'virtual' ? 'virtual table' : 'table';

  const drop = async () => {
    if (!(await confirm(`Drop ${kind} "${table.name}"?`, isView ? 'You can undo this.' : 'All of its rows will be deleted. You can undo this.', 'Drop'))) return;
    const inverse = isView && table.sql ? [table.sql] : undefined;
    await runDdl([dropObjectSql(isView ? 'view' : 'table', table.name)], `Drop ${kind} ${table.name}`, inverse);
  };

  return (
    <div class="structure">
      <div class="toolbar">
        <div class="toolbar-title">
          <Icon name={isView ? 'view' : 'table'} />
          <b>{table.name}</b>
          <span class="muted">{kind}</span>
          {table.withoutRowid && <span class="pill">WITHOUT ROWID</span>}
          {table.strict && <span class="pill">STRICT</span>}
        </div>
        <div class="toolbar-actions">
          {canAlter && (
            <>
              <button class="btn" onClick={() => setForm({ kind: 'column' })}>
                + Column
              </button>
              <button class="btn" onClick={() => setForm({ kind: 'index' })}>
                + Index
              </button>
              <button class="btn" onClick={() => setForm({ kind: 'rename' })}>
                Rename
              </button>
            </>
          )}
          {canDrop && (
            <button class="btn danger" onClick={() => void drop()}>
              Drop
            </button>
          )}
        </div>
      </div>
      <div class="structure-body">
        {form?.kind === 'column' && <AddColumnForm table={table} onDone={() => setForm(null)} />}
        {form?.kind === 'index' && <AddIndexForm table={table} onDone={() => setForm(null)} />}
        {form?.kind === 'rename' && <RenameTableForm table={table} onDone={() => setForm(null)} />}
        {table.error && <div class="error-bar">{table.error}</div>}
        <ColumnsSection table={table} canAlter={canAlter} />
        {!isView && <IndexesSection table={table} canAlter={canAlter} />}
        {!isView && table.foreignKeys.length > 0 && <ForeignKeysSection table={table} />}
        {table.triggers.length > 0 && <TriggersSection table={table} canAlter={!readOnly} />}
        <h3 class="section-title">Create statement</h3>
        {table.sql ? <SqlBlock sql={table.sql} /> : <p class="muted">Built-in object without a CREATE statement.</p>}
      </div>
    </div>
  );
}

function ColumnsSection({ table, canAlter }: { table: TableInfo; canAlter: boolean }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const fk = new Map<string, string>();
  for (const f of table.foreignKeys) f.from.forEach((c, i) => fk.set(c, `${f.table}.${f.to[i] ?? 'id'}`));
  const unique = new Set(table.indexes.filter((i) => i.origin === 'u' && i.columns.length === 1).map((i) => i.columns[0]));

  const rename = async (from: string) => {
    const to = newName.trim();
    setRenaming(null);
    if (!to || to === from) return;
    await runDdl([renameColumnSql(table.name, from, to)], `Rename column ${from}`, [renameColumnSql(table.name, to, from)]);
  };

  const drop = async (column: string) => {
    if (!(await confirm(`Drop column "${column}" from "${table.name}"?`, 'Its data will be deleted. You can undo this.', 'Drop column'))) return;
    await runDdl([dropColumnSql(table.name, column)], `Drop column ${column}`);
  };

  return (
    <>
      <h3 class="section-title">Columns ({table.columns.length})</h3>
      <table class="struct-table">
        <thead>
          <tr>
            <th class="narrow">#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Not null</th>
            <th>Default</th>
            <th>Key</th>
            {canAlter && <th class="actions-col" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c, i) => (
            <tr>
              <td class="muted narrow">{i + 1}</td>
              <td>
                {renaming === c.name ? (
                  <input
                    class="input"
                    value={newName}
                    autoFocus
                    aria-label={`New name for ${c.name}`}
                    onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(c.name);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={() => setRenaming(null)}
                  />
                ) : (
                  <b>{c.name}</b>
                )}
              </td>
              <td class="mono">{c.type || <span class="muted">—</span>}</td>
              <td>{c.notNull ? '✓' : ''}</td>
              <td class="mono">{c.defaultValue ?? ''}</td>
              <td>
                {c.pk > 0 && <span class="tag">PK{table.pk.length > 1 ? ` ${c.pk}` : ''}</span>}
                {fk.has(c.name) && <span class="tag">→ {fk.get(c.name)}</span>}
                {unique.has(c.name) && <span class="tag">UNIQUE</span>}
                {c.generated && <span class="tag">generated</span>}
              </td>
              {canAlter && (
                <td class="actions-col">
                  <button
                    class="link"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setNewName(c.name);
                      setRenaming(c.name);
                    }}
                  >
                    Rename
                  </button>
                  {c.pk === 0 && (
                    <button class="link danger" onClick={() => void drop(c.name)}>
                      Drop
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function IndexesSection({ table, canAlter }: { table: TableInfo; canAlter: boolean }) {
  const origin = { c: 'CREATE INDEX', u: 'UNIQUE constraint', pk: 'PRIMARY KEY' } as const;
  const drop = async (name: string, sql: string | null) => {
    if (!(await confirm(`Drop index "${name}"?`, 'You can undo this.', 'Drop index'))) return;
    await runDdl([dropObjectSql('index', name)], `Drop index ${name}`, sql ? [sql] : undefined);
  };
  return (
    <>
      <h3 class="section-title">Indexes ({table.indexes.length})</h3>
      {table.indexes.length === 0 ? (
        <p class="muted">No indexes.</p>
      ) : (
        <table class="struct-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Unique</th>
              <th>Origin</th>
              {canAlter && <th class="actions-col" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {table.indexes.map((i) => (
              <tr>
                <td>{i.name}</td>
                <td class="mono">
                  {i.columns.join(', ')}
                  {i.partial && <span class="muted"> (partial)</span>}
                </td>
                <td>{i.unique ? '✓' : ''}</td>
                <td>{origin[i.origin] ?? i.origin}</td>
                {canAlter && (
                  <td class="actions-col">
                    {i.origin === 'c' && (
                      <button class="link danger" onClick={() => void drop(i.name, i.sql)}>
                        Drop
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ForeignKeysSection({ table }: { table: TableInfo }) {
  return (
    <>
      <h3 class="section-title">Foreign keys ({table.foreignKeys.length})</h3>
      <table class="struct-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>References</th>
            <th>On delete</th>
            <th>On update</th>
          </tr>
        </thead>
        <tbody>
          {table.foreignKeys.map((f) => (
            <tr>
              <td class="mono">{f.from.join(', ')}</td>
              <td class="mono">
                <button class="link" onClick={() => selectTable(f.table, 'structure')} title={`Open ${f.table}`}>
                  {f.table}({f.to.join(', ') || 'primary key'})
                </button>
              </td>
              <td>{f.onDelete}</td>
              <td>{f.onUpdate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TriggersSection({ table, canAlter }: { table: TableInfo; canAlter: boolean }) {
  const drop = async (name: string, sql: string) => {
    if (!(await confirm(`Drop trigger "${name}"?`, 'You can undo this.', 'Drop trigger'))) return;
    await runDdl([dropObjectSql('trigger', name)], `Drop trigger ${name}`, [sql]);
  };
  return (
    <>
      <h3 class="section-title">Triggers ({table.triggers.length})</h3>
      {table.triggers.map((t) => (
        <div class="trigger">
          <div class="trigger-head">
            <b>{t.name}</b>
            {canAlter && (
              <button class="link danger" onClick={() => void drop(t.name, t.sql)}>
                Drop
              </button>
            )}
          </div>
          <SqlBlock sql={t.sql} />
        </div>
      ))}
    </>
  );
}

function FormShell({ preview, error, submit, onSubmit, onCancel, children }: {
  preview: string;
  error: string | null;
  submit: string;
  onSubmit(): void;
  onCancel(): void;
  children: preact.ComponentChildren;
}) {
  return (
    <div
      class="inline-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !error) onSubmit();
      }}
    >
      {children}
      <div class="row-gap">
        <button class="btn primary" disabled={!!error} onClick={onSubmit} title={error ?? undefined}>
          {submit}
        </button>
        <button class="btn" onClick={onCancel}>
          Cancel
        </button>
        {error && <span class="muted">{error}</span>}
      </div>
      <SqlBlock sql={preview} />
    </div>
  );
}

function AddColumnForm({ table, onDone }: { table: TableInfo; onDone(): void }) {
  const [col, setCol] = useState<NewColumnDef>(emptyColumn('', 'TEXT'));
  const exists = table.columns.some((c) => c.name.toLowerCase() === col.name.trim().toLowerCase());
  const error = !col.name.trim() ? 'Enter a column name.' : exists ? 'A column with this name exists.' : col.notNull && !col.defaultValue.trim() ? 'NOT NULL columns need a default.' : null;
  const sql = addColumnSql(table.name, { ...col, name: col.name.trim() || 'new_column' });
  const submit = async () => {
    if (error) return;
    const inverse = col.references ? undefined : [dropColumnSql(table.name, col.name.trim())];
    if (await runDdl([sql], `Add column ${col.name.trim()}`, inverse)) onDone();
  };
  const set = (patch: Partial<NewColumnDef>) => setCol((c) => ({ ...c, ...patch }));
  return (
    <FormShell preview={sql} error={error} submit="Add column" onSubmit={() => void submit()} onCancel={onDone}>
      <div class="form-row">
        <input class="input" placeholder="Column name" aria-label="Column name" autoFocus value={col.name} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
        <TypeInput value={col.type} onChange={(type) => set({ type })} />
        <input class="input" placeholder="Default" aria-label="Default value" value={col.defaultValue} onInput={(e) => set({ defaultValue: (e.target as HTMLInputElement).value })} />
        <label class="check">
          <input type="checkbox" checked={col.notNull} onChange={(e) => set({ notNull: (e.target as HTMLInputElement).checked })} /> NOT NULL
        </label>
        <ReferencesInput value={col.references} onChange={(references) => set({ references })} />
      </div>
    </FormShell>
  );
}

export function TypeInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <>
      <input class="input type-input" list="sqlite-types" placeholder="Type" aria-label="Type" value={value} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      <datalist id="sqlite-types">
        {COMMON_TYPES.map((t) => (
          <option value={t} />
        ))}
      </datalist>
    </>
  );
}

export function ReferencesInput({ value, onChange }: { value: NewColumnDef['references']; onChange(v: NewColumnDef['references']): void }) {
  const tables = useStore((s) => s.schema.tables.filter((t) => t.type === 'table'));
  const target = tables.find((t) => t.name === value?.table);
  return (
    <span class="row-gap">
      <select
        class="input"
        aria-label="References table"
        value={value?.table ?? ''}
        onChange={(e) => {
          const name = (e.target as HTMLSelectElement).value;
          const t = tables.find((x) => x.name === name);
          onChange(name ? { table: name, column: t?.pk[0] ?? t?.columns[0]?.name ?? '' } : null);
        }}
      >
        <option value="">No reference</option>
        {tables.map((t) => (
          <option value={t.name}>→ {t.name}</option>
        ))}
      </select>
      {target && (
        <select class="input" aria-label="References column" value={value?.column} onChange={(e) => onChange({ table: target.name, column: (e.target as HTMLSelectElement).value })}>
          {target.columns.map((c) => (
            <option value={c.name}>{c.name}</option>
          ))}
        </select>
      )}
    </span>
  );
}

function AddIndexForm({ table, onDone }: { table: TableInfo; onDone(): void }) {
  const [cols, setCols] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const indexName = nameEdited ? name : defaultIndexName(table.name, cols);
  const allNames = useStore((s) => s.schema.tables.flatMap((t) => t.indexes.map((i) => i.name.toLowerCase())));
  const error = cols.length === 0 ? 'Pick at least one column.' : !indexName.trim() ? 'Enter an index name.' : allNames.includes(indexName.toLowerCase()) ? 'An index with this name exists.' : null;
  const sql = createIndexSql(indexName, table.name, cols.length ? cols : ['…'], unique);
  const toggle = (c: string) => setCols((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  const submit = async () => {
    if (error) return;
    if (await runDdl([sql], `Create index ${indexName}`, [dropObjectSql('index', indexName)])) onDone();
  };
  return (
    <FormShell preview={sql} error={error} submit="Create index" onSubmit={() => void submit()} onCancel={onDone}>
      <input
        class="input wide"
        aria-label="Index name"
        value={indexName}
        onInput={(e) => {
          setName((e.target as HTMLInputElement).value);
          setNameEdited(true);
        }}
      />
      <div class="chips" role="group" aria-label="Columns, in index order">
        {table.columns.map((c) => {
          const at = cols.indexOf(c.name);
          return (
            <button class={at >= 0 ? 'chip on' : 'chip'} aria-pressed={at >= 0} onClick={() => toggle(c.name)}>
              {at >= 0 && cols.length > 1 ? `${at + 1}. ` : ''}
              {c.name}
            </button>
          );
        })}
      </div>
      <label class="check">
        <input type="checkbox" checked={unique} onChange={(e) => setUnique((e.target as HTMLInputElement).checked)} /> UNIQUE
      </label>
    </FormShell>
  );
}

function RenameTableForm({ table, onDone }: { table: TableInfo; onDone(): void }) {
  const [name, setName] = useState(table.name);
  const names = useStore((s) => s.schema.tables.map((t) => t.name.toLowerCase()));
  const trimmed = name.trim();
  const error = !trimmed ? 'Enter a name.' : trimmed === table.name ? 'Enter a different name.' : names.includes(trimmed.toLowerCase()) && trimmed.toLowerCase() !== table.name.toLowerCase() ? 'That name is taken.' : null;
  const sql = renameTableSql(table.name, trimmed || table.name);
  const submit = async () => {
    if (error) return;
    if (await runDdl([sql], `Rename table ${table.name}`, [renameTableSql(trimmed, table.name)])) {
      setState({ table: trimmed });
      onDone();
    }
  };
  return (
    <FormShell preview={sql} error={error} submit="Rename" onSubmit={() => void submit()} onCancel={onDone}>
      <input
        class="input wide"
        aria-label="New table name"
        autoFocus
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
    </FormShell>
  );
}
