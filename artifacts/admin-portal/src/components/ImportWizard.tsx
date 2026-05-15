import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, AlertTriangle, FileSpreadsheet, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import type { TableDescriptor, Field } from "@/lib/tables";
import { useFkOptions, invalidateFk, loadFkRows } from "@/lib/fk";
import { getTable } from "@/lib/tables";
import { autoMap, buildErrorCsv, coerceCell, readSpreadsheet, type ParsedSheet } from "@/lib/import";

type Step = "upload" | "map" | "preview" | "result";

type ImportResult = {
  inserted: number;
  failed: number;
  total: number;
  results: { index: number; ok: boolean; id?: string; error?: string }[];
};

function DefaultValueInput({
  field, value, onChange,
}: { field: Field; value: string; onChange: (v: string) => void }) {
  const fk = useFkOptions(field.type === "fk" ? field.fkTable : undefined);
  if (field.type === "fk") {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick…" /></SelectTrigger>
        <SelectContent className="max-h-72">
          {fk.options.map((o) => (
            <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "select") {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick…" /></SelectTrigger>
        <SelectContent>
          {field.options?.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      className="h-8 text-xs"
      value={value}
      placeholder="(blank)"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ImportWizard({
  open, onOpenChange, descriptor, onDone,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  descriptor: TableDescriptor;
  onDone: () => void;
}) {
  const writableFields = descriptor.fields.filter((f) => !f.readonly && !f.virtual);
  const [step, setStep] = useState<Step>("upload");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [previewIssues, setPreviewIssues] = useState<{ index: number; message: string }[]>([]);
  /** For each field with importResolveByLabel: map of normalized FK label -> id, used to translate "Kanvas" → site UUID. */
  const [fkLabelMaps, setFkLabelMaps] = useState<Record<string, Map<string, string>>>({});

  useEffect(() => {
    let cancelled = false;
    const resolvable = writableFields.filter((f) => f.type === "fk" && f.importResolveByLabel && f.fkTable);
    Promise.all(
      resolvable.map(async (f) => {
        const rows = await loadFkRows(f.fkTable!);
        const labelField = getTable(f.fkTable!)?.primaryLabelField ?? "id";
        const m = new Map<string, string>();
        for (const r of rows) {
          const id = String((r as any).id ?? "");
          const label = String((r as any)[labelField] ?? "").trim().toLowerCase();
          if (id && label) m.set(label, id);
        }
        return [f.key, m] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setFkLabelMaps(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [descriptor.name]);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function reset() {
    setStep("upload");
    setSheet(null);
    setMapping({});
    setDefaults({});
    setBusy(false);
    setError(null);
    setResult(null);
    setPreviewRows([]);
    setPreviewIssues([]);
  }

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const parsed = await readSpreadsheet(file);
      setSheet(parsed);
      setMapping(autoMap(parsed.headers, writableFields));
      setDefaults({});
      setStep("map");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function buildPayloadRows(): Record<string, unknown>[] {
    if (!sheet) return [];
    return sheet.rows.map((r) => {
      const out: Record<string, unknown> = {};
      // Apply defaults first so explicit cell values override them.
      for (const [k, v] of Object.entries(defaults)) {
        if (v !== "") out[k] = v;
      }
      for (const [header, key] of Object.entries(mapping)) {
        if (!key) continue;
        const f = writableFields.find((x) => x.key === key);
        if (!f) continue;
        const raw = r[header];
        const v = coerceCell(raw, f);
        if (v !== null && v !== undefined && v !== "") out[key] = v;
      }
      // Coerce defaults to typed values too.
      for (const f of writableFields) {
        if (f.key in out && (defaults[f.key] === out[f.key] || mapping && Object.values(mapping).includes(f.key))) {
          const v = coerceCell(out[f.key], f);
          if (v !== null && v !== undefined && v !== "") out[f.key] = v;
        }
      }
      // Resolve FK label -> id for fields opted in via importResolveByLabel.
      for (const f of writableFields) {
        if (!f.importResolveByLabel || f.type !== "fk") continue;
        const v = out[f.key];
        if (v === undefined || v === null || v === "") continue;
        const s = String(v);
        if (UUID_RE.test(s)) continue;
        const id = fkLabelMaps[f.key]?.get(s.trim().toLowerCase());
        if (id) out[f.key] = id;
        // If not resolved, leave the raw string — it'll fail validation and surface in the error CSV.
      }
      return out;
    });
  }

  function goPreview() {
    const built = buildPayloadRows();
    const issues: { index: number; message: string }[] = [];
    built.forEach((row, idx) => {
      for (const f of writableFields) {
        if (f.required && (row[f.key] === undefined || row[f.key] === null || row[f.key] === "")) {
          issues.push({ index: idx, message: `Row ${idx + 1}: missing required "${f.label}"` });
        }
        if (f.type === "fk" && f.importResolveByLabel) {
          const v = row[f.key];
          if (v && !UUID_RE.test(String(v))) {
            issues.push({ index: idx, message: `Row ${idx + 1}: "${f.label}" value "${v}" doesn't match any existing ${f.fkTable}` });
          }
        }
      }
    });
    setPreviewRows(built);
    setPreviewIssues(issues);
    setStep("preview");
  }

  async function runImport() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ImportResult>(`/admin/import/${descriptor.name}`, {
        method: "POST",
        body: { rows: previewRows },
      });
      setResult(res);
      invalidateFk(descriptor.name);
      setStep("result");
      if (res.inserted > 0) onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function downloadErrorCsv() {
    if (!sheet || !result) return;
    const failed = result.results
      .filter((r) => !r.ok)
      .map((r) => ({ row: sheet.rows[r.index] ?? {}, error: r.error ?? "Unknown" }));
    const blob = buildErrorCsv(sheet.headers, failed);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${descriptor.name}-errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={(b) => { onOpenChange(b); if (!b) reset(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Import {descriptor.label} —{" "}
            <span className="brand-gold">
              {step === "upload" ? "Upload file"
                : step === "map" ? "Map columns"
                : step === "preview" ? "Preview & validate"
                : "Done"}
            </span>
          </DialogTitle>
        </DialogHeader>

        {error && (
          <div className="text-sm text-destructive bg-destructive/5 p-3 rounded border border-destructive/20">
            {error}
          </div>
        )}

        {step === "upload" && (
          <div className="py-8 text-center border-2 border-dashed rounded-lg">
            <FileSpreadsheet className="w-10 h-10 mx-auto brand-gold mb-3" />
            <p className="text-sm text-muted-foreground mb-3">
              Drop or pick an Excel (.xlsx) or CSV file. The first sheet is used.
            </p>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.tsv"
              disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              className="block mx-auto text-sm"
            />
          </div>
        )}

        {step === "map" && sheet && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Detected <b>{sheet.headers.length}</b> columns and <b>{sheet.rows.length}</b> rows.
              Match each spreadsheet column to a field, or set a default value for any missing required fields.
            </p>
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-sm">
              <div className="font-semibold uppercase text-xs brand-navy">Spreadsheet column</div>
              <div></div>
              <div className="font-semibold uppercase text-xs brand-navy">Field</div>
              {sheet.headers.map((h) => (
                <div key={h} className="contents">
                  <div className="text-sm py-1.5 truncate font-mono bg-accent/30 px-2 rounded">{h}</div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  <Select
                    value={mapping[h] ?? ""}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [h]: v === "__skip__" ? "" : v }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Skip" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__skip__">Skip this column</SelectItem>
                      {writableFields.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}{f.required ? " *" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="border-t pt-4">
              <div className="text-xs uppercase font-semibold brand-navy mb-2">Default values (apply to all rows)</div>
              <div className="grid grid-cols-2 gap-3">
                {writableFields
                  .filter((f) => !Object.values(mapping).includes(f.key))
                  .map((f) => (
                    <div key={f.key}>
                      <Label className="text-xs">
                        {f.label}{f.required && <span className="text-destructive ml-1">*</span>}
                      </Label>
                      <DefaultValueInput
                        field={f}
                        value={defaults[f.key] ?? ""}
                        onChange={(v) => setDefaults((d) => ({ ...d, [f.key]: v }))}
                      />
                    </div>
                  ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep("upload")}>Back</Button>
              <Button onClick={goPreview} className="bg-brand-navy text-white hover:opacity-90">
                Preview rows
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <CheckCircle2 className="w-4 h-4" /> {previewRows.length - previewIssues.length} ready
              </span>
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle className="w-4 h-4" /> {previewIssues.length} flagged
              </span>
            </div>
            {previewIssues.length > 0 && (
              <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 max-h-32 overflow-auto">
                {previewIssues.slice(0, 30).map((i, n) => <div key={n}>{i.message}</div>)}
                {previewIssues.length > 30 && <div className="italic">…and {previewIssues.length - 30} more</div>}
              </div>
            )}
            <div className="overflow-auto max-h-72 border rounded">
              <table className="w-full text-xs">
                <thead className="bg-card sticky top-0">
                  <tr>
                    <th className="text-left p-2">#</th>
                    {writableFields.map((f) => <th key={f.key} className="text-left p-2">{f.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 text-muted-foreground">{i + 1}</td>
                      {writableFields.map((f) => (
                        <td key={f.key} className="p-2 truncate max-w-[200px]">
                          {r[f.key] === undefined || r[f.key] === null ? "—" : String(r[f.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewRows.length > 50 && (
                <div className="p-2 text-xs text-muted-foreground italic">
                  Showing first 50 of {previewRows.length} rows.
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep("map")}>Back</Button>
              <Button onClick={runImport} disabled={busy} className="bg-brand-navy text-white hover:opacity-90">
                {busy ? "Importing…" : `Import ${previewRows.length} rows`}
              </Button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <div className="border rounded p-3">
                <div className="text-xs text-muted-foreground">Total rows</div>
                <div className="text-2xl brand-navy" style={{ fontFamily: "Georgia, serif" }}>{result.total}</div>
              </div>
              <div className="border rounded p-3 bg-emerald-50">
                <div className="text-xs text-muted-foreground">Inserted</div>
                <div className="text-2xl text-emerald-700" style={{ fontFamily: "Georgia, serif" }}>{result.inserted}</div>
              </div>
              <div className="border rounded p-3 bg-destructive/5">
                <div className="text-xs text-muted-foreground">Failed</div>
                <div className="text-2xl text-destructive" style={{ fontFamily: "Georgia, serif" }}>{result.failed}</div>
              </div>
            </div>
            {result.failed > 0 && (
              <>
                <div className="text-xs bg-destructive/5 border border-destructive/20 rounded p-2 max-h-48 overflow-auto">
                  {result.results.filter((r) => !r.ok).slice(0, 50).map((r) => (
                    <div key={r.index}>Row {r.index + 1}: {r.error}</div>
                  ))}
                </div>
                <Button variant="outline" onClick={downloadErrorCsv}>
                  Download error CSV
                </Button>
              </>
            )}
            <div className="flex justify-end pt-2">
              <Button onClick={() => { onOpenChange(false); reset(); }} className="bg-brand-navy text-white hover:opacity-90">
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
