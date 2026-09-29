import { describe, expect, it } from 'vitest';
import { guessDirectionFromName, guessIntfMode, guessPinDirection, intfModeSide } from '../src/model/heuristics';

const pin = (name: string, extra: Partial<{ dir: 'I' | 'O' | 'IO'; type: string }> = {}) => ({
  name,
  path: `c/${name}`,
  ...extra,
});

describe('guessPinDirection', () => {
  it('keeps declared directions', () => {
    expect(guessPinDirection(pin('anything', { dir: 'O' }))).toBe('O');
  });
  it('uses the -type when present', () => {
    expect(guessPinDirection(pin('x', { type: 'clk' }))).toBe('I');
    expect(guessPinDirection(pin('x', { type: 'intr' }))).toBe('O');
  });
  it('recognises common input names', () => {
    for (const n of ['s_axi_aclk', 'aclk', 'aresetn', 'clk_in1', 'ext_reset_in', 'In0', 'slowest_sync_clk', 'S00_AXI_ARESETN'])
      expect(guessPinDirection(pin(n)), n).toBe('I');
  });
  it('recognises common output names', () => {
    for (const n of ['dout', 'clk_out1', 'locked', 'peripheral_aresetn', 'interconnect_aresetn', 'ip2intc_irpt', 'm_axi_awvalid', 'Res'])
      expect(guessPinDirection(pin(n)), n).toBe('O');
  });
  it('recognises GPIO / UART / suffix style names', () => {
    for (const n of ['gpio_io_o', 'gpio2_io_o', 'clkout1', 'uart_txd', 'tx', 'mmcm_locked', 'axi_intc_irq', 'mb_reset', 'bus_struct_reset', 'x_o_n', 'Debug_SYS_Rst'])
      expect(guessDirectionFromName(n), n).toBe('O');
    for (const n of ['gpio_io_i', 'din', 'uart_rxd', 'rx', 'dcm_locked', 'x_i_n', 'M00_ACLK', 'M00_ARESETN', 'm_axi_aclk', 'reset', 'intr', 'processor_rst', 'mb_debug_sys_rst'])
      expect(guessDirectionFromName(n), n).toBe('I');
    expect(guessDirectionFromName('gpio_io_t')).toBeUndefined();
  });
  it('lets a declared driver on the net override the name', () => {
    // e.g. a processor's Interrupt input fed by an interrupt controller
    expect(guessPinDirection(pin('Interrupt'))).toBe('O');
    expect(guessPinDirection(pin('Interrupt'), undefined, { netHasDeclaredDriver: true })).toBe('I');
    // a declared sink only helps when the name says nothing
    expect(guessPinDirection(pin('s_axi_aclk'), undefined, { netHasDeclaredSink: true })).toBe('I');
  });
  it('falls back to net hints, then undefined', () => {
    expect(guessPinDirection(pin('mystery'), undefined, { netHasDeclaredDriver: true })).toBe('I');
    expect(guessPinDirection(pin('mystery'), undefined, { netHasDeclaredSink: true })).toBe('O');
    expect(guessPinDirection(pin('mystery'))).toBeUndefined();
  });
});

describe('guessIntfMode', () => {
  it('maps AXI naming to modes and sides', () => {
    expect(guessIntfMode({ name: 's_axi', path: 'c/s_axi' })).toBe('Slave');
    expect(guessIntfMode({ name: 'S00_AXI', path: 'c/S00_AXI' })).toBe('Slave');
    expect(guessIntfMode({ name: 'M03_AXI', path: 'c/M03_AXI' })).toBe('Master');
    expect(guessIntfMode({ name: 'CLK_IN_D', path: 'c/CLK_IN_D' })).toBe('Slave');
    expect(guessIntfMode({ name: 'GT_SERIAL_TX', path: 'c/GT_SERIAL_TX' })).toBe('Master');
    expect(intfModeSide('Slave')).toBe('west');
    expect(intfModeSide('Master')).toBe('east');
    expect(intfModeSide(undefined)).toBeUndefined();
  });
  it('keeps declared modes', () => {
    expect(guessIntfMode({ name: 'm_axi', path: 'c/m_axi', mode: 'Slave' })).toBe('Slave');
  });
});
