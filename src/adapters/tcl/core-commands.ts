/**
 * Core Tcl language commands: the subset that generated block-design scripts
 * (and simple hand-written ones) rely on.
 */
import { BreakSignal, ContinueSignal, ReturnSignal, TclError } from './errors';
import { truthy } from './expr';
import { bodyArg, type CallContext, type Interp } from './interpreter';
import { formatList, splitList } from './lists';

function wrongArgs(usage: string): TclError {
  return new TclError(`wrong # args: should be "${usage}"`);
}

/** Convert a glob pattern (`*`, `?`, `[...]`) to an anchored RegExp. */
export function globToRegExp(pattern: string, nocase = false): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '\\' && i + 1 < pattern.length) re += `\\${pattern[++i]}`;
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) re += '\\[';
      else {
        re += `[${pattern.slice(i + 1, close).replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, nocase ? 'is' : 's');
}

/** Run a loop body, translating break/continue. Returns false on break. */
function runLoopBody(interp: Interp, body: { text: string; line: number }): boolean {
  try {
    interp.evalBody(body);
  } catch (e) {
    if (e instanceof BreakSignal) return false;
    if (e instanceof ContinueSignal) return true;
    throw e;
  }
  return true;
}

function cmdIf(interp: Interp, args: string[], ctx: CallContext): string {
  let i = 0;
  for (;;) {
    if (i >= args.length) throw wrongArgs('if expr ?then? body ?elseif expr body ...? ?else body?');
    const cond = bodyArg(args, ctx, i);
    let ok: boolean;
    try {
      ok = truthy(interp.evalExpr(cond.text, cond.line));
    } catch (e) {
      if (!(e instanceof TclError)) throw e;
      interp.report({
        severity: 'warning',
        message: `Could not evaluate "if" condition (${e.message}); treated as false.`,
        line: cond.line,
      });
      ok = false;
    }
    i++;
    if (args[i] === 'then') i++;
    if (i >= args.length) throw wrongArgs('if expr ?then? body');
    if (ok) return interp.evalBody(bodyArg(args, ctx, i));
    i++;
    if (i >= args.length) return '';
    if (args[i] === 'elseif') {
      i++;
      continue;
    }
    if (args[i] === 'else') i++;
    if (i >= args.length) throw wrongArgs('if expr body else body');
    return interp.evalBody(bodyArg(args, ctx, i));
  }
}

function cmdCatch(interp: Interp, args: string[], ctx: CallContext): string {
  if (args.length < 1) throw wrongArgs('catch script ?resultVarName? ?optionVarName?');
  let code = 0;
  let result = '';
  try {
    result = interp.evalBody(bodyArg(args, ctx, 0));
  } catch (e) {
    if (e instanceof TclError) {
      code = 1;
      result = e.message;
    } else if (e instanceof ReturnSignal) {
      code = 2;
      result = e.value;
    } else if (e instanceof BreakSignal) code = 3;
    else if (e instanceof ContinueSignal) code = 4;
    else throw e; // fatal errors and host bugs are not catchable
  }
  if (args.length >= 2) interp.setVar(args[1], result);
  return String(code);
}

function cmdProc(interp: Interp, args: string[], ctx: CallContext): string {
  if (args.length !== 3) throw wrongArgs('proc name args body');
  const params = splitList(args[1]).map((p) => {
    const parts = splitList(p);
    return { name: parts[0] ?? '', def: parts.length > 1 ? parts[1] : undefined };
  });
  const bare = args[0].replace(/^::/, '');
  const ns = interp.currentNamespace;
  const name = ns && !bare.includes('::') ? `${ns}::${bare}` : bare;
  const body = bodyArg(args, ctx, 2);
  interp.procs.set(name, { name, params, body: body.text, bodyLine: body.line });
  return '';
}

function cmdForeach(interp: Interp, args: string[], ctx: CallContext): string {
  if (args.length < 3 || args.length % 2 !== 1) throw wrongArgs('foreach varList list ?varList list ...? command');
  const pairs: { vars: string[]; items: string[] }[] = [];
  for (let i = 0; i < args.length - 1; i += 2) pairs.push({ vars: splitList(args[i]), items: splitList(args[i + 1]) });
  const iterations = Math.max(...pairs.map((p) => Math.ceil(p.items.length / Math.max(1, p.vars.length))));
  const body = bodyArg(args, ctx, args.length - 1);
  for (let n = 0; n < iterations; n++) {
    for (const p of pairs) p.vars.forEach((v, k) => interp.setVar(v, p.items[n * p.vars.length + k] ?? ''));
    if (!runLoopBody(interp, body)) break;
  }
  return '';
}

function cmdWhile(interp: Interp, args: string[], ctx: CallContext): string {
  if (args.length !== 2) throw wrongArgs('while test command');
  const test = bodyArg(args, ctx, 0);
  const body = bodyArg(args, ctx, 1);
  while (truthy(interp.evalExpr(test.text, test.line))) if (!runLoopBody(interp, body)) break;
  return '';
}

function cmdFor(interp: Interp, args: string[], ctx: CallContext): string {
  if (args.length !== 4) throw wrongArgs('for start test next command');
  interp.evalBody(bodyArg(args, ctx, 0));
  const test = bodyArg(args, ctx, 1);
  const next = bodyArg(args, ctx, 2);
  const body = bodyArg(args, ctx, 3);
  while (truthy(interp.evalExpr(test.text, test.line))) {
    if (!runLoopBody(interp, body)) break;
    interp.evalBody(next);
  }
  return '';
}

function cmdString(_interp: Interp, args: string[]): string {
  const [sub, ...rest] = args;
  const flags = new Set<string>(rest.filter((a) => a === '-nocase' || a === '-length'));
  const a = rest.filter((x) => !flags.has(x));
  switch (sub) {
    case 'first':
      return String(a[1]?.indexOf(a[0] ?? '', Number(a[2] ?? 0)) ?? -1);
    case 'last':
      return String(a[1]?.lastIndexOf(a[0] ?? '') ?? -1);
    case 'compare': {
      let x = a[0] ?? '';
      let y = a[1] ?? '';
      if (flags.has('-nocase')) {
        x = x.toLowerCase();
        y = y.toLowerCase();
      }
      return x < y ? '-1' : x > y ? '1' : '0';
    }
    case 'equal':
      return flags.has('-nocase') ? String(Number((a[0] ?? '').toLowerCase() === (a[1] ?? '').toLowerCase())) : String(Number(a[0] === a[1]));
    case 'length':
      return String((a[0] ?? '').length);
    case 'tolower':
      return (a[0] ?? '').toLowerCase();
    case 'toupper':
      return (a[0] ?? '').toUpperCase();
    case 'trim':
    case 'trimleft':
    case 'trimright': {
      const s = a[0] ?? '';
      const chars = a[1] ?? ' \t\n\r';
      let lo = 0;
      let hi = s.length;
      if (sub !== 'trimright') while (lo < hi && chars.includes(s[lo])) lo++;
      if (sub !== 'trimleft') while (hi > lo && chars.includes(s[hi - 1])) hi--;
      return s.slice(lo, hi);
    }
    case 'match':
      return String(Number(globToRegExp(a[0] ?? '', flags.has('-nocase')).test(a[1] ?? '')));
    case 'range': {
      const s = a[0] ?? '';
      const from = a[1] === 'end' ? s.length - 1 : Number(a[1]);
      const to = a[2] === 'end' ? s.length - 1 : Number(a[2]);
      return s.slice(Math.max(0, from), to + 1);
    }
    case 'index': {
      const s = a[0] ?? '';
      const i = a[1] === 'end' ? s.length - 1 : Number(a[1]);
      return s[i] ?? '';
    }
    case 'map': {
      const pairs = splitList(a[0] ?? '');
      let s = a[1] ?? '';
      for (let i = 0; i + 1 < pairs.length; i += 2) s = s.split(pairs[i]).join(pairs[i + 1]);
      return s;
    }
    default:
      throw new TclError(`unsupported "string ${sub ?? ''}" subcommand`);
  }
}

function cmdFile(_interp: Interp, args: string[]): string {
  const [sub, ...a] = args;
  const p = a[0] ?? '';
  switch (sub) {
    case 'normalize':
      return p;
    case 'dirname': {
      const i = p.lastIndexOf('/');
      return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i);
    }
    case 'tail':
      return p.slice(p.lastIndexOf('/') + 1);
    case 'join':
      return a.reduce((acc, x) => (x.startsWith('/') || !acc ? x : `${acc.replace(/\/$/, '')}/${x}`), '');
    case 'rootname': {
      const dot = p.lastIndexOf('.');
      return dot > p.lastIndexOf('/') ? p.slice(0, dot) : p;
    }
    case 'extension': {
      const dot = p.lastIndexOf('.');
      return dot > p.lastIndexOf('/') ? p.slice(dot) : '';
    }
    case 'exists':
    case 'isfile':
    case 'isdirectory':
    case 'readable':
    case 'writable':
      return '0';
    default:
      return '';
  }
}

function cmdLindex(_interp: Interp, args: string[]): string {
  let v = args[0] ?? '';
  for (const idx of args.slice(1)) {
    const items = splitList(v);
    const i = idx === 'end' ? items.length - 1 : /^end-\d+$/.test(idx) ? items.length - 1 - Number(idx.slice(4)) : Number(idx);
    v = items[i] ?? '';
  }
  return v;
}

export function registerCoreCommands(interp: Interp, scriptName = ''): void {
  const r = interp.register.bind(interp);

  r('set', (it, a) => {
    if (a.length === 1) return it.getVar(a[0]);
    if (a.length === 2) return it.setVar(a[0], a[1]);
    throw wrongArgs('set varName ?newValue?');
  });
  r('unset', (it, a) => {
    for (const n of a) if (!n.startsWith('-')) it.unsetVar(n);
    return '';
  });
  r('append', (it, a) => it.setVar(a[0], (it.hasVar(a[0]) ? it.getVar(a[0]) : '') + a.slice(1).join('')));
  r('incr', (it, a) => it.setVar(a[0], String(Number(it.hasVar(a[0]) ? it.getVar(a[0]) : 0) + Number(a[1] ?? 1))));
  r('list', (_it, a) => formatList(a));
  r('lappend', (it, a) => {
    const cur = it.hasVar(a[0]) ? it.getVar(a[0]) : '';
    const add = formatList(a.slice(1));
    return it.setVar(a[0], cur && add ? `${cur} ${add}` : cur || add);
  });
  r('llength', (_it, a) => String(splitList(a[0] ?? '').length));
  r('lindex', cmdLindex);
  r('lrange', (_it, a) => {
    const items = splitList(a[0] ?? '');
    const from = a[1] === 'end' ? items.length - 1 : Number(a[1]);
    const to = a[2] === 'end' ? items.length - 1 : Number(a[2]);
    return formatList(items.slice(Math.max(0, from), to + 1));
  });
  r('concat', (_it, a) => a.map((x) => x.trim()).filter(Boolean).join(' '));
  r('join', (_it, a) => splitList(a[0] ?? '').join(a[1] ?? ' '));
  r('split', (_it, a) => formatList((a[0] ?? '').split(a.length > 1 ? new RegExp(`[${(a[1] ?? '').replace(/[\]\\^-]/g, '\\$&')}]`) : /\s/)));
  r('expr', (it, a, ctx) => {
    const single = a.length === 1 ? bodyArg(a, ctx, 0) : { text: a.join(' '), line: ctx.line };
    return it.evalExpr(single.text, single.line);
  });
  r('if', cmdIf);
  r('catch', cmdCatch);
  r('proc', cmdProc);
  r('foreach', cmdForeach);
  r('while', cmdWhile);
  r('for', cmdFor);
  r('break', () => {
    throw new BreakSignal();
  });
  r('continue', () => {
    throw new ContinueSignal();
  });
  r('return', (_it, a, ctx) => {
    // Options such as `-code ok` are accepted and ignored.
    let i = 0;
    while (i + 1 < a.length && a[i].startsWith('-')) i += 2;
    throw new ReturnSignal(a[i] ?? '', ctx.line);
  });
  r('error', (_it, a) => {
    throw new TclError(a[0] ?? 'error');
  });
  r('eval', (it, a, ctx) => it.evalBody(a.length === 1 ? bodyArg(a, ctx, 0) : { text: a.join(' '), line: ctx.line }));
  r('variable', (it, a) => {
    const ns = it.currentNamespace;
    for (let i = 0; i < a.length; i += 2) {
      const name = a[i];
      const qualified = name.includes('::') ? name : ns ? `${ns}::${name}` : name;
      it.linkGlobal(name.replace(/^.*::/, ''), qualified);
      if (i + 1 < a.length) it.setVar(qualified, a[i + 1]);
    }
    return '';
  });
  r('global', (it, a) => {
    for (const name of a) it.linkGlobal(name, name);
    return '';
  });
  r('namespace', (it, a, ctx) => {
    const sub = a[0];
    if (sub === 'eval' && a.length >= 3) {
      const ns = a[1].replace(/^::/, '');
      it.nsStack.push(ns);
      try {
        return it.evalBody(a.length === 3 ? bodyArg(a, ctx, 2) : { text: a.slice(2).join(' '), line: ctx.line });
      } finally {
        it.nsStack.pop();
      }
    }
    if (sub === 'current') return `::${it.currentNamespace}`;
    return '';
  });
  r('info', (it, a) => {
    switch (a[0]) {
      case 'exists':
        return it.hasVar(a[1] ?? '') ? '1' : '0';
      case 'script':
        return scriptName;
      case 'level':
        return String(it.depth);
      case 'procs':
        return formatList([...it.procs.keys()]);
      default:
        return '';
    }
  });
  r('string', cmdString);
  r('file', cmdFile);
  r('puts', () => '');
  r('format', (_it, a) => {
    let i = 1;
    return (a[0] ?? '').replace(/%[-+ 0#]*\d*(?:\.\d+)?[sdixXf%]/g, (spec) => (spec === '%%' ? '%' : (a[i++] ?? '')));
  });
  // Approximation: evaluates in the current frame (generated scripts never use it).
  r('uplevel', (it, a, ctx) => (a.length ? it.evalBody(bodyArg(a, ctx, a.length - 1)) : ''));
}
