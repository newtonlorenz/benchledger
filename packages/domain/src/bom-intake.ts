/** Browser-safe, bounded CSV intake. Imported text is data, never executable content. */
export const MAX_BOM_INTAKE_BYTES = 256 * 1024;
export const MAX_BOM_INTAKE_ROWS = 24;
export type BomIntakeUnit = "each" | "gram" | "metre" | "millimetre" | "millilitre" | "set";
export type BomColumn = "name" | "quantity" | "unit" | "role" | "optional" | "notes" | "itemId";
export type BomColumnMapping = Partial<Record<BomColumn, number>>;
export interface BomIntakeRow { name: string; requiredQuantity: number; unit: BomIntakeUnit; role: "consumed" | "reusable"; optional: boolean; notes?: string; itemId?: string }
export interface BomIntakeIssue { row: number; field: string; message: string }
export function parseBomTable(text: string, delimiter: "," | ";" | "\t" = ","): { headers: string[]; rows: string[][] } {
  if (new TextEncoder().encode(text).byteLength > MAX_BOM_INTAKE_BYTES) throw new Error("The import exceeds 256 KiB. Split it into smaller reviewed projects.");
  if (text.includes("\0")) throw new Error("The file contains binary data, not CSV text.");
  const source = text.replace(/^\uFEFF/u, "");
  const table: string[][] = []; let row: string[] = [], value = "", quoted = false, closed = false;
  const cell = () => { row.push(value); value = ""; closed = false; if (row.length > 50) throw new Error("At most 50 CSV columns are supported."); };
  const endRow = () => { cell(); if (row.some((v) => v.trim() !== "")) table.push(row); row = []; if (table.length > MAX_BOM_INTAKE_ROWS + 1) throw new Error("Review at most 24 requirement rows in one import."); };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') { quoted = false; closed = true; }
      else value += ch;
    } else if (ch === delimiter) cell();
    else if (ch === "\r" || ch === "\n") { endRow(); if (ch === "\r" && source[i + 1] === "\n") i += 1; }
    else if (ch === '"' && value === "" && !closed) quoted = true;
    else if (ch === '"' || closed) throw new Error(`Malformed CSV near character ${i + 1}. Quote the entire field and double embedded quotes.`);
    else value += ch;
  }
  if (quoted) throw new Error("A quoted CSV field is not closed.");
  if (value !== "" || row.length || closed) endRow();
  const headers = table.shift()?.map((v) => v.trim()) ?? [];
  if (!headers.length || !table.length) throw new Error("Include a header row and at least one requirement.");
  if (headers.some((v) => !v || v.length > 240)) throw new Error("Each CSV column needs a non-empty header of at most 240 characters.");
  if (table.some((r) => r.length !== headers.length)) throw new Error("Each CSV row must have the same number of fields as its header. Check delimiters and quotes.");
  return { headers, rows: table };
}
const aliases: Record<BomColumn, readonly string[]> = {
  name: ["name", "requirement", "description", "part", "part name"], quantity: ["quantity", "qty", "required quantity"],
  unit: ["unit", "units"], role: ["role", "use"], optional: ["optional"], notes: ["notes", "note"],
  itemId: ["selected inventory id", "inventory id", "itemid"]
};
export function suggestBomMapping(headers: readonly string[]): BomColumnMapping {
  const mapping: BomColumnMapping = {};
  for (const [field, names] of Object.entries(aliases) as [BomColumn, readonly string[]][]) {
    const matches = headers.map((h, i) => names.includes(h.trim().toLowerCase()) ? i : -1).filter((i) => i >= 0);
    if (matches.length === 1 && field !== "itemId") mapping[field] = matches[0]!;
  }
  return mapping;
}
const unitNames: Readonly<Record<string, BomIntakeUnit>> = { each: "each", piece: "each", pieces: "each", pc: "each", pcs: "each", g: "gram", gram: "gram", grams: "gram", m: "metre", metre: "metre", metres: "metre", meter: "metre", meters: "metre", mm: "millimetre", millimetre: "millimetre", ml: "millilitre", millilitre: "millilitre", set: "set", sets: "set" };
export function mapBomTable(table: { headers: readonly string[]; rows: readonly string[][] }, mapping: BomColumnMapping, defaults: { unit: BomIntakeUnit; role: "consumed" | "reusable"; decimal: "dot" | "comma" }): { rows: BomIntakeRow[]; issues: BomIntakeIssue[] } {
  const issues: BomIntakeIssue[] = [], rows: BomIntakeRow[] = [];
  for (const field of ["name", "quantity"] as const) if (mapping[field] === undefined) issues.push({ row: 1, field, message: `Map a ${field} column before reviewing.` });
  const columns = Object.values(mapping); if (new Set(columns).size !== columns.length || columns.some((c) => !Number.isInteger(c) || c < 0 || c >= table.headers.length)) issues.push({ row: 1, field: "mapping", message: "Each mapped field must use a different valid column." });
  if (issues.length) return { rows, issues };
  table.rows.forEach((cells, index) => {
    const get = (field: BomColumn) => mapping[field] === undefined ? "" : cells[mapping[field]!]!.trim();
    const issue = (field: string, message: string) => issues.push({ row: index + 2, field, message });
    const name = get("name"), raw = get("quantity"), decimal = defaults.decimal === "comma" ? raw.replace(",", ".") : raw;
    const quantity = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/u.test(decimal) ? Number(decimal) : NaN;
    const unit = mapping.unit === undefined ? defaults.unit : unitNames[get("unit").toLowerCase()];
    const roleText = get("role").toLowerCase();
    const role = mapping.role === undefined ? defaults.role : ["consumed", "part", "material"].includes(roleText) ? "consumed" : ["reusable", "tool", "equipment"].includes(roleText) ? "reusable" : undefined;
    const optionalText = get("optional").toLowerCase();
    const optional = mapping.optional === undefined || ["", "false", "no", "0", "required"].includes(optionalText) ? false : ["true", "yes", "1", "optional"].includes(optionalText) ? true : undefined;
    const notes = get("notes"), itemId = get("itemId");
    if (!name || name.length > 240) issue("name", "Name is required and must be at most 240 characters.");
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9) issue("quantity", "Use a positive decimal up to one billion, without thousands separators or formulae.");
    if (!unit) issue("unit", "Choose an explicit supported unit; units are never guessed from a part name.");
    if (!role) issue("role", "Use consumed for parts/materials or reusable for tools/equipment.");
    if (optional === undefined) issue("optional", "Use yes/no, true/false or 1/0.");
    if (notes.length > 2000) issue("notes", "Notes must be at most 2,000 characters.");
    if (itemId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(itemId)) issue("itemId", "Use an exact existing inventory identifier, or leave the cell empty.");
    if (!issues.some((entry) => entry.row === index + 2)) rows.push({ name, requiredQuantity: quantity, unit: unit!, role: role!, optional: optional!, ...(notes ? { notes } : {}), ...(itemId ? { itemId } : {}) });
  });
  return { rows, issues };
}
export const makerIntakeTemplates = [
  { id: "electronics", name: "Electronics enclosure", route: "none" as const, workItems: [{ name: "Enclosure and mounting", kind: "assembly" as const }, { name: "Electronics and wiring", kind: "electronics" as const }], rows: [{ name: "Controller board", requiredQuantity: 1, unit: "each" as const, role: "consumed" as const, optional: false, notes: "Decide the board, supply voltage and connector requirements." }, { name: "Enclosure", requiredQuantity: 1, unit: "each" as const, role: "consumed" as const, optional: false, notes: "Measure internal clearance and mounting points." }] },
  { id: "printed", name: "Printed part", route: "printed" as const, workItems: [{ name: "Design and fit test", kind: "part" as const }], rows: [{ name: "Print material", requiredQuantity: 1, unit: "gram" as const, role: "consumed" as const, optional: false, notes: "Placeholder only: replace with the slicer material estimate and intended material." }] },
  { id: "fixture", name: "Workshop fixture", route: "ready_made" as const, workItems: [{ name: "Mechanical assembly", kind: "assembly" as const }], rows: [{ name: "Mounting hardware", requiredQuantity: 1, unit: "set" as const, role: "consumed" as const, optional: false, notes: "Specify size, load and quantity before sourcing." }, { name: "Assembly tool", requiredQuantity: 1, unit: "each" as const, role: "reusable" as const, optional: false, notes: "Select a suitable owned tool or record the specification." }] }
] as const;
