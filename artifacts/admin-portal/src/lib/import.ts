import * as XLSX from "xlsx";
import type { TableDescriptor, Field } from "./tables";

export type ParsedSheet = {
  headers: string[];
  rows: Record<string, unknown>[];
};

export async function readSpreadsheet(file: File): Promise<ParsedSheet> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
    defval: "",
    raw: false,
  });
  const headers =
    json.length > 0
      ? Object.keys(json[0])
      : (XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 })[0] ?? []) as string[];
  return { headers, rows: json };
}

export function downloadTemplateXlsx(descriptor: TableDescriptor): void {
  const fields = descriptor.fields.filter((f) => !f.readonly && !f.virtual);
  // Header row: required fields get a "*" suffix
  const headers = fields.map((f) => `${f.label}${f.required ? " *" : ""}`);
  const sampleRow = fields.map((f) => sampleFor(f));
  const hintRow = fields.map((f) => hintFor(f));
  const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow, hintRow]);
  // Set sensible column widths so the hint row is readable when opened.
  ws["!cols"] = headers.map((h, i) => ({
    wch: Math.min(
      60,
      Math.max(
        h.length + 2,
        String(sampleRow[i] ?? "").length + 2,
        String(hintRow[i] ?? "").length + 2,
        14,
      ),
    ),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, descriptor.label.slice(0, 30));
  XLSX.writeFile(wb, `${descriptor.name}-template.xlsx`);
}

function sampleFor(f: Field): string {
  switch (f.type) {
    case "email": return "name@example.com";
    case "number": return "0.00";
    case "integer": return "0";
    case "date": return "2025-01-31";
    case "datetime": return "2025-01-31T09:00";
    case "boolean": return "false";
    case "select": return f.options?.[0]?.value ?? "";
    case "fk":
      return f.importResolveByLabel
        ? `<${f.fkTable} ${f.fkLabel ?? "name"}>`
        : `<${f.fkTable} id (uuid)>`;
    case "password": return "min 6 chars";
    default: return "";
  }
}

/** A short human hint describing the accepted format / allowed values. */
function hintFor(f: Field): string {
  const req = f.required ? "required. " : "optional. ";
  switch (f.type) {
    case "email": return req + "Valid email address";
    case "number": return req + "Decimal number, e.g. 12.50";
    case "integer": return req + "Whole number";
    case "date": return req + "YYYY-MM-DD";
    case "datetime": return req + "YYYY-MM-DDTHH:mm (ISO 8601)";
    case "boolean": return req + "true or false";
    case "select":
      return req + "One of: " + (f.options ?? []).map((o) => o.value).join(" | ");
    case "fk":
      return req + (f.importResolveByLabel
        ? `Existing ${f.fkTable} ${f.fkLabel ?? "name"} (matched case-insensitively)`
        : `UUID of an existing ${f.fkTable} row`);
    case "password": return req + "Min 6 characters (omit column to keep existing)";
    case "textarea": return req + "Free text";
    default: return req + "Free text";
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
      const d = new Date(String(s));
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }
    case "datetime": {
      const d = new Date(String(s));
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
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
