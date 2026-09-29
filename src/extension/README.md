# Extension host (`src/extension`)

The VS Code side of Odin: activation, commands, the webview panel that hosts
the diagram, and git integration for compare mode. This is the only part of
the code base that may use Node and VS Code APIs. Everything it shows comes
from the common model (`src/model`), produced by an adapter
(`src/adapters`) and optionally diffed by `src/diff`.

## Files

| File | Role |
| --- | --- |
| `main.ts` | `activate` / `deactivate`: wires everything below into `context.subscriptions` |
| `detect.ts` | `BlockDesignDetector`: maintains the `odin.isBlockDesign` context key |
| `panel.ts` | `DesignPanel`: one controller per source document, owns the webview |
| `customEditor.ts` | `BlockDesignEditorProvider`: "Open With… > Odin Block Design" |
| `commands.ts` | Registers every `odin.*` command |
| `compare.ts` | Revision picker, loading/parsing the base revision, the `odin-git:` content provider |
| `git.ts` | Thin `git` CLI wrapper (`execFile`, never a shell) |
| `log.ts` | The "Odin" output channel (`log.info/warn/error`, `Odin: Show Log`) |

## Activation

`package.json` activates on `onLanguage:tcl` and
`onCustomEditor:odin.blockDesign`; commands activate the extension implicitly
(VS Code ≥ 1.74). `activate()`:

1. creates the output channel (`log.init`),
2. starts `BlockDesignDetector`,
3. registers the `odin-git:` `TextDocumentContentProvider`,
4. registers the custom editor provider,
5. registers the commands (`registerCommands`).

`deactivate()` and the disposable pushed in `activate()` both call
`DesignPanel.disposeAll()`.

## Detection and context keys

Menus and the command palette depend on three context keys:

| Key | Set by | Meaning |
| --- | --- | --- |
| `odin.isBlockDesign` | `detect.ts` | The active text editor holds a document some adapter recognises |
| `odin.panelFocused` | `panel.ts` | An Odin panel or custom editor is the active editor |
| `odin.hasComparison` | `panel.ts` | The active Odin panel has a comparison base |

The detector calls `findAdapter(text, fileName)` (a cheap content sniff,
never a full parse) when the active editor changes, and debounced (300 ms)
when the active document is edited or opened. While a non-text editor such as
the diagram is focused it keeps the previous value, so editor-title buttons
do not flicker. `when` clauses also use VS Code's own `activeWebviewPanelId`
(`odin.blockDesignPanel`) and `activeCustomEditorId` (`odin.blockDesign`).

## `DesignPanel` lifecycle

`DesignPanel` instances live in a static map keyed by the source document URI
string, so there is at most one diagram per file. `DesignPanel.active()` is
the focused one (tracked via `onDidChangeViewState`).

* **Creation**: `DesignPanel.show(context, uri)` reveals the existing panel
  or creates a `WebviewPanel` (`viewType` `odin.blockDesignPanel`) beside the
  editor, with `retainContextWhenHidden` and `localResourceRoots` limited to
  `dist/`. `DesignPanel.attach()` does the same for a panel handed over by
  the custom editor. Creating a panel for a URI that already has one disposes
  the old one.
* **HTML**: `html()` loads `dist/webview.js` and `dist/webview.css` under a
  strict CSP (nonce'd script, no inline styles, resources only from the
  webview origin).
* **Handshake**: messages posted before the webview says `ready` would be
  lost, so `post()` drops them. On `ready` the panel sends `restoreState`
  (settings defaults merged with the view state saved in `workspaceState`)
  and then calls `refresh()`, which sends the design and, if a comparison is
  active, the diff.
* **Refresh**: `refresh()` re-reads the document (unsaved editor contents
  included), picks an adapter and parses it. Parsers never throw; they report
  problems in `design.diagnostics`. If the parsed design has **no cells and at
  least one `error` diagnostic**, the panel sends `parseError` with the first
  error (prefixed with `file:line` when known). Otherwise it sends `design`,
  and the webview shows any diagnostics in its warning indicator. A
  `try/catch` around the parse is kept as a safety net and also reports
  `parseError`. Saving the file triggers `refresh()` when
  `odin.autoRefreshOnSave` is on.
* **Disposal**: closing the tab disposes the controller, removes it from the
  map and clears the context keys if it was active.

### Custom editor sharing

`BlockDesignEditorProvider` is a `CustomTextEditorProvider` registered with
`priority: "option"` in `package.json`, so it only opens through
"Open With…" (or when a user makes it the default for `*.tcl`). Its
`resolveCustomTextEditor` just calls `DesignPanel.attach()`: the custom
editor and the `odin.visualize` panel run the same controller, messages and
commands. The only differences are how the `WebviewPanel` is obtained and
the `isCustomEditor` flag (used for logging).

## Messages

The protocol is defined once in `src/shared/protocol.ts` and imported by both
sides; change both in the same commit.

Host → webview: `design`, `diff`, `clearDiff`, `restoreState`,
`requestExportSvg`, `focus`, `parseError`.

Webview → host, handled in `DesignPanel.onMessage`:

| Message | Host action |
| --- | --- |
| `ready` | Send `restoreState`, then `refresh()` |
| `revealSource` | Open the file at `loc` (resolving plain paths, `file:` and `odin-git:` URIs) in the editor column the user came from, select and centre the lines |
| `exportSvg` | Save dialog next to the source file, write the SVG, offer to open it |
| `requestCompare` | Run `odin.compare` for this document |
| `stateChanged` | Persist the `ViewState` in `workspaceState` under `odin.viewState:<uri>` |
| `notify` | Show an information / warning / error message |

Incoming messages are type-checked loosely (`isWebviewMessage`); the `switch`
has an exhaustiveness check, so adding a message type to the protocol without
handling it fails to compile. Errors in a handler are logged and shown, never
thrown back into the webview.

## Compare flow

1. `odin.compare [uri] [ref]` resolves the target document (explicit URI,
   else the focused diagram, else the active editor) and opens its panel if
   needed.
2. `pickAndLoadBase()` requires a `file:` URI, then `locateInRepo()` runs
   `git rev-parse --show-toplevel --show-prefix` from the file's directory to
   get the repo root and the repo-relative path.
3. Without a `ref` argument the quick pick offers `odin.compare.defaultRef`,
   `HEAD`, `HEAD~1`, the upstream branch, the last 30 commits touching the
   file (`git log -- <path>`), branches, tags and "Enter a revision…".
   Revisions starting with `-` are rejected (`assertSafeRef`).
4. `git show <ref>:<path>` fetches the old text, which is parsed with the
   adapter matching it. A base that parses to no cells with an error
   diagnostic is rejected with that error. Locations in the base design point
   at an `odin-git:` URI (see below). The label is `ref (shorthash)`.
5. `DesignPanel.setBase()` stores the base, updates `odin.hasComparison` and
   sends `{ type: 'diff', payload: { base, diff, baseLabel } }`, where
   `diff = diffDesigns(base, head)`. The diff is recomputed on every refresh
   (for example after a save); the base is not re-read.
6. `odin.clearCompare` drops the base and sends `clearDiff`.

Passing a ref makes the command scriptable, e.g.
`vscode.commands.executeCommand('odin.compare', uri, 'HEAD~3')`.

### The `odin-git:` scheme

`revisionUri(fsPath, ref)` builds
`odin-git:/abs/path/file.tcl?{"ref":"…","fsPath":"…"}`.
`RevisionContentProvider` answers such URIs with `git show` output, so
"go to source" on a removed (ghost) object opens a read-only editor showing
the file as it was at the base revision, at the right line.

All git calls go through `runGit()` (`execFile` with the configured
executable, `cwd` = repo root, 256 MB buffer) and are logged to the output
channel. Errors become `GitError` with a readable message (not a repository,
unknown revision, file absent at that revision, git not found).

## Settings

| Setting | Default | Read in |
| --- | --- | --- |
| `odin.autoRefreshOnSave` | `true` | `panel.ts` (save listener) |
| `odin.hideClockResetNetsByDefault` | `false` | `panel.ts` (`initialState`, first open only) |
| `odin.hideUnconnectedPinsByDefault` | `false` | `panel.ts` (`initialState`, first open only) |
| `odin.compare.defaultRef` | `"HEAD"` | `compare.ts` (first quick-pick entry, input box default) |
| `odin.git.path` | `"git"` (machine scope) | `git.ts` |

The two "ByDefault" settings only seed the view state; once the user toggles
the filters in the diagram, the saved per-file state wins.

## Commands

| Command | Behaviour |
| --- | --- |
| `odin.visualize` | Open or reveal the diagram for the target `.tcl` (warns if it is not a block design) |
| `odin.compare` | Pick a git revision and show the diff overlay |
| `odin.clearCompare` | Remove the diff overlay |
| `odin.exportSvg` | Ask the webview for an SVG and save it |
| `odin.refresh` | Re-parse and redraw |
| `odin.openSource` | Show the source text editor for the diagram |
| `odin.showLog` | Show the "Odin" output channel |

All commands resolve their target with `targetUri(arg)`: an explicit `Uri`
argument (menus pass one), else the focused diagram, else the active text
editor.

## How to add a command

1. `package.json` → `contributes.commands`: id `odin.<name>`, `title`,
   `category: "Odin"`, optional codicon `icon`.
2. Add menu entries (`editor/title`, `editor/context`, `explorer/context`)
   and a `commandPalette` entry with a `when` clause built from the context
   keys above, so the command only shows where it can work. Add a keybinding
   under `contributes.keybindings` if needed.
3. Register it in `registerCommands()` (`commands.ts`) with `reg(id, fn)`.
   `reg` wraps the handler in `guard`, which logs and shows errors, so do not
   add your own top-level `try/catch`. Use `targetUri(arg)` /
   `existingPanel(arg)` to find the document or panel.
4. If the webview must react, add a message to `src/shared/protocol.ts`, a
   public method on `DesignPanel` that `post()`s it, and handle it in
   `webview/src/main.ts`.
5. Mention it in `README.md` and `CHANGELOG.md`.

## Debugging

Use the "Run Extension" launch configuration (`.vscode/launch.json`); it
builds first. Everything the host does (parse timings with cell/net/diagnostic
counts, git invocations, errors with stacks) goes to the "Odin" output
channel (`Odin: Show Log`). For the diagram itself, the standalone harness
(`npm run dev:webview`, see `webview/README.md`) is faster than reloading the
extension, and "Developer: Open Webview Developer Tools" works inside VS
Code.
