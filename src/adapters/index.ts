/**
 * Adapter registry. To add a new source format, implement `SourceAdapter`
 * in a sibling folder and push it onto `adapters` below.
 */
import type { Design, SourceFormat } from '../model/types';
import { isVivadoBlockDesignTcl, parseVivadoBdTcl } from './tcl';

export interface SourceAdapter {
  format: SourceFormat;
  /** Human-readable name shown in UI. */
  displayName: string;
  /** File extensions (lowercase, with dot) this adapter may apply to. */
  extensions: string[];
  /** Content sniff; must be cheap because it runs on every editor change. */
  detect(text: string): boolean;
  parse(text: string, file: string): Design;
}

export const adapters: SourceAdapter[] = [
  {
    format: 'vivado-bd-tcl',
    displayName: 'Vivado block design (TCL export)',
    extensions: ['.tcl'],
    detect: isVivadoBlockDesignTcl,
    parse: parseVivadoBdTcl,
  },
];

export function findAdapter(text: string, fileName: string): SourceAdapter | undefined {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return adapters.find((a) => a.extensions.includes(ext) && a.detect(text));
}

export function parseDesign(text: string, file: string): Design | undefined {
  return findAdapter(text, file)?.parse(text, file);
}
