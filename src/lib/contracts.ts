// Errors the app expects and can explain: provider refusals, limits, bad input.
export class GateError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}
