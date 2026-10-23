import type { ErrorBody, ErrorCode } from "../shared/contracts.ts";

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details && { details: this.details }) } };
  }
}
