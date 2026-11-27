# Change Log

## [3.0.0] - 2026-11-27

A rewrite: Local AstroDB is now a full SQLite viewer and editor.

### Added

- Custom editor for `.db`, `.sqlite`, `.sqlite3` and `.db3` files with Data, Structure, SQL, ER Diagram and Compare views.
- Virtualized data grid with paging, sorting, per-column filters, search across all columns, resizable columns and row counts.
- In-place editing, row panel (NULL toggles, JSON formatting, BLOBs as hex), insert and delete rows, copy/paste as TSV.
- Native Undo/Redo, Save, Save As, Revert and hot exit. Nothing is written until you save.
- Rowid and `WITHOUT ROWID` tables, composite keys, generated columns and 64-bit integers.
- SQL editor (CodeMirror 6) with schema-aware autocomplete, run statement / run all, multiple sortable result sets, timing, history and undoable changes.
- Schema editing: add/rename/drop columns, rename/drop tables, create/drop indexes, New Table form with live SQL preview.
- ER diagram from foreign keys with pan, zoom, highlighting and SVG export.
- Database comparison: schema changes and rows added/removed/changed, matched by primary key or rowid.
- Export tables and query results to CSV, JSON, SQL and Markdown; full SQL dump.
- Copy Schema as TypeScript Types.
- Automatic reload when another program changes the file; WAL databases include their `-wal` contents.
- Sidebar with actions, recent and workspace databases, and settings; status bar info; open-as-text hint.
- Settings: `openReadOnly`, `statusBar.enabled`, `showOpenAsTextHint`, `undoMemoryLimitMB`, `maxResultRows`.

### Changed

- SQLite runs in a worker thread (sql.js 1.16, SQLite 3.54.1), keeping the extension host responsive.
- Everything is bundled locally with esbuild. The webview loads nothing from the network (Monaco from unpkg and Google Fonts are gone) and uses a strict Content Security Policy.
- Minimum VS Code version is 1.90.

### Removed

- The `localastrodb.databasePath` setting and opening `.astro/content.db` automatically on startup. Workspace databases, including `.astro/content.db`, are listed in the sidebar instead, and open editors reload when the file changes.
- The `db/seed.ts` watcher (and its "Seed file not found" error in every workspace) and the `chokidar` dependency.

### Security and dependencies

- Dependency audit: 12 vulnerabilities (9 high, 3 moderate) before, 0 after.
- Replaced the deprecated `vsce` 1.x with `@vscode/vsce`; updated TypeScript (5.9), `@types/vscode`, `@types/node` and `sql.js`.
- `minimatch` is pinned to 11.x through `overrides` to fix GHSA-g3hv-75wg-m249 in build tooling.
- SQL built from user input uses bound parameters and quoted identifiers (the old table view interpolated table names and assumed the first column was the key).

## [1.0.0]

- Initial release: open and view `.db` databases, run custom SQL queries, edit table data, tree view of tables and columns.
