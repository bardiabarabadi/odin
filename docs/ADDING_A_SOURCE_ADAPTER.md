# Adding a source-format adapter

Odin turns files into the [common design model](DESIGN_MODEL.md) through
adapters registered in [`src/adapters/index.ts`](../src/adapters/index.ts).
The Vivado block-design TCL adapter in `src/adapters/tcl/` is the reference
implementation and the most complete example.

## Steps

1. **Create a folder** `src/adapters/<format>/` with an `index.ts` exporting
   two functions:

   ```ts
   export function is<Format>(text: string): boolean;              // cheap sniff
   export function parse<Format>(text: string, file: string): Design;
   ```

   `detect` runs on every keystroke in a matching file, so it must be a cheap
   regex or prefix check. `parse` must never throw; report problems through
   `design.diagnostics` and return the best partial model you can.

2. **Register it** by appending an entry to the `adapters` array in
   `src/adapters/index.ts` with the format id, display name, file extensions
   and the two functions. Order matters only when two adapters share an
   extension: the first whose `detect` returns true wins.

3. **Fill `loc`** on every object you create. Users navigate from the diagram
   back to the source, and diagnostics link to lines.

4. **Respect the path conventions** in `DESIGN_MODEL.md`. In particular, nets
   must be scoped to one hierarchy level and boundary pins must use the
   `hierPath/pinName` form.

5. **Add fixtures and tests** under `test/fixtures/<format>/` and
   `test/<format>-*.test.ts`. Fixtures must be synthetic: small, hand-written
   files with generic names that exercise the syntax you support. Never commit
   real project files.

6. **Document it** in `src/adapters/<format>/README.md`: what the format is,
   which constructs are supported, known limitations, and how to extend it.

7. **Wire the UI** if the format needs it. Detection alone already enables the
   editor-title button and the "Open With" option for the registered
   extensions; add new file extensions to the `customEditors` selector and the
   `languages` contribution in `package.json`.

## Keep the parser portable

Adapters must not import Node built-ins (`fs`, `path`, `child_process`). The
model and adapters are meant to be bundleable into the webview or a future web
extension. File access belongs in `src/extension/` or `scripts/`.

## Sharing a design across formats

When a project has several representations of the same design (for example a
TCL export next to a `.bd` file), a future "enrichment" step can merge models
by path. Keep that in mind: produce stable, tool-independent paths and put
tool-specific detail into `properties` rather than inventing new fields.
