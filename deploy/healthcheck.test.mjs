import assert from "node:assert/strict";
import test from "node:test";
import { checkHealth } from "./healthcheck.mjs";

test("healthcheck targets the versioned public health endpoint", async () => {
  let requested;
  const ok = await checkHealth(async (url) => {
    requested = url;
    return { ok: true, status: 200 };
  }, { BENCHLEDGER_PORT: "9876" });
  assert.equal(ok, true);
  assert.equal(requested, "http://127.0.0.1:9876/api/v1/health");
});

test("healthcheck fails on a non-OK response", async () => {
  await assert.rejects(() => checkHealth(async () => ({ ok: false, status: 503 }), {}), /503/);
});
