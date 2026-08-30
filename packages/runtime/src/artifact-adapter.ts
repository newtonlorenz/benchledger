import type { ArtifactStore, ArtifactRevision, UploadSession as StoreUploadSession } from "@benchledger/artifacts";
import type { Artifact as ApiArtifact, UploadSession as ApiUploadSession } from "@benchledger/api-contract";
import { ArtifactBuildConfigurationBindingRepository } from "@benchledger/database";
import type { ArtifactBuildConfigurationBinding } from "@benchledger/api-contract";
import type { ArtifactDownload, ArtifactPort, BeginUploadInput, Page, RequestContext, UnitOfWorkPort, UploadSessionDetails } from "@benchledger/application";
import { ApplicationError } from "@benchledger/application";
import { RuntimeState } from "./persistence.js";
import { apiArtifactFromStore, apiUploadSessionFromStore } from "./mappers.js";
import { attempt, clone, nowIso, page, resultValue } from "./utils.js";

const ARTIFACT = "artifact";
const UPLOAD = "upload_session";

function metadataFor(state: RuntimeState, artifact: ArtifactRevision): { readonly author?: string; readonly machineBinding?: Readonly<Record<string, string>>; readonly retired?: boolean } {
  const value = state.getMetadata(ARTIFACT, artifact.artifactId);
  const machineBindingValue = value.machineBinding;
  const machineBinding = machineBindingValue !== null && typeof machineBindingValue === "object" && !Array.isArray(machineBindingValue)
    ? Object.fromEntries(Object.entries(machineBindingValue).filter(([, candidate]) => typeof candidate === "string")) as Readonly<Record<string, string>>
    : undefined;
  return {
    ...(typeof value.author === "string" ? { author: value.author } : {}),
    ...(machineBinding === undefined ? {} : { machineBinding }),
    ...(value.retired === true ? { retired: true } : {})
  };
}

export class ProductionArtifactAdapter implements ArtifactPort {
  constructor(
    private readonly store: ArtifactStore,
    private readonly state: RuntimeState,
    private readonly unitOfWork: Pick<UnitOfWorkPort, "exclusive">,
    private readonly bindings?: ArtifactBuildConfigurationBindingRepository,
  ) {}

  async listArtifacts(projectId: string, workItemId?: string, revisionId?: string): Promise<readonly ApiArtifact[]> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      const listed = resultValue(await this.store.listArtifactRevisions());
      return listed.filter((artifact) => artifact.projectId === projectId && (workItemId === undefined || artifact.workItemId === workItemId) && (revisionId === undefined || artifact.revisionId === revisionId)).map((artifact) => this.toApi(artifact));
    }));
  }

  async getArtifact(id: string): Promise<ApiArtifact | null> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      const found = await this.findArtifact(id);
      return found === undefined ? null : this.toApi(found);
    }));
  }

  async getUploadSessionDetails(id: string): Promise<UploadSessionDetails | null> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      const result = await this.store.getUploadSession(id);
      // The application port treats a missing session as a nullable lookup;
      // preserve other store failures so callers still receive validation or
      // integrity errors rather than silently treating them as absent.
      if (!result.ok && result.error.code === "NOT_FOUND") return null;
      const session = resultValue(result);
      const uploadMetadata = this.state.getMetadata(UPLOAD, id);
      return {
        session: apiUploadSessionFromStore(session, session.expectedBytes ?? this.store.maxUploadBytes),
        projectId: session.projectId,
        ...(session.workItemId === undefined ? {} : { workItemId: session.workItemId }),
        ...(session.revisionId === undefined ? {} : { revisionId: session.revisionId }),
        ...(typeof uploadMetadata.buildConfigurationSnapshotId === "string" ? { buildConfigurationSnapshotId: uploadMetadata.buildConfigurationSnapshotId } : {})
      };
    }));
  }

  async beginUpload(input: BeginUploadInput, _ctx: RequestContext): Promise<ApiUploadSession> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      let session: StoreUploadSession | undefined;
      try {
        const result = await this.store.beginUpload({
          projectId: input.projectId,
          ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
          ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
          role: input.role,
          filename: input.filename,
          mediaType: input.mediaType,
          expectedBytes: input.byteSize,
          expectedSha256: input.sha256,
          ...(input.source === undefined ? {} : { source: input.source })
        });
        session = resultValue(result);
        this.state.setMetadata(UPLOAD, session.sessionId, {
          ...(input.author === undefined ? {} : { author: input.author }),
          ...(input.source === undefined ? {} : { source: input.source }),
          byteSize: input.byteSize,
          sha256: input.sha256,
          ...(input.buildConfigurationSnapshotId === undefined ? {} : { buildConfigurationSnapshotId: input.buildConfigurationSnapshotId })
        });
        return apiUploadSessionFromStore(session, input.byteSize);
      } catch (error: unknown) {
        if (session !== undefined) {
          const aborted = await this.store.abortUpload(session.sessionId);
          if (!aborted.ok && aborted.error.code !== "NOT_FOUND") resultValue(aborted);
        }
        throw error;
      }
    }));
  }

  async abortUpload(sessionId: string): Promise<void> {
    await this.unitOfWork.exclusive(() => attempt(async () => {
      const result = await this.store.abortUpload(sessionId);
      // Compensation is deliberately idempotent: a concurrent expiry or a
      // previous cleanup already removed the session and its bytes, which is
      // the desired postcondition for an audited begin failure.
      if (!result.ok && result.error.code !== "NOT_FOUND") resultValue(result);
      this.state.deleteMetadata(UPLOAD, sessionId);
    }));
  }

  async writeUpload(sessionId: string, body: Uint8Array): Promise<{ readonly receivedBytes: number }> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      // ArtifactStore accepts byte iterables, but Buffer/Uint8Array itself
      // iterates as numbers. Wrap one request body as one byte chunk.
      const result = resultValue(await this.store.writeUpload(sessionId, [body]));
      return { receivedBytes: result.bytesWritten };
    }));
  }

  async finalizeUpload(sessionId: string, _ctx: RequestContext): Promise<ApiArtifact> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      // The store returns the same artifact for a finalized session. Capture
      // the state before finalizing so projection failures can compensate only
      // a finalization created by this call, never an idempotent replay.
      const upload = resultValue(await this.store.getUploadSession(sessionId));
      const createdFinalization = upload.status !== "finalized";
      const finalized = resultValue(await this.store.finalizeUpload(sessionId));
      try {
        const uploadMetadata = this.state.getMetadata(UPLOAD, sessionId);
        const artifactMetadata = this.state.getMetadata(ARTIFACT, finalized.artifactId);
        const currentVersion = this.state.getVersion(ARTIFACT, finalized.artifactId);
        this.state.setInitialVersion(ARTIFACT, finalized.artifactId);
        this.state.setMetadata(ARTIFACT, finalized.artifactId, {
          ...artifactMetadata,
          ...(typeof uploadMetadata.author === "string" ? { author: uploadMetadata.author } : {}),
          ...(typeof uploadMetadata.machineBinding === "object" && uploadMetadata.machineBinding !== null ? { machineBinding: uploadMetadata.machineBinding } : {}),
          artifactRevisionId: finalized.artifactRevisionId
        });
        return this.toApi(finalized, currentVersion);
      } catch (error: unknown) {
        if (!createdFinalization) throw error;
        try {
          const rollback = resultValue(await this.store.rollbackFinalization(sessionId));
          if (rollback.artifactId !== finalized.artifactId) {
            throw new ApplicationError("integrity_error", "Artifact finalization compensation targeted a different artifact");
          }
          // The adapter projection is part of the same logical finalization.
          // Remove any rows written before the projection failure so direct
          // adapter callers are consistent even outside an SQLite transaction.
          this.state.deleteMetadata(ARTIFACT, finalized.artifactId);
          this.state.deleteVersion(ARTIFACT, finalized.artifactId);
        } catch (compensationError: unknown) {
          const message = compensationError instanceof Error ? compensationError.message : "unknown compensation failure";
          throw new ApplicationError("integrity_error", "Artifact finalization failed and could not be compensated", {
            sessionId,
            artifactId: finalized.artifactId,
            compensationError: message
          });
        }
        throw error;
      }
    }));
  }

  async commitFinalization(sessionId: string, artifactId: string): Promise<void> {
    await this.unitOfWork.exclusive(() => attempt(async () => {
      const committed = resultValue(await this.store.commitFinalization(sessionId, artifactId));
      return committed;
    }));
  }

  async bindBuildConfiguration(input: { readonly artifactId: string; readonly buildConfigurationSnapshotId: string; readonly projectRevisionId: string }): Promise<ArtifactBuildConfigurationBinding> {
    if (this.bindings === undefined) throw new ApplicationError("integrity_error", "Artifact build-configuration binding storage is not configured");
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.bindings!.create(input))));
  }

  async rollbackFinalization(sessionId: string, artifactId: string): Promise<void> {
    await this.unitOfWork.exclusive(() => attempt(async () => {
      const rollback = resultValue(await this.store.rollbackFinalization(sessionId));
      if (rollback.artifactId !== artifactId) throw new ApplicationError("integrity_error", "Artifact finalization compensation targeted a different artifact");
      if (rollback.artifactRecordRemoved) {
        this.state.deleteMetadata(ARTIFACT, artifactId);
        this.state.deleteVersion(ARTIFACT, artifactId);
      }
      return rollback;
    }));
  }

  async readArtifact(id: string): Promise<ArtifactDownload> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      const artifact = await this.findArtifact(id);
      if (artifact === undefined) throw new ApplicationError("not_found", `artifact ${id} was not found`);
      const bytes = resultValue(await this.store.readArtifact(artifact.artifactRevisionId));
      return { artifact: this.toApi(bytes.artifact), body: new Uint8Array(bytes.bytes) };
    }));
  }

  async retireArtifact(id: string, expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiArtifact> {
    return attempt(async () => {
      const artifact = await this.findArtifact(id);
      if (artifact === undefined) throw new ApplicationError("not_found", `artifact ${id} was not found`);
      const version = this.state.getVersion(ARTIFACT, artifact.artifactId);
      if (expectedVersion !== undefined && version !== expectedVersion) throw new ApplicationError("conflict", `artifact '${id}' changed since it was read`, { expectedVersion, actualVersion: version });
      const metadata = this.state.getMetadata(ARTIFACT, artifact.artifactId);
      const nextVersion = this.state.bumpVersion(ARTIFACT, artifact.artifactId);
      this.state.setMetadata(ARTIFACT, artifact.artifactId, { ...metadata, retired: true });
      return this.toApi(artifact, nextVersion, true);
    });
  }

  private async findArtifact(id: string): Promise<ArtifactRevision | undefined> {
    const artifacts = resultValue(await this.store.listArtifactRevisions());
    return artifacts.filter((artifact) => artifact.artifactId === id || artifact.artifactRevisionId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.artifactRevisionId.localeCompare(a.artifactRevisionId))[0];
  }

  private toApi(artifact: ArtifactRevision, version = this.state.getVersion(ARTIFACT, artifact.artifactId), retired = metadataFor(this.state, artifact).retired === true): ApiArtifact {
    return clone(apiArtifactFromStore(artifact, metadataFor(this.state, artifact), version, retired));
  }
}
