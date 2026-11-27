import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export function Icon({ name, title }: { name: 'table' | 'view' | 'virtual' | 'db' | 'key' | 'search' | 'close' | 'play' | 'refresh'; title?: string }) {
  const paths: Record<string, string> = {
    table: 'M2 3h12v10H2zM2 6.5h12M6 6.5V13',
    view: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
    virtual: 'M2 3h12v10H2zM2 6.5h12M5 9.5h6',
    db: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2v8c0 1.1-2.2 2-5 2s-5-.9-5-2zM3 4c0 1.1 2.2 2 5 2s5-.9 5-2M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
    key: 'M10 2.5a3.5 3.5 0 11-2.9 5.4L3 12v1.5h2V12h1.5v-1.5H8l.6-.6A3.5 3.5 0 0110 2.5z',
    search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM10.5 10.5L14 14',
    close: 'M4 4l8 8M12 4l-8 8',
    play: 'M5 3l8 5-8 5z',
    refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2.5V5h-2.5',
  };
  return (
    <svg class={`icon icon-${name}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name]} fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
    </svg>
  );
}

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect(): void;
}

/** A button with a dropdown menu, usable from the keyboard. */
export function MenuButton({ label, items, title, disabled }: { label: ComponentChildren; items: MenuItem[]; title?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (open) (ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[focus])?.focus();
  }, [open, focus]);
  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  };
  return (
    <div class="menu" ref={ref}>
      <button
        class="btn"
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setFocus(0);
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setFocus(0);
            setOpen(true);
          }
        }}
      >
        {label} <span class="caret">▾</span>
      </button>
      {open && (
        <div
          class="menu-list"
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              (ref.current?.querySelector('button') as HTMLElement | null)?.focus();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setFocus((f) => (f + 1) % items.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setFocus((f) => (f - 1 + items.length) % items.length);
            }
          }}
        >
          {items.map((item) => (
            <button role="menuitem" class="menu-item" disabled={item.disabled} onClick={() => choose(item)}>
              <span>{item.label}</span>
              {item.hint && <span class="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}

export const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac OS');
export const modKey = isMac ? '⌘' : 'Ctrl+';

export function SqlBlock({ sql }: { sql: string }) {
  return <pre class="sql-block">{highlightSql(sql)}</pre>;
}

const SQL_KEYWORDS = new Set(
  (
    'select from where and or not null is in as on join left right inner outer cross natural using group by order having limit offset ' +
    'create table index unique view trigger virtual if exists primary key references foreign default check constraint autoincrement ' +
    'insert into values update set delete drop alter rename to add column begin end after before instead of for each row when then else case ' +
    'without rowid strict collate asc desc distinct union all intersect except with recursive cascade restrict action no match generated always stored ' +
    'integer text real blob numeric'
  ).split(' '),
);

/** Tiny highlighter for read-only SQL snippets. */
export function highlightSql(sql: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(--[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
  let m: RegExpExecArray | null;
  let plain = '';
  const flush = () => {
    if (plain) out.push(plain);
    plain = '';
  };
  while ((m = re.exec(sql))) {
    if (m[1]) {
      flush();
      out.push(<span class="tok-string">{m[1]}</span>);
    } else if (m[2]) {
      flush();
      out.push(<span class="tok-ident">{m[2]}</span>);
    } else if (m[3]) {
      flush();
      out.push(<span class="tok-comment">{m[3]}</span>);
    } else if (m[4]) {
      flush();
      out.push(<span class="tok-number">{m[4]}</span>);
    } else if (m[5] && SQL_KEYWORDS.has(m[5].toLowerCase())) {
      flush();
      out.push(<span class="tok-keyword">{m[5]}</span>);
    } else plain += m[0];
  }
  flush();
  return out;
}
