import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryRequest, fetchArtifactDownload, sha256Hex } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("artifact bytes in LAN browsers", () => {
  it("never sends upload credentials to another origin or follows redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await expect(binaryRequest("https://untrusted.example/upload", new ArrayBuffer(1), "synthetic-csrf")).rejects.toThrow("unsafe upload");
    expect(fetcher).not.toHaveBeenCalled();
    await binaryRequest("/api/v1/artifacts/uploads/test", new ArrayBuffer(1), "synthetic-csrf");
    expect(fetcher).toHaveBeenCalledWith("/api/v1/artifacts/uploads/test", expect.objectContaining({ redirect: "error" }));
  });
  it("hashes without secure-context WebCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(await sha256Hex(new Blob(["abc"]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("downloads exact bytes with session auth and no redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("abc"));
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchArtifactDownload("file/id", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await result.text()).toBe("abc");
    expect(fetcher).toHaveBeenCalledWith("/api/v1/artifacts/file%2Fid/download", expect.objectContaining({ credentials: "include", redirect: "error" }));
  });
  it("rejects corrupted bytes and expired sessions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("wrong")).mockResolvedValueOnce(new Response("", { status: 401 })));
    await expect(fetchArtifactDownload("file", "a".repeat(64))).rejects.toThrow("integrity");
    await expect(fetchArtifactDownload("file", "a".repeat(64))).rejects.toThrow("Sign in");
  });
  it("reports inaccessible files and network failures without returning error bodies as files", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("private error", { status: 404 })).mockRejectedValueOnce(new Error("private network detail")));
    await expect(fetchArtifactDownload("file", "a".repeat(64))).rejects.toThrow("could not be downloaded");
    await expect(fetchArtifactDownload("file", "a".repeat(64))).rejects.toThrow("connection");
  });
});
