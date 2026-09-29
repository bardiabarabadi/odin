/**
 * A small, sandboxed Tcl interpreter.
 *
 * It evaluates parsed commands (see `tokenizer.ts`) against a table of
 * command implementations. There is no I/O: commands are plain functions that
 * a host registers (`core-commands.ts` for the language, `bd-commands.ts` for
 * Vivado block-design commands). Unknown commands are routed to an
 * `unknown` hook instead of failing.
 */
import type { DiagnosticSeverity } from '../../model/types';
import { BreakSignal, ContinueSignal, ReturnSignal, TclError, TclFatalError } from './errors';
import { evalExpr } from './expr';
import { formatList, splitList } from './lists';
import { parseScript, TclSyntaxError, type Command, type Part } from './tokenizer';

/** Per-invocation information handed to command implementations. */
export interface CallContext {
  /** Command name as invoked. */
  name: string;
  /** 1-based first / last source line of the invoking command. */
  line: number;
  endLine: number;
  /** Source line where each argument word starts (aligned with `args`). */
  argLines: number[];
  /**
   * Raw text of arguments that were literal braced words (aligned with
   * `args`), used to evaluate script bodies with exact line numbers.
   */
  argRaw: (string | undefined)[];
}

export type CommandFn = (interp: Interp, args: string[], ctx: CallContext) => string;

export interface Proc {
  name: string;
  params: { name: string; def?: string }[];
  body: string;
  bodyLine: number;
}

interface Frame {
  vars: Map<string, string>;
  /** Local name -> name of a global (namespace) variable. */
  links: Map<string, string>;
}

export interface InterpDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line?: number;
  endLine?: number;
}

export interface InterpOptions {
  /** Maximum number of commands evaluated before aborting. */
  maxSteps?: number;
  maxDepth?: number;
  /** Receives interpreter-level diagnostics. */
  report?: (d: InterpDiagnostic) => void;
}

/** A script body argument: its text plus the line it starts on. */
export interface Body {
  text: string;
  line: number;
}

export function bodyArg(args: string[], ctx: CallContext, i: number): Body {
  return { text: ctx.argRaw[i] ?? args[i], line: ctx.argLines[i] ?? ctx.line };
}

export class Interp {
  readonly commands = new Map<string, CommandFn>();
  readonly procs = new Map<string, Proc>();
  /** Namespace stack for `namespace eval`; `''` is the global namespace. */
  readonly nsStack: string[] = [''];
  /** Hook for commands that are neither built in nor procs. */
  unknown: CommandFn = () => '';

  private readonly frames: Frame[] = [{ vars: new Map(), links: new Map() }];
  private readonly parseCache = new Map<string, Command[]>();
  private steps = 0;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  private readonly reportFn: (d: InterpDiagnostic) => void;

  constructor(opts: InterpOptions = {}) {
    this.maxSteps = opts.maxSteps ?? 5_000_000;
    this.maxDepth = opts.maxDepth ?? 500;
    this.reportFn = opts.report ?? (() => undefined);
  }

  report(d: InterpDiagnostic): void {
    this.reportFn(d);
  }

  register(name: string, fn: CommandFn): void {
    this.commands.set(name, fn);
  }

  get depth(): number {
    return this.frames.length - 1;
  }

  get currentNamespace(): string {
    return this.nsStack[this.nsStack.length - 1];
  }

  // ------------------------------------------------------------ variables

  private get frame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  private get globals(): Frame {
    return this.frames[0];
  }

  /** Resolve a variable name to the frame + key that stores it. */
  private locate(name: string): [Frame, string] {
    if (name.includes('::')) return [this.globals, name.replace(/^::/, '')];
    const f = this.frame;
    const link = f.links.get(name);
    if (link !== undefined) return [this.globals, link];
    if (f === this.globals) {
      const ns = this.currentNamespace;
      if (ns && !this.globals.vars.has(name)) {
        const qualified = `${ns}::${name}`;
        if (this.globals.vars.has(qualified)) return [this.globals, qualified];
      }
    }
    return [f, name];
  }

  getVar(name: string): string {
    const [f, key] = this.locate(name);
    const v = f.vars.get(key);
    if (v === undefined) throw new TclError(`can't read "${name}": no such variable`);
    return v;
  }

  setVar(name: string, value: string): string {
    const [f, key] = this.locate(name);
    f.vars.set(key, value);
    return value;
  }

  unsetVar(name: string): void {
    const [f, key] = this.locate(name);
    f.vars.delete(key);
  }

  hasVar(name: string): boolean {
    const [f, key] = this.locate(name);
    return f.vars.has(key);
  }

  /** Read a global (namespace-level) variable, if set. */
  getGlobal(name: string): string | undefined {
    return this.globals.vars.get(name.replace(/^::/, ''));
  }

  /** Link a local name to a namespace variable (`variable` / `global`). */
  linkGlobal(local: string, qualified: string): void {
    // At namespace level the name already refers to the namespace variable.
    if (this.frame === this.globals) return;
    this.frame.links.set(local, qualified.replace(/^::/, ''));
  }

  // ------------------------------------------------------------ evaluation

  /** Evaluate a script body. Parsed scripts are cached by (line, text). */
  evalBody(body: Body): string {
    return this.evalCommands(this.parse(body.text, body.line));
  }

  parse(text: string, line: number): Command[] {
    const key = `${line}\u0000${text}`;
    let cmds = this.parseCache.get(key);
    if (!cmds) {
      try {
        cmds = parseScript(text, line);
      } catch (e) {
        if (e instanceof TclSyntaxError) throw new TclError(e.message, e.line);
        throw e;
      }
      this.parseCache.set(key, cmds);
    }
    return cmds;
  }

  evalCommands(cmds: Command[]): string {
    let result = '';
    for (const c of cmds) result = this.evalCommand(c);
    return result;
  }

  evalExpr(text: string, line: number): string {
    return evalExpr(text, line, { substParts: (parts) => this.substParts(parts) });
  }

  substParts(parts: Part[]): string {
    if (parts.length === 1 && parts[0].kind === 'text') return parts[0].value;
    let out = '';
    for (const p of parts) {
      if (p.kind === 'text') out += p.value;
      else if (p.kind === 'var') out += this.getVar(p.index ? `${p.name}(${this.substParts(p.index)})` : p.name);
      else out += this.evalCommands(p.script);
    }
    return out;
  }

  evalCommand(cmd: Command): string {
    if (++this.steps > this.maxSteps) throw new TclFatalError('evaluation step limit exceeded', cmd.line);
    try {
      const args: string[] = [];
      const argLines: number[] = [];
      const argRaw: (string | undefined)[] = [];
      for (const w of cmd.words) {
        const v = this.substParts(w.parts);
        if (w.expand) {
          for (const el of splitList(v)) {
            args.push(el);
            argLines.push(w.line);
            argRaw.push(undefined);
          }
        } else {
          args.push(v);
          argLines.push(w.line);
          argRaw.push(w.quoting === 'brace' ? w.raw : undefined);
        }
      }
      if (args.length === 0) return '';
      const name = args[0];
      const ctx: CallContext = {
        name,
        line: cmd.line,
        endLine: cmd.endLine,
        argLines: argLines.slice(1),
        argRaw: argRaw.slice(1),
      };
      return this.invoke(name, args.slice(1), ctx);
    } catch (e) {
      if ((e instanceof TclError || e instanceof TclFatalError) && e.line === undefined) e.line = cmd.line;
      throw e;
    }
  }

  /** Look up a proc by name, honouring the current namespace. */
  findProc(name: string): Proc | undefined {
    const bare = name.replace(/^::/, '');
    const ns = this.currentNamespace;
    return (ns ? this.procs.get(`${ns}::${bare}`) : undefined) ?? this.procs.get(bare);
  }

  invoke(name: string, args: string[], ctx: CallContext): string {
    const bare = name.replace(/^::/, '');
    const proc = this.findProc(bare);
    if (proc) return this.callProc(proc, args, ctx);
    const fn = this.commands.get(bare);
    if (fn) return fn(this, args, ctx);
    return this.unknown(this, args, ctx);
  }

  callProc(proc: Proc, args: string[], ctx: CallContext): string {
    if (this.frames.length > this.maxDepth) throw new TclFatalError('too many nested procedure calls', ctx.line);
    const frame: Frame = { vars: new Map(), links: new Map() };
    const { params } = proc;
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.name === 'args' && i === params.length - 1) {
        frame.vars.set('args', formatList(args.slice(i)));
        break;
      }
      if (i < args.length) frame.vars.set(p.name, args[i]);
      else if (p.def !== undefined) frame.vars.set(p.name, p.def);
      else throw new TclError(`wrong # args: should be "${proc.name} ${params.map((x) => x.name).join(' ')}"`);
    }
    if (args.length > params.length && params[params.length - 1]?.name !== 'args') {
      throw new TclError(`wrong # args: should be "${proc.name} ${params.map((x) => x.name).join(' ')}"`);
    }
    this.frames.push(frame);
    try {
      return this.evalBody({ text: proc.body, line: proc.bodyLine });
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      if (e instanceof BreakSignal || e instanceof ContinueSignal) throw new TclError('invoked "break" or "continue" outside of a loop');
      throw e;
    } finally {
      this.frames.pop();
    }
  }

  /**
   * Run a whole script at top level, one command at a time, so that earlier
   * commands take effect even when a later one fails. Errors are reported,
   * never thrown.
   */
  runScript(text: string): void {
    let cmds: Command[];
    try {
      cmds = parseScript(text, 1);
    } catch (e) {
      const err = e as { message?: string; line?: number };
      this.report({ severity: 'error', message: `Tcl syntax error: ${err.message ?? String(e)}`, line: err.line });
      return;
    }
    for (const c of cmds) {
      try {
        this.evalCommand(c);
      } catch (e) {
        if (e instanceof ReturnSignal) {
          this.report({
            severity: 'warning',
            message: `Script stopped by a top-level "return${e.value ? ` ${e.value}` : ''}"; later commands were not evaluated.`,
            line: e.line,
          });
          return;
        }
        if (e instanceof TclFatalError) {
          this.report({ severity: 'error', message: `Evaluation aborted: ${e.message}`, line: e.line });
          return;
        }
        if (e instanceof TclError) {
          this.report({ severity: 'error', message: `Tcl error: ${e.message}`, line: e.line });
          continue;
        }
        if (e instanceof BreakSignal || e instanceof ContinueSignal) continue;
        const err = e as { message?: string; line?: number };
        this.report({ severity: 'error', message: `Tcl error: ${err.message ?? String(e)}`, line: err.line ?? c.line });
      }
    }
  }
}
