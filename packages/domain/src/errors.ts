export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function assertPositiveQuantity(quantity: number, field = "quantity"): void {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new DomainError("invalid_quantity", `${field} must be a finite value greater than zero`);
  }
}

export function assertNonNegativeQuantity(quantity: number, field = "quantity"): void {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new DomainError("invalid_quantity", `${field} must be a finite value greater than or equal to zero`);
  }
}
