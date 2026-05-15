import * as XLSX from "xlsx";
import type { TableDescriptor, Field, FieldType } from "./tables";

/** Field types that require uploads, not text — excluded from the Excel
 *  import flow (template, mapping, validation). Admins still edit these
 *  per-row from the row dialog after the bulk-imported records exist. */
const NON_IMPORTABLE_TYPES: ReadonlySet<FieldType> = new Set(["fileKey", "fileKeyList"]);

/** Fields that participate in the Excel import: writable (not readonly /
 *  virtual) and not a file-upload type. */
export function getImportableFields(descriptor: TableDescriptor): Field[] {
  return descriptor.fields.filter(
    (f) => !f.readonly && !f.virtual && !NON_IMPORTABLE_TYPES.has(f.type),
  );
}

export type ParsedSheet = {
  headers: string[];
  rows: Record<string, unknown>[];
  /** True if a template hint row was detected and removed from `rows`. */
  hintRowSkipped?: boolean;
};

/**
 * Sentinel string future templates can prepend to a hint row's first cell to
 * mark it for skipping. The current `downloadTemplateXlsx` does not inject
 * this string into the sheet (it labels row 2 via an A1 cell comment plus
 * deterministic sample values), but `isTemplateHintRow` still honours it so
 * older or hand-edited templates carrying the marker continue to be skipped.
 */
export const TEMPLATE_HINT_MARKER = "EXAMPLE — delete this row before importing";

export async function readSpreadsheet(
  file: File,
  descriptor?: TableDescriptor,
): Promise<ParsedSheet> {
  const buf = await file.arrayBuffer();
  // cellDates: true so cells styled as dates come back as JS Date objects.
  // Cells that are formatted as plain Number but actually hold an Excel date
  // serial (very common in old Glide/iOS exports) stay numeric — coerceCell
  // converts those serials below. raw: false formats Date objects per dateNF.
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
    defval: "",
    raw: false,
    dateNF: 'yyyy-mm-dd"T"hh:mm:ss',
  });
  const headers =
    json.length > 0
      ? Object.keys(json[0])
      : (XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 })[0] ?? []) as string[];
  let hintRowSkipped = false;
  if (descriptor && json.length > 0 && isTemplateHintRow(json[0], headers, descriptor)) {
    json.shift();
    hintRowSkipped = true;
  }
  return { headers, rows: json, hintRowSkipped };
}

/**
 * Detect the auto-generated template hint row so it isn't treated as data.
 * A row qualifies if either:
 *  - any cell starts with the visible TEMPLATE_HINT_MARKER, or
 *  - every non-empty cell exactly matches the deterministic sample value
 *    that `downloadTemplateXlsx` would have written for that column.
 */
function isTemplateHintRow(
  row: Record<string, unknown>,
  headers: string[],
  descriptor: TableDescriptor,
): boolean {
  for (const v of Object.values(row)) {
    if (typeof v === "string" && v.startsWith(TEMPLATE_HINT_MARKER)) return true;
  }
  const fields = getImportableFields(descriptor);
  const byLabel = new Map(fields.map((f) => [f.label, f]));
  let matched = 0;
  let nonEmpty = 0;
  for (const h of headers) {
    const cell = row[h];
    const s = cell === null || cell === undefined ? "" : String(cell).trim();
    if (s === "") continue;
    nonEmpty++;
    const f = byLabel.get(h);
    if (!f) return false;
    const expected = sampleFor(f).trim();
    if (expected === "") return false;
    if (s === expected) matched++;
    else return false;
  }
  return nonEmpty > 0 && matched === nonEmpty;
}

export function downloadTemplateXlsx(descriptor: TableDescriptor): void {
  const fields = getImportableFields(descriptor);
  const headers = fields.map((f) => f.label);
  const sampleRow = fields.map((f) => sampleFor(f));
  const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
  // Attach a comment to A1 so admins see why the second row exists.
  const a1 = ws["A1"];
  if (a1) {
    (a1 as XLSX.CellObject).c = [{
      a: "Template",
      t: `Row 2 contains example values to show the expected format for each column. Delete row 2 before importing your real data — if you leave it in, ${TEMPLATE_HINT_MARKER.toLowerCase()} (we will skip it automatically).`,
    }];
  }
  // Auto-fit-ish column widths based on the longer of header / sample.
  ws["!cols"] = headers.map((h, i) => ({
    wch: Math.max(12, h.length + 2, String(sampleRow[i] ?? "").length + 2),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, descriptor.label.slice(0, 30));
  XLSX.writeFile(wb, `${descriptor.name}-template.xlsx`);
}

function sampleFor(f: Field): string {
  if (f.importExample !== undefined) return f.importExample;
  switch (f.type) {
    case "email": return "name@example.com";
    case "number": return "0.00";
    case "integer": return "0";
    case "date": return "2025-01-31";
    case "datetime": return "2025-01-31T09:00";
    case "boolean": return "false";
    case "select": return f.options?.[0]?.value ?? "";
    case "fk": return `<${f.fkTable} id>`;
    default: return "";
  }
}

/** Best-effort guess: match a header to a field by exact, case-insensitive, or substring. */
export function autoMap(
  headers: string[],
  fields: Field[],
): Record<string, string> {
  const map: Record<string, string> = {};
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const fieldKeys = fields.map((f) => ({ field: f, normLabel: norm(f.label), normKey: norm(f.key) }));
  for (const h of headers) {
    const nh = norm(h);
    const exact = fieldKeys.find((f) => f.normKey === nh || f.normLabel === nh);
    if (exact) { map[h] = exact.field.key; continue; }
    const partial = fieldKeys.find((f) => nh.includes(f.normKey) || nh.includes(f.normLabel) || f.normLabel.includes(nh));
    if (partial) { map[h] = partial.field.key; continue; }
    map[h] = "";
  }
  return map;
}

/** Excel/Lotus date serial epoch is 1899-12-30 (accounts for the 1900 leap-year bug). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Parse a cell that might be a JS Date, an Excel serial number, or any
 *  string Date can handle. Excel exports from Glide / iOS Numbers commonly
 *  store timestamps as plain numbers (e.g. 46129.95347) rather than styled
 *  date cells, which would otherwise pass straight through as the literal
 *  number string. */
function parseDateLike(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Treat plausible Excel serials (> 1 day, < year 9999) as date serials.
    if (v >= 1 && v < 2958466) {
      return new Date(EXCEL_EPOCH_MS + Math.round(v * 86400 * 1000));
    }
    return null;
  }
  const str = String(v ?? "").trim();
  if (!str) return null;
  // Pure-number strings (xlsx with raw:false sometimes still hands these back)
  // get the same Excel-serial treatment.
  if (/^-?\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n >= 1 && n < 2958466) {
      return new Date(EXCEL_EPOCH_MS + Math.round(n * 86400 * 1000));
    }
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Coerce a raw cell into the form expected by the API for that field. */
export function coerceCell(raw: unknown, field: Field): unknown {
  if (raw === undefined || raw === null) return null;
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (s === "") return null;
  switch (field.type) {
    case "boolean": {
      const v = String(s).toLowerCase();
      if (["true","1","yes","y","active"].includes(v)) return true;
      if (["false","0","no","n","inactive"].includes(v)) return false;
      return null;
    }
    case "integer": {
      // Match digits inside messy strings like "Level 2" or "Lvl 3"
      const m = String(s).match(/-?\d+/);
      return m ? parseInt(m[0], 10) : null;
    }
    case "number": {
      // Strip currency symbols, commas
      const m = String(s).replace(/[£$,]/g, "").match(/-?\d+(\.\d+)?/);
      return m ? m[0] : null;
    }
    case "date": {
      const d = parseDateLike(s);
      if (!d) return null;
      return d.toISOString().slice(0, 10);
    }
    case "datetime": {
      const d = parseDateLike(s);
      if (!d) return null;
      return d.toISOString();
    }
    case "json": {
      // Accept JSON strings or pass through objects/arrays as-is.
      if (typeof s === "object") return s;
      const str = String(s).trim();
      try {
        return JSON.parse(str);
      } catch {
        return null;
      }
    }
    case "fileKeyList": {
      // Accept JSON arrays, comma/newline/semicolon-separated strings, or a
      // single key. Always returns string[] (or null).
      if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
      const str = String(s).trim();
      if (str.startsWith("[")) {
        try {
          const arr = JSON.parse(str);
          return Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : null;
        } catch {
          return null;
        }
      }
      const parts = str.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
      return parts.length > 0 ? parts : null;
    }
    case "select": {
      // Try exact match against options' values or labels (case-insensitive).
      const v = String(s).toLowerCase();
      const opt = field.options?.find(
        (o) => o.value.toLowerCase() === v || o.label.toLowerCase() === v,
      );
      if (opt) return opt.value;
      // Try numeric extraction (e.g., "Level 2" → "2")
      const m = String(s).match(/-?\d+/);
      const byDigit = m && field.options?.find((o) => o.value === m[0]);
      if (byDigit) return byDigit.value;
      return String(s);
    }
    default:
      return String(s);
  }
}

export function buildErrorCsv(
  originalHeaders: string[],
  failedRows: { row: Record<string, unknown>; error: string }[],
): Blob {
  const hdr = [...originalHeaders, "_error"];
  const lines = [hdr.map(csvCell).join(",")];
  for (const { row, error } of failedRows) {
    const line = originalHeaders.map((h) => csvCell(row[h])).concat(csvCell(error)).join(",");
    lines.push(line);
  }
  return new Blob([lines.join("\n")], { type: "text/csv" });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
