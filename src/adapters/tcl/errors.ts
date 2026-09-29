/** Control-flow signals and errors used by the Tcl interpreter. */

/** A Tcl-level error (return code 1). Catchable by `catch`. */
export class TclError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
    this.name = 'TclError';
  }
}

/** Unrecoverable interpreter condition (step limit, recursion). Not catchable by `catch`. */
export class TclFatalError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
    this.name = 'TclFatalError';
  }
}

/** `return` (code 2). */
export class ReturnSignal {
  constructor(
    readonly value: string,
    readonly line: number,
  ) {}
}

/** `break` (code 3). */
export class BreakSignal {}

/** `continue` (code 4). */
export class ContinueSignal {}
