/**
 * Developer CLI: parse a Vivado block-design TCL export and print a summary.
 *
 *   npm run parse -- <file.tcl> [--json]
 */
import { readFileSync } from 'fs';
import { getChildren } from '../src/model/query';
import type { Design } from '../src/model/types';
import { isVivadoBlockDesignTcl, parseVivadoBdTcl } from '../src/adapters/tcl';

function countBy<T>(items: T[], key: (t: T) => string): string {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m].map(([k, v]) => `${k}=${v}`).join(' ') || '-';
}

function printTree(design: Design, scope: string, indent: string, out: string[]): void {
  for (const c of getChildren(design, scope)) {
    const what = c.kind === 'ip' ? c.vlnv : c.kind === 'module' ? c.reference : undefined;
    out.push(`${indent}${c.name} [${c.kind}${what ? ` ${what}` : ''}] pins=${c.pins.length} intf=${c.intfPins.length}`);
    if (c.kind === 'hier') printTree(design, c.path, `${indent}  `, out);
  }
}

function summary(d: Design, elapsedMs: number): string {
  const pins = d.cells.flatMap((c) => c.pins);
  const intfPins = d.cells.flatMap((c) => c.intfPins);
  const out = [
    `design:      ${d.name}`,
    `tool:        ${d.tool ? JSON.stringify(d.tool) : '-'}`,
    `parsed in:   ${elapsedMs} ms`,
    `cells:       ${d.cells.length} (${countBy(d.cells, (c) => c.kind)})`,
    `pins:        ${pins.length} (declared=${pins.filter((p) => !p.inferred).length} inferred=${pins.filter((p) => p.inferred).length})`,
    `intf pins:   ${intfPins.length} (inferred=${intfPins.filter((p) => p.inferred).length}, no mode=${intfPins.filter((p) => !p.mode).length})`,
    `ports:       ${d.ports.length}, intf ports: ${d.intfPorts.length}`,
    `nets:        ${d.nets.length} (${countBy(d.nets, (n) => n.kind)})`,
    `addresses:   ${d.addressAssignments.length}`,
    '',
    'hierarchy:',
  ];
  printTree(d, '', '  ', out);
  out.push('', `diagnostics: ${d.diagnostics.length}`);
  for (const x of d.diagnostics) out.push(`  ${x.severity.padEnd(7)} ${x.loc ? `line ${x.loc.line}: ` : ''}${x.message}`);
  return out.join('\n');
}

function main(argv: string[]): number {
  const json = argv.includes('--json');
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: npm run parse -- <file.tcl> [--json]\n');
    return 2;
  }
  const text = readFileSync(file, 'utf8');
  if (!isVivadoBlockDesignTcl(text)) process.stderr.write(`note: ${file} does not look like a write_bd_tcl export\n`);
  const t0 = Date.now();
  const design = parseVivadoBdTcl(text, file);
  const elapsed = Date.now() - t0;
  process.stdout.write(`${json ? JSON.stringify(design, null, 2) : summary(design, elapsed)}\n`);
  return design.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
