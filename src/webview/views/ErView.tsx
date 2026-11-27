import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { selectTable } from '../actions';
import { modKey } from '../components/common';
import { edgePath, ER, layoutEr, type ErNode } from '../erLayout';
import { reportError, request } from '../rpc';
import { useStore } from '../store';

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.2;
const MAX_K = 3;

export function ErView({ visible }: { visible: boolean }) {
  const schema = useStore((s) => s.schema);
  const fileName = useStore((s) => s.info?.fileName ?? 'database');
  const layout = useMemo(() => layoutEr(schema), [schema]);
  const byName = useMemo(() => new Map(layout.nodes.map((n) => [n.name, n])), [layout]);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const fitted = useRef(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; table: string | null } | null>(null);

  const fit = () => {
    const host = hostRef.current;
    if (!host || host.clientWidth === 0) return;
    const k = Math.max(MIN_K, Math.min(1.2, (host.clientWidth - 20) / layout.width, (host.clientHeight - 20) / layout.height));
    setView({ k, x: Math.max(0, (host.clientWidth - layout.width * k) / 2), y: 0 });
  };

  useEffect(() => {
    if (visible && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(fit);
    }
  }, [visible, layout]);
  useEffect(() => {
    fitted.current = false;
    if (visible) requestAnimationFrame(fit);
  }, [layout.nodes.length]);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  };
  const zoomCenter = (factor: number) => {
    const host = hostRef.current!;
    zoomAt(factor, host.clientWidth / 2, host.clientHeight / 2);
  };

  useEffect(() => {
    const host = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = host.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Pointer capture retargets pointerup to the canvas, so remember the table now.
    const table = (e.target as Element).closest('[data-table]')?.getAttribute('data-table') ?? null;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, table };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && d.table) selectTable(d.table, 'data');
  };

  const related = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    for (const e of layout.edges) {
      if (e.from === hover) set.add(e.to);
      if (e.to === hover) set.add(e.from);
    }
    return set;
  }, [hover, layout]);

  const exportSvg = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.ceil(layout.width)));
    clone.setAttribute('height', String(Math.ceil(layout.height)));
    clone.setAttribute('viewBox', `0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}`);
    clone.querySelector('.er-root')?.removeAttribute('transform');
    clone.querySelectorAll('.dim').forEach((el) => el.classList.remove('dim'));
    clone.querySelectorAll('.hot').forEach((el) => el.classList.remove('hot'));
    const css = getComputedStyle(document.body);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      svg { font-family: ${v('--vscode-editor-font-family', 'monospace')}; font-size: 11px; background: ${v('--vscode-editor-background', '#1e1e1e')}; }
      .er-bg { fill: ${v('--vscode-editor-background', '#1e1e1e')}; }
      .er-box { fill: ${v('--vscode-editorWidget-background', '#252526')}; stroke: ${v('--vscode-widget-border', '#454545')}; }
      .er-head { fill: ${v('--vscode-button-background', '#0e639c')}; }
      .er-node.view .er-head { fill: ${v('--vscode-badge-background', '#4d4d4d')}; }
      .er-title { fill: ${v('--vscode-button-foreground', '#ffffff')}; font-weight: 600; }
      .er-col { fill: ${v('--vscode-editor-foreground', '#cccccc')}; }
      .er-col.pk { font-weight: 700; }
      .er-type { fill: ${v('--vscode-descriptionForeground', '#999999')}; }
      .er-edge { fill: none; stroke: ${v('--vscode-descriptionForeground', '#888888')}; stroke-width: 1.2; }
      .er-arrow { fill: ${v('--vscode-descriptionForeground', '#888888')}; }`;
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('class', 'er-bg');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    clone.insertBefore(bg, style.nextSibling);
    const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    try {
      await request('saveSvg', { svg: text, name: `${fileName.replace(/\.[^.]+$/, '')}-er.svg` });
    } catch (err) {
      reportError(err, 'Export failed');
    }
  };

  const tableCount = layout.nodes.filter((n) => n.kind !== 'view').length;
  const viewCount = layout.nodes.length - tableCount;

  const renderNode = (n: ErNode) => {
    const cls = `er-node ${n.kind}${related ? (related.has(n.name) ? ' hot' : ' dim') : ''}`;
    return (
      <g class={cls} data-table={n.name} transform={`translate(${n.x},${n.y})`} onMouseEnter={() => setHover(n.name)} onMouseLeave={() => setHover(null)}>
        <title>{`${n.name} — click to open`}</title>
        <rect class="er-box" width={n.w} height={n.h} rx="4" />
        <path class="er-head" d={`M0 4 a4 4 0 0 1 4 -4 h${n.w - 8} a4 4 0 0 1 4 4 v${ER.header - 4} h${-n.w} z`} />
        <text class="er-title" x="10" y={ER.header - 8}>
          {n.kind === 'view' ? '◉ ' : ''}
          {n.name}
        </text>
        {n.columns.map((c, i) => {
          const y = ER.header + (i + 1) * ER.row - 3;
          return (
            <g>
              <text class={c.pk ? 'er-col pk' : 'er-col'} x="10" y={y}>
                {c.pk ? '⚷ ' : c.fk ? '↗ ' : ''}
                {c.name}
              </text>
              <text class="er-type" x={n.w - 10} y={y} text-anchor="end">
                {c.type}
              </text>
            </g>
          );
        })}
      </g>
    );
  };

  return (
    <div class="er-view">
      <div class="toolbar">
        <div class="toolbar-title muted">
          {tableCount} table{tableCount === 1 ? '' : 's'}
          {viewCount ? ` · ${viewCount} view${viewCount === 1 ? '' : 's'}` : ''} · {layout.edges.length} relationship{layout.edges.length === 1 ? '' : 's'} · drag to pan, {modKey}
          scroll to zoom, click a table to open it
        </div>
        <div class="toolbar-actions">
          <button class="btn icon-btn" aria-label="Zoom out" title="Zoom out (-)" onClick={() => zoomCenter(1 / 1.25)}>
            −
          </button>
          <span class="muted zoom-label">{Math.round(view.k * 100)}%</span>
          <button class="btn icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomCenter(1.25)}>
            +
          </button>
          <button class="btn" onClick={fit} title="Fit to window (0)">
            Fit
          </button>
          <button class="btn" onClick={() => void exportSvg()}>
            Export SVG
          </button>
        </div>
      </div>
      <div
        class="er-canvas"
        ref={hostRef}
        tabIndex={0}
        aria-label="ER diagram. Use + and - to zoom, arrow keys to pan, 0 to fit."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => {
          const step = 60;
          if (e.key === '+' || e.key === '=') zoomCenter(1.2);
          else if (e.key === '-') zoomCenter(1 / 1.2);
          else if (e.key === '0') fit();
          else if (e.key === 'ArrowLeft') setView((v) => ({ ...v, x: v.x + step }));
          else if (e.key === 'ArrowRight') setView((v) => ({ ...v, x: v.x - step }));
          else if (e.key === 'ArrowUp') setView((v) => ({ ...v, y: v.y + step }));
          else if (e.key === 'ArrowDown') setView((v) => ({ ...v, y: v.y - step }));
          else return;
          e.preventDefault();
        }}
      >
        {layout.nodes.length === 0 ? (
          <div class="placeholder">No tables to show.</div>
        ) : (
          <svg ref={svgRef} class="er-svg" width="100%" height="100%">
            <defs>
              <marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path class="er-arrow" d="M0 0 L10 5 L0 10 z" />
              </marker>
            </defs>
            <g class="er-root" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {layout.edges.map((e) => {
                const child = byName.get(e.from);
                const parent = byName.get(e.to);
                if (!child || !parent) return null;
                const cls = related ? (e.from === hover || e.to === hover ? 'er-edge hot' : 'er-edge dim') : 'er-edge';
                return <path class={cls} d={edgePath(child, e.fromCol, parent, e.toCol)} marker-end="url(#er-arrow)" />;
              })}
              {layout.nodes.map(renderNode)}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}
