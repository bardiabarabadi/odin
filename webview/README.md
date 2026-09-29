# Odin diagram webview

The interactive block-design schematic shown inside the Odin custom editor.
It is a framework-free TypeScript app bundled by esbuild into
`dist/webview.js` (IIFE) and `dist/webview.css`. Layout is done by
[ELK](https://eclipse.dev/elk/) (`elkjs`, layered algorithm) on the main
thread; rendering is plain SVG built with DOM APIs.

## Quick start

```sh
npm run dev:webview        # builds, then serves the repo at http://localhost:5173/webview/dev/
npx vitest run webview     # pure-module tests (graph building, diff index, search, ELK layout)
npx tsc --noEmit -p webview/tsconfig.json
```

Harness URL options: `?diff=1` loads `sample-diff.json` on start (or
`?diff=<url>` any `DiffPayload` JSON), `?theme=light|dark|hc`,
`?design=<url>` loads any `Design` JSON (for example one produced by
`npm run parse -- file.tcl --json`). `node webview/dev/serve.mjs --data <dir>`
also serves `<dir>` at `/data/`, so generated JSON can stay outside the repo. The floating "harness" bar can send
`diff`, `clearDiff`, `parseError`, `focus` and `requestExportSvg` messages and
switch themes. The harness page uses the same kind of Content Security Policy
as the extension (nonce'd scripts, no inline styles, no eval) and records
violations in `window.__cspViolations`, so CSP regressions show up early.

### Headless screenshots

`webview/dev/screenshot.mjs` drives the harness in headless Chrome over the
DevTools protocol (Node 22+, no npm dependencies; set `CHROME_PATH` if Chrome
is not in a standard location). It waits for the diagram, runs `--step`s
(`click:<selector>`, `dblclick:<selector>`, `drag:x1,y1,x2,y2`,
`wait:<js>`, `sleep:<ms>` or plain JavaScript), writes a PNG and prints a
JSON report (time to first render, uncaught exceptions, console errors, CSP
violations, error banner). It exits non-zero on an exception or timeout, so
it doubles as a smoke test. The README images were made like this:

```sh
npm run parse -- test/fixtures/soc.tcl --json > /tmp/odin/soc.json
node esbuild.mjs && node webview/dev/serve.mjs --data /tmp/odin &
node webview/dev/screenshot.mjs --hide-harness --out docs/images/hierarchy.png \
  --url 'http://localhost:5173/webview/dev/?design=/data/soc.json&theme=dark' \
  --step 'dblclick:[data-kind="cell"][data-path="io_subsystem"]' \
  --step 'wait:document.querySelector(`[data-path="io_subsystem/axi_gpio_1"]`)' \
  --step 'click:[data-kind="cell"][data-path="io_subsystem/axi_gpio_1"]'
```

For a diff, build a `DiffPayload` (`{ base, diff: diffDesigns(base, head, …),
baseLabel }`) from two parsed designs and add `&diff=/data/diff.json`;
`click:#odin-tab-changes` opens the Changes panel. Only use synthetic
fixtures for images that go into the repository.

## Module map

| Module | Role | DOM? |
|---|---|---|
| `main.ts` | Bootstrap, host message handling, application state, orchestration | yes |
| `vscode-api.ts` | `acquireVsCodeApi()` wrapper with a standalone fallback (console + localStorage, SVG download) | yes |
| `state.ts` | `Selection`, `NavTarget`, default/merged `ViewState`, net keys, small utils | no |
| `graph.ts` | Design + scope + filters → ELK graph + render metadata (`SceneGraph`) | no |
| `layout.ts` | Runs ELK, extracts positions/routes, caches per layout key | no |
| `render.ts` | `LaidOutScene` → SVG; selection highlighting | yes |
| `interaction.ts` | Pan/zoom (`PanZoom`), click vs. drag, hover, hit testing | yes |
| `panels.ts` | Side panel (Properties / Changes tabs), diagnostics popover, tooltip | yes |
| `toolbar.ts` | Breadcrumb, search box, toggles, actions, diff legend, diagnostics button | yes |
| `search.ts` | Whole-design fuzzy search index | no |
| `diff-index.ts` | `DiffIndex`, per-hier change counts, base/head merge, change list | no |
| `export-svg.ts` | Self-contained SVG export (computed colours inlined) | yes |
| `theme.ts` | Font/text measurement, colour normalisation, theme-change hook | yes |
| `dom.ts` | Tiny `h()` element helper | yes |
| `styles.css` | All styling; colours come from `--vscode-*` variables with fallbacks | – |

The pure modules (`graph`, `layout`, `diff-index`, `search`, `state`) are
covered by `webview/test/graph.test.ts` and run under Node.

## Data flow

```
host ── design / diff / restoreState / focus ──▶ main.ts
                                                  │  head design (+ base & DesignDiff)
                                                  ▼
                               diff-index.mergeDesigns  (head + removed objects from base)
                                                  │  "merged" Design, DiffContext
                                                  ▼
       graph.buildGraph(design, {scope, hideClockReset, hideUnconnected, diff, measure})
                                                  │  SceneGraph (ELK graph + NodeView/PinView/NetView/EdgeView)
                                                  ▼
       layout.LayoutCache.get(layoutKey(...))  ──▶ ELK layered  ──▶ LaidOutScene (positions, routes)
                                                  ▼
                   render.renderScene  ──▶ <svg>  ──▶ interaction.PanZoom  ──▶ user events
                                                  │
    selection ─▶ render.applyHighlight + panels.SidePanel.showSelection
    scope/toggles change ─▶ persist (setState) + debounced `stateChanged` to host
```

* Only one hierarchy scope is shown at a time. At the root the boundary shows
  the design's top-level ports; inside a hierarchy it shows that cell's pins.
* `main.ts` keeps a pan/zoom transform per `(scope, filters)` so going back to
  a scope restores the view; the first visit fits the diagram.
* Layout results are cached by `layoutKey(scope, filters, version)`; `version`
  is bumped whenever the design or diff changes, which invalidates the cache.
* The "Diff only" toggle is purely presentational (a class on the `<svg>`),
  so it never triggers a re-layout.

### Messages (see `src/shared/protocol.ts`)

Received: `design`, `diff`, `clearDiff`, `restoreState`, `focus`,
`parseError`, `requestExportSvg`.
Sent: `ready` (on boot), `stateChanged` (debounced 250 ms on scope/toggle
change), `revealSource` (Ctrl/Cmd+click, double-click on a leaf cell, "Go to
source" links, diagnostics entries), `exportSvg`, `requestCompare`, `notify`
(e.g. `focus` on an unknown path).

`focus.path` may be a cell path, a pin path, a top-level port name, or a net
given as `scope/netName` (or just its name).

## Pin sides and direction inference

Pins are placed with `elk.portConstraints = FIXED_POS`: inputs on the WEST
edge, outputs on the EAST edge, in source order with interface pins first
(Vivado style). The role of each pin is taken from `dir` / interface `mode`
(Master and MirroredSlave drive; Slave, MirroredMaster and Monitor are
driven). Scope boundary pins and top-level ports are inverted, because an
input of the hierarchy *drives* the nets inside it.

TCL exports often omit directions on IP pins (`inferred: true`). Name-based
guesses come from the shared heuristics in `src/model/heuristics.ts`
(`guessPinDirection` for signals, `guessIntfMode` + `intfModeSide` for
interface pins without a mode), so the renderer, the properties panel and
any future consumer agree. `graph.ts` adds net-based evidence on top, per
net in the displayed scope, passed to the heuristics as `siblingHints`:

1. a declared driver elsewhere on the net makes every unknown pin a sink
   (`netHasDeclaredDriver`; this beats the name, e.g. a processor's
   `Interrupt` input fed by an interrupt controller);
2. otherwise a pin whose name looks like an output (`*_o`, `dout`, `Q`,
   `clk_out1`, `locked`, `ip2intc_irpt`, `peripheral_aresetn`, `M00_AXI`, …)
   becomes the driver and the other unknown pins sinks;
3. otherwise, if every other endpoint is (or looks like) a sink, the one
   remaining unguessed pin drives (`netHasDeclaredSink`);
4. pins that look like inputs become sinks; anything left stays `unknown`
   and is drawn WEST.

Guesses for scope boundary pins are inverted like declared ones. Pins on no
net in the scope get the name guess only. The properties panel shows a
guessed value as e.g. `I (guessed)` or `Slave (guessed)` (computed with the
same heuristics and the declared endpoints of the pin's nets), and `?` when
nothing can be said. To teach Odin a new naming convention, add a pattern to
`src/model/heuristics.ts` and a case to `test/heuristics.test.ts`.

## How to…

### Add a toolbar toggle

1. If the toggle should survive reloads, add a field to `ViewState` in
   `src/shared/protocol.ts` (shared with the extension host; coordinate the
   change) and handle it in `mergeViewState` / `DEFAULT_VIEW_STATE`
   (`state.ts`).
2. Add the name to `ToggleName` and an entry to `TOGGLES` in `toolbar.ts`.
3. Pass it through `Toolbar.update()` in `main.ts` (`updateToolbar`).
   `setToggle()` already persists and re-renders.
4. Implement the effect:
   * geometry-changing filters: add an option to `GraphOptions`, use it in
     `buildGraph`, **and include it in `layoutKey()`** plus
     `App.transformKey()`;
   * presentation-only effects: toggle a class on `handles.svg` in
     `renderScope()` and style it in `styles.css`.

### Change layout options

Global ELK options live in `ROOT_LAYOUT_OPTIONS` (`graph.ts`). Scopes above
`LARGE_GRAPH_THRESHOLD` (40 nodes or 120 edges) also get
`LARGE_LAYOUT_OPTIONS`, which swaps NETWORK_SIMPLEX node placement and
model-order crossing minimisation for faster settings (150 cells / 440 edges:
~4 s → ~0.3 s). Node geometry constants (header height, pin pitch, stub
length, …) are in `GEOM`; `render.ts` uses the same constants, so keep them in
one place. Per-node options (port constraints, first/last layer for boundary
ports) are set in `buildGraph`. If ELK rejects a configuration, `runLayout`
retries once without layer constraints (`relaxLayoutOptions`).

### Understand the diff overlay

`diff-index.ts` turns a `DesignDiff` into a `DiffContext`:

* `index` (`DiffIndex`): status per cell / pin / port / net key. Cells with
  property or pin changes are marked `modified` even if the diff engine did
  not list them.
* `netChanges`: the `NetChange` per net key, used to colour individual edges
  whose endpoint was added or removed.
* `hierCounts`: number of changes located inside each hierarchy (any depth),
  shown as a badge on hier cells.
* `propertyChanges`: before/after values for the properties table.

`mergeDesigns(head, base, ctx)` returns the head design plus every object the
diff marks `removed`, copied from the base design (cells, pins, ports, nets,
and removed endpoints of modified nets). Layout and rendering then treat them
like any other object; `render.ts` adds `st-added` / `st-removed` /
`st-modified` classes (and `ghost` for removed objects, drawn dashed and
translucent), `unchanged` for everything else so "Diff only" can dim it.
Colours come from `--vscode-charts-green/red/orange`.

## Theming and CSP

* All CSS lives in `styles.css` (the webview CSP forbids `<style>` tags).
  Colours are `--odin-*` tokens computed on `<body>` from `--vscode-*`
  variables, with fallbacks for light/dark (`prefers-color-scheme`) and
  overrides for high-contrast themes.
* Only CSSOM writes (`el.style.transform`) are used for dynamic positioning;
  SVG geometry uses attributes.
* Text is measured with a canvas 2D context using the VS Code UI font
  (`theme.ts`), so node sizes match the rendered labels.
* SVG export copies computed presentation properties onto the cloned elements
  (only where they differ from the parent), normalises `color(srgb …)` values
  to `rgb()`, strips classes and interaction-only elements, and embeds a
  one-line `<style>` for the font family.

## Keyboard

| Key | Action |
|---|---|
| Backspace, Alt+↑ | Go up one hierarchy level |
| Enter | Open the selected hierarchy |
| + / − / 0 | Zoom in / out / fit |
| Arrow keys | Pan |
| / or Ctrl/Cmd+F | Focus search (↑/↓/Enter/Esc in results) |
| Esc | Clear selection / close popover |
| ←/→ in breadcrumb | Move between breadcrumb items |
