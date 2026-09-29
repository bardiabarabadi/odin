# Contributing to Odin

Thanks for helping. This document covers local setup, project layout, and the
rules that keep the codebase easy to extend.

## Setup

```bash
git clone https://github.com/bardiabarabadi/odin.git
cd odin
npm install
npm run build        # bundles the extension host and the webview into dist/
npm test             # unit tests (vitest)
npm run typecheck
```

Press **F5** in VS Code to launch an Extension Development Host with Odin
loaded. Open any `.tcl` produced by Vivado's `write_bd_tcl` and run
**Odin: Visualize Block Design**.

Windows, macOS and Linux are all supported; CI runs the test suite on all
three. Avoid shell-specific scripts and hard-coded path separators.

## Layout

```
src/model/       common design model + query helpers (no Node, no DOM)
src/adapters/    source-format adapters (TCL today)          -> Design
src/diff/        semantic diff between two Designs           -> DesignDiff
src/shared/      host <-> webview message protocol
src/extension/   VS Code integration: commands, panels, git, custom editor
webview/         the diagram UI (ELK layout + SVG), bundled to dist/webview.js
test/            vitest suites and synthetic fixtures
docs/            architecture and how-to guides
scripts/         developer CLIs (e.g. parse a file and print the model)
```

Each folder with non-trivial logic has its own `README.md`. Start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Rules of the road

* **Model first.** New features consume the design model, never the raw
  source text. If the model lacks something, extend it (optional fields) and
  update the diff engine and docs together.
* **Fixtures are synthetic.** Never commit real project files or anything
  derived from them. Hand-write small examples with generic names.
* **Parsers never throw.** Report problems via diagnostics and return the best
  partial model.
* **Keep `src/model`, `src/adapters`, `src/diff` and `webview` free of Node
  APIs** so they can run in the browser.
* **Strict TypeScript**, no `any` without a comment explaining why.
* **Tests accompany behavior.** Parser, diff and layout changes need unit
  tests; UI changes should be exercised in the standalone harness
  (`npm run dev:webview`).
* **Small commits, clear messages.** Reference the issue when there is one.

## Releasing

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. Tag `vX.Y.Z` and push the tag. The release workflow builds the `.vsix` and
   attaches it to a GitHub Release.
3. Install with **Extensions: Install from VSIX…** in VS Code or Cursor.
