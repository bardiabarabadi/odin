// Builds two bundles:
//   dist/extension.js  – the extension host (Node, CommonJS)
//   dist/webview.js    – the diagram UI (browser, IIFE)
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const extensionCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/extension/main.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
});

const webviewCtx = await esbuild.context({
  ...common,
  entryPoints: ['webview/src/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
