import { connectionSchema, type Connection } from "./connection";

const scheme = "benchledger:";
const isPair = (url: URL) => url.protocol === scheme && (url.host === "pair" || url.pathname.replace(/^\/+/u, "") === "pair");

/**
 * `benchledger://pair?url=<server>&token=<token>` only prefills the connect
 * form. The caller must never submit it automatically or log it. A link never
 * enables local HTTP on its own: the user must turn that on in the form.
 */
export function parsePairLink(input: string): Connection | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (!isPair(url)) return null;
  const address = url.searchParams.get("url")?.trim() ?? "";
  let server: URL;
  try { server = new URL(address); } catch { return null; }
  if (server.protocol !== "https:" && server.protocol !== "http:") return null;
  const token = url.searchParams.get("token") ?? "";
  const validToken = connectionSchema.shape.token.safeParse(token).success ? token.trim() : "";
  return { server: address, token: validToken, allowLocalHttp: false };
}

export function isPairLink(input: string): boolean {
  try { return isPair(new URL(input)); } catch { return false; }
}

/** React Navigation linking for record links; pairing is handled outside the navigator. */
export const linking = {
  prefixes: ["benchledger://"],
  filter: (url: string) => !isPairLink(url),
  config: {
    screens: {
      Stock: { initialRouteName: "Inventory" as const, screens: { Inventory: "inventory", Item: "item/:id" } },
      Builds: { initialRouteName: "Projects" as const, screens: { Projects: "projects", Project: "project/:id" } },
      Server: { screens: { Workspace: "server" } }
    }
  }
};
