import ExcelJS from "exceljs";
import type { TableDescriptor, Field, FieldType } from "./tables";

/** Field types that require uploads, not text — excluded from the Excel
 *  import flow (template, mapping, validation). Admins still edit these
 *  per-row from the row dialog after the bulk-imported records exist. */
const NON_IMPORTABLE_TYPES: ReadonlySet<FieldType> = new Set(["fileKey", "fileKeyList"]);

/** Fields that participate in the Excel import: writable (not readonly /
 *  virtual) and not a file-upload type. */
export function getImportableFields(descriptor: TableDescriptor): Field[] {
  return descriptor.fields.filter(
    (f) => !f.readonly && !f.virtual && !f.derived && !NON_IMPORTABLE_TYPES.has(f.type),
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

/** Extract a plain scalar value from an ExcelJS cell value, which can be a
 *  formula result, rich-text object, hyperlink, Date, etc. */
function extractCellValue(val: ExcelJS.CellValue): unknown {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === "object") {
    if ("result" in val) {
      const r = (val as ExcelJS.CellFormulaValue).result;
      if (r instanceof Date) return r.toISOString();
      if (r instanceof Error) return "";
      return r ?? "";
    }
    if ("richText" in val) {
      return (val as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join("");
    }
    if ("text" in val) {
      return (val as ExcelJS.CellHyperlinkValue).text;
    }
    if (val instanceof Error) return "";
  }
  return val;
}

async function readXlsx(buf: ArrayBuffer, descriptor?: TableDescriptor): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf);
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount === 0) return { headers: [], rows: [] };

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    headers.push(String(extractCellValue(cell.value) ?? ""));
  });

  if (headers.length === 0) return { headers: [], rows: [] };

  const rows: Record<string, unknown>[] = [];
  for (let r = 2; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const obj: Record<string, unknown> = {};
    let hasData = false;
    headers.forEach((h, i) => {
      const cell = row.getCell(i + 1);
      const val = extractCellValue(cell.value);
      obj[h] = val;
      if (val !== null && val !== undefined && val !== "") hasData = true;
    });
    if (hasData) rows.push(obj);
  }

  let hintRowSkipped = false;
  if (descriptor && rows.length > 0 && isTemplateHintRow(rows[0], headers, descriptor)) {
    rows.shift();
    hintRowSkipped = true;
  }
  return { headers, rows, hintRowSkipped };
}

function parseCsv(text: string, delimiter: string): ParsedSheet {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };

  function parseLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuote = false;
        else cur += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === delimiter) { cells.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  }

  const headers = parseLine(lines[0]);
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = parseLine(line);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    rows.push(obj);
  }
  return { headers, rows };
}

export async function readSpreadsheet(
  file: File,
  descriptor?: TableDescriptor,
): Promise<ParsedSheet> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    const text = await file.text();
    const result = parseCsv(text, ",");
    if (descriptor && result.rows.length > 0 && isTemplateHintRow(result.rows[0], result.headers, descriptor)) {
      result.rows.shift();
      result.hintRowSkipped = true;
    }
    return result;
  }
  if (name.endsWith(".tsv")) {
    const text = await file.text();
    const result = parseCsv(text, "\t");
    if (descriptor && result.rows.length > 0 && isTemplateHintRow(result.rows[0], result.headers, descriptor)) {
      result.rows.shift();
      result.hintRowSkipped = true;
    }
    return result;
  }
  const buf = await file.arrayBuffer();
  return readXlsx(buf, descriptor);
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

export async function downloadTemplateXlsx(descriptor: TableDescriptor): Promise<void> {
  const fields = getImportableFields(descriptor);
  const headers = fields.map((f) => f.label);
  const sampleRow = fields.map((f) => sampleFor(f));

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(descriptor.label.slice(0, 30));

  worksheet.addRow(headers);
  worksheet.addRow(sampleRow);

  worksheet.columns = headers.map((h, i) => ({
    width: Math.max(12, h.length + 2, String(sampleRow[i] ?? "").length + 2),
  }));

  const headerCell = worksheet.getCell("A1");
  headerCell.note = {
    texts: [{
      text: `Row 2 contains example values to show the expected format for each column. Delete row 2 before importing your real data — if you leave it in, ${TEMPLATE_HINT_MARKER.toLowerCase()} (we will skip it automatically).`,
    }],
  };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${descriptor.name}-template.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
    if (v >= 1 && v < 2958466) {
      return new Date(EXCEL_EPOCH_MS + Math.round(v * 86400 * 1000));
    }
    return null;
  }
  const str = String(v ?? "").trim();
  if (!str) return null;
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
      const m = String(s).match(/-?\d+/);
      return m ? parseInt(m[0], 10) : null;
    }
    case "number": {
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
      if (typeof s === "object") return s;
      const str = String(s).trim();
      try {
        return JSON.parse(str);
      } catch {
        return null;
      }
    }
    case "fileKeyList": {
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
      const v = String(s).toLowerCase();
      const opt = field.options?.find(
        (o) => o.value.toLowerCase() === v || o.label.toLowerCase() === v,
      );
      if (opt) return opt.value;
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
