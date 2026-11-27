# Local AstroDB Viewer

Open any SQLite database in VS Code and actually work with it. Double-click a `.db`, `.sqlite`, `.sqlite3` or `.db3` file to browse, filter, sort and edit your tables, run SQL, change the schema, export data, see an ER diagram and compare two databases. It is fast on big tables, follows your theme, and needs nothing else installed.

Working on an Astro project? Your `.astro/content.db` shows up under **Workspace databases** in the Local AstroDB sidebar, and the editor reloads it automatically whenever Astro rewrites it.

## Browse millions of rows smoothly

- A virtualized grid that pages rows in as you scroll, so large tables open instantly.
- Click a header to sort. Resize columns by dragging.
- Filter each column: `abc` (contains), `=abc`, `!=abc`, `>5`, `<=10`, `null`, `!null`, `empty`.
- Search every column at once (<kbd>Ctrl/Cmd+F</kbd>).
- The table list shows row counts for every table and view.

## Edit safely, with Undo

- Edit a cell in place: press <kbd>Enter</kbd> or start typing. Press <kbd>Delete</kbd> to set a cell to `NULL`. You can also paste into a cell (a block copied from a spreadsheet fills several cells).
- Open the row panel (<kbd>Space</kbd>) to edit every field of a row. It has NULL toggles, JSON formatting, and BLOBs as hex.
- Insert rows (defaults and `INTEGER PRIMARY KEY` fill themselves), and delete one row or many.
- Changes behave like any other VS Code editor: Undo/Redo (<kbd>Ctrl/Cmd+Z</kbd>), Save (<kbd>Ctrl/Cmd+S</kbd>), Save As, Revert File and hot exit. Nothing is written to disk until you save.
- Works with rowid tables, `WITHOUT ROWID` tables, composite primary keys, generated columns and 64-bit integers. Views and virtual tables open read-only.
- If another program changes the file, it reloads automatically, or asks first when you have unsaved edits.

## Run SQL

- An editor with syntax colouring and autocomplete for your tables, columns, keywords and functions (<kbd>Ctrl+Space</kbd>).
- <kbd>Ctrl/Cmd+Enter</kbd> runs the statement at the cursor (or the selection). <kbd>Shift+Ctrl/Cmd+Enter</kbd> runs everything.
- Multiple result sets, sortable results, the time taken and the number of rows changed.
- Query history that you can load with one click.
- Statements that change data or schema can be undone like any other edit.

## Structure and schema editing

- See columns, types, `NOT NULL`, defaults, primary keys, foreign keys, indexes, triggers and the `CREATE` SQL.
- Add, rename and drop columns. Rename or drop tables. Create and drop indexes.
- New Table form with a live SQL preview.

## ER diagram

- Built automatically from your foreign keys, with referenced tables on the left.
- Pan, zoom (<kbd>Ctrl/Cmd+scroll</kbd> or <kbd>+</kbd>/<kbd>-</kbd>), and hover a table to highlight its relationships. Click a table to open it.
- Export the diagram as SVG.

## Compare two databases

- Shows tables added or removed, and columns added, removed or retyped.
- Shows rows added, removed and changed, matched by primary key (or rowid), with the changed cells highlighted.

## Export

- Export a table or query results to CSV, JSON, SQL (`CREATE` + `INSERT`) or Markdown.
- Export the whole database as a `.sql` dump.

## Copy Schema as TypeScript Types

- One interface per table and view, with SQLite types mapped to TypeScript (`INTEGER` → `number`, `TEXT` → `string`, `BLOB` → `Uint8Array`) and nullable columns typed `| null`, plus a `Database` interface keyed by table name.
- Copied to the clipboard and opened in a new tab, ready for your app, Drizzle/Kysely code or API layer.
- Run **Local AstroDB: Copy Schema as TypeScript Types** from the Command Palette or the sidebar.

## Works everywhere

- Pure WebAssembly SQLite (sql.js, SQLite 3.54) with no native modules, so it runs the same on macOS, Windows and Linux.
- Also works in WSL, SSH and Dev Container workspaces.
- Databases in WAL mode open with the contents of their `-wal` file.
- Follows light, dark and high-contrast themes, and is fully usable from the keyboard.

## Keyboard

| Where | Keys | Action |
| --- | --- | --- |
| Grid | Arrows, PageUp/PageDown, Home/End, Ctrl/Cmd+Home/End | Move |
| Grid | Enter / F2 / type | Edit cell (Enter saves and moves down, Tab moves right, Esc cancels) |
| Grid | Space | Open the row panel |
| Grid | Delete | Set cell to NULL, or delete the selected rows |
| Grid | Shift+Arrow, click or Shift/Ctrl-click row numbers | Select rows |
| Grid | Ctrl/Cmd+A | Select all rows |
| Grid | Ctrl/Cmd+C, Ctrl/Cmd+V | Copy cell or rows (TSV), paste into a cell |
| Row panel | Ctrl/Cmd+Enter, Esc | Save row, close |
| Row panel | Alt+↑ / Alt+↓ | Previous / next row |
| Anywhere | Ctrl/Cmd+F | Search the table |
| Anywhere | Ctrl/Cmd+S, Ctrl/Cmd+Z | Save to disk, undo |
| SQL | Ctrl/Cmd+Enter, Shift+Ctrl/Cmd+Enter, Ctrl+Space | Run statement, run all, autocomplete |
| ER diagram | + / - / 0, arrows | Zoom in, zoom out, fit, pan |

## Commands

Open the Command Palette and type **Local AstroDB**:

- Local AstroDB: Open Database... and Local AstroDB: New Database...
- Local AstroDB: Run SQL Query, Local AstroDB: Show ER Diagram, Local AstroDB: Compare with Another Database...
- Local AstroDB: Export Table (CSV, JSON, SQL, Markdown)... and Local AstroDB: Export Database as SQL Dump...
- Local AstroDB: Copy Schema as TypeScript Types
- Local AstroDB: Reload Database from Disk

You can also right-click a database file in the Explorer and choose **Open with Local AstroDB Viewer**.

## Sidebar

Click the Local AstroDB icon in the Activity Bar for one-click access: Open a database…, New database, Run SQL query, Show ER diagram, Compare and Export, your recent databases, the databases in your workspace, and the most-used settings (open read-only, status bar info, the open-as-text hint).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `localastrodb.openReadOnly` | `false` | Open databases read-only. |
| `localastrodb.statusBar.enabled` | `true` | Show size, table count and SQLite version in the status bar. |
| `localastrodb.showOpenAsTextHint` | `true` | Offer to open SQLite files that were opened in the text editor. |
| `localastrodb.undoMemoryLimitMB` | `512` | Memory for undoing SQL statements and schema changes. Older snapshots beyond it can no longer be undone. |
| `localastrodb.maxResultRows` | `100000` | Rows kept per SQL result set. |

## Known limitations

- The database is loaded into memory (that is how WebAssembly SQLite works). Files larger than about 1–2 GB may not open.
- Cell, row and most schema edits are undone precisely and cheaply. Arbitrary SQL, dropped tables/columns and edits to tables with triggers are undone from a snapshot of the database, limited by `localastrodb.undoMemoryLimitMB`.
- Queries run on a background thread, so VS Code stays responsive, but a running query can't be cancelled; close the editor to stop it.
- Saving rewrites the whole file. For WAL databases the `-wal` and `-shm` files are removed after their contents were merged; don't save while another program is writing to the same database.
- Not available in VS Code for the Web (vscode.dev).

## Development

```sh
npm install
npm run build          # bundle into dist/
npm run check          # typecheck, lint and unit tests
scripts/integration.sh # integration tests in an isolated VS Code instance
```

`scripts/integration.sh` uses VS Code from `/Applications` on macOS, or `code` from your `PATH`. Pass another executable as the first argument or in `VSCODE_BIN`; on a headless Linux machine run it under Xvfb:

```sh
VSCODE_BIN=/usr/share/code/code xvfb-run -a scripts/integration.sh
```

The build tasks in `.vscode/tasks.json` use the problem matchers from the recommended *esbuild Problem Matchers* extension.

`node scripts/build.mjs --harness` builds a browser harness (`out-harness/`) that runs the real webview against the real engine, useful for UI work without restarting the Extension Development Host. Press <kbd>F5</kbd> in VS Code to launch the extension.
