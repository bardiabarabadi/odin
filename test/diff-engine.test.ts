import { describe, expect, it } from 'vitest';
import { buildDiffIndex, countChangesUnder, diffDesigns, isEmptyDiff, normalizeValue } from '../src/diff';
import type { Design } from '../src/model/types';
import { addr, cell, clone, design, net, port } from './diff-helpers';

const opts = { baseLabel: 'HEAD~1', headLabel: 'working tree' };

function baseDesign(): Design {
  return design({
    tool: { name: 'Vivado', version: '2023.2', part: 'xczu9eg' },
    ports: [port('clk_in', { dir: 'I', type: 'clk' }), port('led', { dir: 'O', from: 3, to: 0 })],
    intfPorts: [{ name: 'S_AXI', path: 'S_AXI', mode: 'Slave', vlnv: 'xilinx.com:interface:aximm_rtl:1.0' }],
    cells: [
      cell('hier_0', { kind: 'hier', pins: [{ name: 'clk', dir: 'I', type: 'clk' }] }),
      cell('hier_0/inner', { kind: 'hier', pins: [{ name: 'clk', dir: 'I' }] }),
      cell('hier_0/inner/gpio', {
        vlnv: 'xilinx.com:ip:axi_gpio:2.0',
        properties: { 'CONFIG.C_GPIO_WIDTH': '4' },
        pins: [{ name: 's_axi_aclk', inferred: true }],
      }),
      cell('hier_0/const', {
        vlnv: 'xilinx.com:ip:xlconstant:1.1',
        properties: { 'CONFIG.CONST_VAL': '{0}' },
        pins: [{ name: 'dout', inferred: true }],
      }),
      cell('mod_0', {
        kind: 'module',
        reference: 'my_mod',
        pins: [
          { name: 'clk', dir: 'I', type: 'clk' },
          { name: 'data', dir: 'O', from: 7, to: 0 },
        ],
        intfPins: [{ name: 'M_AXI', mode: 'Master', vlnv: 'xilinx.com:interface:aximm_rtl:1.0' }],
      }),
    ],
    nets: [
      net('', 'clk_in_1', ['clk_in', 'hier_0/clk', 'mod_0/clk']),
      net('hier_0', 'hier_0_clk', ['hier_0/clk', 'hier_0/inner/clk']),
      net('hier_0/inner', 'clk_1', ['hier_0/inner/clk', 'hier_0/inner/gpio/s_axi_aclk']),
      net('', 'S_AXI_1', ['S_AXI', 'mod_0/M_AXI'], 'interface'),
    ],
    addressAssignments: [addr('mod_0/M_AXI', 'hier_0/inner/gpio/S_AXI/Reg', '0x40000000', '64K')],
  });
}

describe('diffDesigns', () => {
  it('identical designs produce an empty diff', () => {
    const b = baseDesign();
    const d = diffDesigns(b, clone(b), opts);
    expect(isEmptyDiff(d)).toBe(true);
    expect(d.netRenames).toEqual([]);
    expect(Object.values(d.summary).every((v) => v === 0)).toBe(true);
    expect(d.baseLabel).toBe('HEAD~1');
    expect(d.headLabel).toBe('working tree');
  });

  it('ignores loc and diagnostics', () => {
    const b = baseDesign();
    const h = clone(b);
    for (const c of h.cells) c.loc = { file: 'other.tcl', line: 999 };
    for (const n of h.nets) n.loc = { file: 'other.tcl', line: 42 };
    h.diagnostics.push({ severity: 'warning', message: 'x' });
    expect(isEmptyDiff(diffDesigns(b, h, opts))).toBe(true);
  });

  it('detects added, removed and modified cells', () => {
    const b = baseDesign();
    const h = clone(b);
    h.cells = h.cells.filter((c) => c.path !== 'hier_0/const');
    h.cells.push(cell('new_ip', { vlnv: 'xilinx.com:ip:util_vector_logic:2.0' }));
    h.cells.find((c) => c.path === 'mod_0')!.reference = 'my_mod_v2';
    const d = diffDesigns(b, h, opts);
    expect(d.cells).toEqual([
      { path: 'hier_0/const', kind: 'removed' },
      { path: 'mod_0', kind: 'modified', detail: 'reference my_mod -> my_mod_v2' },
      { path: 'new_ip', kind: 'added' },
    ]);
    expect(d.summary).toMatchObject({ cellsAdded: 1, cellsRemoved: 1, cellsModified: 1 });
    // pins of added/removed cells are not itemised
    expect(d.pins).toEqual([]);
  });

  it('detects vlnv and kind changes', () => {
    const b = baseDesign();
    const h = clone(b);
    const gpio = h.cells.find((c) => c.path === 'hier_0/inner/gpio')!;
    gpio.vlnv = 'xilinx.com:ip:axi_gpio:2.1';
    const m = h.cells.find((c) => c.path === 'mod_0')!;
    m.kind = 'unknown';
    const d = diffDesigns(b, h, opts);
    expect(d.cells.map((c) => [c.path, c.kind])).toEqual([
      ['hier_0/inner/gpio', 'modified'],
      ['mod_0', 'modified'],
    ]);
    expect(d.cells[0].detail).toContain('vlnv xilinx.com:ip:axi_gpio:2.0 -> xilinx.com:ip:axi_gpio:2.1');
    expect(d.cells[1].detail).toContain('kind module -> unknown');
  });

  it('reports property changes and normalises braces and whitespace', () => {
    const b = baseDesign();
    const h = clone(b);
    const k = h.cells.find((c) => c.path === 'hier_0/const')!;
    k.properties['CONFIG.CONST_VAL'] = ' 0 '; // was `{0}` -> same value
    const g = h.cells.find((c) => c.path === 'hier_0/inner/gpio')!;
    g.properties['CONFIG.C_GPIO_WIDTH'] = '{8}';
    g.properties['CONFIG.C_ALL_OUTPUTS'] = '1';
    const d = diffDesigns(b, h, opts);
    expect(d.properties).toEqual([
      { path: 'hier_0/inner/gpio', key: 'CONFIG.C_ALL_OUTPUTS', after: '1' },
      { path: 'hier_0/inner/gpio', key: 'CONFIG.C_GPIO_WIDTH', before: '4', after: '{8}' },
    ]);
    expect(d.cells).toEqual([{ path: 'hier_0/inner/gpio', kind: 'modified', detail: '2 properties changed' }]);
    expect(d.summary.propertiesChanged).toBe(2);
  });

  it('reports removed properties', () => {
    const b = baseDesign();
    const h = clone(b);
    delete h.cells.find((c) => c.path === 'hier_0/const')!.properties['CONFIG.CONST_VAL'];
    const d = diffDesigns(b, h, opts);
    expect(d.properties).toEqual([{ path: 'hier_0/const', key: 'CONFIG.CONST_VAL', before: '{0}' }]);
  });

  it('normalizeValue strips one pair of braces and trims', () => {
    expect(normalizeValue(' {  abc } ')).toBe('abc');
    expect(normalizeValue('{{a}}')).toBe('{a}');
    expect(normalizeValue(undefined)).toBeUndefined();
  });

  it('detects a pin width change and marks the cell modified', () => {
    const b = baseDesign();
    const h = clone(b);
    const m = h.cells.find((c) => c.path === 'mod_0')!;
    m.pins.find((p) => p.name === 'data')!.from = 15;
    const d = diffDesigns(b, h, opts);
    expect(d.pins).toEqual([{ path: 'mod_0/data', kind: 'modified', detail: 'width [7:0] -> [15:0]' }]);
    expect(d.cells).toEqual([{ path: 'mod_0', kind: 'modified', detail: '1 pin changed' }]);
    expect(d.summary.pinsChanged).toBe(1);
  });

  it('detects declared pin add/remove and interface pin attribute changes', () => {
    const b = baseDesign();
    const h = clone(b);
    const m = h.cells.find((c) => c.path === 'mod_0')!;
    m.pins = m.pins.filter((p) => p.name !== 'clk');
    m.pins.push({ name: 'rst', path: 'mod_0/rst', dir: 'I', type: 'rst' });
    m.intfPins[0].mode = 'Slave';
    const d = diffDesigns(b, h, opts);
    expect(d.pins).toEqual([
      { path: 'mod_0/M_AXI', kind: 'modified', detail: 'mode Master -> Slave' },
      { path: 'mod_0/clk', kind: 'removed' },
      { path: 'mod_0/rst', kind: 'added' },
    ]);
    expect(d.cells[0]).toMatchObject({ path: 'mod_0', kind: 'modified', detail: '3 pins changed' });
  });

  it('inferred-pin churn does not mark the cell modified', () => {
    const b = baseDesign();
    const h = clone(b);
    const g = h.cells.find((c) => c.path === 'hier_0/inner/gpio')!;
    g.pins.push({ name: 'gpio_io_o', path: 'hier_0/inner/gpio/gpio_io_o', inferred: true });
    const k = h.cells.find((c) => c.path === 'hier_0/const')!;
    k.pins = [];
    const d = diffDesigns(b, h, opts);
    expect(d.cells).toEqual([]);
    expect(d.pins).toEqual([
      { path: 'hier_0/const/dout', kind: 'removed', detail: 'inferred from connectivity', inferred: true },
      { path: 'hier_0/inner/gpio/gpio_io_o', kind: 'added', detail: 'inferred from connectivity', inferred: true },
    ]);
  });

  it('a net renamed with identical endpoints is unchanged', () => {
    const b = baseDesign();
    const h = clone(b);
    h.nets.find((n) => n.name === 'clk_in_1')!.name = 'Net6';
    // endpoint order does not matter
    h.nets.find((n) => n.name === 'Net6')!.endpoints.reverse();
    const d = diffDesigns(b, h, opts);
    expect(d.nets).toEqual([]);
    expect(isEmptyDiff(d)).toBe(true);
    expect(d.netRenames).toEqual([{ scope: '', kind: 'signal', baseName: 'clk_in_1', headName: 'Net6' }]);
  });

  it('a renamed net in a different scope is not matched', () => {
    const b = design({ nets: [net('a', 'n1', ['a/x/p', 'a/y/q'])] });
    const h = design({ nets: [net('b', 'n2', ['a/x/p', 'a/y/q'])] });
    const d = diffDesigns(b, h, opts);
    expect(d.nets.map((n) => [n.path, n.kind])).toEqual([
      ['a/n1', 'removed'],
      ['b/n2', 'added'],
    ]);
  });

  it('a net with an added endpoint is modified', () => {
    const b = baseDesign();
    const h = clone(b);
    const n = h.nets.find((x) => x.name === 'hier_0_clk')!;
    n.endpoints.push({ path: 'hier_0/const/clk', kind: 'pin' });
    n.endpoints = n.endpoints.filter((e) => e.path !== 'hier_0/clk');
    const d = diffDesigns(b, h, opts);
    expect(d.nets).toEqual([
      {
        path: 'hier_0/hier_0_clk',
        kind: 'modified',
        scope: 'hier_0',
        name: 'hier_0_clk',
        addedEndpoints: ['hier_0/const/clk'],
        removedEndpoints: ['hier_0/clk'],
        detail: '+1 endpoint, -1 endpoint',
      },
    ]);
    expect(d.summary.netsModified).toBe(1);
  });

  it('a net whose kind changed is removed + added', () => {
    const b = design({ nets: [net('', 'x', ['a/p', 'b/q'], 'signal')] });
    const h = design({ nets: [net('', 'x', ['a/p', 'b/q'], 'interface')] });
    const d = diffDesigns(b, h, opts);
    expect(d.nets.map((n) => [n.name, n.kind])).toEqual([
      ['x', 'removed'],
      ['x', 'added'],
    ]);
    expect(d.summary).toMatchObject({ netsAdded: 1, netsRemoved: 1, netsModified: 0 });
    expect(buildDiffIndex(d).nets.get('::x')).toBe('modified');
  });

  it('detects port changes', () => {
    const b = baseDesign();
    const h = clone(b);
    h.ports.find((p) => p.name === 'led')!.to = 1;
    h.ports = h.ports.filter((p) => p.name !== 'clk_in');
    h.ports.push(port('rst_n', { dir: 'I', type: 'rst' }));
    h.intfPorts[0].vlnv = 'xilinx.com:interface:aximm_rtl:1.1';
    const d = diffDesigns(b, h, opts);
    expect(d.ports).toEqual([
      { path: 'S_AXI', kind: 'modified', detail: 'vlnv xilinx.com:interface:aximm_rtl:1.0 -> xilinx.com:interface:aximm_rtl:1.1' },
      { path: 'clk_in', kind: 'removed' },
      { path: 'led', kind: 'modified', detail: 'width [3:0] -> [3:1]' },
      { path: 'rst_n', kind: 'added' },
    ]);
    expect(d.summary.portsChanged).toBe(4);
  });

  it('detects port direction and type changes', () => {
    const b = design({ ports: [port('p', { dir: 'I', type: 'data' })] });
    const h = design({ ports: [port('p', { dir: 'O', type: 'clk' })] });
    expect(diffDesigns(b, h, opts).ports).toEqual([
      { path: 'p', kind: 'modified', detail: 'dir I -> O; type data -> clk' },
    ]);
  });

  it('detects address assignment offset change', () => {
    const b = baseDesign();
    const h = clone(b);
    h.addressAssignments[0].offset = '0x40010000';
    h.addressAssignments.push(addr('mod_0/M_AXI', 'hier_0/other/Reg', '0x0', '4K'));
    const d = diffDesigns(b, h, opts);
    expect(d.addressAssignments).toEqual([
      { path: 'mod_0/M_AXI -> hier_0/inner/gpio/S_AXI/Reg', kind: 'modified', detail: 'offset 0x40000000 -> 0x40010000' },
      { path: 'mod_0/M_AXI -> hier_0/other/Reg', kind: 'added' },
    ]);
    expect(d.summary.addressAssignmentsChanged).toBe(2);
  });

  it('reports tool version changes as design-level properties', () => {
    const b = baseDesign();
    const h = clone(b);
    h.tool = { name: 'Vivado', version: '2024.1', part: 'xczu9eg', board: 'zcu102' };
    const d = diffDesigns(b, h, opts);
    expect(d.properties).toEqual([
      { path: '', key: 'tool.board', after: 'zcu102' },
      { path: '', key: 'tool.version', before: '2023.2', after: '2024.1' },
    ]);
    expect(d.cells).toEqual([]);
    expect(d.summary.propertiesChanged).toBe(2);
  });

  it('produces deterministic ordering independent of input order', () => {
    const b = baseDesign();
    const h = clone(b);
    h.cells.push(cell('zz'), cell('aa'), cell('hier_0/mm'));
    h.nets.push(net('', 'z_net', ['zz/a', 'aa/b']), net('', 'a_net', ['aa/c', 'zz/d']));
    const h2 = clone(h);
    h2.cells.reverse();
    h2.nets.reverse();
    const b2 = clone(b);
    b2.cells.reverse();
    b2.nets.reverse();
    const d1 = diffDesigns(b, h, opts);
    const d2 = diffDesigns(b2, h2, opts);
    expect(d2).toEqual(d1);
    expect(d1.cells.map((c) => c.path)).toEqual(['aa', 'hier_0/mm', 'zz']);
    expect(d1.nets.map((n) => n.path)).toEqual(['a_net', 'z_net']);
  });
});

describe('buildDiffIndex', () => {
  it('builds keyed maps', () => {
    const b = baseDesign();
    const h = clone(b);
    h.cells = h.cells.filter((c) => c.path !== 'hier_0/const');
    h.cells.find((c) => c.path === 'mod_0')!.pins[1].to = 1;
    h.nets = h.nets.filter((n) => n.name !== 'clk_1');
    h.nets.push(net('hier_0', 'new_net', ['hier_0/clk', 'hier_0/inner/gpio/x']));
    h.ports[0].dir = 'IO';
    h.addressAssignments = [];
    h.tool!.version = '2024.2';
    const idx = buildDiffIndex(diffDesigns(b, h, opts));
    expect(idx.cells).toEqual(new Map([['hier_0/const', 'removed'], ['mod_0', 'modified']]));
    expect(idx.pins).toEqual(new Map([['mod_0/data', 'modified']]));
    expect(idx.ports).toEqual(new Map([['clk_in', 'modified']]));
    expect(idx.nets).toEqual(
      new Map([
        ['hier_0/inner::clk_1', 'removed'],
        ['hier_0::new_net', 'added'],
      ]),
    );
    expect(idx.addressAssignments?.get('mod_0/M_AXI -> hier_0/inner/gpio/S_AXI/Reg')).toBe('removed');
    expect(idx.properties?.get('')).toEqual([{ path: '', key: 'tool.version', before: '2023.2', after: '2024.2' }]);
  });
});

describe('countChangesUnder', () => {
  it('counts changes inside nested hierarchy', () => {
    const b = baseDesign();
    const h = clone(b);
    // inside hier_0/inner
    h.cells.find((c) => c.path === 'hier_0/inner/gpio')!.properties['CONFIG.C_GPIO_WIDTH'] = '8';
    h.nets.find((n) => n.name === 'clk_1')!.endpoints.push({ path: 'hier_0/inner/gpio/extra', kind: 'pin' });
    h.cells.find((c) => c.path === 'hier_0/inner/gpio')!.pins.push({
      name: 'extra',
      path: 'hier_0/inner/gpio/extra',
      inferred: true,
    });
    // boundary pin of hier_0/inner: counts under hier_0 but not under hier_0/inner
    h.cells.find((c) => c.path === 'hier_0/inner')!.pins.push({ name: 'rst', path: 'hier_0/inner/rst', dir: 'I' });
    // directly inside hier_0
    h.cells = h.cells.filter((c) => c.path !== 'hier_0/const');
    // outside hier_0
    h.cells.push(cell('other'));
    const d = diffDesigns(b, h, opts);

    expect(countChangesUnder(d, 'hier_0/inner')).toEqual({ added: 0, removed: 0, modified: 2, total: 2 });
    // gpio modified, clk_1 modified, inner modified (boundary pin), inner/rst added, const removed
    expect(countChangesUnder(d, 'hier_0')).toEqual({ added: 1, removed: 1, modified: 3, total: 5 });
    // root: everything above + `other` added
    expect(countChangesUnder(d, '')).toEqual({ added: 2, removed: 1, modified: 3, total: 6 });
    // hier cell itself is not marked modified because its children changed
    expect(d.cells.find((c) => c.path === 'hier_0')).toBeUndefined();
    expect(countChangesUnder(d, 'mod_0')).toEqual({ added: 0, removed: 0, modified: 0, total: 0 });
  });

  it('does not count a sibling with a shared name prefix', () => {
    const b = design({ cells: [cell('h', { kind: 'hier' }), cell('h2', { kind: 'hier' })] });
    const h = clone(b);
    h.cells.push(cell('h2/x'));
    const d = diffDesigns(b, h, opts);
    expect(countChangesUnder(d, 'h').total).toBe(0);
    expect(countChangesUnder(d, 'h2').total).toBe(1);
  });
});
