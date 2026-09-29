/** Tcl list helpers: split a string into list elements and format a list back. */
import { TclError } from './errors';

function isListSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

function unescapeChar(s: string, i: number): [string, number] {
  const c = s[i + 1];
  if (c === undefined) return ['\\', i + 1];
  switch (c) {
    case 'n':
      return ['\n', i + 2];
    case 't':
      return ['\t', i + 2];
    case 'r':
      return ['\r', i + 2];
    case '\n': {
      let j = i + 2;
      while (s[j] === ' ' || s[j] === '\t') j++;
      return [' ', j];
    }
    default:
      return [c, i + 2];
  }
}

/** Split a Tcl list into its elements. Throws `TclError` on malformed lists. */
export function splitList(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && isListSpace(s[i])) i++;
    if (i >= n) break;
    const c = s[i];
    if (c === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (s[j] === '\\') j += 2;
        else {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') depth--;
          j++;
        }
      }
      if (depth !== 0) throw new TclError('unmatched open brace in list');
      out.push(s.slice(i + 1, j - 1));
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let el = '';
      while (j < n && s[j] !== '"') {
        if (s[j] === '\\') {
          const [ch, nj] = unescapeChar(s, j);
          el += ch;
          j = nj;
        } else el += s[j++];
      }
      if (j >= n) throw new TclError('unmatched open quote in list');
      out.push(el);
      i = j + 1;
    } else {
      let el = '';
      while (i < n && !isListSpace(s[i])) {
        if (s[i] === '\\') {
          const [ch, ni] = unescapeChar(s, i);
          el += ch;
          i = ni;
        } else el += s[i++];
      }
      out.push(el);
    }
  }
  return out;
}

const PLAIN = /^[^\s{}[\]"\\$;#]+$/;

function bracesBalanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      if (i >= s.length) return false;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Quote one element so that `splitList` returns it unchanged. */
export function quoteElement(s: string): string {
  if (s === '') return '{}';
  if (PLAIN.test(s)) return s;
  if (bracesBalanced(s)) return `{${s}}`;
  return s.replace(/[\s{}[\]"\\$;#]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\t') return '\\t';
    if (c === '\r') return '\\r';
    return `\\${c}`;
  });
}

export function formatList(items: readonly string[]): string {
  return items.map(quoteElement).join(' ');
}
