/**
 * Name-based heuristics for pins whose direction or interface mode the source
 * did not state. Exported block-design scripts never declare pins of packaged
 * IP, so the adapter marks them `inferred` with no direction. These helpers
 * give the renderer a sensible side to place them on and let the diff engine
 * stay agnostic. They are guesses: callers must treat the result as a hint.
 */
import type { Cell, IntfMode, IntfPin, Pin, PinDirection } from './types';

/**
 * Names that are unambiguous even when a broader pattern of the opposite
 * direction would also match (e.g. `M00_AXI_ARESETN` is a reset input although
 * it starts like a master AXI signal; `peripheral_aresetn` is a reset output
 * although it ends like a reset input). Checked in this order:
 * strong outputs, strong inputs, general outputs, general inputs.
 */
const STRONG_OUTPUT_PATTERNS: RegExp[] = [
  /^clk_out/i, // clk_out1, clk_out2_ce
  /(^|_)(peripheral|interconnect|bus_struct|mb)_(aresetn|reset|resetn)$/i,
  /(^|_)(?<!dcm_)locked$/i, // clk_wiz locked, mmcm_locked (but not dcm_locked)
  /^debug_sys_rst$/i, // debug module reset request
];

const STRONG_INPUT_PATTERNS: RegExp[] = [
  /(^|_)a?clk(_?in)?\d*$/i, // aclk, clk, s_axi_aclk, M00_ACLK, clk_in1
  /(^|_)clk_in\d*$/i,
  /(^|_)a?rst(n)?$/i, // rst, rstn, arst
  /(^|_)a?reset(n)?(_in)?$/i, // aresetn, reset, ext_reset_in
  /ext_reset_in$/i,
  /(^|_)dcm_locked$/i,
  /(^|_)slowest_sync_clk$/i,
  /^(aux_reset_in|mb_debug_sys_rst)$/i,
];

const OUTPUT_PATTERNS: RegExp[] = [
  /^(m|m\d+)_?axi/i,
  /_out(\d+)?$/i,
  /out\d*$/i, // clkout1, dataout
  /(^|_)(o|dout|q)\d*$/i, // gpio_io_o, dout, q
  /_o_/i, // gpio_o_n style
  /^(data_out|m_axis.*)$/i,
  /^mb_reset$/i,
  /(^|_)(interrupt|irq|irpt)$/i, // interrupt, ip2intc_irpt (intr is an input, see below)
  /^res$/i, // util_vector_logic
  /^(valid_out|ready_out)$/i,
  /(^|_)txd?$/i, // uart tx / txd
];

const INPUT_PATTERNS: RegExp[] = [
  /^(s|s\d+)_?axi/i, // slave AXI signals such as s_axi_awvalid
  /_in(\d+)?$/i,
  /(^|_)(i|din|d)\d*$/i, // gpio_io_i, din, d
  /_i_/i,
  /^(data_in|s_axis.*)$/i,
  /^(ce|en|enable|we|wen|valid_in|ready_in)$/i,
  /^(interrupt|intr|irq)_in$/i,
  /^intr$/i, // interrupt controller input vector
  /^in\d+$/i, // xlconcat In0, In1 ...
  /^(op1|op2)$/i, // util_vector_logic
  /(^|_)rxd?$/i, // uart rx / rxd
];

/** Direction implied by the pin name alone, or undefined. */
export function guessDirectionFromName(name: string): PinDirection | undefined {
  if (STRONG_OUTPUT_PATTERNS.some((r) => r.test(name))) return 'O';
  if (STRONG_INPUT_PATTERNS.some((r) => r.test(name))) return 'I';
  if (OUTPUT_PATTERNS.some((r) => r.test(name))) return 'O';
  if (INPUT_PATTERNS.some((r) => r.test(name))) return 'I';
  return undefined;
}

/**
 * Hints a caller learned from the nets a pin sits on. A declared driver on the
 * same net is strong evidence (a net has one driver) and overrides the name;
 * a declared sink is weak evidence and is used only when the name says nothing.
 */
export interface SiblingHints {
  netHasDeclaredDriver?: boolean;
  netHasDeclaredSink?: boolean;
}

/**
 * Best-effort direction for a pin. Declared directions are returned as-is,
 * then the pin `-type`, then `siblingHints.netHasDeclaredDriver`, then the
 * name, then `siblingHints.netHasDeclaredSink`.
 */
export function guessPinDirection(pin: Pin, _cell?: Cell, siblingHints?: SiblingHints): PinDirection | undefined {
  if (pin.dir) return pin.dir;
  if (pin.type === 'clk' || pin.type === 'rst' || pin.type === 'ce' || pin.type === 'clkEn') return 'I';
  if (pin.type === 'intr') return 'O';
  if (siblingHints?.netHasDeclaredDriver) return 'I';
  const byName = guessDirectionFromName(pin.name);
  if (byName) return byName;
  if (siblingHints?.netHasDeclaredSink) return 'O';
  return undefined;
}

/** Best-effort interface mode from the pin name (s_axi -> Slave, M00_AXI -> Master). */
export function guessIntfMode(pin: IntfPin): IntfMode | undefined {
  if (pin.mode) return pin.mode;
  const n = pin.name;
  if (/^(s|s\d+)_/i.test(n) || /^s\d*_?axi/i.test(n) || /_(s|slave)$/i.test(n)) return 'Slave';
  if (/^(m|m\d+)_/i.test(n) || /^m\d*_?axi/i.test(n) || /_(m|master)$/i.test(n)) return 'Master';
  if (/^(clk|clock)_in|_clk_in$|^diff_clock|^sys_clk|^default_sysclk/i.test(n)) return 'Slave';
  if (/(rx|in)$/i.test(n)) return 'Slave';
  if (/(tx|out)$/i.test(n)) return 'Master';
  return undefined;
}

/** Which side of a block an interface pin should sit on. */
export function intfModeSide(mode: IntfMode | undefined): 'west' | 'east' | undefined {
  switch (mode) {
    case 'Slave':
    case 'MirroredMaster':
      return 'west';
    case 'Master':
    case 'MirroredSlave':
      return 'east';
    default:
      return undefined;
  }
}
