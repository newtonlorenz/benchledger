import { idSchema } from "@benchledger/api-contract";
import { SEARCH_MAX_LENGTH } from "./client";
import { isPairLink, parsePairLink } from "./links";

/**
 * Decide what a scanned QR code or barcode does. Labels encode
 * `benchledger://item/<id>`; a pairing QR only prefills the connect form;
 * other text searches inventory. Web addresses are never opened, and the
 * result never contains a pairing token outside the `pair` route.
 */
export type ScanRoute =
  | { kind: "item"; id: string }
  | { kind: "project"; id: string }
  | { kind: "pair"; url: string }
  | { kind: "search"; text: string }
  | { kind: "ignored"; reason: string };

const MAX_PAYLOAD = 4096;
const recordLink = /^benchledger:\/\/(item|project)\/([^/?#]+)$/u;

/** The printable label payload for an inventory item. */
export function itemLabelLink(id: string) { return `benchledger://item/${idSchema.parse(id)}`; }

export function routeScan(raw: string, context: { signedIn: boolean }): ScanRoute {
  const data = raw.trim();
  if (!data) return { kind: "ignored", reason: "The code was empty." };
  if (data.length > MAX_PAYLOAD) return { kind: "ignored", reason: "This code is too long to be a BenchLedger label." };
  if (/^benchledger:/iu.test(data)) {
    if (isPairLink(data)) {
      if (context.signedIn) return { kind: "ignored", reason: "This is a pairing code. Disconnect in the Server tab before pairing with another server." };
      return parsePairLink(data) ? { kind: "pair", url: data } : { kind: "ignored", reason: "This pairing code has no valid server address." };
    }
    const match = recordLink.exec(data);
    // Check the raw text: URL parsing would resolve "../" segments into another ID.
    if (!match || !idSchema.safeParse(match[2]).success) return { kind: "ignored", reason: "This BenchLedger code does not point to a valid record." };
    if (!context.signedIn) return { kind: "ignored", reason: "Connect to your workspace before opening records." };
    return match[1] === "item" ? { kind: "item", id: match[2]! } : { kind: "project", id: match[2]! };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(data)) return { kind: "ignored", reason: "This code holds a web address. BenchLedger doesn't open web links from scans." };
  if (!context.signedIn) return { kind: "ignored", reason: "Scan your server's pairing code, or connect first to look up items." };
  const text = data.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").slice(0, SEARCH_MAX_LENGTH).trim();
  return text ? { kind: "search", text } : { kind: "ignored", reason: "The code was empty." };
}
