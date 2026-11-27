// Side panel to view and edit every field of a row, or insert a new one.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CellValue, ColumnInfo, InputValue, TableInfo } from '../../shared/protocol';
import { Icon, Kbd, modKey } from '../components/common';
import { editText, formatBytes, inputFromText, isComplete, looksLikeJson } from '../format';
import { reportError, request } from '../rpc';

export type RowPanelTarget =
  | { mode: 'edit'; row: number; key: CellValue[]; focus?: string }
  | { mode: 'view'; row: number; values: CellValue[] }
  | { mode: 'insert' };

interface Field {
  text: string;
  isNull: boolean;
  useDefault: boolean;
  dirty: boolean;
  blob: boolean;
  /** Value too large to edit here. */
  locked: string | null;
}

function fieldFor(v: CellValue, col: ColumnInfo): Field {
  const blob = v !== null && typeof v === 'object' && '$b' in v;
  const locked = !isComplete(v) && v !== null && typeof v === 'object' && '$b' in v ? `BLOB of ${formatBytes(v.n)} — too large to edit here` : null;
  return { text: editText(v), isNull: v === null, useDefault: false, dirty: false, blob: blob || (v === null && /BLOB/i.test(col.type)), locked };
}

export function RowPanel({
  table,
  target,
  readOnly,
  onClose,
  onInserted,
  onNavigate,
}: {
  table: TableInfo;
  target: RowPanelTarget;
  readOnly: boolean;
  onClose(): void;
  onInserted(key: CellValue[] | null): void;
  onNavigate(delta: number): void;
}) {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const insert = target.mode === 'insert';
  const canEdit = !readOnly && target.mode !== 'view';
  const targetKey = target.mode === 'edit' ? JSON.stringify(target.key) : target.mode === 'view' ? `v${target.row}` : 'insert';

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setMissing(false);
    if (target.mode === 'insert') {
      setFields(
        table.columns.map((c) => ({
          text: '',
          isNull: false,
          useDefault: true,
          dirty: false,
          blob: /BLOB/i.test(c.type),
          locked: c.generated ? 'Generated column' : null,
        })),
      );
      return;
    }
    if (target.mode === 'view') {
      setFields(table.columns.map((c, i) => fieldFor(target.values[i] ?? null, c)));
      return;
    }
    setFields(null);
    request('getRow', { table: table.name, key: target.key })
      .then((values) => {
        if (cancelled) return;
        if (!values) setMissing(true);
        else setFields(table.columns.map((c, i) => fieldFor(values[i], c)));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [table.name, targetKey]);

  useEffect(() => {
    if (!fields) return;
    const focusName = target.mode === 'edit' ? target.focus : undefined;
    const sel = focusName ? `[data-field="${CSS.escape(focusName)}"] textarea` : 'textarea:not([disabled])';
    rootRef.current?.querySelector<HTMLTextAreaElement>(sel)?.focus();
  }, [fields === null, targetKey]);

  const update = (i: number, patch: Partial<Field>) => {
    setFields((f) => f && f.map((x, j) => (j === i ? { ...x, ...patch, dirty: true } : x)));
  };

  const valueOf = (f: Field, c: ColumnInfo): InputValue => {
    if (f.isNull) return null;
    if (f.blob) return { $b: f.text.replace(/[\s:]/g, '').replace(/^0x/i, '') };
    return inputFromText(f.text, c);
  };

  const dirty = !!fields?.some((f) => f.dirty);

  const save = async () => {
    if (!fields || !canEdit || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (insert) {
        const values: Record<string, InputValue> = {};
        table.columns.forEach((c, i) => {
          const f = fields[i];
          if (!f.useDefault && !c.generated) values[c.name] = valueOf(f, c);
        });
        const r = await request('insertRow', { table: table.name, values });
        onInserted(r.key);
        onClose();
      } else if (target.mode === 'edit') {
        const changes = table.columns
          .map((c, i) => ({ c, f: fields[i] }))
          .filter(({ c, f }) => f.dirty && !c.generated && !f.locked)
          .map(({ c, f }) => ({ key: target.key, column: c.name, value: valueOf(f, c) }));
        if (changes.length) await request('updateCells', { table: table.name, changes });
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (target.mode !== 'edit') return;
    try {
      await request('deleteRows', { table: table.name, keys: [target.key] });
      onClose();
    } catch (err) {
      reportError(err, 'Delete failed');
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.altKey && !dirty) {
      e.preventDefault();
      onNavigate(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const title = insert ? 'New row' : target.mode === 'edit' ? `Row ${target.row + 1}` : `Row ${target.row + 1}`;

  return (
    <div class="row-panel" role="dialog" aria-label={`${title} of ${table.name}`} ref={rootRef} onKeyDown={onKeyDown}>
      <header class="panel-head">
        <div>
          <b>{title}</b> <span class="muted">in {table.name}</span>
        </div>
        {!insert && (
          <div class="row-gap">
            <button class="btn icon-btn" title="Previous row (Alt+↑)" aria-label="Previous row" disabled={dirty} onClick={() => onNavigate(-1)}>
              ↑
            </button>
            <button class="btn icon-btn" title="Next row (Alt+↓)" aria-label="Next row" disabled={dirty} onClick={() => onNavigate(1)}>
              ↓
            </button>
          </div>
        )}
        <button class="btn icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div class="panel-body">
        {missing && <p class="muted">This row no longer exists.</p>}
        {!fields && !missing && !error && <p class="muted">Loading…</p>}
        {fields &&
          table.columns.map((c, i) => {
            const f = fields[i];
            const disabled = !canEdit || !!f.locked || f.isNull || (insert && f.useDefault);
            const json = !f.blob && !f.isNull && looksLikeJson(f.text);
            return (
              <div class="field" data-field={c.name}>
                <label class="field-label" for={`field-${i}`}>
                  <span class="field-name">{c.name}</span>
                  <span class="muted">{c.type || 'any'}</span>
                  {c.pk > 0 && <span class="tag">PK</span>}
                  {c.notNull && <span class="tag">NOT NULL</span>}
                  {c.generated && <span class="tag">generated</span>}
                </label>
                {f.locked ? (
                  <div class="field-locked muted">{f.locked}</div>
                ) : (
                  <textarea
                    id={`field-${i}`}
                    class={`input field-input${f.blob ? ' mono' : ''}`}
                    rows={Math.min(8, Math.max(1, f.text.split('\n').length, Math.ceil(f.text.length / 60)))}
                    value={f.isNull ? '' : f.text}
                    placeholder={insert && f.useDefault ? (c.isRowidAlias ? 'auto' : c.defaultValue ? `DEFAULT ${c.defaultValue}` : 'DEFAULT (NULL)') : f.isNull ? 'NULL' : f.blob ? 'hex bytes' : ''}
                    disabled={disabled}
                    spellcheck={false}
                    onInput={(e) => update(i, { text: (e.target as HTMLTextAreaElement).value })}
                  />
                )}
                {canEdit && !c.generated && !f.locked && (
                  <div class="field-tools">
                    {insert && (
                      <label class="check">
                        <input type="checkbox" checked={f.useDefault} onChange={(e) => update(i, { useDefault: (e.target as HTMLInputElement).checked })} />
                        {c.isRowidAlias ? 'Auto' : 'Default'}
                      </label>
                    )}
                    <label class="check">
                      <input
                        type="checkbox"
                        checked={f.isNull}
                        disabled={insert && f.useDefault}
                        onChange={(e) => update(i, { isNull: (e.target as HTMLInputElement).checked })}
                      />
                      NULL
                    </label>
                    {!f.isNull && (f.blob || c.affinity === 'BLOB') && (
                      <label class="check" title="Edit as hexadecimal bytes">
                        <input
                          type="checkbox"
                          checked={f.blob}
                          disabled={insert && f.useDefault}
                          onChange={(e) => {
                            const toBlob = (e.target as HTMLInputElement).checked;
                            const text = toBlob
                              ? [...new TextEncoder().encode(f.text)].map((b) => b.toString(16).padStart(2, '0')).join('')
                              : (() => {
                                  try {
                                    const hex = f.text.replace(/\s/g, '');
                                    return new TextDecoder().decode(new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16))));
                                  } catch {
                                    return f.text;
                                  }
                                })();
                            update(i, { blob: toBlob, text });
                          }}
                        />
                        BLOB (hex)
                      </label>
                    )}
                    {json && (
                      <>
                        <button class="link" onClick={() => update(i, { text: JSON.stringify(JSON.parse(f.text), null, 2) })}>
                          Format JSON
                        </button>
                        <button class="link" onClick={() => update(i, { text: JSON.stringify(JSON.parse(f.text)) })}>
                          Minify
                        </button>
                      </>
                    )}
                    {f.blob && !f.isNull && <span class="muted">{formatBytes(f.text.replace(/\s/g, '').length / 2)}</span>}
                  </div>
                )}
              </div>
            );
          })}
      </div>
      <footer class="panel-foot">
        {error && <div class="error-text">{error}</div>}
        <div class="row-gap">
          {canEdit && (
            <button class="btn primary" disabled={busy || (!insert && !dirty)} onClick={() => void save()}>
              {insert ? 'Insert row' : 'Save'} <Kbd>{modKey}↵</Kbd>
            </button>
          )}
          <button class="btn" onClick={onClose}>
            {canEdit && dirty ? 'Cancel' : 'Close'}
          </button>
          <span class="spacer" />
          {canEdit && target.mode === 'edit' && (
            <button class="btn danger" onClick={() => void remove()}>
              Delete row
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
