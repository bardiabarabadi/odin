# Vivado block-design TCL adapter

Reads the scripts that Vivado's `write_bd_tcl` produces and turns them into the
common `Design` model (`src/model/types.ts`).

Exported scripts are real programs: design creation is wrapped in procs
(`create_root_design`, `create_hier_cell_*`), uses variables (`$parentCell`,
`$hier_obj`, `$block_name`), `catch`/`if` guards, `[list ...]` and line
continuations. So instead of scraping them with regexes, the adapter **runs the
script** in a small sandboxed Tcl interpreter whose Vivado commands operate on
a virtual block design.

## Architecture

```
text ──► tokenizer.ts ──► interpreter.ts + core-commands.ts ──► bd-commands.ts ──► bd-model.ts ──► Design
         (commands,        (sandboxed Tcl: variables, procs,     (Vivado BD         (virtual BD:
          words, parts,     if/catch/foreach, expr.ts)            commands, handle   cells, pins, nets,
          line numbers)                                           resolution)        inference, checks)
```

| File               | Role                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `tokenizer.ts`     | Tcl parser: commands/words/parts, `{}` `""` `[]` `$var` `${var}` `$ns::var`, escapes, continuations, `{*}`. Records 1-based start/end line per command. |
| `lists.ts`         | Tcl list split / format.                                                                               |
| `expr.ts`          | `expr` evaluator (AST, lazy `&&` / `\|\|` / `?:`, string and numeric comparisons, a few math functions). |
| `interpreter.ts`   | Frames, namespaces, procs, command dispatch, step and recursion limits, top-level runner that never throws. |
| `core-commands.ts` | Language commands: `set`, `proc`, `if`, `catch`, `foreach`, `while`, `for`, `list`, `lappend`, `string`, `file`, `info`, `namespace eval`, `variable`, `global`, `return`, `error`, ... |
| `bd-commands.ts`   | Vivado commands and environment stubs (see below).                                                     |
| `bd-model.ts`      | The virtual block design and the conversion to `Design`.                                               |
| `index.ts`         | `isVivadoBlockDesignTcl` (cheap sniff) and `parseVivadoBdTcl` (entry point).                          |

Everything here is pure TypeScript with no Node APIs, so it bundles for the
browser. Only `scripts/parse.ts` (the developer CLI) touches the file system.

### Object handles

Vivado commands return object handles; here a handle is the absolute object
path with a leading `/` (the root design is `/`). The model stores paths
without the leading slash. Relative paths are resolved against the current
`current_bd_instance` scope. The adapter remembers which kind of object each
handle string was last produced for (`get_bd_pins` → pin, `get_bd_ports` →
port, ...) so `set_property` knows where to store properties.

### Inference

- Pins that nets or `set_property` mention on cells that never declared them
  (IP and module-reference pins are never declared in exports) are created
  with `inferred: true` and no direction.
- Inferred interface pins get their `mode` (and `vlnv`) from the other end of
  the interface net: a hierarchy boundary pin or top-level port passes its mode
  through; a peer on the same level gets the opposite mode
  (`Master`↔`Slave`, `MirroredMaster`→`Master`, `MirroredSlave`→`Slave`).
- Nets without `-net` / `-intf_net` get a name built from their first endpoint.
  Nets with the same name in the same scope are merged.

## Supported commands

| Command                                                 | Effect                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `create_bd_design [-dir d] name`                        | Sets the design name.                                                                   |
| `current_bd_design`                                     | Returns the design name.                                                                |
| `current_bd_instance [path \| .]`                        | Gets / sets the current hierarchy scope.                                                |
| `create_bd_cell -type ip\|hier\|module\|inline_hdl ...`  | Creates a cell (`-vlnv`, `-reference`).                                                 |
| `create_bd_pin` / `create_bd_intf_pin`                  | Declares a boundary pin on the current hierarchical cell (`-dir -from -to -type`, `-mode -vlnv`). |
| `create_bd_port` / `create_bd_intf_port`                | Declares a top-level port (`-freq_hz` becomes `CONFIG.FREQ_HZ`).                        |
| `connect_bd_net [-net n] objs...`                       | Signal net in the current scope; endpoints may be lists.                                |
| `connect_bd_intf_net [-intf_net n] objs...`             | Interface net in the current scope.                                                     |
| `get_bd_cells`, `get_bd_pins`, `get_bd_intf_pins`, `get_bd_ports`, `get_bd_intf_ports`, `get_bd_nets`, `get_bd_intf_nets`, `get_bd_addr_spaces`, `get_bd_addr_segs` | Return handles. `get_bd_cells ""` and `get_bd_cells /` return the root `/`. |
| `set_property -dict {k v ...} objs` / `set_property k v objs` | Stores properties on cells, pins, interface pins, ports and interface ports; `BOARD_PART` goes to `design.tool.board`. |
| `get_property TYPE obj`                                 | `hier` for the root and hierarchical cells (keeps the generated sanity checks happy).   |
| `assign_bd_address ... -target_address_space S segs`    | Address assignment (`-offset`, `-range`; also `-target seg`).                          |
| `create_bd_addr_seg -range -offset space seg name`      | Legacy address assignment form.                                                         |
| `create_project ... -part P`, `set_part P`              | `design.tool.part`.                                                                     |
| `version -short`                                        | Returns `$scripts_vivado_version` so the version check passes (it becomes `design.tool.version`). |
| `common::send_gid_msg -severity ERROR msg`              | Recorded as an `error` diagnostic; other severities are ignored.                        |
| `get_projects`, `get_bd_designs`, `get_files`           | Return `""`.                                                                            |
| `get_ipdefs`, `can_resolve_reference`                   | Report every IP / module as available.                                                  |
| `validate_bd_design`, `save_bd_design`, `regenerate_bd_layout`, `close_bd_design`, `exclude_bd_addr_seg`, ... | Ignored silently. |

Any other command is ignored and reported once as an `info` diagnostic.

## Diagnostics

- `error`: Tcl syntax errors, runtime errors escaping a top-level command
  (evaluation continues with the next top-level command), step-limit aborts,
  `send_gid_msg -severity ERROR`.
- `warning`: unevaluable `if` conditions (treated as false), a top-level
  `return` that stops the script early, nets with no endpoints, endpoints on
  unknown cells or undeclared ports, nets that reach outside their scope,
  duplicate declarations, `set_property` on missing objects.
- `info`: unsupported commands.

## Known limitations

- Only the Tcl subset used by generated scripts (plus common basics) is
  implemented; `uplevel` evaluates in the current frame, `upvar`, arrays
  beyond simple `$a(key)` reads, `regexp`, `dict` and `clock` are not
  supported.
- `get_bd_*` queries return handles for any path that is asked for (IP pins are
  unknown until referenced); `-filter`, `-of_objects` and `-hierarchical` are
  ignored.
- Pin directions of IP / module pins are not known from the script and are left
  undefined.
- Commands that edit an existing design (`delete_bd_objs`, `move_bd_cells`,
  `disconnect_bd_net`, `apply_bd_automation`, ...) are not modelled.

## Adding a command

1. Decide whether it is a language command (`core-commands.ts`) or a Vivado
   command (`bd-commands.ts`).
2. Register it with `r('name', (interp, args, ctx) => result)`. `args` are
   fully substituted strings; use `parseOptions(args)` for `-flag value`
   options (add value-taking options to `VALUED_OPTIONS`) and `splitList` for
   list arguments. For script-body arguments use `bodyArg(args, ctx, i)` so
   line numbers stay exact. `ctx.line` / `ctx.endLine` give the command's
   source range; build a `SourceLocation` with `model.loc(ctx.line, ctx.endLine)`.
3. Mutate the design only through `BdModel` methods; add a method there if the
   command introduces a new kind of change.
4. Return a Tcl result string (a handle, a list, or `""`). Throw `TclError` only
   for genuine script errors; prefer `model.diag('warning', ...)` for bad input.
5. Add a unit test in `test/tcl-*.test.ts` and, if it appears in exports, a use
   in one of the fixtures under `test/fixtures/`.
