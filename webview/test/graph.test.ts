import { describe, expect, it } from 'vitest';
import type { Design } from '../../src/model/types';
import type { DiffPayload } from '../../src/shared/protocol';
import { buildGraph, guessRoleFromName, layoutKey } from '../src/graph';
import { runLayout } from '../src/layout';
import { buildDiffContext, buildDiffIndex, listChanges, mergeDesigns } from '../src/diff-index';
import { buildSearchIndex, searchItems } from '../src/search';
import sample from '../dev/sample-design.json';
import sampleDiff from '../dev/sample-diff.json';

const design = sample as unknown as Design;
const diffPayload = sampleDiff as unknown as DiffPayload;

const base = { hideClockReset: false, hideUnconnected: false };

describe('guessRoleFromName', () => {
  it('recognises common Vivado pin names', () => {
    expect(guessRoleFromName('gpio_io_o')).toBe('src');
    expect(guessRoleFromName('gpio_io_i')).toBe('sink');
    expect(guessRoleFromName('s_axi_aclk')).toBe('sink');
    expect(guessRoleFromName('s_axi_aresetn')).toBe('sink');
    expect(guessRoleFromName('interconnect_aresetn')).toBe('src');
    expect(guessRoleFromName('ip2intc_irpt')).toBe('src');
    expect(guessRoleFromName('foo')).toBe('unknown');
  });
});

describe('buildGraph', () => {
  it('shows root cells and top-level ports as boundary nodes', () => {
    const g = buildGraph(design, { scope: '', ...base });
    const cells = [...g.nodes.values()].filter((n) => n.kind === 'cell').map((n) => n.path);
    expect(cells).toContain('microblaze_0');
    expect(cells).toContain('io_subsystem');
    expect(cells).not.toContain('io_subsystem/axi_uart_0');
    const ports = [...g.nodes.values()].filter((n) => n.kind === 'boundary').map((n) => n.path);
    expect(ports).toEqual(expect.arrayContaining(['sys_clk', 'leds', 'gpio_rtl', 'spare_io']));
  });

  it('places inputs WEST and outputs EAST, and infers unknown directions', () => {
    const g = buildGraph(design, { scope: '', ...base });
    expect(g.pins.get('pwm_gen_0/clk')?.side).toBe('WEST');
    expect(g.pins.get('pwm_gen_0/pwm')?.side).toBe('EAST');
    // Master interface -> EAST, Slave -> WEST
    expect(g.pins.get('microblaze_0/M_AXI_DP')?.side).toBe('EAST');
    expect(g.pins.get('axi_gpio_0/S_AXI')?.side).toBe('WEST');
    // Inferred, no dir: every other endpoint is an input -> driver -> EAST
    expect(g.pins.get('axi_gpio_0/gpio2_io_o')?.side).toBe('EAST');
    // Inferred, net has a known driver elsewhere -> WEST
    expect(g.pins.get('microblaze_0/Interrupt')?.side).toBe('WEST');
    // Inferred everywhere: name hints pick the driver
    expect(g.pins.get('clk_wiz_0/clk_out1')?.side).toBe('EAST');
    expect(g.pins.get('microblaze_0/Clk')?.side).toBe('WEST');
    expect(g.pins.get('proc_sys_reset_0/peripheral_aresetn')?.side).toBe('EAST');
    expect(g.pins.get('proc_sys_reset_0/ext_reset_in')?.side).toBe('WEST');
    expect(g.pins.get('clk_wiz_0/locked')?.side).toBe('EAST');
    expect(g.pins.get('proc_sys_reset_0/dcm_locked')?.side).toBe('WEST');
    // Input top port sits left (its stub on EAST), output port right.
    expect(g.pins.get('sys_clk')?.side).toBe('EAST');
    expect(g.pins.get('leds')?.side).toBe('WEST');
    expect(g.pins.get('spare_io')?.side).toBe('EAST');
  });

  it('places pins of an IP whose pins are all inferred by name and interface mode', () => {
    const inferred = (cell: string, name: string) => ({ name, path: `${cell}/${name}`, inferred: true });
    const d: Design = {
      ...design,
      cells: [
        {
          name: 'gpio',
          path: 'gpio',
          parent: '',
          kind: 'ip',
          vlnv: 'x:ip:gpio:1.0',
          properties: {},
          pins: ['s_axi_aclk', 's_axi_aresetn', 'gpio_io_o', 'ip2intc_irpt', 'gpio_io_t'].map((n) => inferred('gpio', n)),
          intfPins: [inferred('gpio', 'S_AXI')],
        },
        {
          name: 'ic',
          path: 'ic',
          parent: '',
          kind: 'ip',
          vlnv: 'x:ip:ic:1.0',
          properties: {},
          pins: [],
          intfPins: [inferred('ic', 'M00_AXI')],
        },
      ],
      ports: [
        { name: 'sys_clk', path: 'sys_clk', dir: 'I' },
        { name: 'leds', path: 'leds', dir: 'O' },
      ],
      intfPorts: [],
      nets: [
        { name: 'clk', scope: '', kind: 'signal', endpoints: [{ path: 'sys_clk', kind: 'port' }, { path: 'gpio/s_axi_aclk', kind: 'pin' }] },
        { name: 'leds', scope: '', kind: 'signal', endpoints: [{ path: 'gpio/gpio_io_o', kind: 'pin' }, { path: 'leds', kind: 'port' }] },
        { name: 'axi', scope: '', kind: 'interface', endpoints: [{ path: 'gpio/S_AXI', kind: 'intfPin' }, { path: 'ic/M00_AXI', kind: 'intfPin' }] },
      ],
    };
    const g = buildGraph(d, { scope: '', ...base });
    const side = (p: string) => g.pins.get(p)?.side;
    // net hint: the clock net has a declared driver (an input port)
    expect(side('gpio/s_axi_aclk')).toBe('WEST');
    // unconnected: name only
    expect(side('gpio/s_axi_aresetn')).toBe('WEST');
    expect(side('gpio/ip2intc_irpt')).toBe('EAST');
    expect(side('gpio/gpio_io_t')).toBe('WEST');
    expect(g.pins.get('gpio/gpio_io_t')?.role).toBe('unknown');
    // name says output, drives an output port
    expect(side('gpio/gpio_io_o')).toBe('EAST');
    // interface pins without a mode: guessIntfMode + intfModeSide
    expect(side('gpio/S_AXI')).toBe('WEST');
    expect(side('ic/M00_AXI')).toBe('EAST');
    expect(g.nets.get('::axi')?.edgeIds.map((id) => g.edges.get(id)?.source)).toEqual(['ic/M00_AXI']);
  });

  it('shows hier boundary pins inside a hierarchy', () => {
    const g = buildGraph(design, { scope: 'io_subsystem', ...base });
    const boundary = [...g.nodes.values()].filter((n) => n.kind === 'boundary').map((n) => n.path);
    expect(boundary).toEqual(expect.arrayContaining(['io_subsystem/clk', 'io_subsystem/tx', 'io_subsystem/S_AXI']));
    // hier input pin drives inside -> stub on EAST of a left-hand node
    expect(g.pins.get('io_subsystem/rx')?.side).toBe('EAST');
    expect(g.pins.get('io_subsystem/tx')?.side).toBe('WEST');
    expect(g.nets.size).toBe(8);
  });

  it('builds one ELK edge per driver->sink pair', () => {
    const g = buildGraph(design, { scope: '', ...base });
    const clk = g.nets.get('::clk_wiz_0_clk_out1');
    expect(clk?.edgeIds.length).toBe(9);
    expect(g.elk.edges?.length).toBe(g.edges.size);
  });

  it('hides clock/reset nets and then unconnected pins', () => {
    const g1 = buildGraph(design, { scope: '', hideClockReset: true, hideUnconnected: false });
    expect(g1.nets.has('::clk_wiz_0_clk_out1')).toBe(false);
    expect(g1.nets.has('::proc_sys_reset_0_peripheral_aresetn')).toBe(false);
    expect(g1.pins.has('pwm_gen_0/clk')).toBe(true);
    const g2 = buildGraph(design, { scope: '', hideClockReset: true, hideUnconnected: true });
    expect(g2.pins.has('pwm_gen_0/clk')).toBe(false);
    expect(g2.pins.has('pwm_gen_0/debug')).toBe(false);
    expect(g2.pins.has('pwm_gen_0/pwm')).toBe(true);
    expect(g2.hiddenPins).toBeGreaterThan(0);
  });

  it('produces distinct cache keys per scope and filter', () => {
    expect(layoutKey({ scope: '', ...base }, 1)).not.toBe(layoutKey({ scope: 'io_subsystem', ...base }, 1));
    expect(layoutKey({ scope: '', ...base }, 1)).not.toBe(layoutKey({ scope: '', hideClockReset: true, hideUnconnected: false }, 1));
  });
});

describe('diff overlay', () => {
  const ctx = buildDiffContext(diffPayload.diff);
  const merged = mergeDesigns(design, diffPayload.base, ctx);

  it('indexes changes and marks cells with property changes as modified', () => {
    const idx = buildDiffIndex(diffPayload.diff);
    expect(idx.cells.get('pwm_gen_0')).toBe('added');
    expect(idx.cells.get('axi_bram_ctrl_0')).toBe('removed');
    expect(idx.nets.get('::clk_wiz_0_clk_out1')).toBe('modified');
    expect(idx.cells.get('io_subsystem/axi_timer_0')).toBe('modified');
  });

  it('merges removed objects from base as ghosts', () => {
    expect(merged.cells.some((c) => c.path === 'axi_bram_ctrl_0')).toBe(true);
    const g = buildGraph(merged, { scope: '', ...base, diff: ctx });
    const ghost = [...g.nodes.values()].find((n) => n.path === 'axi_bram_ctrl_0');
    expect(ghost?.status).toBe('removed');
    expect(g.nets.get('::axi_bram_ctrl_0_clk')?.status).toBe('removed');
    const clkEdges = g.nets.get('::clk_wiz_0_clk_out1')!.edgeIds.map((id) => g.edges.get(id)!);
    expect(clkEdges.find((e) => e.target === 'pwm_gen_0/clk')?.status).toBe('added');
    const hier = [...g.nodes.values()].find((n) => n.path === 'io_subsystem');
    expect(hier?.changeCount).toBe(4);
  });

  it('lists changes with navigation targets', () => {
    const items = listChanges(diffPayload.diff);
    const pin = items.find((i) => i.group === 'Pins');
    expect(pin?.target).toEqual({ scope: 'io_subsystem', select: { kind: 'pin', path: 'io_subsystem/axi_timer_0/interrupt' } });
    expect(items.filter((i) => i.group === 'Properties')).toHaveLength(3);
  });
});

describe('search', () => {
  it('finds cells, pins and nets across scopes', () => {
    const idx = buildSearchIndex(design);
    const r = searchItems(idx, 'axi_uart');
    expect(r[0].path).toBe('io_subsystem/axi_uart_0');
    expect(r[0].scope).toBe('io_subsystem');
    expect(searchItems(idx, 'uart').map((x) => x.path)).toEqual(expect.arrayContaining(['uart_rx', 'io_subsystem/axi_uart_0']));
    expect(searchItems(idx, 'gpio2').some((x) => x.kind === 'pin')).toBe(true);
    expect(searchItems(idx, 'clkout1').some((x) => x.kind === 'net')).toBe(true);
  });
});

describe('layout (ELK)', () => {
  it('lays out the root scope with orthogonal routes', async () => {
    const g = buildGraph(design, { scope: '', ...base });
    const scene = await runLayout(g);
    expect(scene.nodePos.size).toBe(g.nodes.size);
    expect(scene.width).toBeGreaterThan(0);
    for (const [id, route] of scene.edgeRoutes) {
      expect(route.polylines.length, id).toBeGreaterThan(0);
      for (const line of route.polylines) {
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1];
          const b = line[i];
          expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
        }
      }
    }
    // Inputs are laid out to the left of the cells they feed.
    const sysClk = scene.nodePos.get(g.nodeByPath.get('sys_clk')!)!;
    const clkWiz = scene.nodePos.get(g.nodeByPath.get('clk_wiz_0')!)!;
    expect(sysClk.x).toBeLessThan(clkWiz.x);
  });

  it('handles ~150 cells in reasonable time', async () => {
    const big: Design = { ...design, cells: [], nets: [], ports: [], intfPorts: [] };
    for (let i = 0; i < 150; i++) {
      const src = Math.floor((i - 1) / 3);
      big.cells.push({
        name: `c${i}`,
        path: `c${i}`,
        parent: '',
        kind: 'ip',
        vlnv: 'x:ip:blk:1.0',
        properties: {},
        pins: [
          { name: 'clk', path: `c${i}/clk`, dir: 'I' },
          { name: 'din', path: `c${i}/din`, dir: 'I', from: 7, to: 0 },
          { name: 'dout', path: `c${i}/dout`, dir: 'O', from: 7, to: 0 },
        ],
        intfPins: [],
      });
      if (i > 0) big.nets.push({ name: `n${i}`, scope: '', kind: 'signal', endpoints: [{ path: `c${src}/dout`, kind: 'pin' }, { path: `c${i}/din`, kind: 'pin' }] });
    }
    big.nets.push({ name: 'clk', scope: '', kind: 'signal', endpoints: big.cells.map((c) => ({ path: `${c.path}/clk`, kind: 'pin' as const })) });
    const g = buildGraph(big, { scope: '', ...base });
    expect(g.elk.layoutOptions?.['elk.layered.nodePlacement.strategy']).toBe('BRANDES_KOEPF');
    const t0 = Date.now();
    const scene = await runLayout(g);
    expect(scene.nodePos.size).toBe(150);
    expect(Date.now() - t0).toBeLessThan(10000);
  }, 30000);
});
