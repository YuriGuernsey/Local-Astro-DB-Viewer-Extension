import { useEffect, useState } from 'preact/hooks';
import type { CellValue, CompareRowSet, TableDiff } from '../../shared/protocol';
import { runCompare } from '../actions';
import { cellKind, displayText, formatCount } from '../format';
import { useStore } from '../store';

function Cell({ v }: { v: CellValue }) {
  return <td class={`k-${cellKind(v)}`}>{displayText(v)}</td>;
}

export function CompareView() {
  const result = useStore((s) => s.compare);
  const fileName = useStore((s) => s.info?.fileName ?? '');
  const [showSame, setShowSame] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (result) setOpen(new Set(result.tables.filter((t) => t.status === 'changed').map((t) => t.name)));
  }, [result]);

  if (!result) {
    return (
      <div class="placeholder">
        <div class="center-card">
          <h2>Compare two databases</h2>
          <p class="muted">
            See which tables were added or removed, which columns changed, and which rows were added, removed or changed in <b>{fileName}</b> compared
            with another SQLite file. Rows are matched by primary key (or rowid).
          </p>
          <button class="btn primary" onClick={() => void runCompare()}>
            Compare with…
          </button>
        </div>
      </div>
    );
  }

  const tables = result.tables.filter((t) => showSame || t.status !== 'same');
  const toggle = (name: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div class="compare">
      <div class="toolbar">
        <div class="toolbar-title">
          <b>{result.left}</b> <span class="muted">→</span> <b>{result.right}</b>
        </div>
        <div class="toolbar-actions">
          <span class="badge added">{result.summary.added} added</span>
          <span class="badge removed">{result.summary.removed} removed</span>
          <span class="badge changed">{result.summary.changed} changed</span>
          <span class="badge">{result.summary.same} same</span>
          <label class="check">
            <input type="checkbox" checked={showSame} onChange={(e) => setShowSame((e.target as HTMLInputElement).checked)} /> Show unchanged
          </label>
          <button class="btn" onClick={() => void runCompare()}>
            Compare with…
          </button>
        </div>
      </div>
      <div class="compare-body">
        {tables.length === 0 && <p class="muted pad">The databases have the same tables and rows.</p>}
        {tables.map((t) => (
          <TableSection t={t} open={open.has(t.name)} onToggle={() => toggle(t.name)} rowLimit={result.rowLimit} left={result.left} right={result.right} />
        ))}
      </div>
    </div>
  );
}

function TableSection({ t, open, onToggle, rowLimit, left, right }: { t: TableDiff; open: boolean; onToggle(): void; rowLimit: number; left: string; right: string }) {
  const counts = t.status === 'changed' || t.status === 'same';
  return (
    <section class={`cmp-table status-${t.status}`}>
      <button class="cmp-head" aria-expanded={open} onClick={onToggle}>
        <span class="caret">{open ? '▾' : '▸'}</span>
        <b>{t.name}</b>
        <span class={`badge ${t.status}`}>{t.status}</span>
        {t.schemaChanged && <span class="muted">schema</span>}
        <span class="spacer" />
        {counts && (
          <span class="mono muted">
            +{formatCount(t.added.count)} −{formatCount(t.removed.count)} ~{formatCount(t.changed.count)}
          </span>
        )}
        <span class="mono muted">
          {formatCount(t.rowCountLeft)} → {formatCount(t.rowCountRight)} rows
        </span>
      </button>
      {open && (
        <div class="cmp-body">
          {t.status === 'added' && <p class="muted">Only in {right}.</p>}
          {t.status === 'removed' && <p class="muted">Only in {left}.</p>}
          {t.error && <div class="error-bar">{t.error}</div>}
          {(t.columns.added.length > 0 || t.columns.removed.length > 0 || t.columns.retyped.length > 0 || t.indexes.added.length > 0 || t.indexes.removed.length > 0) && (
            <ul class="schema-changes">
              {t.columns.added.map((c) => (
                <li class="added">+ column {c}</li>
              ))}
              {t.columns.removed.map((c) => (
                <li class="removed">− column {c}</li>
              ))}
              {t.columns.retyped.map((c) => (
                <li class="changed">
                  ~ column {c.name}: {c.from || 'any'} → {c.to || 'any'}
                </li>
              ))}
              {t.indexes.added.map((c) => (
                <li class="added">+ index {c}</li>
              ))}
              {t.indexes.removed.map((c) => (
                <li class="removed">− index {c}</li>
              ))}
            </ul>
          )}
          {counts && (
            <>
              <p class="muted">
                {t.keyKind === 'pk'
                  ? `Rows matched by primary key (${t.keyColumns.join(', ')}).`
                  : t.keyKind === 'rowid'
                    ? 'Rows matched by rowid.'
                    : 'No common key: rows are compared as a whole.'}{' '}
                Showing up to {rowLimit} of each.
              </p>
              {t.removed.count > 0 && <RowSet title="Removed" cls="removed" set={t.removed} keyed={t.keyKind !== 'row'} />}
              {t.added.count > 0 && <RowSet title="Added" cls="added" set={t.added} keyed={t.keyKind !== 'row'} />}
              {t.changed.count > 0 && (
                <>
                  <h4 class="changed">Changed ({formatCount(t.changed.count)})</h4>
                  <div class="cmp-scroll">
                    <table class="cmp-rows">
                      <thead>
                        <tr>
                          <th>key</th>
                          {t.changed.columns.map((c) => (
                            <th>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {t.changed.rows.map((r) => (
                          <tr>
                            <td class="key">{r.key.map(displayText).join(', ')}</td>
                            {r.after.map((after, i) =>
                              // The engine compares stored values; previews of long values can look identical.
                              !r.changed[i] ? (
                                <Cell v={after} />
                              ) : (
                                <td class="diff">
                                  <del>{displayText(r.before[i])}</del> <ins>{displayText(after)}</ins>
                                </td>
                              ),
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {t.status === 'same' && <p class="muted">No differences.</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RowSet({ title, cls, set, keyed }: { title: string; cls: string; set: CompareRowSet; keyed: boolean }) {
  return (
    <>
      <h4 class={cls}>
        {title} ({formatCount(set.count)})
      </h4>
      <div class="cmp-scroll">
        <table class="cmp-rows">
          <thead>
            <tr>
              {keyed && <th>key</th>}
              {set.columns.map((c) => (
                <th>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {set.rows.map((r) => (
              <tr>
                {keyed && <td class="key">{displayText(r[0])}</td>}
                {r.slice(1).map((v) => (
                  <Cell v={v} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
