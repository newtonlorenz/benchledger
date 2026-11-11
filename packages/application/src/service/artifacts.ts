import { ApplicationError, notFound } from "../errors.js";
import type { ArtifactDownload, BeginUploadInput, Mutation, RequestContext, UploadSessionDetails } from "../ports.js";
import { buildConfigurationPort, requireId } from "./shared.js";
import { artifactListQuerySchema, beginUploadSchema } from "@benchledger/api-contract";
import type { BeginUpload as ApiBeginUpload, Artifact, ArtifactListQuery, UploadSession } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const ALLOWED_ARTIFACT_MEDIA = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "application/octet-stream",
  "application/json", "application/zip", "application/x-zip-compressed", "image/svg+xml",
  "model/step", "model/stl", "model/gltf-binary", "application/x-kicad-pcb", "application/vnd.ms-package.3dmanufacturing-3mf"
]);

// ZIP source bundles stay opaque; SVG drawings are never executed or inlined.
// Downloads are authenticated attachments and SVG previews use escaped text.
export const DISALLOWED_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".exe", ".sh", ".tar", ".gz"]);

export function safeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed || trimmed.length > 255 || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new ApplicationError("validation", "Filename must be a single safe relative name");
  }
  const dot = trimmed.lastIndexOf(".");
  const extension = dot >= 0 ? trimmed.slice(dot).toLowerCase() : "";
  if (DISALLOWED_EXTENSIONS.has(extension)) {
    throw new ApplicationError("unsupported_media", "This file type is not accepted");
  }
  return trimmed;
}

/**
 * Translate the strict public upload shape to the storage-facing shape used by
 * existing artifact adapters. Every application caller must cross the strict
 * public revisioned contract before this normalization step.
 */
export function normalizeArtifactUpload(input: ApiBeginUpload): BeginUploadInput {
  const result = beginUploadSchema.safeParse(input);
  if (!result.success) {
    throw new ApplicationError("validation", "Artifact upload must contain exactly one revisioned scope", { issues: result.error.issues });
  }
  const parsed = result.data;
  if ("projectRevisionId" in parsed) {
    const { projectRevisionId, buildConfigurationSnapshotId, ...rest } = parsed;
    return {
      ...rest,
      revisionId: projectRevisionId,
      ...(buildConfigurationSnapshotId === undefined ? {} : { buildConfigurationSnapshotId }),
    } as BeginUploadInput;
  }
  const { workItemId, workItemRevisionId, ...rest } = parsed;
  return { ...rest, workItemId, revisionId: workItemRevisionId } as BeginUploadInput;
}

/** Project artifact uploads, downloads and retirement with verified ancestry. */
export class ArtifactModule extends ServiceModule {
  async listArtifacts(projectId: string, query?: ArtifactListQuery) {
    const parsedProjectId = requireId(projectId, "project id");
    await this.assertProjectReadable(parsedProjectId);
    const parsedQuery = artifactListQuerySchema.parse(query ?? {});
    let workItemId: string | undefined;
    let revisionId: string | undefined;
    if ("projectRevisionId" in parsedQuery) {
      const revision = await this.ports.projects.getProjectRevision(parsedQuery.projectRevisionId);
      const collidingWorkRevision = await this.ports.projects.getWorkItemRevision(parsedQuery.projectRevisionId);
      if (revision === null || revision.projectId !== parsedProjectId || collidingWorkRevision !== null) {
        throw notFound("Project revision", parsedQuery.projectRevisionId);
      }
      revisionId = parsedQuery.projectRevisionId;
    } else if ("workItemRevisionId" in parsedQuery) {
      const workItem = await this.ports.projects.getWorkItem(parsedQuery.workItemId);
      const revision = await this.ports.projects.getWorkItemRevision(parsedQuery.workItemRevisionId);
      const collidingProjectRevision = await this.ports.projects.getProjectRevision(parsedQuery.workItemRevisionId);
      if (workItem === null || workItem.projectId !== parsedProjectId || revision === null || revision.projectId !== parsedProjectId || revision.workItemId !== parsedQuery.workItemId || collidingProjectRevision !== null) {
        throw notFound("Work-item revision", parsedQuery.workItemRevisionId);
      }
      workItemId = parsedQuery.workItemId;
      revisionId = parsedQuery.workItemRevisionId;
    }
    const artifacts = await this.ports.unitOfWork.exclusive(() => this.ports.artifacts.listArtifacts(parsedProjectId, workItemId, revisionId));
    return parsedQuery.role === undefined ? artifacts : artifacts.filter((artifact) => artifact.role === parsedQuery.role);
  }

  async getArtifact(id: string) {
    return this.ports.unitOfWork.exclusive(async () => {
      const artifact = await this.ports.artifacts.getArtifact(requireId(id, "artifact id"));
      if (!artifact) throw notFound("Artifact", id);
      await this.assertProjectReadable(artifact.projectId);
      return artifact;
    });
  }

  async getUploadSessionDetails(id: string): Promise<UploadSessionDetails> {
    return this.ports.unitOfWork.exclusive(async () => {
      const details = await this.ports.artifacts.getUploadSessionDetails(requireId(id, "upload session id"));
      if (!details) throw notFound("Upload session", id);
      await this.assertProjectReadable(details.projectId);
      return details;
    });
  }

  async beginArtifactUpload(input: ApiBeginUpload, ctx: RequestContext): Promise<Mutation<UploadSession>> {
    const normalizedInput = normalizeArtifactUpload(input);
    // Validate ancestry before entering mutate(): malformed/cross-project
    // requests must not create a session, audit row, or idempotency record.
    await this.assertArtifactAncestry(normalizedInput);
    if (normalizedInput.byteSize <= 0 || normalizedInput.byteSize > MAX_UPLOAD_BYTES) throw new ApplicationError("quota_exceeded", "Upload exceeds the per-file limit");
    const filename = safeFilename(normalizedInput.filename);
    if (!ALLOWED_ARTIFACT_MEDIA.has(normalizedInput.mediaType) && !normalizedInput.mediaType.startsWith("text/")) {
      throw new ApplicationError("unsupported_media", "This media type is not accepted");
    }
    const normalized = { ...normalizedInput, filename };
    return this.mutate(ctx, "artifact.upload.begin", "project", normalized.projectId, async () => {
      const session = await this.ports.artifacts.beginUpload(normalized, ctx);
      return {
        value: session,
        entityId: session.id,
        compensate: async () => {
          if (this.ports.artifacts.abortUpload === undefined) {
            throw new ApplicationError("integrity_error", "The artifact upload adapter cannot compensate an uncommitted session");
          }
          await this.ports.artifacts.abortUpload(session.id);
        }
      };
    });
  }

  async writeArtifactUpload(sessionId: string, body: Uint8Array, expectedOffset?: number) {
    if (expectedOffset !== undefined && (!Number.isSafeInteger(expectedOffset) || expectedOffset < 0)) throw new ApplicationError("validation", "Upload offset must be a non-negative integer");
    requireId(sessionId, "upload session id");
    if (body.byteLength > MAX_UPLOAD_BYTES) throw new ApplicationError("quota_exceeded", "Upload exceeds the per-file limit");
    return this.ports.unitOfWork.exclusive(() => this.ports.artifacts.writeUpload(sessionId, body, expectedOffset));
  }

  async finalizeArtifactUpload(sessionId: string, ctx: RequestContext): Promise<Mutation<Artifact>> {
    const id = requireId(sessionId, "upload session id");
    let finalizedArtifactId: string | undefined;
    let createdFinalization = false;
    const mutation = await this.mutate(ctx, "artifact.upload.finalize", "upload_session", id, async () => {
      const upload = await this.ports.artifacts.getUploadSessionDetails(id);
      if (upload === null) throw notFound("Upload session", id);
      await this.assertProjectActive(upload.projectId);
      // A finalized session may be retried with another idempotency key after
      // its original database transaction committed. It may still have a
      // process-local filesystem receipt if post-commit cleanup failed, but a
      // later transaction must never own compensation for that already
      // committed artifact.
      createdFinalization = upload.session.status !== "finalized";
      const snapshotId = upload.buildConfigurationSnapshotId;
      if (snapshotId !== undefined) {
        if (upload.revisionId === undefined || upload.workItemId !== undefined) {
          throw new ApplicationError("validation", "A build configuration can only bind to a project-revision upload");
        }
        const configurations = buildConfigurationPort(this.ports);
        const snapshot = await configurations.getBuildConfiguration(snapshotId);
        if (snapshot === null) throw notFound("Build configuration", snapshotId);
        if (snapshot.projectRevisionId !== upload.revisionId) {
          throw new ApplicationError("validation", "The build configuration snapshot does not belong to the upload revision");
        }
        const revision = await this.ports.projects.getProjectRevision(upload.revisionId);
        if (revision === null || revision.projectId !== upload.projectId) {
          throw new ApplicationError("validation", "The build configuration snapshot is not in the upload project ancestry");
        }
        if (this.ports.artifacts.bindBuildConfiguration === undefined) {
          throw new ApplicationError("integrity_error", "The artifact adapter cannot persist build configuration bindings");
        }
      }
      let artifact: Artifact;
      try {
        artifact = await this.ports.artifacts.finalizeUpload(id, ctx);
        finalizedArtifactId = artifact.id;
        if (snapshotId !== undefined) {
          await this.ports.artifacts.bindBuildConfiguration!({ artifactId: artifact.id, buildConfigurationSnapshotId: snapshotId, projectRevisionId: upload.revisionId! });
        }
      } catch (error: unknown) {
        // Binding is part of this operation, so a failure happens before the
        // normal mutate() compensation receipt can be registered. Roll back a
        // filesystem finalization immediately only when this invocation
        // created it; a finalized session belongs to an earlier committed
        // operation and must remain visible.
        if (finalizedArtifactId !== undefined && createdFinalization) {
          if (this.ports.artifacts.rollbackFinalization === undefined) {
            throw new ApplicationError("integrity_error", "Artifact finalization failed and cannot be compensated");
          }
          try {
            await this.ports.artifacts.rollbackFinalization(id, finalizedArtifactId);
          } catch {
            throw new ApplicationError("integrity_error", "Artifact finalization failed and could not be compensated");
          }
        }
        throw error;
      }
      return {
        value: artifact,
        entityId: artifact.id,
        version: artifact.version,
        ...(createdFinalization ? {
          compensate: async () => {
            if (this.ports.artifacts.rollbackFinalization !== undefined) await this.ports.artifacts.rollbackFinalization(id, artifact.id);
          }
        } : {})
      };
    });
    // The artifact store keeps a process-local compensation receipt until the
    // surrounding SQLite transaction has committed. A post-commit cleanup
    // failure is recoverable: an idempotency replay still has the committed
    // artifact in its result, so retry receipt closure for every successful
    // return rather than only for the operation that created the artifact.
    await this.ports.artifacts.commitFinalization?.(id, mutation.data.id);
    return mutation;
  }

  async readArtifact(id: string): Promise<ArtifactDownload> {
    const artifactId = requireId(id, "artifact id");
    await this.getArtifact(artifactId);
    return this.ports.unitOfWork.exclusive(() => this.ports.artifacts.readArtifact(artifactId));
  }

  async retireArtifact(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Artifact>> {
    const artifactId = requireId(id, "artifact id");
    return this.mutate(ctx, "artifact.retire", "artifact", artifactId, async () => {
      const existing = await this.ports.artifacts.getArtifact(artifactId);
      if (existing === null) throw notFound("Artifact", artifactId);
      await this.assertProjectActive(existing.projectId);
      const artifact = await this.ports.artifacts.retireArtifact(artifactId, expectedVersion, ctx);
      return { value: artifact, entityId: artifact.id, version: artifact.version };
    });
  }

  private async assertArtifactAncestry(input: BeginUploadInput): Promise<void> {
    const projectId = requireId(input.projectId, "project id");
    await this.assertProjectActive(projectId);

    if (input.workItemId !== undefined) {
      const workItemId = requireId(input.workItemId, "work item id");
      const workItem = await this.ports.projects.getWorkItem(workItemId);
      if (workItem === null || workItem.projectId !== projectId) throw notFound("Work item", workItemId);
    }

    if (input.buildConfigurationSnapshotId !== undefined && (input.revisionId === undefined || input.workItemId !== undefined)) {
      throw new ApplicationError("validation", "A build configuration can only bind to a project-revision upload");
    }
    if (input.revisionId === undefined) {
      throw new ApplicationError("validation", "Artifact upload must be anchored to exactly one revisioned scope");
    }
    const revisionId = requireId(input.revisionId, "revision id");
    const projectRevision = await this.ports.projects.getProjectRevision(revisionId);
    const workItemRevision = await this.ports.projects.getWorkItemRevision(revisionId);
    if (input.workItemId === undefined) {
      if (projectRevision === null || projectRevision.projectId !== projectId || workItemRevision !== null) {
        throw notFound("Project revision", revisionId);
      }
      if (input.buildConfigurationSnapshotId !== undefined) {
        const snapshot = await buildConfigurationPort(this.ports).getBuildConfiguration(requireId(input.buildConfigurationSnapshotId, "build configuration id"));
        if (snapshot === null) throw notFound("Build configuration", input.buildConfigurationSnapshotId);
        if (snapshot.projectRevisionId !== revisionId) throw new ApplicationError("validation", "The build configuration snapshot does not belong to the upload revision");
      }
      return;
    }

    if (
      workItemRevision === null ||
      workItemRevision.projectId !== projectId ||
      workItemRevision.workItemId !== input.workItemId ||
      projectRevision !== null
    ) {
      throw notFound("Work-item revision", revisionId);
    }
  }
}
