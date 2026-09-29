/** Convenience queries over a `Design`. Pure functions, safe in the webview. */
import type { Cell, Design, IntfPin, Net, Pin } from './types';

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function leafName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function getCell(design: Design, path: string): Cell | undefined {
  return design.cells.find((c) => c.path === path);
}

/** Direct children of a hierarchy scope (`""` = root). */
export function getChildren(design: Design, scope: string): Cell[] {
  return design.cells.filter((c) => c.parent === scope);
}

/** Nets declared inside a hierarchy scope. */
export function getNetsInScope(design: Design, scope: string): Net[] {
  return design.nets.filter((n) => n.scope === scope);
}

export function findPin(design: Design, path: string): Pin | IntfPin | undefined {
  const cellPath = parentPath(path);
  const name = leafName(path);
  if (cellPath === '') {
    return design.ports.find((p) => p.name === name) ?? design.intfPorts.find((p) => p.name === name);
  }
  const cell = getCell(design, cellPath);
  if (!cell) return undefined;
  return cell.pins.find((p) => p.name === name) ?? cell.intfPins.find((p) => p.name === name);
}

/** Every net (any scope) that touches the given pin/port path. */
export function netsTouching(design: Design, pinPath: string): Net[] {
  return design.nets.filter((n) => n.endpoints.some((e) => e.path === pinPath));
}

export function isClockPin(pin: Pin): boolean {
  return pin.type === 'clk' || /(^|_)a?clk(_|$)|clock/i.test(pin.name);
}

export function isResetPin(pin: Pin): boolean {
  return pin.type === 'rst' || /reset|(^|_)a?rst(n)?(_|$)|aresetn/i.test(pin.name);
}

/** Build a lookup map once instead of repeated `find` calls. */
export function indexCells(design: Design): Map<string, Cell> {
  return new Map(design.cells.map((c) => [c.path, c]));
}
