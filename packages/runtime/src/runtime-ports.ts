import type { EventBusEvent, EventBusPort, HealthPort, IdempotencyPort } from "@benchledger/application";
import type { ArtifactStore } from "@benchledger/artifacts";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeState } from "./persistence.js";

export class ProductionEventBus implements EventBusPort {
  private readonly listeners = new Set<(event: EventBusEvent) => void>();

  publish(event: EventBusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        // Delivery is post-commit and best-effort. One broken integration
        // must not suppress other subscribers or turn a successful mutation
        // into a retry that could duplicate external work.
      }
    }
  }

  subscribe(listener: (event: EventBusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class ProductionIdempotency implements IdempotencyPort {
  constructor(private readonly state: RuntimeState) {}

  async get(actor: string, key: string): Promise<unknown | null> {
    return structuredClone(this.state.getIdempotency(actor, key));
  }

  async set(actor: string, key: string, value: unknown): Promise<void> {
    this.state.setIdempotency(actor, key, value);
  }
}

export class ProductionHealth implements HealthPort {
  private closed = false;

  constructor(private readonly database: BenchDatabase, private readonly artifacts: ArtifactStore) {}

  markClosed(): void {
    this.closed = true;
  }

  async check(): Promise<Readonly<Record<string, "ok" | "degraded" | "failed">>> {
    if (this.closed) return { database: "failed", artifacts: "failed" };
    let databaseStatus: "ok" | "failed" = "ok";
    let artifactStatus: "ok" | "failed" = "ok";
    try {
      const row = this.database.get("SELECT value FROM forge_meta WHERE key = ?", ["runtime_schema_version"]);
      if (row === undefined) databaseStatus = "failed";
    } catch {
      databaseStatus = "failed";
    }
    try {
      const usage = await this.artifacts.getUsage();
      if (!usage.ok || usage.value.uniqueBytes + usage.value.activeUploadBytes > usage.value.maxStorageBytes) artifactStatus = "failed";
    } catch {
      artifactStatus = "failed";
    }
    return { database: databaseStatus, artifacts: artifactStatus };
  }
}
