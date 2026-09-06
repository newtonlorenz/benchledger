#!/usr/bin/env node
// Trusted host CLI, never an MCP filesystem or credential capability.
import { createHash } from "node:crypto";
import { open, lstat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 100 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(message); };
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : fail("Invalid or missing identifier.");

async function boundedBody(response, limit) {
  const chunks = []; let total = 0;
  if (!response.body) fail("Empty server response.");
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) fail("Response exceeds the bounded transfer limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function transferArtifact(options) {
  let stage = "validation";
  try {
    const { operation, token, file, role } = options;
    if (!["upload", "download"].includes(operation)) fail("Choose upload or download.");
    if (typeof token !== "string" || !token || /[\s\u0000-\u001f]/u.test(token)) fail("Set BENCHLEDGER_TOKEN in the host environment.");
    const base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") fail("Base URL must be an HTTP(S) origin without credentials, query or path.");
    const projectId = id(options.projectId);
    const scope = options.projectRevisionId !== undefined
      ? { projectRevisionId: id(options.projectRevisionId) }
      : { workItemId: id(options.workItemId), workItemRevisionId: id(options.workItemRevisionId) };
    if (options.projectRevisionId !== undefined && (options.workItemId !== undefined || options.workItemRevisionId !== undefined)) fail("Choose exactly one revision scope.");
    if (!/^(source|cad|document|brief|design_record|cad_source|step|stl|three_mf|slicer_project|gcode|firmware|drawing|validation|photo|text|other)$/u.test(role ?? "")) fail("Supply an explicit valid file role.");
    if (typeof file !== "string" || !file || file.includes("\0")) fail("Supply an explicit local file path.");
    const request = async (path, method = "GET", body, binary = false) => {
      const response = await fetch(new URL(`/api/v1${path}`, base), {
        method, redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": binary ? "application/octet-stream" : "application/json" }) },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
      });
      if (!response.ok) { await response.body?.cancel(); fail(`HTTP ${response.status}; check token scope and record state. No automatic retry.`); }
      return response;
    };
    const json = async (path, method, body, binary) => JSON.parse((await boundedBody(await request(path, method, body, binary), 1024 * 1024)).toString("utf8"));
    // HTTP persistence metadata uses revisionId; workItemId disambiguates its kind.
    const scopeMatches = (artifact) => artifact.projectId === projectId && artifact.role === role && (scope.projectRevisionId
      ? !artifact.workItemId && (artifact.projectRevisionId ?? artifact.revisionId) === scope.projectRevisionId
      : artifact.workItemId === scope.workItemId && (artifact.workItemRevisionId ?? artifact.revisionId) === scope.workItemRevisionId);
    const verify = (artifact, bytes) => {
      if (!scopeMatches(artifact)) fail("Artifact scope or role does not match the explicit request.");
      if (artifact.byteSize !== bytes.length || artifact.sha256 !== digest(bytes)) fail("Artifact SHA-256 or byte length verification failed.");
    };
    let artifact;
    if (operation === "upload") {
      stage = "local read";
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) fail("Upload must be a regular nonempty file no larger than 100 MiB.");
        bytes = await boundedBody({ body: handle.createReadStream({ autoClose: false }) }, MAX_BYTES);
      } finally { await handle.close(); }
      if (!bytes.length) fail("Upload must not be empty.");
      const mediaType = options.mediaType;
      if (typeof mediaType !== "string" || !mediaType || mediaType.length > 200) fail("Supply the file media type.");
      stage = "begin upload";
      const begun = await json("/artifacts/uploads", "POST", { projectId, ...scope, role, filename: basename(file), mediaType, byteSize: bytes.length, sha256: digest(bytes) });
      const uploadId = id(begun.data?.id);
      stage = "write upload";
      await json(`/artifacts/uploads/${uploadId}`, "PUT", bytes, true);
      stage = "finalize upload (an interrupted response may have committed; inspect the revision before retrying)";
      artifact = (await json(`/artifacts/uploads/${uploadId}/finalize`, "POST")).data;
      verify(artifact, bytes);
      stage = "read back finalized artifact";
      verify(await json(`/artifacts/${id(artifact.id)}`), bytes);
    } else {
      stage = "download metadata";
      const artifactId = id(options.artifactId);
      // Preflight destination, then use exclusive creation again after verification.
      try { await lstat(file); fail("Destination already exists; choose a new output path."); } catch (error) { if (error.code !== "ENOENT") throw error; }
      artifact = await json(`/artifacts/${artifactId}`);
      if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 1 || artifact.byteSize > MAX_BYTES) fail("Artifact exceeds transfer limit.");
      if (!scopeMatches(artifact)) fail("Artifact scope or role does not match the explicit request.");
      stage = "download bytes";
      const bytes = await boundedBody(await request(`/artifacts/${artifactId}/download`), artifact.byteSize);
      verify(artifact, bytes);
      stage = "save verified download";
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      catch (error) { await unlink(file); throw error; }
      finally { await handle.close(); }
    }
    return { status: operation === "upload" ? "uploaded" : "downloaded", artifactId: id(artifact.id), projectId, ...scope, role, byteSize: artifact.byteSize, sha256: artifact.sha256 };
  } catch (error) {
    // Never serialize fetch URLs, paths, bearer values, response bodies or stacks.
    const safe = /^(Choose |Set BENCHLEDGER_TOKEN|Invalid or missing|Base URL|Supply |HTTP \d|Response exceeds|Empty server|Artifact |Upload must|Destination already)/u.test(error.message ?? "") ? error.message : "Transfer failed; check connectivity, file access and server state. No automatic retry.";
    throw new Error(`${stage}: ${safe}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "--help") {
    console.log("Host-only artifact transfer. Set BENCHLEDGER_URL and BENCHLEDGER_TOKEN privately.\nnode scripts/artifact-transfer.mjs upload|download --file <path> --project <id> --project-revision <id> --role <role> [--media-type <type>] [--artifact <id>]\nUse --work-item <id> --work-item-revision <id> instead of --project-revision for a work-item revision. Upload needs --media-type; download needs --artifact. No overwrites or automatic retries. HTTP is only appropriate on a trusted LAN; prefer HTTPS.");
  } else {
    const keys = { "--file": "file", "--project": "projectId", "--project-revision": "projectRevisionId", "--work-item": "workItemId", "--work-item-revision": "workItemRevisionId", "--role": "role", "--media-type": "mediaType", "--artifact": "artifactId" };
    const options = { operation, baseUrl: process.env.BENCHLEDGER_URL, token: process.env.BENCHLEDGER_TOKEN };
    try {
      for (let i = 0; i < args.length; i += 2) {
        const key = keys[args[i]];
        if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) fail("Invalid arguments; use --help.");
        options[key] = args[i + 1];
      }
      console.log(JSON.stringify(await transferArtifact(options)));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
