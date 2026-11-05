export class CareerEngineError extends Error {
  constructor(public code: string, public params: Record<string, string | number> = {}) {
    super(code);
    this.name = "CareerEngineError";
  }
}
