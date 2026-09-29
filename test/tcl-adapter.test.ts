import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../src/adapters';
import { isVivadoBlockDesignTcl, parseVivadoBdTcl } from '../src/adapters/tcl';
import { findPin, getCell, getChildren, getNetsInScope } from '../src/model/query';
import type { Design, IntfPin, Net, Pin } from '../src/model/types';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** 1-based line of the first line containing `needle`. */
function lineOf(text: string, needle: string): number {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`fixture does not contain: ${needle}`);
  return i + 1;
}

function countKinds(d: Design): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of d.cells) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}

function net(d: Design, scope: string, name: string): Net {
  const n = d.nets.find((x) => x.scope === scope && x.name === name);
  if (!n) throw new Error(`net ${scope}:${name} not found`);
  return n;
}

const endpointPaths = (n: Net): string[] => n.endpoints.map((e) => e.path).sort();

describe('isVivadoBlockDesignTcl', () => {
  it('detects write_bd_tcl exports', () => {
    for (const f of ['minimal.tcl', 'soc.tcl', 'edge-cases.tcl']) expect(isVivadoBlockDesignTcl(read(f))).toBe(true);
  });

  it('rejects ordinary Tcl', () => {
    expect(isVivadoBlockDesignTcl(read('not-a-bd.tcl'))).toBe(false);
    expect(isVivadoBlockDesignTcl('')).toBe(false);
  });

  it('finds BD commands beyond the first 200 lines', () => {
    const text = `${'# filler\n'.repeat(500)}proc x {} {\n  create_bd_cell -type ip -vlnv a:b:c:1.0 c\n}\n`;
    expect(isVivadoBlockDesignTcl(text)).toBe(true);
  });

  it('is used by the adapter registry', () => {
    expect(findAdapter(read('minimal.tcl'), 'design.tcl')?.format).toBe('vivado-bd-tcl');
    expect(findAdapter(read('not-a-bd.tcl'), 'util.tcl')).toBeUndefined();
  });
});

describe('minimal.tcl', () => {
  const text = read('minimal.tcl');
  const d = parseVivadoBdTcl(text, 'fixtures/minimal.tcl');

  it('has no diagnostics and the expected metadata', () => {
    expect(d.diagnostics).toEqual([]);
    expect(d.name).toBe('minimal_bd');
    expect(d.sourceFormat).toBe('vivado-bd-tcl');
    expect(d.sourceFile).toBe('fixtures/minimal.tcl');
    expect(d.tool).toEqual({ name: 'Vivado', version: '2024.2', part: 'xc7a35ticsg324-1L' });
  });

  it('builds cells with kinds, parents and VLNVs', () => {
    expect(countKinds(d)).toEqual({ ip: 4, hier: 1, module: 1 });
    expect(getChildren(d, '').map((c) => c.name)).toEqual(['clk_wiz_0', 'io_subsystem', 'proc_sys_reset_0']);
    expect(getChildren(d, 'io_subsystem').map((c) => c.path)).toEqual([
      'io_subsystem/axi_gpio_0',
      'io_subsystem/my_filter_0',
      'io_subsystem/xlconstant_0',
    ]);
    const filter = getCell(d, 'io_subsystem/my_filter_0');
    expect(filter).toMatchObject({ kind: 'module', reference: 'my_filter', parent: 'io_subsystem' });
    expect(filter?.properties).toEqual({ 'CONFIG.DATA_WIDTH': '4' });
    expect(getCell(d, 'clk_wiz_0')?.vlnv).toBe('xilinx.com:ip:clk_wiz:6.0');
    expect(getCell(d, 'io_subsystem/axi_gpio_0')?.properties).toEqual({ 'CONFIG.C_ALL_OUTPUTS': '1', 'CONFIG.C_GPIO_WIDTH': '8' });
  });

  it('declares hier boundary pins with direction, type and vector bounds', () => {
    const hier = getCell(d, 'io_subsystem');
    expect(hier?.pins.map((p) => p.name)).toEqual(['clk', 'resetn', 'sw', 'leds']);
    expect(findPin(d, 'io_subsystem/clk')).toMatchObject({ dir: 'I', type: 'clk' });
    expect(findPin(d, 'io_subsystem/leds')).toMatchObject({ dir: 'O', from: 7, to: 0 });
    expect(findPin(d, 'io_subsystem/leds')).not.toHaveProperty('inferred');
  });

  it('declares top-level ports with properties', () => {
    expect(d.ports.map((p) => p.name)).toEqual(['sys_clk', 'reset', 'sw', 'leds']);
    expect(d.ports[0]).toMatchObject({ path: 'sys_clk', dir: 'I', type: 'clk', properties: { 'CONFIG.FREQ_HZ': '100000000' } });
    expect(d.ports[3]).toMatchObject({ dir: 'O', from: 7, to: 0 });
  });

  it('infers undeclared IP / module pins from nets', () => {
    const pin = findPin(d, 'io_subsystem/my_filter_0/din') as Pin;
    expect(pin).toMatchObject({ name: 'din', inferred: true });
    expect(pin.dir).toBeUndefined();
    expect(getCell(d, 'proc_sys_reset_0')?.pins.map((p) => p.name).sort()).toEqual([
      'dcm_locked',
      'ext_reset_in',
      'peripheral_aresetn',
      'slowest_sync_clk',
    ]);
  });

  it('scopes nets inside hierarchies', () => {
    expect(getNetsInScope(d, '')).toHaveLength(7);
    expect(getNetsInScope(d, 'io_subsystem')).toHaveLength(5);
    const clk = net(d, 'io_subsystem', 'clk_1');
    expect(clk.kind).toBe('signal');
    expect(clk.endpoints).toEqual([
      { path: 'io_subsystem/clk', kind: 'pin' },
      { path: 'io_subsystem/axi_gpio_0/s_axi_aclk', kind: 'pin' },
      { path: 'io_subsystem/my_filter_0/clk', kind: 'pin' },
    ]);
    // The same boundary pin seen from outside, in the root scope.
    expect(endpointPaths(net(d, '', 'sw_1'))).toEqual(['io_subsystem/sw', 'sw']);
    expect(net(d, '', 'sw_1').endpoints.find((e) => e.path === 'sw')?.kind).toBe('port');
  });

  it('records source locations', () => {
    expect(getCell(d, 'clk_wiz_0')?.loc).toEqual({
      file: 'fixtures/minimal.tcl',
      line: lineOf(text, 'create_bd_cell -type ip -vlnv xilinx.com:ip:clk_wiz:6.0 clk_wiz_0'),
    });
    expect(getCell(d, 'io_subsystem')?.loc?.line).toBe(lineOf(text, 'set hier_obj [create_bd_cell -type hier $nameHier]'));
    expect(getCell(d, 'io_subsystem/my_filter_0')?.loc?.line).toBe(lineOf(text, 'set my_filter_0 [create_bd_cell -type module'));
    const start = lineOf(text, 'connect_bd_net -net clk_wiz_0_clk_out1');
    expect(net(d, '', 'clk_wiz_0_clk_out1').loc).toMatchObject({ line: start, endLine: start + 2 });
    expect(d.ports[0].loc?.line).toBe(lineOf(text, 'create_bd_port -dir I -type clk sys_clk'));
  });
});

describe('soc.tcl', () => {
  const text = read('soc.tcl');
  const d = parseVivadoBdTcl(text, 'soc.tcl');

  it('parses cleanly with the expected size', () => {
    expect(d.diagnostics).toEqual([]);
    expect(d.name).toBe('soc_bd');
    expect(countKinds(d)).toEqual({ ip: 22, hier: 4, module: 4 });
    expect(d.nets.filter((n) => n.kind === 'interface')).toHaveLength(29);
    expect(d.nets.filter((n) => n.kind === 'signal')).toHaveLength(38);
    expect(d.ports).toHaveLength(6);
    expect(d.intfPorts).toHaveLength(5);
  });

  it('builds two nested hierarchy levels', () => {
    expect(getCell(d, 'io_subsystem/sensor_block')).toMatchObject({ kind: 'hier', parent: 'io_subsystem' });
    expect(getChildren(d, 'io_subsystem/sensor_block').map((c) => c.name)).toEqual([
      'data_sync_0',
      'my_filter_0',
      'xlconstant_0',
      'xlslice_0',
      'xlslice_1',
    ]);
    expect(getCell(d, 'io_subsystem/sensor_block/data_sync_0')).toMatchObject({ kind: 'module', reference: 'sync_bits' });
    const deep = net(d, 'io_subsystem/sensor_block', 'data_sync_0_dout');
    expect(endpointPaths(deep)).toEqual([
      'io_subsystem/sensor_block/data_sync_0/dout',
      'io_subsystem/sensor_block/xlslice_0/Din',
      'io_subsystem/sensor_block/xlslice_1/Din',
    ]);
    // Middle level: child hier pin and own boundary pin.
    expect(endpointPaths(net(d, 'io_subsystem', 'sensor_data_1'))).toEqual(['io_subsystem/sensor_block/sensor_data', 'io_subsystem/sensor_data']);
  });

  it('declares interrupt, clock and vector pins on hierarchies', () => {
    expect(findPin(d, 'io_subsystem/sensor_block/alarm')).toMatchObject({ dir: 'O', type: 'intr' });
    expect(findPin(d, 'io_subsystem/sensor_data')).toMatchObject({ dir: 'I', from: 15, to: 0 });
    expect(findPin(d, 'dsp_chain/aclk')).toMatchObject({ type: 'clk' });
  });

  it('keeps interface port properties and -freq_hz', () => {
    const streamIn = d.intfPorts.find((p) => p.name === 'stream_in');
    expect(streamIn).toMatchObject({ mode: 'Slave', vlnv: 'xilinx.com:interface:axis_rtl:1.0' });
    expect(streamIn?.properties).toEqual({ 'CONFIG.FREQ_HZ': '100000000', 'CONFIG.HAS_TLAST': '1', 'CONFIG.TDATA_NUM_BYTES': '4' });
    expect(d.ports.find((p) => p.name === 'ext_clk')?.properties).toEqual({ 'CONFIG.FREQ_HZ': '50000000' });
    expect(d.ports.find((p) => p.name === 'reset')?.properties).toEqual({ 'CONFIG.POLARITY': 'ACTIVE_HIGH' });
  });

  it('connects interface nets and infers interface pin modes', () => {
    const gpio = net(d, 'io_subsystem', 'Conn1');
    expect(gpio.kind).toBe('interface');
    expect(gpio.endpoints).toEqual([
      { path: 'io_subsystem/S_AXI_GPIO0', kind: 'intfPin' },
      { path: 'io_subsystem/axi_gpio_0/S_AXI', kind: 'intfPin' },
    ]);
    const mode = (p: string) => (findPin(d, p) as IntfPin | undefined)?.mode;
    // Pass-through from a hier boundary pin keeps the mode.
    expect(mode('io_subsystem/axi_gpio_0/S_AXI')).toBe('Slave');
    // Facing a hier pin from outside flips it.
    expect(mode('microblaze_0_axi_periph/M00_AXI')).toBe('Master');
    // Top-level ports pass their mode to the pin they drive.
    expect(mode('clk_wiz_0/CLK_IN1_D')).toBe('Slave');
    expect(mode('axi_uartlite_0/UART')).toBe('Master');
    // Mirrored LMB bus: hier pin is MirroredMaster, the processor side is Master.
    expect(mode('microblaze_0/DLMB')).toBe('Master');
    expect(mode('microblaze_0_local_memory/dlmb_v10/LMB_M')).toBe('MirroredMaster');
    expect(findPin(d, 'io_subsystem/axi_gpio_0/S_AXI')).toMatchObject({ inferred: true, vlnv: 'xilinx.com:interface:aximm_rtl:1.0' });
  });

  it('merges a wide clock net into one net with every endpoint', () => {
    const clk = net(d, '', 'microblaze_0_Clk');
    expect(clk.endpoints).toHaveLength(16);
    expect(clk.endpoints[0]).toEqual({ path: 'clk_wiz_0/clk_out1', kind: 'pin' });
    expect(clk.loc?.endLine).toBe((clk.loc?.line ?? 0) + 15);
  });

  it('records address assignments', () => {
    expect(d.addressAssignments).toHaveLength(7);
    expect(d.addressAssignments[2]).toMatchObject({
      masterSpace: 'microblaze_0/Data',
      slaveSegment: 'io_subsystem/axi_gpio_0/S_AXI/Reg',
      offset: '0x40000000',
      range: '0x00010000',
    });
    expect(d.addressAssignments[1].masterSpace).toBe('microblaze_0/Instruction');
    expect(d.addressAssignments[3].loc?.line).toBe(lineOf(text, '-with_name SEG_axi_gpio_1_Reg'));
  });

  it('runs well under the time budget', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) parseVivadoBdTcl(text, 'soc.tcl');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('edge-cases.tcl', () => {
  const text = read('edge-cases.tcl');
  const d = parseVivadoBdTcl(text, 'edge-cases.tcl');

  it('parses cleanly and picks up board / part metadata', () => {
    expect(d.diagnostics).toEqual([]);
    expect(d.tool).toEqual({ name: 'Vivado', version: '2023.2', part: 'xc7z020clg400-1', board: 'example.com:demo_board:part0:1.0' });
    expect(countKinds(d)).toEqual({ ip: 3, module: 1, hier: 1 });
  });

  it('handles semicolon-separated commands and unusual spacing', () => {
    expect(getCell(d, 'ctrl')?.pins.map((p) => p.name)).toEqual(['aclk', 'aresetn', 'irq', 'status']);
    expect(findPin(d, 'ctrl/irq')).toMatchObject({ dir: 'O', type: 'intr' });
    expect(findPin(d, 'irq_out')).toMatchObject({ dir: 'O', type: 'intr' });
    expect(d.ports.find((p) => p.name === 'clk_in')?.properties).toEqual({ 'CONFIG.FREQ_HZ': '125000000' });
    expect(getCell(d, 'ctrl/axi_gpio_0')?.properties['CONFIG.C_INTERRUPT_PRESENT']).toBe('1');
  });

  it('resolves ${var} forms and set_property on get_bd_cells / get_bd_intf_ports', () => {
    expect(getCell(d, 'axi_iic_0')?.properties).toEqual({ 'CONFIG.IIC_FREQ_KHZ': '400' });
    expect(d.intfPorts[0]).toMatchObject({ name: 'iic', mode: 'Master', properties: { 'CONFIG.BOARD.ASSOCIATED_PARAM': 'IIC_BOARD_INTERFACE' } });
    expect(endpointPaths(net(d, '', 'iic_1'))).toEqual(['axi_iic_0/IIC', 'iic']);
  });

  it('resolves absolute paths and multi-pin get_bd_pins calls', () => {
    expect(endpointPaths(net(d, 'ctrl', 'ctrl_clk'))).toEqual(['ctrl/aclk', 'ctrl/axi_gpio_0/s_axi_aclk']);
    expect(endpointPaths(net(d, 'ctrl', 'ctrl_rst'))).toEqual(['ctrl/aresetn', 'ctrl/axi_gpio_0/s_axi_aresetn']);
    expect(endpointPaths(net(d, '', 'clk_net'))).toEqual([
      'axi_iic_0/s_axi_aclk',
      'clk_in',
      'ctrl/aclk',
      'my_filter_0/clk',
      'rst_0/slowest_sync_clk',
    ]);
    const start = lineOf(text, 'connect_bd_net -net clk_net');
    expect(net(d, '', 'clk_net').loc).toMatchObject({ line: start, endLine: start + 3 });
  });

  it('synthesizes names for nets without -net / -intf_net', () => {
    expect(net(d, 'ctrl', 'axi_gpio_0_ip2intc_irpt').endpoints.map((e) => e.path)).toEqual([
      'ctrl/axi_gpio_0/ip2intc_irpt',
      'ctrl/irq',
    ]);
    expect(net(d, 'ctrl', 'S_AXI').kind).toBe('interface');
  });

  it('records the address assignment and ignores exclusions', () => {
    expect(d.addressAssignments).toEqual([
      expect.objectContaining({ masterSpace: 'my_filter_0/m_axi', slaveSegment: 'axi_iic_0/S_AXI/Reg', offset: '0x41600000' }),
    ]);
  });
});

describe('robustness', () => {
  it('reports unknown commands once as info', () => {
    const d = parseVivadoBdTcl('create_bd_design x\nfrobnicate 1\nfrobnicate 2\ncreate_bd_cell -type ip -vlnv a:b:c:1.0 c0', 'x.tcl');
    expect(d.cells).toHaveLength(1);
    expect(d.diagnostics).toEqual([expect.objectContaining({ severity: 'info', loc: { file: 'x.tcl', line: 2 } })]);
  });

  it('warns about nets with no endpoints and unknown cells', () => {
    const d = parseVivadoBdTcl('create_bd_design x\nconnect_bd_net -net empty\nconnect_bd_net -net n [get_bd_pins ghost/o] [get_bd_ports nope]', 'x.tcl');
    expect(d.nets.map((n) => n.name)).toEqual(['n']);
    expect(d.diagnostics.filter((x) => x.severity === 'warning')).toHaveLength(3);
  });

  it('never throws on malformed input', () => {
    const d = parseVivadoBdTcl('create_bd_design x\nset a {unterminated', 'bad.tcl');
    expect(d.name).toBe('bad');
    expect(d.diagnostics[0].severity).toBe('error');
    const d2 = parseVivadoBdTcl('create_bd_design y\ncreate_bd_cell -type ip -vlnv a:b:c:1.0 c0\nproc p {} { set x [unterminated }\np', 'p.tcl');
    expect(d2.cells).toHaveLength(1);
    expect(d2.diagnostics.some((x) => x.severity === 'error')).toBe(true);
  });

  it('records send_gid_msg errors', () => {
    const d = parseVivadoBdTcl('catch {common::send_gid_msg -ssname BD::TCL -id 1 -severity "ERROR" "bad thing"}', 'e.tcl');
    expect(d.diagnostics).toEqual([{ severity: 'error', message: 'bad thing', loc: { file: 'e.tcl', line: 1 } }]);
  });

  it('supports the legacy create_bd_addr_seg form', () => {
    const d = parseVivadoBdTcl(
      'create_bd_design x\ncreate_bd_addr_seg -range 0x10000 -offset 0x40000000 [get_bd_addr_spaces cpu/Data] [get_bd_addr_segs gpio/S_AXI/Reg] SEG_gpio_Reg',
      'x.tcl',
    );
    expect(d.addressAssignments).toEqual([
      expect.objectContaining({ masterSpace: 'cpu/Data', slaveSegment: 'gpio/S_AXI/Reg', offset: '0x40000000', range: '0x10000' }),
    ]);
  });
});
