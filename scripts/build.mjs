// Build script: bundles the extension host, the SQLite worker and the webview with esbuild.
//   node scripts/build.mjs               development build
//   node scripts/build.mjs --production  minified build without source maps
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --tests       bundle the unit tests into out-test/
//   node scripts/build.mjs --harness     bundle the browser harness into out-harness/
//   node scripts/build.mjs --integration bundle the VS Code integration test into out-test/
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  absWorkingDir: root,
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

function copyWasm(outDir) {
  mkdirSync(join(root, outDir), { recursive: true });
  copyFileSync(join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), join(root, outDir, 'sql-wasm.wasm'));
}

const webviewOptions = {
  ...common,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
};

async function buildApp() {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  copyWasm('dist');
  const configs = [
    {
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
    },
    {
      ...common,
      entryPoints: ['src/engine/worker.ts'],
      outfile: 'dist/worker.js',
      platform: 'node',
      format: 'cjs',
      target: 'node20',
    },
    {
      ...webviewOptions,
      entryPoints: { webview: 'src/webview/main.tsx' },
      outdir: 'dist',
    },
  ];
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[watch] build started');
    return;
  }
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

async function buildTests() {
  rmSync(join(root, 'out-test'), { recursive: true, force: true });
  copyWasm('out-test');
  const entryPoints = readdirSync(join(root, 'test'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `test/${f}`);
  await esbuild.build({
    ...common,
    sourcemap: 'inline',
    entryPoints,
    outdir: 'out-test',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning',
  });
}

async function buildIntegration() {
  copyWasm('out-test');
  await esbuild.build({
    ...common,
    sourcemap: 'inline',
    entryPoints: { integration: 'test/integration/index.ts' },
    outdir: 'out-test',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    logLevel: 'warning',
  });
}

async function buildHarness() {
  rmSync(join(root, 'out-harness'), { recursive: true, force: true });
  copyWasm('out-harness');
  // esbuild picks sql.js's "browser" build, which loads its own wasm file.
  copyFileSync(join(root, 'node_modules/sql.js/dist/sql-wasm-browser.wasm'), join(root, 'out-harness/sql-wasm-browser.wasm'));
  copyFileSync(join(root, 'test/harness/index.html'), join(root, 'out-harness/index.html'));
  await esbuild.build({
    ...webviewOptions,
    entryPoints: { webview: 'src/webview/main.tsx', harness: 'test/harness/harness.ts' },
    outdir: 'out-harness',
    // sql.js references node built-ins behind runtime checks; they are never reached in the browser.
    external: ['fs', 'path', 'crypto'],
  });
}

if (args.has('--tests')) {
  await buildTests();
} else if (args.has('--integration')) {
  await buildIntegration();
} else if (args.has('--harness')) {
  await buildHarness();
} else {
  await buildApp();
}
