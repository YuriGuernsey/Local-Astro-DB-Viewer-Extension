// Layout for the ER diagram: tables are placed in columns by foreign-key depth, so
// referenced tables sit to the left of the tables that reference them. Views go last.
import type { SchemaInfo } from '../shared/protocol';

export interface ErColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

export interface ErNode {
  name: string;
  kind: 'table' | 'view' | 'virtual';
  columns: ErColumn[];
  x: number;
  y: number;
  w: number;
  h: number;
  level: number;
}

export interface ErEdge {
  id: string;
  from: string;
  fromCol: number;
  to: string;
  toCol: number;
}

export interface ErLayout {
  nodes: ErNode[];
  edges: ErEdge[];
  width: number;
  height: number;
}

export const ER = { header: 24, row: 17, pad: 28, gapX: 90, gapY: 28, charW: 6.6 };

export function layoutEr(schema: SchemaInfo): ErLayout {
  const tables = schema.tables.filter((t) => t.type !== 'shadow' && !t.name.startsWith('sqlite_'));
  const byName = new Map(tables.map((t) => [t.name, t]));
  const lower = new Map(tables.map((t) => [t.name.toLowerCase(), t.name]));

  const edges: ErEdge[] = [];
  const parents = new Map<string, Set<string>>();
  for (const t of tables) {
    parents.set(t.name, new Set());
    for (const fk of t.foreignKeys) {
      const parentName = lower.get(fk.table.toLowerCase());
      if (!parentName) continue;
      const parent = byName.get(parentName)!;
      fk.from.forEach((col, i) => {
        const fromCol = t.columns.findIndex((c) => c.name === col);
        const target = fk.to[i] ?? parent.pk[i] ?? parent.columns.find((c) => c.isRowidAlias)?.name;
        const toCol = Math.max(0, parent.columns.findIndex((c) => c.name.toLowerCase() === (target ?? '').toLowerCase()));
        edges.push({ id: `${t.name}.${col}->${parentName}`, from: t.name, fromCol, to: parentName, toCol });
      });
      if (parentName !== t.name) parents.get(t.name)!.add(parentName);
    }
  }

  // Longest path from a root, guarding against cycles.
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (name: string): number => {
    const known = level.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0;
    visiting.add(name);
    let d = 0;
    for (const p of parents.get(name) ?? []) d = Math.max(d, depth(p) + 1);
    visiting.delete(name);
    level.set(name, d);
    return d;
  };
  for (const t of tables) if (t.type !== 'view') depth(t.name);
  const maxLevel = Math.max(0, ...[...level.values()]);
  for (const t of tables) if (t.type === 'view') level.set(t.name, maxLevel + 1);

  const nodes: ErNode[] = tables.map((t) => {
    const columns = t.columns.map((c) => ({
      name: c.name,
      type: c.type.toLowerCase(),
      pk: c.pk > 0,
      fk: t.foreignKeys.some((f) => f.from.includes(c.name)),
    }));
    const longest = Math.max(t.name.length + 4, ...columns.map((c) => c.name.length + c.type.length + 5));
    return {
      name: t.name,
      kind: t.type === 'view' ? 'view' : t.type === 'virtual' ? 'virtual' : 'table',
      columns,
      x: 0,
      y: 0,
      w: Math.max(150, Math.min(320, Math.ceil(longest * ER.charW) + 24)),
      h: ER.header + Math.max(1, columns.length) * ER.row + 8,
      level: level.get(t.name) ?? 0,
    };
  });

  // Order each column: roots by name, then by the average position of their parents.
  const columns: ErNode[][] = [];
  for (const n of nodes) (columns[n.level] ??= []).push(n);
  const position = new Map<string, number>();
  columns.forEach((col, li) => {
    if (!col) return;
    if (li === 0) col.sort((a, b) => a.name.localeCompare(b.name));
    else {
      const score = (n: ErNode) => {
        const ps = [...(parents.get(n.name) ?? [])].map((p) => position.get(p)).filter((v): v is number => v !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    }
    col.forEach((n, i) => position.set(n.name, i));
  });

  let x = ER.pad;
  let height = 0;
  for (const col of columns) {
    if (!col) continue;
    const w = Math.max(...col.map((n) => n.w));
    let y = ER.pad;
    for (const n of col) {
      n.x = x;
      n.y = y;
      n.w = w;
      y += n.h + ER.gapY;
    }
    height = Math.max(height, y);
    x += w + ER.gapX;
  }
  return { nodes, edges, width: Math.max(x - ER.gapX + ER.pad, 200), height: Math.max(height - ER.gapY + ER.pad, 120) };
}

/** SVG path for an edge from the child's FK row to the parent's referenced row. */
export function edgePath(child: ErNode, fromCol: number, parent: ErNode, toCol: number): string {
  const rowY = (n: ErNode, i: number) => n.y + ER.header + (Math.max(0, i) + 0.5) * ER.row + 2;
  const y1 = rowY(child, fromCol);
  const y2 = rowY(parent, toCol);
  if (child === parent) {
    const xr = child.x + child.w;
    return `M ${xr} ${y1} C ${xr + 40} ${y1}, ${xr + 40} ${y2}, ${xr + 6} ${y2}`;
  }
  if (parent.x + parent.w <= child.x) {
    const x1 = child.x;
    const x2 = parent.x + parent.w + 6;
    const dx = Math.max(30, (x1 - x2) / 2);
    return `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
  }
  // Same column or parent to the right (cycles): route around the right side.
  const x1 = child.x + child.w;
  const x2 = parent.x + parent.w + 6;
  const bend = Math.max(x1, x2) + 50;
  return `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`;
}
