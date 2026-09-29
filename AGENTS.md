# Guide for coding agents and new contributors

This file is the fastest way to become productive in this repository. It is
tool-agnostic: any automated coding assistant or human should follow it.

## What Odin is

A VS Code / Cursor extension that renders FPGA block designs as an interactive
schematic and diffs them against git history. Today it reads Vivado
`write_bd_tcl` exports; the architecture is built to add more formats.

## Read these first

1. `docs/ARCHITECTURE.md` – how the pieces fit and the data flow.
2. `docs/DESIGN_MODEL.md` – the model everything is built on, path rules.
3. The `README.md` inside the folder you are changing
   (`src/adapters/tcl`, `src/diff`, `webview`, `src/extension`).

## Commands you will use

```bash
npm run build          # bundle host + webview
npm run watch          # rebuild on change
npm test               # vitest
npm run typecheck      # both tsconfigs
npm run lint
npm run parse -- path/to/design.tcl        # print the parsed model summary
npm run parse -- path/to/design.tcl --json # full model as JSON
npm run dev:webview    # serve the standalone diagram harness
npm run package        # build a .vsix
```

## Where things go

| Task | Location |
| --- | --- |
| Support a new Tcl command in the exporter format | `src/adapters/tcl/` (see its README, "adding a command") |
| Support a new source format | `src/adapters/<format>/` + register in `src/adapters/index.ts` (guide: `docs/ADDING_A_SOURCE_ADAPTER.md`) |
| Change what counts as a "change" in compare mode | `src/diff/` |
| Change the drawing, layout, toolbar, panels | `webview/src/` |
| Add a command, setting, menu, keybinding | `package.json` `contributes` + `src/extension/commands.ts` |
| Git integration | `src/extension/git.ts`, `src/extension/compare.ts` |
| Host <-> webview messages | `src/shared/protocol.ts` (update both sides in the same change) |

## Invariants to protect

* Paths: `/`-separated, no leading slash, root is `""`; boundary pins are
  `hierPath/pinName` from both sides. See `docs/DESIGN_MODEL.md`.
* Nets are scoped to one hierarchy level.
* Parsers never throw; they emit diagnostics.
* `src/model`, `src/adapters`, `src/diff`, `webview`: no Node APIs.
* Fixtures are synthetic and generic. Do not add real designs, even renamed.
* Webview CSP is strict: no inline `<style>`, no external resources; all CSS in
  `webview/src/styles.css`, all scripts bundled.

## Definition of done for a change

* Type-checks, lints, and `npm test` pass on macOS, Linux and Windows (CI).
* New behavior has a test (parser/diff) or a harness scenario (webview).
* Docs updated: the folder README and, if user-visible, `README.md` and
  `CHANGELOG.md`.
* No secrets, no proprietary content, no references to private projects.
