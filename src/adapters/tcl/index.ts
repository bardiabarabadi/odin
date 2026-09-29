/**
 * Vivado block-design TCL adapter (output of `write_bd_tcl`).
 *
 * Pipeline: `tokenizer.ts` (source -> commands) -> `interpreter.ts` +
 * `core-commands.ts` (a small sandboxed Tcl) -> `bd-commands.ts` (Vivado BD
 * commands) -> `bd-model.ts` (virtual block design -> common `Design`).
 * See README.md in this folder.
 */
import type { Design } from '../../model/types';
import { registerBdCommands } from './bd-commands';
import { BdModel } from './bd-model';
import { registerCoreCommands } from './core-commands';
import { Interp } from './interpreter';

const HEADER = /This is a generated script based on design/;
const BD_COMMAND = /(^|[\s[;{])(create_bd_design|create_bd_cell|create_root_design)\b/m;

/** Cheap sniff used for editor-title icon / custom editor detection. */
export function isVivadoBlockDesignTcl(text: string): boolean {
  // Look at roughly the first 200 lines first: the write_bd_tcl banner lives there.
  let end = 0;
  for (let i = 0; i < 200 && end >= 0; i++) end = text.indexOf('\n', end + 1);
  const head = end < 0 ? text : text.slice(0, end);
  if (HEADER.test(head) || BD_COMMAND.test(head)) return true;
  return end >= 0 && BD_COMMAND.test(text);
}

function baseName(file: string): string {
  const leaf = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf || 'design';
}

/** Parse an exported block-design script into the common design model. Never throws on bad input; reports via `design.diagnostics`. */
export function parseVivadoBdTcl(text: string, file: string): Design {
  const model = new BdModel(file);
  try {
    const interp = new Interp({
      report: (d) => model.diag(d.severity, d.message, d.line !== undefined ? model.loc(d.line, d.endLine) : undefined),
    });
    registerCoreCommands(interp, file);
    registerBdCommands(interp, model);
    interp.runScript(text.replace(/\r\n?/g, '\n'));
    const version = interp.getGlobal('scripts_vivado_version');
    if (version !== undefined) model.tool.version = version;
    if (model.tool.version !== undefined || model.tool.part !== undefined) model.tool.name = 'Vivado';
    if (!model.designName) model.designName = interp.getGlobal('design_name') ?? '';
    return model.toDesign(baseName(file));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: baseName(file),
      sourceFormat: 'vivado-bd-tcl',
      sourceFile: file,
      ports: [],
      intfPorts: [],
      cells: [],
      nets: [],
      addressAssignments: [],
      diagnostics: [...model.diagnostics, { severity: 'error', message: `Internal parser error: ${message}` }],
    };
  }
}
