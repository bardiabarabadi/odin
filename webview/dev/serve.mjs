// Tiny static file server for the webview dev harness.
// Serves the repository root so the harness can load ../../dist/webview.js.
//   node webview/dev/serve.mjs [--port 5173] [--data <dir>]
// `--data <dir>` additionally serves <dir> at /data/, so designs and diffs
// generated outside the repository can be loaded with
// ?design=/data/x.json&diff=/data/y.json without copying them in.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argPort = process.argv.indexOf('--port');
const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT ?? 5173);
const argData = process.argv.indexOf('--data');
const dataRoot = argData > 0 ? resolve(process.argv[argData + 1]) : undefined;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.tcl': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/webview/dev/';
    let base = root;
    if (dataRoot && rel.startsWith('/data/')) {
      base = dataRoot;
      rel = rel.slice('/data'.length);
    }
    let file = normalize(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const st = await stat(file).catch(() => undefined);
    if (st?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Odin webview harness: http://localhost:${port}/webview/dev/`);
  console.log('Options: ?diff=1 (sample diff) or ?diff=<url of a DiffPayload JSON>, ?theme=light|dark|hc, ?design=<url of a Design JSON>');
  if (dataRoot) console.log(`Serving ${dataRoot} at /data/`);
});
