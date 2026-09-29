import { describe, expect, it } from 'vitest';
import { registerCoreCommands } from '../src/adapters/tcl/core-commands';
import { Interp, type InterpDiagnostic } from '../src/adapters/tcl/interpreter';

function run(script: string): { interp: Interp; diags: InterpDiagnostic[]; out: string[] } {
  const diags: InterpDiagnostic[] = [];
  const out: string[] = [];
  const interp = new Interp({ report: (d) => diags.push(d) });
  registerCoreCommands(interp, 'test.tcl');
  interp.register('emit', (_it, args) => {
    out.push(args.join(' '));
    return '';
  });
  interp.runScript(script);
  return { interp, diags, out };
}

describe('tcl interpreter', () => {
  it('sets and substitutes variables', () => {
    const { interp } = run('set a 5\nset b "x${a}y"\nset c [set a]');
    expect(interp.getGlobal('b')).toBe('x5y');
    expect(interp.getGlobal('c')).toBe('5');
  });

  it('defines and calls procs with defaults and args', () => {
    const { out } = run('proc f {a {b 2} args} { emit $a $b $args; return [expr {$a + $b}] }\nemit [f 1]\nf 1 3 x y');
    expect(out).toEqual(['1 2 ', '3', '1 3 x y']);
  });

  it('keeps proc locals separate and links `variable` to globals', () => {
    const { out } = run('set g top\nproc p {} { variable g; set x 1; emit $g [info exists x] }\np\nemit [info exists x]');
    expect(out).toEqual(['top 1', '0']);
  });

  it('evaluates if / elseif / else', () => {
    const { out } = run('set v 3\nif {$v == 1} {emit one} elseif {$v eq "3" && !($v < 0)} {emit three} else {emit other}');
    expect(out).toEqual(['three']);
  });

  it('catch returns 0/1 and stores the message', () => {
    const { interp } = run('set r0 [catch {set ok 1} m0]\nset r1 [catch {error boom} m1]\nset r2 [catch {set nope} m2]');
    expect([interp.getGlobal('r0'), interp.getGlobal('m0')]).toEqual(['0', '1']);
    expect([interp.getGlobal('r1'), interp.getGlobal('m1')]).toEqual(['1', 'boom']);
    expect(interp.getGlobal('r2')).toBe('1');
  });

  it('treats an unevaluable if condition as false with a warning', () => {
    const { out, diags } = run('if {$x ==} {emit yes} else {emit no}');
    expect(out).toEqual(['no']);
    expect(diags.some((d) => d.severity === 'warning' && /if/.test(d.message))).toBe(true);
    const r = run('if {bogus_word} {emit yes} else {emit no}');
    expect(r.out).toEqual(['no']);
  });

  it('supports foreach, lappend, string and namespace procs', () => {
    const { out } = run(
      'namespace eval ns { proc id {x} { return $x } }\nset acc {}\nforeach v {a b c} { lappend acc [ns::id $v] }\nemit $acc [string first b abc] [string compare a b] [llength $acc]',
    );
    expect(out).toEqual(['a b c 1 -1 3']);
  });

  it('short-circuits && and ||', () => {
    const { out } = run('if {1 || [emit side]} {emit ok}\nif {0 && [emit side]} {} else {emit ok2}');
    expect(out).toEqual(['ok', 'ok2']);
  });

  it('stops at a top-level return and reports it', () => {
    const { out, diags } = run('emit a\nreturn 1\nemit b');
    expect(out).toEqual(['a']);
    expect(diags[0]).toMatchObject({ severity: 'warning', line: 2 });
  });

  it('reports runtime errors with their line and continues with the next command', () => {
    const { out, diags } = run('emit a\n\nset missing_var_read $nope\nemit b');
    expect(out).toEqual(['a', 'b']);
    expect(diags).toEqual([expect.objectContaining({ severity: 'error', line: 3 })]);
  });

  it('aborts runaway scripts with a step limit', () => {
    const diags: InterpDiagnostic[] = [];
    const interp = new Interp({ maxSteps: 1000, report: (d) => diags.push(d) });
    registerCoreCommands(interp);
    interp.runScript('while {1} { set x 1 }');
    expect(diags[0]?.severity).toBe('error');
  });

  it('evaluates expr arithmetic and comparisons', () => {
    const { interp } = run('set a [expr {(2 + 3) * 4 - 10 / 3}]\nset b [expr {"abc" ne "abd"}]\nset c [expr {0x10 >= 16 ? "hex" : "no"}]');
    expect(interp.getGlobal('a')).toBe('17');
    expect(interp.getGlobal('b')).toBe('1');
    expect(interp.getGlobal('c')).toBe('hex');
  });
});
