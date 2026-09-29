// Drive the webview dev harness in headless Chrome and take a PNG screenshot.
// Uses the Chrome DevTools Protocol directly (Node's built-in WebSocket and
// fetch), so it needs no npm dependencies. Start the harness first:
//
//   node esbuild.mjs && node webview/dev/serve.mjs --data /some/dir
//   node webview/dev/screenshot.mjs \
//     --url 'http://localhost:5173/webview/dev/?design=/data/x.json&theme=dark' \
//     --out shot.png --step 'click:[data-kind="cell"][data-path="clk_wiz_0"]'
//
// Options
//   --url <url>          page to open (required)
//   --out <file.png>     where to write the screenshot (omit to only report)
//   --width/--height     viewport, default 1400x900
//   --wait <js expr>     readiness condition, default: diagram rendered
//   --step <spec>        repeatable, run in order after the page is ready:
//                          click:<css selector>  real mouse click at the element centre
//                          dblclick:<css selector>
//                          drag:x1,y1,x2,y2      mouse drag in viewport pixels (pans)
//                          wait:<js expr>        poll until truthy
//                          sleep:<ms>
//                          <any other text>      evaluated as JavaScript (awaited)
//   --hide-harness       hide the floating harness bar before the screenshot
//   --timeout <ms>       per wait, default 60000
//
// Prints a JSON report: time until ready, uncaught exceptions, console errors,
// CSP violations and the error banner text (if shown). Exit code 1 when an
// exception was thrown or a wait timed out.
//
// Chrome is looked up in CHROME_PATH, then the usual install locations.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const opts = { width: 1400, height: 900, steps: [], timeout: 60000, hideHarness: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') opts.url = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--width') opts.width = Number(next());
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--wait') opts.wait = next();
    else if (a === '--step') opts.steps.push(next());
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--hide-harness') opts.hideHarness = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!opts.url) throw new Error('--url is required');
  return opts;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('Chrome not found; set CHROME_PATH');
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(file, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\n')) return text;
    }
    await sleep(50);
  }
  throw new Error('Chrome did not start (no DevToolsActivePort)');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const profile = mkdtempSync(join(tmpdir(), 'odin-chrome-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      `--window-size=${opts.width},${opts.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const report = { url: opts.url, exceptions: [], consoleErrors: [], timedOut: [] };
  let cdp;
  try {
    const [port] = (await waitForFile(join(profile, 'DevToolsActivePort'), 15000)).split('\n');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    cdp.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        report.exceptions.push(d.exception?.description ?? d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        report.consoleErrors.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr) => {
      const t0 = Date.now();
      while (Date.now() - t0 < opts.timeout) {
        try {
          if (await evaluate(`!!(${expr})`)) return Date.now() - t0;
        } catch {
          // page not ready yet
        }
        await sleep(25);
      }
      report.timedOut.push(expr);
      return -1;
    };
    const mouse = async (selector, clickCount) => {
      const box = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;` +
          ' const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 14) }; })()',
      );
      if (!box) throw new Error(`No element for ${selector}`);
      for (let n = 1; n <= clickCount; n++) {
        const base = { x: box.x, y: box.y, button: 'left', clickCount: n };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      }
    };

    const drag = async (x1, y1, x2, y2) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        const x = x1 + ((x2 - x1) * i) / 10;
        const y = y1 + ((y2 - y1) * i) / 10;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    };

    const ready =
      opts.wait ??
      "document.querySelector('svg [data-kind]') && document.querySelector('.loading')?.hidden !== false";
    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: opts.url });
    const waited = await waitFor(ready);
    report.readyMs = waited < 0 ? -1 : Date.now() - t0;

    for (const step of opts.steps) {
      if (step.startsWith('click:')) await mouse(step.slice(6), 1);
      else if (step.startsWith('dblclick:')) await mouse(step.slice(9), 2);
      else if (step.startsWith('drag:')) await drag(...step.slice(5).split(',').map(Number));
      else if (step.startsWith('wait:')) await waitFor(step.slice(5));
      else if (step.startsWith('sleep:')) await sleep(Number(step.slice(6)));
      else await evaluate(step);
      await sleep(150);
    }
    if (opts.hideHarness) {
      await evaluate(
        "for (const id of ['harness', 'harness-log']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }",
      );
    }
    // Park the pointer outside the canvas so hover tooltips do not cover the shot.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: opts.height - 2 });
    await sleep(300);
    Object.assign(
      report,
      await evaluate(`({
        status: document.querySelector('.status')?.textContent ?? undefined,
        cells: document.querySelectorAll('svg [data-kind="cell"]').length,
        nets: document.querySelectorAll('svg [data-kind="net"]').length,
        banner: (() => { const b = document.querySelector('.banner'); return b && !b.hidden ? b.textContent : undefined; })(),
        cspViolations: window.__cspViolations || [],
      })`),
    );
    if (opts.out) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(opts.out, Buffer.from(shot.data, 'base64'));
      report.out = opts.out;
    }
  } finally {
    cdp?.close();
    chrome.kill();
    await sleep(200);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Chrome may still hold files on Windows
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.exceptions.length || report.timedOut.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
