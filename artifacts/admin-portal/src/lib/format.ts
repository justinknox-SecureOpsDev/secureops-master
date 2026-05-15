import type { Field } from "./tables";

export function formatCell(value: unknown, field: Field): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (field.type) {
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    }
    case "date": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleDateString();
    }
    case "boolean":
      return value ? "Yes" : "No";
    case "json":
      try { return JSON.stringify(value); } catch { return String(value); }
    case "fileKey":
      return String(value);
    case "fileKeyList": {
      if (!Array.isArray(value)) return String(value);
      return `${value.length} file${value.length === 1 ? "" : "s"}`;
    }
    case "select": {
      const opt = field.options?.find((o) => o.value === String(value));
      return opt?.label ?? String(value);
    }
    case "password":
      return "••••••";
    default:
      return String(value);
  }
}

export function toFormValue(value: unknown, field: Field): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return "";
      // input[type=datetime-local] expects "YYYY-MM-DDTHH:mm"
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case "date": {
      const s = String(value);
      if (s.length >= 10) return s.slice(0, 10);
      return s;
    }
    case "boolean":
      return value ? "true" : "false";
    case "json":
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    case "fileKey":
      return String(value);
    case "fileKeyList":
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    default:
      return String(value);
  }
}

export function fromFormValue(raw: string, field: Field): unknown {
  if (raw === "" || raw === null) {
    return field.required ? "" : null;
  }
  switch (field.type) {
    case "number":
      return raw;
    case "integer": {
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return raw === "true";
    case "datetime":
    case "date":
      return raw;
    case "json":
    case "fileKeyList":
      try { return JSON.parse(raw); } catch { return raw; }
    case "fileKey":
      return raw;
    default:
      return raw;
  }
}
