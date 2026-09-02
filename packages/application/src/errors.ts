export type ApplicationErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_cursor"
  | "validation"
  | "forbidden"
  | "idempotency_conflict"
  | "quota_exceeded"
  | "unsupported_media"
  | "upload_expired"
  | "project_removed"
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

/**
 * Safe details for deterministic create collisions. Keep the target explicit
 * enough for an agent to choose its next action, while never returning the
 * conflicting record or a storage-engine error.
 */
export function stableCreateConflict(
  reason: "project_id_exists" | "revision_id_exists" | "project_name_exists",
  field: "projectId" | "revisionId" | "projectName",
  id: string,
  message: string,
  commandId?: string,
): ApplicationError {
  return new ApplicationError("conflict", message, {
    reason,
    field,
    id,
    retryable: false,
    commitState: "not_committed",
    ...(commandId === undefined ? {} : { commandId }),
  });
}

export function projectRemoved(projectId: string, details?: Readonly<Record<string, unknown>>): ApplicationError {
  return new ApplicationError("project_removed", `Project '${projectId}' has been removed from the workspace`, { entity: "Project", id: projectId, ...details });
}
