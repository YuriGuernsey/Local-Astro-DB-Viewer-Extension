// Virtualized, keyboard-driven data grid. Rows are fetched in pages as they scroll into
// view; only visible rows exist in the DOM. Very tall tables are scaled so the scroll
// height stays within browser limits.
import type { CellValue, GridRow, RowRange } from '../../shared/protocol';
import { cellKind, displayText } from '../format';

export interface GridColumn {
  name: string;
  type: string;
  badge?: 'pk' | 'fk';
  badgeTitle?: string;
  readOnly: boolean;
  numeric: boolean;
  width: number;
}

export interface GridSource {
  total: number;
  fetch(offset: number, limit: number): Promise<GridRow[]>;
}

export interface GridHandlers {
  onSort?(col: number): void;
  onFilter?(col: number, value: string): void;
  /** Return false to refuse inline editing (the handler may open another editor instead). */
  onBeforeEdit?(row: number, col: number, data: GridRow): boolean;
  onCommit?(row: number, col: number, text: string, data: GridRow): void;
  onSetNull?(row: number, col: number, data: GridRow): void;
  onOpenRow?(row: number, data: GridRow | undefined): void;
  onDeleteRows?(ranges: RowRange[]): void;
  onCopy?(): void;
  onPaste?(row: number, col: number): void;
  onSelectionChange?(): void;
  onResize?(col: number, width: number): void;
  onSearch?(): void;
}

export interface GridOptions {
  editable: boolean;
  filters: boolean;
  handlers: GridHandlers;
}

const ROW_H = 24;
const HEAD_H = 30;
const FILTER_H = 28;
const PAGE = 100;
const MAX_PAGES = 60;
const MAX_CANVAS = 12_000_000;

let gridSeq = 0;

export class VirtualGrid {
  readonly el: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly canvas: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly filterRow: HTMLDivElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly empty: HTMLDivElement;
  private readonly id = ++gridSeq;

  private columns: GridColumn[] = [];
  private source: GridSource = { total: 0, fetch: async () => [] };
  private pages = new Map<number, GridRow[]>();
  private stale = new Map<number, GridRow[]>();
  private loading = new Set<number>();
  private generation = 0;
  private sort: { col: number; dir: 'asc' | 'desc' } | null = null;
  private filterValues: string[] = [];
  private rowEls = new Map<number, HTMLDivElement>();
  private rowData = new WeakMap<HTMLDivElement, GridRow | undefined>();
  private frame = 0;
  private emptyText = 'No rows';

  active = { row: 0, col: 0 };
  private selection: RowRange[] = [];
  private anchor = 0;
  private editing: { row: number; col: number; data: GridRow; original: string } | null = null;
  private lastPasteKey = 0;

  constructor(private opts: GridOptions) {
    this.el = document.createElement('div');
    this.el.className = 'grid';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'grid');
    this.scroller = div('grid-scroll');
    this.canvas = div('grid-canvas');
    this.header = div('grid-header');
    this.header.setAttribute('role', 'row');
    this.filterRow = div('grid-filters');
    this.editor = document.createElement('textarea');
    this.editor.className = 'grid-editor';
    this.editor.spellcheck = false;
    this.editor.setAttribute('aria-label', 'Cell editor');
    this.empty = div('grid-empty');
    this.canvas.append(this.header, this.filterRow);
    this.scroller.append(this.canvas);
    this.el.append(this.scroller, this.empty);

    this.scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.el.addEventListener('copy', (e) => {
      if (this.editing || e.target === this.editor || (e.target as HTMLElement).tagName === 'INPUT') return;
      e.preventDefault();
      this.opts.handlers.onCopy?.();
    });
    this.el.addEventListener('paste', (e) => {
      if (this.editing || (e.target as HTMLElement).tagName === 'INPUT' || Date.now() - this.lastPasteKey < 300) return;
      e.preventDefault();
      this.opts.handlers.onPaste?.(this.active.row, this.active.col);
    });
    this.editor.addEventListener('keydown', (e) => this.onEditorKey(e));
    this.editor.addEventListener('input', () => this.sizeEditor());
    this.editor.addEventListener('blur', () => {
      if (this.editing) this.commitEdit(null);
    });
  }

  // ---------- configuration ----------

  setColumns(columns: GridColumn[], filters: Record<string, string> = {}, sort: { col: number; dir: 'asc' | 'desc' } | null = null): void {
    this.cancelEdit();
    this.columns = columns;
    this.sort = sort;
    // Cached rows belong to the previous column set.
    this.generation++;
    this.pages.clear();
    this.stale.clear();
    this.loading.clear();
    this.filterValues = columns.map((c) => filters[c.name] ?? '');
    for (const el of this.rowEls.values()) el.remove();
    this.rowEls.clear();
    this.columns.forEach((c, i) => this.el.style.setProperty(`--w${i}`, `${c.width}px`));
    this.el.setAttribute('aria-colcount', String(columns.length + 1));
    this.buildHeader();
    this.active.col = Math.min(this.active.col, Math.max(0, columns.length - 1));
    this.schedule();
  }

  setEditable(editable: boolean): void {
    this.opts = { ...this.opts, editable };
  }

  setSort(sort: { col: number; dir: 'asc' | 'desc' } | null): void {
    this.sort = sort;
    this.buildHeader();
  }

  /** New data (query changed): forget cached pages. */
  setSource(source: GridSource, keepPosition = false): void {
    this.cancelEdit();
    this.source = source;
    this.generation++;
    this.pages.clear();
    this.stale.clear();
    this.loading.clear();
    if (!keepPosition) {
      this.scroller.scrollTop = 0;
      this.active.row = 0;
      this.selection = [];
      this.anchor = 0;
    }
    this.clampActive();
    this.el.setAttribute('aria-rowcount', String(source.total + 1));
    this.schedule();
    this.opts.handlers.onSelectionChange?.();
  }

  /** Same query, data changed (edit, undo, reload): refetch but keep showing old rows meanwhile. */
  refresh(total?: number): void {
    if (total !== undefined) this.source = { ...this.source, total };
    this.generation++;
    for (const [k, v] of this.pages) this.stale.set(k, v);
    this.pages.clear();
    this.loading.clear();
    this.clampActive();
    this.el.setAttribute('aria-rowcount', String(this.source.total + 1));
    this.schedule();
  }

  setEmptyText(text: string): void {
    this.emptyText = text;
    this.schedule();
  }

  get total(): number {
    return this.source.total;
  }

  getRow(i: number): GridRow | undefined {
    const p = Math.floor(i / PAGE);
    return (this.pages.get(p) ?? this.stale.get(p))?.[i - p * PAGE];
  }

  /** Locally patches a cached row (optimistic update before the refresh arrives). */
  patchCell(row: number, col: number, value: CellValue): void {
    const r = this.getRow(row);
    if (r) {
      r.v = r.v.slice();
      r.v[col] = value;
      const p = Math.floor(row / PAGE);
      const page = this.pages.get(p) ?? this.stale.get(p);
      if (page) page[row - p * PAGE] = r;
      const el = this.rowEls.get(row);
      if (el) this.rowData.delete(el);
      this.schedule();
    }
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  // ---------- selection ----------

  selectedRanges(): RowRange[] {
    return this.selection.map((r) => ({ ...r }));
  }

  selectedCount(): number {
    return this.selection.reduce((n, r) => n + (r.to - r.from), 0);
  }

  isRowSelected(i: number): boolean {
    return this.selection.some((r) => i >= r.from && i < r.to);
  }

  clearSelection(): void {
    this.selection = [];
    this.schedule();
    this.opts.handlers.onSelectionChange?.();
  }

  selectRows(from: number, to: number): void {
    this.selection = to > from ? [{ from, to }] : [];
    this.schedule();
    this.opts.handlers.onSelectionChange?.();
  }

  setActive(row: number, col = this.active.col, reveal = true): void {
    this.active = { row: clamp(row, 0, Math.max(0, this.source.total - 1)), col: clamp(col, 0, Math.max(0, this.columns.length - 1)) };
    if (reveal) this.reveal(this.active.row, this.active.col);
    this.schedule();
    this.opts.handlers.onSelectionChange?.();
  }

  private toggleRow(i: number): void {
    if (this.isRowSelected(i)) {
      const next: RowRange[] = [];
      for (const r of this.selection) {
        if (i < r.from || i >= r.to) next.push(r);
        else {
          if (i > r.from) next.push({ from: r.from, to: i });
          if (i + 1 < r.to) next.push({ from: i + 1, to: r.to });
        }
      }
      this.selection = next;
    } else {
      this.selection = mergeRanges([...this.selection, { from: i, to: i + 1 }]);
    }
  }

  private extendTo(i: number): void {
    const from = Math.min(this.anchor, i);
    const to = Math.max(this.anchor, i) + 1;
    this.selection = [{ from, to }];
  }

  private clampActive(): void {
    this.active.row = clamp(this.active.row, 0, Math.max(0, this.source.total - 1));
    this.selection = this.selection.map((r) => ({ from: r.from, to: Math.min(r.to, this.source.total) })).filter((r) => r.to > r.from);
  }

  // ---------- geometry ----------

  private get headH(): number {
    return HEAD_H + (this.opts.filters ? FILTER_H : 0);
  }

  private get numW(): number {
    return Math.max(48, String(this.source.total).length * 8 + 24);
  }

  private colLeft(col: number): number {
    let x = this.numW;
    for (let i = 0; i < col; i++) x += this.columns[i].width;
    return x;
  }

  private metrics() {
    const viewH = Math.max(0, this.scroller.clientHeight - this.headH);
    const fullH = this.source.total * ROW_H;
    const scaled = fullH > MAX_CANVAS;
    const canvasH = scaled ? MAX_CANVAS : fullH;
    const st = this.scroller.scrollTop;
    const ratio = scaled && canvasH > viewH ? (fullH - viewH) / (canvasH - viewH) : 1;
    return { viewH, fullH, canvasH, st, ratio, virtualTop: st * ratio };
  }

  /** Scrolls so the cell is visible. */
  reveal(row: number, col: number): void {
    const m = this.metrics();
    const top = row * ROW_H;
    let vt = m.virtualTop;
    if (top < vt) vt = top;
    else if (top + ROW_H > vt + m.viewH) vt = top + ROW_H - m.viewH;
    if (vt !== m.virtualTop) this.scroller.scrollTop = vt / m.ratio;
    if (col >= 0 && col < this.columns.length) {
      const left = this.colLeft(col);
      const right = left + this.columns[col].width;
      const sl = this.scroller.scrollLeft;
      const visibleLeft = sl + this.numW;
      const visibleRight = sl + this.scroller.clientWidth;
      if (left < visibleLeft) this.scroller.scrollLeft = left - this.numW;
      else if (right > visibleRight) this.scroller.scrollLeft = right - this.scroller.clientWidth;
    }
  }

  // ---------- rendering ----------

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private buildHeader(): void {
    this.header.textContent = '';
    this.filterRow.textContent = '';
    this.header.style.height = `${HEAD_H}px`;
    this.filterRow.style.height = `${FILTER_H}px`;
    this.filterRow.style.top = `${HEAD_H}px`;
    this.filterRow.hidden = !this.opts.filters;
    const corner = div('grid-corner');
    corner.textContent = '#';
    corner.setAttribute('role', 'columnheader');
    this.header.append(corner);
    const fcorner = div('grid-corner');
    fcorner.title = 'Filter syntax: abc (contains), =abc, !=abc, >5, <=10, null, !null, empty';
    fcorner.textContent = '⧩';
    this.filterRow.append(fcorner);
    this.columns.forEach((c, i) => {
      const h = div('grid-hcell' + (c.numeric ? ' num' : ''));
      h.style.width = `var(--w${i})`;
      h.setAttribute('role', 'columnheader');
      h.dataset.col = String(i);
      const sorted = this.sort?.col === i ? this.sort.dir : null;
      h.setAttribute('aria-sort', sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none');
      h.title = `${c.name}${c.type ? ' · ' + c.type : ''}${c.badgeTitle ? '\n' + c.badgeTitle : ''}\nClick to sort`;
      const label = document.createElement('span');
      label.className = 'grid-hlabel';
      if (c.badge) {
        const b = document.createElement('span');
        b.className = `grid-badge ${c.badge}`;
        b.textContent = c.badge === 'pk' ? '🔑' : '→';
        label.append(b);
      }
      const name = document.createElement('span');
      name.className = 'grid-hname';
      name.textContent = c.name;
      label.append(name);
      if (c.type) {
        const t = document.createElement('span');
        t.className = 'grid-htype';
        t.textContent = c.type.toLowerCase();
        label.append(t);
      }
      const arrow = document.createElement('span');
      arrow.className = 'grid-sort';
      arrow.textContent = sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '';
      const resizer = div('grid-resizer');
      resizer.dataset.resize = String(i);
      h.append(label, arrow, resizer);
      this.header.append(h);

      const f = div('grid-fcell');
      f.style.width = `var(--w${i})`;
      const input = document.createElement('input');
      input.className = 'grid-filter';
      input.placeholder = 'Filter';
      input.value = this.filterValues[i] ?? '';
      input.setAttribute('aria-label', `Filter ${c.name}`);
      input.spellcheck = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.filterValues[i] = input.value;
          this.opts.handlers.onFilter?.(i, input.value);
        }, 250);
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          input.value = '';
          this.filterValues[i] = '';
          this.opts.handlers.onFilter?.(i, '');
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.focus();
        }
      });
      f.append(input);
      this.filterRow.append(f);
    });
  }

  private render(): void {
    const m = this.metrics();
    const total = this.source.total;
    const width = this.colLeft(this.columns.length);
    this.el.style.setProperty('--num-w', `${this.numW}px`);
    this.canvas.style.height = `${m.canvasH + this.headH}px`;
    this.canvas.style.width = `${width}px`;
    this.empty.hidden = total > 0 || this.columns.length === 0;
    this.empty.textContent = this.emptyText;
    this.empty.style.top = `${this.headH + 12}px`;

    const first = Math.max(0, Math.floor(m.virtualTop / ROW_H) - 2);
    const last = Math.min(total, Math.ceil((m.virtualTop + m.viewH) / ROW_H) + 2);

    for (const [i, el] of this.rowEls) {
      if (i < first || i >= last) {
        el.remove();
        this.rowEls.delete(i);
      }
    }
    for (let i = first; i < last; i++) {
      let el = this.rowEls.get(i);
      if (!el) {
        el = this.createRow(i);
        this.rowEls.set(i, el);
        this.canvas.append(el);
      }
      el.style.top = `${this.headH + i * ROW_H - m.virtualTop + m.st}px`;
      el.style.width = `${width}px`;
      const data = this.getRow(i);
      if (this.rowData.get(el) !== data || !this.rowData.has(el)) {
        this.fillRow(el, data);
        this.rowData.set(el, data);
      }
      el.classList.toggle('selected', this.isRowSelected(i));
      el.classList.toggle('active-row', i === this.active.row);
      const cells = el.children;
      for (let c = 0; c < this.columns.length; c++) {
        const cell = cells[c + 1] as HTMLElement;
        const isActive = i === this.active.row && c === this.active.col;
        cell.classList.toggle('active', isActive);
        if (isActive) cell.id = `g${this.id}-active`;
        else if (cell.id) cell.removeAttribute('id');
      }
    }
    if (total > 0) this.el.setAttribute('aria-activedescendant', `g${this.id}-active`);
    else this.el.removeAttribute('aria-activedescendant');
    if (this.editing) this.positionEditor();
    this.fetchMissing(first, last);
  }

  private createRow(i: number): HTMLDivElement {
    const el = div('grid-row');
    el.setAttribute('role', 'row');
    el.setAttribute('aria-rowindex', String(i + 2));
    el.style.height = `${ROW_H}px`;
    el.dataset.row = String(i);
    const num = div('grid-num');
    num.textContent = String(i + 1);
    num.dataset.rownum = String(i);
    el.append(num);
    for (let c = 0; c < this.columns.length; c++) {
      const cell = div('grid-cell');
      cell.setAttribute('role', 'gridcell');
      cell.style.width = `var(--w${c})`;
      cell.dataset.col = String(c);
      el.append(cell);
    }
    return el;
  }

  private fillRow(el: HTMLDivElement, data: GridRow | undefined): void {
    const cells = el.children;
    for (let c = 0; c < this.columns.length; c++) {
      const cell = cells[c + 1] as HTMLElement;
      if (!data) {
        cell.textContent = '';
        cell.className = 'grid-cell loading';
        continue;
      }
      const v = data.v[c];
      if (v === undefined) {
        cell.textContent = '';
        cell.className = 'grid-cell';
        continue;
      }
      const kind = cellKind(v);
      cell.className = `grid-cell k-${kind}`;
      cell.textContent = displayText(v);
    }
  }

  private fetchMissing(first: number, last: number): void {
    if (last <= first) return;
    const p0 = Math.floor(first / PAGE);
    const p1 = Math.floor((last - 1) / PAGE);
    for (let p = p0; p <= p1; p++) {
      if (this.pages.has(p) || this.loading.has(p)) continue;
      this.loading.add(p);
      const gen = this.generation;
      this.source
        .fetch(p * PAGE, PAGE)
        .then((rows) => {
          if (gen !== this.generation) return;
          this.pages.set(p, rows);
          this.stale.delete(p);
          this.loading.delete(p);
          this.evict(p);
          this.schedule();
        })
        .catch(() => {
          if (gen === this.generation) this.loading.delete(p);
        });
    }
  }

  private evict(current: number): void {
    if (this.pages.size <= MAX_PAGES) return;
    const far = [...this.pages.keys()].sort((a, b) => Math.abs(b - current) - Math.abs(a - current));
    for (const p of far.slice(0, this.pages.size - MAX_PAGES)) this.pages.delete(p);
  }

  // ---------- mouse ----------

  private hit(e: MouseEvent): { row: number; col: number | null; rownum: boolean } | null {
    const target = e.target as HTMLElement;
    const rowEl = target.closest<HTMLElement>('.grid-row');
    if (!rowEl) return null;
    const row = Number(rowEl.dataset.row);
    if (target.closest('.grid-num')) return { row, col: null, rownum: true };
    const cell = target.closest<HTMLElement>('.grid-cell');
    return { row, col: cell ? Number(cell.dataset.col) : null, rownum: false };
  }

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target === this.editor) return;
    const resize = target.closest<HTMLElement>('[data-resize]');
    if (resize) {
      e.preventDefault();
      this.startResize(Number(resize.dataset.resize), e.clientX);
      return;
    }
    const hcell = target.closest<HTMLElement>('.grid-hcell');
    if (hcell) {
      if (e.button === 0) this.opts.handlers.onSort?.(Number(hcell.dataset.col));
      return;
    }
    if (target.closest('.grid-filters')) return;
    const hit = this.hit(e);
    if (!hit || e.button !== 0) return;
    e.preventDefault();
    if (this.editing) this.commitEdit(null);
    this.focus();
    const mod = e.metaKey || e.ctrlKey;
    if (hit.rownum) {
      if (e.shiftKey) this.extendTo(hit.row);
      else if (mod) {
        this.toggleRow(hit.row);
        this.anchor = hit.row;
      } else {
        this.selection = [{ from: hit.row, to: hit.row + 1 }];
        this.anchor = hit.row;
      }
      this.active.row = hit.row;
    } else {
      if (e.shiftKey && this.selection.length) this.extendTo(hit.row);
      else {
        this.selection = [];
        this.anchor = hit.row;
      }
      this.active = { row: hit.row, col: hit.col ?? this.active.col };
    }
    this.schedule();
    this.opts.handlers.onSelectionChange?.();
  }

  private onDblClick(e: MouseEvent): void {
    const hit = this.hit(e);
    if (!hit) return;
    if (hit.rownum) this.opts.handlers.onOpenRow?.(hit.row, this.getRow(hit.row));
    else if (hit.col !== null) this.beginEdit(null);
  }

  private startResize(col: number, startX: number): void {
    const start = this.columns[col].width;
    document.body.classList.add('resizing');
    const move = (e: MouseEvent) => {
      const w = Math.max(48, Math.min(1200, start + e.clientX - startX));
      this.columns[col].width = w;
      this.el.style.setProperty(`--w${col}`, `${w}px`);
      this.schedule();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.opts.handlers.onResize?.(col, this.columns[col].width);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ---------- keyboard ----------

  private pageRows(): number {
    return Math.max(1, Math.floor(this.metrics().viewH / ROW_H) - 1);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editing || e.target !== this.el) return;
    const mod = e.metaKey || e.ctrlKey;
    const total = this.source.total;
    const { row, col } = this.active;
    const move = (r: number, c: number, extend: boolean) => {
      e.preventDefault();
      const nr = clamp(r, 0, Math.max(0, total - 1));
      if (extend) this.extendTo(nr);
      else if (this.selection.length) this.selection = [];
      if (!extend) this.anchor = nr;
      this.setActive(nr, c);
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(mod ? total - 1 : row + 1, col, e.shiftKey);
      case 'ArrowUp':
        return move(mod ? 0 : row - 1, col, e.shiftKey);
      case 'ArrowRight':
        return move(row, mod ? this.columns.length - 1 : col + 1, false);
      case 'ArrowLeft':
        return move(row, mod ? 0 : col - 1, false);
      case 'PageDown':
        return move(row + this.pageRows(), col, e.shiftKey);
      case 'PageUp':
        return move(row - this.pageRows(), col, e.shiftKey);
      case 'Home':
        return mod ? move(0, col, e.shiftKey) : move(row, 0, false);
      case 'End':
        return mod ? move(total - 1, col, e.shiftKey) : move(row, this.columns.length - 1, false);
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (total > 0) this.beginEdit(null);
        return;
      case ' ':
        e.preventDefault();
        if (total > 0) this.opts.handlers.onOpenRow?.(row, this.getRow(row));
        return;
      case 'Escape':
        if (this.selection.length) {
          e.preventDefault();
          this.clearSelection();
        }
        return;
      case 'Delete':
      case 'Backspace': {
        if (!this.opts.editable || total === 0) return;
        e.preventDefault();
        if (this.selection.length) this.opts.handlers.onDeleteRows?.(this.selectedRanges());
        else {
          const data = this.getRow(row);
          if (data && !this.columns[col]?.readOnly) this.opts.handlers.onSetNull?.(row, col, data);
        }
        return;
      }
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        this.selectRows(0, total);
      } else if (k === 'c') {
        e.preventDefault();
        this.opts.handlers.onCopy?.();
      } else if (k === 'v') {
        e.preventDefault();
        this.lastPasteKey = Date.now();
        if (this.opts.editable) this.opts.handlers.onPaste?.(row, col);
      } else if (k === 'f') {
        e.preventDefault();
        this.opts.handlers.onSearch?.();
      }
      return;
    }
    if (e.key.length === 1 && !e.altKey && this.opts.editable && total > 0) {
      e.preventDefault();
      this.beginEdit(e.key);
    }
  }

  // ---------- editing ----------

  isEditing(): boolean {
    return !!this.editing;
  }

  beginEdit(initial: string | null): void {
    const { row, col } = this.active;
    const data = this.getRow(row);
    const column = this.columns[col];
    if (!data || !column) return;
    if (!this.opts.editable || column.readOnly) {
      if (this.opts.editable) this.opts.handlers.onBeforeEdit?.(row, col, data);
      return;
    }
    if (this.opts.handlers.onBeforeEdit && !this.opts.handlers.onBeforeEdit(row, col, data)) return;
    const v = data.v[col];
    const original = v === null ? '' : typeof v === 'object' ? ('$i' in v ? v.$i : '$f' in v ? v.$f : '') : String(v);
    this.editing = { row, col, data, original };
    this.editor.value = initial ?? original;
    this.editor.dataset.null = v === null && initial === null ? '1' : '';
    this.editor.placeholder = v === null ? 'NULL' : '';
    this.canvas.append(this.editor);
    this.reveal(row, col);
    this.positionEditor();
    this.sizeEditor();
    this.editor.focus();
    const end = this.editor.value.length;
    if (initial === null) this.editor.setSelectionRange(0, end);
    else this.editor.setSelectionRange(end, end);
  }

  private positionEditor(): void {
    if (!this.editing) return;
    const el = this.rowEls.get(this.editing.row);
    const top = el ? parseFloat(el.style.top) : this.headH + this.editing.row * ROW_H;
    this.editor.style.left = `${this.colLeft(this.editing.col)}px`;
    this.editor.style.top = `${top}px`;
    this.editor.style.width = `${Math.max(this.columns[this.editing.col].width, 160)}px`;
  }

  private sizeEditor(): void {
    this.editor.style.height = `${ROW_H}px`;
    const h = Math.min(this.editor.scrollHeight, ROW_H * 8);
    this.editor.style.height = `${Math.max(ROW_H, h)}px`;
  }

  private onEditorKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelEdit();
      this.focus();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.commitEdit('down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.commitEdit(e.shiftKey ? 'left' : 'right');
    }
  }

  private commitEdit(move: 'down' | 'right' | 'left' | null): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const text = this.editor.value;
    this.editor.remove();
    if (text !== ed.original || (ed.data.v[ed.col] === null && text !== '')) {
      this.opts.handlers.onCommit?.(ed.row, ed.col, text, ed.data);
    }
    if (move === 'down') this.setActive(ed.row + 1, ed.col);
    else if (move === 'right') this.setActive(ed.row, ed.col + 1);
    else if (move === 'left') this.setActive(ed.row, ed.col - 1);
    if (move) this.focus();
    this.schedule();
  }

  cancelEdit(): void {
    if (!this.editing) return;
    this.editing = null;
    this.editor.remove();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.el.remove();
  }
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mergeRanges(ranges: RowRange[]): RowRange[] {
  const sorted = ranges.slice().sort((a, b) => a.from - b.from);
  const out: RowRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}
