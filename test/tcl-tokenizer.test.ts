import { describe, expect, it } from 'vitest';
import { formatList, splitList } from '../src/adapters/tcl/lists';
import { parseScript, TclSyntaxError, type Command, type Word } from '../src/adapters/tcl/tokenizer';

/** Render a word back as a compact string for assertions. */
function show(w: Word): string {
  return w.parts
    .map((p) => (p.kind === 'text' ? p.value : p.kind === 'var' ? `$(${p.name})` : `[${p.script.map(showCmd).join(';')}]`))
    .join('');
}
function showCmd(c: Command): string {
  return c.words.map(show).join(' ');
}

describe('tcl tokenizer', () => {
  it('splits commands on newlines and semicolons', () => {
    const cmds = parseScript('set a 1; set b 2\nputs $a');
    expect(cmds.map(showCmd)).toEqual(['set a 1', 'set b 2', 'puts $(a)']);
    expect(cmds.map((c) => c.line)).toEqual([1, 1, 2]);
  });

  it('keeps braced words literal and records their raw text', () => {
    const [cmd] = parseScript('if { $x eq "a" } {\n  puts [hi]\n}');
    expect(cmd.words[1].quoting).toBe('brace');
    expect(show(cmd.words[1])).toBe(' $x eq "a" ');
    expect(cmd.words[2].raw).toBe('\n  puts [hi]\n');
    expect(cmd.endLine).toBe(3);
  });

  it('handles nested braces and escaped braces inside braces', () => {
    const [cmd] = parseScript('set x {a {b c} \\} d}');
    expect(show(cmd.words[2])).toBe('a {b c} \\} d');
  });

  it('parses nested command substitution and variables', () => {
    const [cmd] = parseScript('set x [get_bd_pins $cell/clk]');
    expect(showCmd(cmd)).toBe('set x [get_bd_pins $(cell)/clk]');
  });

  it('supports ${name}, $ns::name and array references', () => {
    const [cmd] = parseScript('puts ${a b}x $::env $ns::v $arr(k)');
    const parts = cmd.words.slice(1).map((w) => w.parts[0]);
    expect(parts.map((p) => (p.kind === 'var' ? p.name : ''))).toEqual(['a b', '::env', 'ns::v', 'arr']);
  });

  it('treats backslash-newline as a line continuation and tracks lines', () => {
    const cmds = parseScript('connect_bd_net -net n \\\n   [get_bd_pins a/b] \\\n   [get_bd_pins c/d]\nputs done');
    expect(cmds).toHaveLength(2);
    expect(cmds[0].words).toHaveLength(5);
    expect(cmds[0].line).toBe(1);
    expect(cmds[0].endLine).toBe(3);
    expect(cmds[1].line).toBe(4);
  });

  it('processes backslash escapes in quoted and bare words', () => {
    const [cmd] = parseScript('puts "a\\tb\\n\\"q\\" \\x41\\u00e9" \\$x');
    expect(show(cmd.words[1])).toBe('a\tb\n"q" Aé');
    expect(show(cmd.words[2])).toBe('$x');
  });

  it('ignores comments only at command start', () => {
    const cmds = parseScript('# comment {with braces}\nputs a#b ;# trailing\n');
    expect(cmds.map(showCmd)).toEqual(['puts a#b']);
    expect(cmds[0].line).toBe(2);
  });

  it('reports unterminated constructs as syntax errors', () => {
    expect(() => parseScript('set x {abc')).toThrow(TclSyntaxError);
    expect(() => parseScript('set x [abc')).toThrow(TclSyntaxError);
    expect(() => parseScript('set x "abc')).toThrow(TclSyntaxError);
  });

  it('supports {*} expansion', () => {
    const [cmd] = parseScript('list {*}$items');
    expect(cmd.words[1].expand).toBe(true);
  });
});

describe('tcl lists', () => {
  it('splits braces, quotes and bare elements', () => {
    expect(splitList(' a {b c} "d e" {} f\\ g ')).toEqual(['a', 'b c', 'd e', '', 'f g']);
  });

  it('round-trips through formatList', () => {
    const items = ['plain', 'with space', '', '{nested {x}}', 'id "10"', 'a$b'];
    expect(splitList(formatList(items))).toEqual(items);
  });
});
