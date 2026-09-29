# Architecture

Odin is organized as a pipeline of independent layers connected by two typed
contracts: the **design model** and the **host ↔ webview protocol**.

```
┌──────────────┐   text    ┌──────────────────┐  Design   ┌──────────────┐
│ VS Code doc  │ ────────► │ source adapter   │ ────────► │ diff engine  │
│ or git show  │           │ (src/adapters)   │           │ (src/diff)   │
└──────────────┘           └──────────────────┘           └──────┬───────┘
                                    │                            │ DesignDiff
                                    ▼                            ▼
                           ┌──────────────────────────────────────────┐
                           │ extension host (src/extension)           │
                           │  panels, commands, git, custom editor    │
                           └──────────────┬───────────────────────────┘
                                          │ postMessage (src/shared/protocol.ts)
                                          ▼
                           ┌──────────────────────────────────────────┐
                           │ webview (webview/src)                    │
                           │  graph builder → ELK layout → SVG        │
                           │  interaction, panels, diff overlay       │
                           └──────────────────────────────────────────┘
```

## Layers

### `src/model` – the design model

Tool-independent description of a block design: cells, pins, interface pins,
ports, nets, address assignments, diagnostics, each with a source location.
[`DESIGN_MODEL.md`](DESIGN_MODEL.md) documents the path and scoping rules.
`query.ts` has lookup helpers and `heuristics.ts` guesses pin directions and
interface modes from names when the source did not state them. No Node or
DOM APIs.

### `src/adapters` – source formats → model

`index.ts` is a registry of `SourceAdapter`s (`detect` + `parse`). The Vivado
TCL adapter (`tcl/`) is a small Tcl interpreter: tokenizer → interpreter with
scopes/procs/`expr` → block-design command handlers that build a virtual
design → conversion to the model. Running the script instead of pattern
matching it keeps the adapter robust to the procedural structure of exported
files. See [`src/adapters/tcl/README.md`](../src/adapters/tcl/README.md) and
[`ADDING_A_SOURCE_ADAPTER.md`](ADDING_A_SOURCE_ADAPTER.md).

### `src/diff` – semantic comparison

`diffDesigns(base, head)` matches objects by path (nets additionally by
identical endpoint sets, so auto-renamed nets do not appear as changes) and
reports added/removed/modified cells, pins, ports, nets, properties and
address assignments plus a summary. `countChangesUnder` powers the badges on
hierarchical cells. Pure functions; usable in both host and webview. See
[`src/diff/README.md`](../src/diff/README.md).

### `src/shared/protocol.ts` – messages

The only coupling between host and webview. Host → webview: `design`, `diff`,
`clearDiff`, `restoreState`, `requestExportSvg`, `focus`, `parseError`.
Webview → host: `ready`, `revealSource`, `exportSvg`, `requestCompare`,
`stateChanged`, `notify`. Change both sides in the same commit.

### `src/extension` – VS Code integration

* `detect.ts` sniffs the active editor (debounced) and sets the
  `odin.isBlockDesign` context key that gates menus.
* `panel.ts` owns one `DesignPanel` per document: creates or attaches the
  webview, serves the HTML with a strict CSP, parses on open and on save,
  persists view state, handles reveal-source and SVG export.
* `customEditor.ts` implements "Open With › Odin Block Design" by attaching
  the same `DesignPanel` to the editor-provided webview.
* `git.ts` / `compare.ts` locate the repository, offer a revision picker,
  fetch the base file with `git show`, parse it, run the diff and post it. A
  content provider for the `odin-git:` scheme lets jump-to-source open the
  file as it was at that revision.
* `commands.ts` wires the palette/menus; `main.ts` activates everything.

See [`src/extension/README.md`](../src/extension/README.md).

### `webview` – the diagram

`graph.ts` turns the current scope of a `Design` (plus filters and an optional
diff) into an ELK graph: nodes with ports on the west/east side according to
declared or guessed direction, edges per net. `layout.ts` runs ELK (layered,
orthogonal routing, faster settings above a size threshold) and caches results
per scope. `render.ts` draws SVG; `interaction.ts` handles pan/zoom/selection;
`panels.ts`, `toolbar.ts`, `search.ts` provide the chrome; `diff-index.ts`
merges base and head for the overlay; `export-svg.ts` inlines styles for a
self-contained file. `webview/dev/` is a standalone harness that runs the same
bundle in a browser with a sample design. See
[`webview/README.md`](../webview/README.md).

## Build and packaging

`esbuild.mjs` produces two bundles: `dist/extension.js` (Node, CommonJS,
`vscode` external) and `dist/webview.js` + `dist/webview.css` (browser,
IIFE). `npm run package` builds in production mode and runs `vsce`. CI runs
typecheck, lint, tests and packaging on Linux, macOS and Windows; the release
workflow attaches the `.vsix` to a GitHub Release on `v*` tags.

## Design decisions

* **Interpret, don't scrape.** Exported scripts are procedural; executing them
  with a tiny Tcl interpreter is simpler and more faithful than regexes.
* **One scope at a time.** Rendering a single hierarchy level keeps layouts
  fast and readable and mirrors the tool users already know.
* **Paths as identity.** Stable hierarchical paths make the diff engine, the
  overlay and click-to-source trivial to reason about.
* **No frameworks in the webview.** Plain DOM + SVG keeps the bundle small
  (ELK is the only dependency) and the CSP strict.
* **Node-free core.** Model, adapters, diff and webview can run in a browser,
  which keeps a future web-extension build possible.
