import { Worker } from "node:worker_threads";
import type { AssemblyMesh, AssemblySource } from "@benchledger/api-contract";
let active = 0;
/** Untrusted CAD parsing is isolated from the request loop, with bounded concurrency and lifetime. */
export async function importAssemblyFile(bytes: Uint8Array, filename: string, unit: AssemblySource["unit"], upAxis: "y" | "z" = "z"): Promise<{ meshes: AssemblyMesh[]; warnings: string[] }> {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Assembly sources are limited to 20 MB per file.");
  if (active >= 2) throw new Error("Two models are being imported. Retry when an import finishes.");
  active++;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(new URL("./assembly-worker.js", import.meta.url), { workerData: { bytes, filename, unit, upAxis }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
      const finish = (error?: Error, result?: { meshes: AssemblyMesh[]; warnings: string[] }) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        void worker.terminate().then(() => {
          if (error) reject(error);
          else resolve(result!);
        }, () => reject(new Error("Model importer could not finish. Retry the import.")));
      };
      const timer = setTimeout(() => finish(new Error("Model import exceeded 20 seconds. Use a simpler assembly export.")), 20_000);
      // CAD libraries may log paths or source metadata; do not forward those logs.
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.once("message", (result: { meshes?: AssemblyMesh[]; warnings: string[]; error?: string }) => {
        if (result.error || !result.meshes) finish(new Error(result.error ?? "Unable to import this model."));
        else finish(undefined, { meshes: result.meshes, warnings: result.warnings });
      });
      worker.once("error", () => finish(new Error("Model import failed within its resource limits. Try a simpler export.")));
      worker.once("exit", () => finish(new Error("Model importer stopped before returning a model. Try a simpler export.")));
    });
  } finally { active--; }
}
