/**
 * Tcl `expr` evaluator.
 *
 * The expression is parsed into a small AST first (operands keep their
 * unevaluated `$var` / `[cmd]` parts) and then evaluated, so `&&`, `||` and
 * `?:` short-circuit exactly like Tcl. All values are strings; numeric
 * operators convert on demand.
 */
import { TclError } from './errors';
import { Parser, type Part } from './tokenizer';

export interface ExprHost {
  /** Substitute variables / command results inside an operand. */
  substParts(parts: Part[]): string;
}

type Node =
  | { t: 'lit'; v: string }
  | { t: 'parts'; parts: Part[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'tern'; c: Node; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

const BINARY_LEVELS: string[][] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['in', 'ni'],
  ['eq', 'ne'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

const SYMBOL_OPS = ['||', '&&', '==', '!=', '<=', '>=', '<<', '>>', '**', '|', '^', '&', '<', '>', '+', '-', '*', '/', '%', '!', '~', '?', ':', '(', ')', ','];
const WORD_OPS = ['eq', 'ne', 'in', 'ni'];
const NUMBER = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/;

class ExprParser {
  private readonly p: Parser;

  constructor(src: string, baseLine: number) {
    this.p = new Parser(src, baseLine);
  }

  parse(): Node {
    const n = this.ternary();
    this.skip();
    if (!this.p.eof) throw new TclError(`syntax error in expression near "${this.p.src.slice(this.p.pos, this.p.pos + 20)}"`);
    return n;
  }

  private skip(): void {
    const s = this.p.src;
    while (this.p.pos < s.length) {
      const c = s[this.p.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.p.pos++;
      else if (c === '\\' && s[this.p.pos + 1] === '\n') this.p.pos += 2;
      else break;
    }
  }

  /** Peek the next operator token without consuming it. */
  private peekOp(): string | undefined {
    this.skip();
    const s = this.p.src;
    const pos = this.p.pos;
    for (const w of WORD_OPS) {
      if (s.startsWith(w, pos) && !/[A-Za-z0-9_]/.test(s[pos + w.length] ?? '')) return w;
    }
    for (const op of SYMBOL_OPS) if (s.startsWith(op, pos)) return op;
    return undefined;
  }

  private take(op: string): boolean {
    if (this.peekOp() === op) {
      this.p.pos += op.length;
      return true;
    }
    return false;
  }

  private ternary(): Node {
    const c = this.binary(0);
    if (this.take('?')) {
      const a = this.ternary();
      if (!this.take(':')) throw new TclError('missing ":" in ternary expression');
      const b = this.ternary();
      return { t: 'tern', c, a, b };
    }
    return c;
  }

  private binary(level: number): Node {
    if (level >= BINARY_LEVELS.length) return this.power();
    let left = this.binary(level + 1);
    for (;;) {
      const op = this.peekOp();
      // Avoid treating the first char of `&&`/`||` as bitwise ops (peekOp already prefers longest).
      if (!op || !BINARY_LEVELS[level].includes(op)) return left;
      this.p.pos += op.length;
      const right = this.binary(level + 1);
      left = { t: 'bin', op, a: left, b: right };
    }
  }

  private power(): Node {
    const base = this.unary();
    if (this.take('**')) return { t: 'bin', op: '**', a: base, b: this.power() };
    return base;
  }

  private unary(): Node {
    const op = this.peekOp();
    if (op === '!' || op === '-' || op === '+' || op === '~') {
      this.p.pos += 1;
      return { t: 'un', op, a: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    this.skip();
    const s = this.p.src;
    const c = s[this.p.pos];
    if (c === undefined) throw new TclError('unexpected end of expression');
    if (c === '(') {
      this.p.pos++;
      const n = this.ternary();
      if (!this.take(')')) throw new TclError('missing ")" in expression');
      return n;
    }
    if (c === '$') return { t: 'parts', parts: [this.p.parseVariable()] };
    if (c === '[') return { t: 'parts', parts: [this.p.parseCommandSubst()] };
    if (c === '"') return { t: 'parts', parts: this.p.parseQuoted() };
    if (c === '{') return { t: 'lit', v: this.p.parseBraced() };
    const num = NUMBER.exec(s.slice(this.p.pos, this.p.pos + 64));
    if (num) {
      this.p.pos += num[0].length;
      return { t: 'lit', v: num[0] };
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.p.pos, this.p.pos + 64));
    if (id) {
      this.p.pos += id[0].length;
      if (this.take('(')) {
        const args: Node[] = [];
        if (!this.take(')')) {
          do args.push(this.ternary());
          while (this.take(','));
          if (!this.take(')')) throw new TclError(`missing ")" after arguments to ${id[0]}()`);
        }
        return { t: 'call', fn: id[0], args };
      }
      if (parseBool(id[0]) !== undefined) return { t: 'lit', v: id[0] };
      throw new TclError(`invalid bareword "${id[0]}" in expression`);
    }
    throw new TclError(`syntax error in expression near "${s.slice(this.p.pos, this.p.pos + 20)}"`);
  }
}

// ---------------------------------------------------------------- values

function parseBool(s: string): boolean | undefined {
  switch (s.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

function parseNumber(s: string): number | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)$/.exec(t);
  if (m) {
    const body = m[2];
    const radix = /[xX]/.test(body[1]) ? 16 : /[bB]/.test(body[1]) ? 2 : 8;
    const v = parseInt(body.slice(2), radix);
    return m[1] === '-' ? -v : v;
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return undefined;
}

function isIntegerLiteral(s: string): boolean {
  return /^\s*[+-]?(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)\s*$/.test(s);
}

function formatNumber(n: number, integer: boolean): string {
  if (integer) return String(Math.trunc(n));
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  return String(n);
}

export function truthy(v: string): boolean {
  const n = parseNumber(v);
  if (n !== undefined) return n !== 0;
  const b = parseBool(v);
  if (b !== undefined) return b;
  throw new TclError(`expected boolean value but got "${v}"`);
}

function num(v: string): number {
  const n = parseNumber(v);
  if (n === undefined) throw new TclError(`can't use non-numeric string "${v}" as operand`);
  return n;
}

function compare(a: string, b: string): number {
  const x = parseNumber(a);
  const y = parseNumber(b);
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

const b2s = (b: boolean): string => (b ? '1' : '0');

function arith(op: string, a: string, b: string): string {
  const x = num(a);
  const y = num(b);
  const ints = isIntegerLiteral(a) && isIntegerLiteral(b);
  switch (op) {
    case '+':
      return formatNumber(x + y, ints);
    case '-':
      return formatNumber(x - y, ints);
    case '*':
      return formatNumber(x * y, ints);
    case '/':
      if (y === 0 && ints) throw new TclError('divide by zero');
      return formatNumber(ints ? Math.floor(x / y) : x / y, ints);
    case '%':
      if (y === 0) throw new TclError('divide by zero');
      return formatNumber(((x % y) + y) % y, true);
    case '**':
      return formatNumber(x ** y, ints);
    case '&':
      return String(x & y);
    case '|':
      return String(x | y);
    case '^':
      return String(x ^ y);
    case '<<':
      return String(x << y);
    case '>>':
      return String(x >> y);
    default:
      throw new TclError(`unsupported operator "${op}"`);
  }
}

function evalNode(n: Node, host: ExprHost): string {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'parts':
      return host.substParts(n.parts);
    case 'un': {
      const v = evalNode(n.a, host);
      if (n.op === '!') return b2s(!truthy(v));
      if (n.op === '~') return String(~num(v));
      if (n.op === '-') return formatNumber(-num(v), isIntegerLiteral(v));
      return formatNumber(num(v), isIntegerLiteral(v));
    }
    case 'tern':
      return truthy(evalNode(n.c, host)) ? evalNode(n.a, host) : evalNode(n.b, host);
    case 'call':
      return callFn(n.fn, n.args.map((a) => evalNode(a, host)));
    case 'bin': {
      if (n.op === '&&') return b2s(truthy(evalNode(n.a, host)) && truthy(evalNode(n.b, host)));
      if (n.op === '||') return b2s(truthy(evalNode(n.a, host)) || truthy(evalNode(n.b, host)));
      const a = evalNode(n.a, host);
      const b = evalNode(n.b, host);
      switch (n.op) {
        case 'eq':
          return b2s(a === b);
        case 'ne':
          return b2s(a !== b);
        case '==':
          return b2s(compare(a, b) === 0);
        case '!=':
          return b2s(compare(a, b) !== 0);
        case '<':
          return b2s(compare(a, b) < 0);
        case '>':
          return b2s(compare(a, b) > 0);
        case '<=':
          return b2s(compare(a, b) <= 0);
        case '>=':
          return b2s(compare(a, b) >= 0);
        case 'in':
        case 'ni': {
          const found = b.split(/\s+/).includes(a);
          return b2s(n.op === 'in' ? found : !found);
        }
        default:
          return arith(n.op, a, b);
      }
    }
  }
}

function callFn(fn: string, args: string[]): string {
  const x = args.map(num);
  switch (fn) {
    case 'abs':
      return formatNumber(Math.abs(x[0]), isIntegerLiteral(args[0]));
    case 'int':
    case 'wide':
    case 'entier':
      return String(Math.trunc(x[0]));
    case 'double':
      return formatNumber(x[0], false);
    case 'round':
      return String(Math.round(x[0]));
    case 'min':
      return args[x.indexOf(Math.min(...x))];
    case 'max':
      return args[x.indexOf(Math.max(...x))];
    case 'bool':
      return b2s(truthy(args[0]));
    default:
      throw new TclError(`unknown math function "${fn}"`);
  }
}

/** Evaluate a Tcl expression string. Throws `TclError` on syntax / type errors. */
export function evalExpr(src: string, baseLine: number, host: ExprHost): string {
  return evalNode(new ExprParser(src, baseLine).parse(), host);
}
