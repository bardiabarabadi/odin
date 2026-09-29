/**
 * Tcl script tokenizer / parser.
 *
 * Turns Tcl source text into a list of `Command`s, each made of `Word`s, each
 * made of `Part`s (literal text, variable references, nested command
 * substitutions). It follows the Tcl "dodekalogue" rules closely enough for
 * machine-generated scripts:
 *
 * - commands are separated by newlines and semicolons;
 * - `#` starts a comment only where a command could start;
 * - `{...}` words are literal (nested braces balanced, `\` escapes skipped);
 * - `"..."` and bare words undergo `$var`, `${var}`, `$ns::var`, `[cmd]` and
 *   backslash substitution;
 * - backslash-newline (plus leading whitespace on the next line) acts as a
 *   single space, i.e. a line continuation;
 * - `{*}` argument expansion.
 *
 * Every command records the 1-based line where it begins and ends. The parser
 * is pure (no I/O) and never evaluates anything.
 */

export type Part =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string; index?: Part[] }
  | { kind: 'cmd'; script: Command[] };

export interface Word {
  parts: Part[];
  /** How the word was quoted in the source. Braced words are fully literal. */
  quoting: 'brace' | 'quote' | 'bare';
  /**
   * For braced words: the raw text between the braces, byte-for-byte, so it
   * can be re-parsed as a script body with correct line numbers.
   */
  raw?: string;
  /** 1-based line of the first character of the word. */
  line: number;
  /** True for `{*}word` (argument expansion). */
  expand: boolean;
}

export interface Command {
  words: Word[];
  line: number;
  endLine: number;
}

export class TclSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'TclSyntaxError';
  }
}

const NAME_CHAR = /[A-Za-z0-9_]/;

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v';
}

export class Parser {
  pos = 0;
  private readonly newlines: number[] = [];

  constructor(
    readonly src: string,
    private readonly baseLine = 1,
  ) {
    for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) this.newlines.push(i);
  }

  /** 1-based line number of a character offset. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.newlines[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return this.baseLine + lo;
  }

  get eof(): boolean {
    return this.pos >= this.src.length;
  }

  /** Parse every command until end of input. */
  parseAll(): Command[] {
    const out: Command[] = [];
    for (let c = this.next(false); c; c = this.next(false)) out.push(c);
    return out;
  }

  /**
   * Parse the next command. Returns `undefined` at end of input, or, when
   * `inBracket`, after consuming the closing `]`.
   */
  next(inBracket: boolean): Command | undefined {
    for (;;) {
      this.skipSeparators();
      if (this.eof) {
        if (inBracket) throw new TclSyntaxError('missing close-bracket', this.lineAt(this.pos));
        return undefined;
      }
      const c = this.src[this.pos];
      if (inBracket && c === ']') {
        this.pos++;
        return undefined;
      }
      if (c === '#') {
        this.skipComment();
        continue;
      }
      const cmd = this.parseCommand(inBracket);
      if (cmd.words.length > 0) return cmd;
    }
  }

  private skipSeparators(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (isSpace(c) || c === '\n' || c === ';') this.pos++;
      else if (c === '\\' && s[this.pos + 1] === '\n') this.pos += 2;
      else break;
    }
  }

  private skipComment(): void {
    const s = this.src;
    while (this.pos < s.length && s[this.pos] !== '\n') {
      if (s[this.pos] === '\\' && this.pos + 1 < s.length) this.pos += 2;
      else this.pos++;
    }
  }

  /** Skip blanks and backslash-newline continuations inside a command. */
  private skipBlanks(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (isSpace(c)) this.pos++;
      else if (c === '\\' && s[this.pos + 1] === '\n') this.pos += 2;
      else break;
    }
  }

  private parseCommand(inBracket: boolean): Command {
    const start = this.pos;
    let end = start;
    const words: Word[] = [];
    for (;;) {
      this.skipBlanks();
      if (this.eof) break;
      const c = this.src[this.pos];
      if (c === '\n' || c === ';' || (inBracket && c === ']')) break;
      words.push(this.parseWord(inBracket));
      end = this.pos;
    }
    return { words, line: this.lineAt(start), endLine: this.lineAt(Math.max(start, end - 1)) };
  }

  private atWordEnd(inBracket: boolean): boolean {
    if (this.eof) return true;
    const c = this.src[this.pos];
    return (
      isSpace(c) ||
      c === '\n' ||
      c === ';' ||
      (inBracket && c === ']') ||
      (c === '\\' && this.src[this.pos + 1] === '\n')
    );
  }

  private parseWord(inBracket: boolean): Word {
    const line = this.lineAt(this.pos);
    let expand = false;
    if (this.src.startsWith('{*}', this.pos)) {
      const after = this.src[this.pos + 3];
      if (after !== undefined && !isSpace(after) && after !== '\n' && after !== ';') {
        expand = true;
        this.pos += 3;
      }
    }
    const c = this.src[this.pos];
    if (c === '{') {
      const raw = this.parseBraced();
      if (this.atWordEnd(inBracket)) {
        return { parts: [{ kind: 'text', value: raw }], quoting: 'brace', raw, line, expand };
      }
      // Lenient: Tcl would report "extra characters after close-brace".
      const parts: Part[] = [{ kind: 'text', value: `{${raw}}` }];
      this.parseBareParts(inBracket, parts);
      return { parts: mergeText(parts), quoting: 'bare', line, expand };
    }
    if (c === '"') {
      const parts = this.parseQuoted();
      if (!this.atWordEnd(inBracket)) this.parseBareParts(inBracket, parts);
      return { parts: mergeText(parts), quoting: 'quote', line, expand };
    }
    const parts: Part[] = [];
    this.parseBareParts(inBracket, parts);
    return { parts: mergeText(parts), quoting: 'bare', line, expand };
  }

  /** Parse `{...}` starting at the open brace; returns the raw inner text. */
  parseBraced(): string {
    const s = this.src;
    const open = this.pos;
    let depth = 1;
    let i = open + 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') i += 2;
      else if (c === '{') {
        depth++;
        i++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          this.pos = i + 1;
          return s.slice(open + 1, i);
        }
        i++;
      } else i++;
    }
    throw new TclSyntaxError('missing close-brace', this.lineAt(open));
  }

  /** Parse `"..."` starting at the open quote. */
  parseQuoted(): Part[] {
    const s = this.src;
    const open = this.pos;
    this.pos++;
    const parts: Part[] = [];
    let text = '';
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '"') {
        this.pos++;
        if (text) parts.push({ kind: 'text', value: text });
        return mergeText(parts);
      }
      if (c === '\\') text += this.parseEscape();
      else if (c === '$' || c === '[') {
        if (text) parts.push({ kind: 'text', value: text });
        text = '';
        parts.push(c === '$' ? this.parseVariable() : this.parseCommandSubst());
      } else {
        text += c;
        this.pos++;
      }
    }
    throw new TclSyntaxError('missing "', this.lineAt(open));
  }

  private parseBareParts(inBracket: boolean, parts: Part[]): void {
    const s = this.src;
    let text = '';
    while (!this.atWordEnd(inBracket)) {
      const c = s[this.pos];
      if (c === '\\') text += this.parseEscape();
      else if (c === '$' || c === '[') {
        if (text) parts.push({ kind: 'text', value: text });
        text = '';
        parts.push(c === '$' ? this.parseVariable() : this.parseCommandSubst());
      } else {
        text += c;
        this.pos++;
      }
    }
    if (text) parts.push({ kind: 'text', value: text });
  }

  /** Parse a backslash sequence starting at `\`; returns its substitution. */
  parseEscape(): string {
    const s = this.src;
    const c = s[this.pos + 1];
    if (c === undefined) {
      this.pos++;
      return '\\';
    }
    this.pos += 2;
    switch (c) {
      case '\n':
        while (this.pos < s.length && (s[this.pos] === ' ' || s[this.pos] === '\t')) this.pos++;
        return ' ';
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'a':
        return '\x07';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case 'x':
      case 'u':
      case 'U': {
        const max = c === 'x' ? 2 : c === 'u' ? 4 : 8;
        const m = /^[0-9A-Fa-f]+/.exec(s.slice(this.pos, this.pos + max));
        if (!m) return c;
        this.pos += m[0].length;
        return String.fromCodePoint(parseInt(m[0], 16));
      }
      default:
        if (c >= '0' && c <= '7') {
          const m = /^[0-7]{1,3}/.exec(s.slice(this.pos - 1, this.pos + 2));
          const digits = m ? m[0] : c;
          this.pos += digits.length - 1;
          return String.fromCharCode(parseInt(digits, 8) & 0xff);
        }
        return c;
    }
  }

  /** Parse a `$` reference. Returns literal `$` text when no name follows. */
  parseVariable(): Part {
    const s = this.src;
    const start = this.pos;
    this.pos++;
    if (s[this.pos] === '{') {
      const close = s.indexOf('}', this.pos);
      if (close < 0) throw new TclSyntaxError('missing close-brace for variable name', this.lineAt(start));
      const name = s.slice(this.pos + 1, close);
      this.pos = close + 1;
      return { kind: 'var', name };
    }
    let name = '';
    for (;;) {
      const c = s[this.pos];
      if (c !== undefined && NAME_CHAR.test(c)) {
        name += c;
        this.pos++;
      } else if (c === ':' && s[this.pos + 1] === ':') {
        while (s[this.pos] === ':') this.pos++;
        name += '::';
      } else break;
    }
    if (!name) return { kind: 'text', value: '$' };
    if (s[this.pos] === '(') {
      this.pos++;
      const index: Part[] = [];
      let text = '';
      while (this.pos < s.length && s[this.pos] !== ')') {
        const c = s[this.pos];
        if (c === '\\') text += this.parseEscape();
        else if (c === '$' || c === '[') {
          if (text) index.push({ kind: 'text', value: text });
          text = '';
          index.push(c === '$' ? this.parseVariable() : this.parseCommandSubst());
        } else {
          text += c;
          this.pos++;
        }
      }
      if (this.pos >= s.length) throw new TclSyntaxError('missing )', this.lineAt(start));
      this.pos++;
      if (text) index.push({ kind: 'text', value: text });
      return { kind: 'var', name, index: mergeText(index) };
    }
    return { kind: 'var', name };
  }

  /** Parse `[...]` starting at the open bracket. */
  parseCommandSubst(): Part {
    this.pos++;
    const script: Command[] = [];
    for (let c = this.next(true); c; c = this.next(true)) script.push(c);
    return { kind: 'cmd', script };
  }
}

function mergeText(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.kind === 'text' && last && last.kind === 'text') out[out.length - 1] = { kind: 'text', value: last.value + p.value };
    else out.push(p);
  }
  return out;
}

/** Parse a complete script. Throws `TclSyntaxError` on malformed input. */
export function parseScript(src: string, baseLine = 1): Command[] {
  return new Parser(src, baseLine).parseAll();
}
