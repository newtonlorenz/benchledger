export type ApplicationErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "forbidden"
  | "idempotency_conflict"
  | "quota_exceeded"
  | "unsupported_media"
  | "upload_expired"
  | "integrity_error";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ApplicationErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): ApplicationError {
  return new ApplicationError("not_found", `${entity} '${id}' was not found`, { entity, id });
}

export function conflict(message: string, details?: Readonly<Record<string, unknown>>): ApplicationError {
  return new ApplicationError("conflict", message, details);
}
