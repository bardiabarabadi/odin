/**
 * Vivado commands, implemented against the virtual block design (`BdModel`).
 *
 * Object handles are strings holding the absolute object path with a leading
 * `/` (the root design is `/`), just like Vivado prints them. The kind of
 * object a handle was last produced for (cell, pin, port, ...) is remembered
 * so `set_property` knows where to store properties.
 */
import { parentPath } from '../../model/query';
import type { CellKind, PinDirection } from '../../model/types';
import { BdModel, normalizePath, type PropertyTarget } from './bd-model';
import type { CallContext, CommandFn, Interp } from './interpreter';
import { formatList, splitList } from './lists';

type HandleKind = PropertyTarget['kind'] | 'net' | 'addr' | 'other';

/** Options that take a value; any other `-flag` is treated as boolean. */
const VALUED_OPTIONS = new Set([
  'dir', 'from', 'to', 'type', 'vlnv', 'mode', 'reference', 'freq_hz', 'net', 'intf_net', 'offset', 'range',
  'target_address_space', 'with_name', 'target', 'export_to_file', 'import_from_file', 'filter', 'of_objects',
  'dict', 'ssname', 'id', 'severity', 'part', 'boundary_type', 'bdsource', 'objects', 'name', 'regexp_filter',
]);

interface ParsedArgs {
  opts: Map<string, string>;
  flags: Set<string>;
  pos: string[];
}

export function parseOptions(args: string[]): ParsedArgs {
  const opts = new Map<string, string>();
  const flags = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[A-Za-z_]/.test(a)) {
      const key = a.slice(1);
      if (VALUED_OPTIONS.has(key) && i + 1 < args.length) opts.set(key, args[++i]);
      else flags.add(key);
    } else pos.push(a);
  }
  return { opts, flags, pos };
}

const handleOf = (path: string): string => `/${path}`;
const hasGlob = (s: string): boolean => /[*?]/.test(s);

/** Glob over hierarchical paths where `*` does not cross `/`. */
function pathGlob(pattern: string): RegExp {
  let re = '';
  for (const c of pattern) re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${re}$`);
}

export function registerBdCommands(interp: Interp, model: BdModel): void {
  const kinds = new Map<string, HandleKind>();
  const unknownSeen = new Set<string>();
  const loc = (ctx: CallContext) => model.loc(ctx.line, ctx.endLine);
  const r = (name: string, fn: CommandFn) => interp.register(name, fn);
  const give = (paths: string[], kind: HandleKind): string => {
    const hs = paths.map(handleOf);
    for (const h of hs) kinds.set(h, kind);
    return formatList(hs);
  };
  /** Turn handle/path arguments (each possibly a list) into absolute paths. */
  const toPaths = (values: string[]): string[] =>
    values.flatMap((v) => splitList(v)).map((h) => (h.startsWith('/') ? normalizePath(h) : model.resolve(h)));

  // ---------------------------------------------------------------- design / scope

  r('create_bd_design', (_it, args) => {
    const { pos } = parseOptions(args);
    model.designName = pos[0] ?? model.designName;
    return model.designName;
  });
  r('current_bd_design', () => model.designName);
  r('current_bd_instance', (_it, args, ctx) => {
    const { pos } = parseOptions(args);
    const target = pos[0];
    if (target !== undefined && target !== '.') {
      const path = target === '' || target === '/' ? '' : toPaths([target])[0] ?? '';
      if (model.isHier(path)) model.scope = path;
      else model.diag('warning', `current_bd_instance: "${target}" is not a hierarchical cell.`, loc(ctx));
    }
    return give([model.scope], 'cell');
  });

  // ---------------------------------------------------------------- creation

  r('create_bd_cell', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    const type = opts.get('type');
    const vlnv = opts.get('vlnv');
    const reference = opts.get('reference');
    let kind: CellKind;
    if (type === 'hier') kind = 'hier';
    else if (type === 'module') kind = 'module';
    else if (type === 'ip' || type === 'inline_hdl' || (!type && vlnv)) kind = 'ip';
    else if (!type && reference) kind = 'module';
    else kind = 'unknown';
    const name = pos[0];
    if (!name) {
      model.diag('warning', 'create_bd_cell without a cell name is ignored.', loc(ctx));
      return '';
    }
    return give([model.createCell(name, kind, { vlnv, reference }, loc(ctx))], 'cell');
  });

  const pinSpec = (args: string[]) => {
    const { opts, pos } = parseOptions(args);
    const num = (k: string) => {
      const v = opts.get(k);
      return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined;
    };
    const dir = opts.get('dir');
    const freq = opts.get('freq_hz');
    return {
      name: pos[0] ?? '',
      dir: dir === 'I' || dir === 'O' || dir === 'IO' ? (dir as PinDirection) : undefined,
      type: opts.get('type'),
      from: num('from'),
      to: num('to'),
      properties: freq !== undefined ? { 'CONFIG.FREQ_HZ': freq } : undefined,
      mode: opts.get('mode'),
      vlnv: opts.get('vlnv'),
    };
  };

  r('create_bd_pin', (_it, args, ctx) => {
    const spec = pinSpec(args);
    const path = spec.name ? model.createPin(model.scope, spec, loc(ctx)) : undefined;
    return path ? give([path], 'pin') : '';
  });
  r('create_bd_intf_pin', (_it, args, ctx) => {
    const spec = pinSpec(args);
    const path = spec.name ? model.createIntfPin(model.scope, spec, loc(ctx)) : undefined;
    return path ? give([path], 'intfPin') : '';
  });
  r('create_bd_port', (_it, args, ctx) => {
    const spec = pinSpec(args);
    return spec.name ? give([model.createPort(spec, loc(ctx))], 'port') : '';
  });
  r('create_bd_intf_port', (_it, args, ctx) => {
    const spec = pinSpec(args);
    return spec.name ? give([model.createIntfPort(spec, loc(ctx))], 'intfPort') : '';
  });

  // ---------------------------------------------------------------- queries

  r('get_bd_cells', (_it, args) => {
    const { pos } = parseOptions(args);
    const patterns = pos.flatMap((p) => (p === '' ? [''] : splitList(p)));
    if (pos.length === 0) return give(model.cellPaths().filter((p) => parentPath(p) === model.scope), 'cell');
    const out: string[] = [];
    for (const p of patterns) {
      if (p === '' || p === '/') {
        out.push('');
        continue;
      }
      const path = p.startsWith('/') ? normalizePath(p) : model.resolve(p);
      if (hasGlob(path)) {
        const re = pathGlob(path);
        out.push(...model.cellPaths().filter((c) => re.test(c)));
      } else if (model.getCell(path)) out.push(path);
    }
    return give(out, 'cell');
  });
  r('get_bd_pins', (_it, args) => give(toPaths(parseOptions(args).pos), 'pin'));
  r('get_bd_intf_pins', (_it, args) => give(toPaths(parseOptions(args).pos), 'intfPin'));
  const portPaths = (args: string[]) => parseOptions(args).pos.flatMap((v) => splitList(v)).map(normalizePath);
  r('get_bd_ports', (_it, args) => give(portPaths(args), 'port'));
  r('get_bd_intf_ports', (_it, args) => give(portPaths(args), 'intfPort'));
  r('get_bd_nets', (_it, args) => give(toPaths(parseOptions(args).pos), 'net'));
  r('get_bd_intf_nets', (_it, args) => give(toPaths(parseOptions(args).pos), 'net'));
  r('get_bd_addr_spaces', (_it, args) => give(toPaths(parseOptions(args).pos), 'addr'));
  r('get_bd_addr_segs', (_it, args) => give(toPaths(parseOptions(args).pos), 'addr'));
  r('get_property', (_it, args) => {
    const { pos } = parseOptions(args);
    const obj = splitList(pos[1] ?? '')[0];
    if (pos[0] === undefined || obj === undefined) return '';
    return model.getProperty(obj.startsWith('/') ? normalizePath(obj) : model.resolve(obj), pos[0]);
  });

  // ---------------------------------------------------------------- connectivity

  r('connect_bd_net', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    model.connect('signal', opts.get('net'), toPaths(pos), loc(ctx));
    return '';
  });
  r('connect_bd_intf_net', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    model.connect('interface', opts.get('intf_net'), toPaths(pos), loc(ctx));
    return '';
  });

  // ---------------------------------------------------------------- properties

  r('set_property', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    let props: [string, string][];
    let objects: string;
    const dict = opts.get('dict');
    if (dict !== undefined) {
      const items = splitList(dict);
      props = [];
      for (let i = 0; i + 1 < items.length; i += 2) props.push([items[i], items[i + 1]]);
      objects = pos[0] ?? '';
    } else {
      if (pos.length < 3) return '';
      props = [[pos[0], pos[1]]];
      objects = pos[2];
    }
    for (const [k, v] of props) if (k.toUpperCase() === 'BOARD_PART') model.tool.board = v;
    for (const h of splitList(objects)) {
      const path = h.startsWith('/') ? normalizePath(h) : model.resolve(h);
      let kind = kinds.get(h);
      if (!kind) {
        if (model.getCell(path)) kind = 'cell';
        else if (model.hasPort(path)) kind = 'port';
        else if (model.hasIntfPort(path)) kind = 'intfPort';
        else kind = 'other';
      }
      if (kind === 'net' || kind === 'addr' || kind === 'other' || (kind === 'cell' && path === '')) continue;
      if (!model.setProperties({ kind, path }, props, loc(ctx))) {
        model.diag('warning', `set_property: target "${h}" does not exist.`, loc(ctx));
      }
    }
    return '';
  });

  // ---------------------------------------------------------------- addressing

  r('assign_bd_address', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    const space = opts.get('target_address_space');
    if (space === undefined) return ''; // automatic assignment: nothing to record
    const masterSpace = toPaths([space])[0] ?? '';
    const segs = toPaths(pos.length ? pos : opts.has('target') ? [opts.get('target') ?? ''] : []);
    for (const slaveSegment of segs) {
      model.addAddress({
        masterSpace,
        slaveSegment,
        ...(opts.has('offset') ? { offset: opts.get('offset') } : {}),
        ...(opts.has('range') ? { range: opts.get('range') } : {}),
        loc: loc(ctx),
      });
    }
    return '';
  });
  r('create_bd_addr_seg', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    const [space, seg] = toPaths(pos.slice(0, 2));
    if (space !== undefined && seg !== undefined) {
      model.addAddress({
        masterSpace: space,
        slaveSegment: seg,
        ...(opts.has('offset') ? { offset: opts.get('offset') } : {}),
        ...(opts.has('range') ? { range: opts.get('range') } : {}),
        loc: loc(ctx),
      });
    }
    return pos[2] ?? '';
  });

  // ---------------------------------------------------------------- project / environment stubs

  r('version', (it, args) => (args.includes('-short') ? (it.getGlobal('scripts_vivado_version') ?? '0000.0') : 'Vivado'));
  r('create_project', (_it, args) => {
    const { opts, pos } = parseOptions(args);
    if (opts.has('part')) model.tool.part = opts.get('part');
    return pos[0] ?? '';
  });
  r('set_part', (_it, args) => {
    model.tool.part = parseOptions(args).pos[0];
    return '';
  });
  r('current_project', () => 'project_1');
  r('get_ipdefs', (_it, args) => formatList(parseOptions(args).pos)); // every IP "exists"
  r('can_resolve_reference', () => '1'); // every module reference "exists"
  r('common::send_gid_msg', (_it, args, ctx) => {
    const { opts, pos } = parseOptions(args);
    if ((opts.get('severity') ?? '').toUpperCase() === 'ERROR') {
      model.diag('error', (pos[pos.length - 1] ?? '').trim(), loc(ctx));
    }
    return '';
  });
  for (const name of ['get_projects', 'get_bd_designs', 'get_files']) r(name, () => '');
  for (const name of [
    'validate_bd_design', 'save_bd_design', 'regenerate_bd_layout', 'close_bd_design', 'open_bd_design',
    'exclude_bd_addr_seg', 'include_bd_addr_seg', 'update_compile_order', 'make_wrapper', 'add_files',
    'import_files', 'set_msg_config', 'update_ip_catalog', 'set_param',
  ]) {
    r(name, () => '');
  }

  interp.unknown = (_it, _args, ctx) => {
    if (!unknownSeen.has(ctx.name)) {
      unknownSeen.add(ctx.name);
      model.diag('info', `Unsupported command "${ctx.name}" ignored.`, loc(ctx));
    }
    return '';
  };
}
