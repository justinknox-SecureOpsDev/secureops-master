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
import { getTable, getImportMatchByLabelFields, singularize } from "@/lib/tables";
import { autoMap, buildErrorCsv, coerceCell, getImportableFields, readSpreadsheet, sampleFor, type ParsedSheet } from "@/lib/import";

/** Normalize a raw cell value to a comparable lookup key. */
function normalizeKey(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim().toLowerCase();
}

/** Friendly label for a list of match-field keys, e.g. ["title","startTime"] -> "title + startTime". */
function joinFieldLabels(t: TableDescriptor, keys: string[]): string {
  return keys
    .map((k) => t.fields.find((f) => f.key === k)?.label ?? k)
    .join(" + ");
}

type Step = "upload" | "map" | "preview" | "result";

type ImportResult = {
  inserted: number;
  failed: number;
  total: number;
  results: { index: number; ok: boolean; id?: string; error?: string }[];
  /** Map of fkField -> list of distinct labels the server auto-provisioned
   *  (e.g. employee names that didn't already exist in the system). */
  autoCreated?: Record<string, string[]>;
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
  // Importable fields exclude file-upload columns (fileKey / fileKeyList) —
  // those require object-storage uploads, not spreadsheet text, so they're
  // hidden from the template, mapping UI, defaults, and preview.
  const writableFields = getImportableFields(descriptor);
  const fkFields = writableFields.filter((f) => f.type === "fk" && f.fkTable);
  const [step, setStep] = useState<Step>("upload");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [previewIssues, setPreviewIssues] = useState<{ index: number; message: string }[]>([]);
  /**
   * Per FK field: how the user wants to resolve values.
   * "id" = the column already holds the UUID (default).
   * "label" = look up by name/email/title against the FK target table.
   */
  const [resolveBy, setResolveBy] = useState<Record<string, "id" | "label">>({});
  /**
   * For composite lookups (e.g. shifts matched by title + startTime),
   * `extraMatch[fkFieldKey][matchFieldKey] = spreadsheetHeader` tells us which
   * column supplies each part of the lookup key. The first match field is
   * supplied by the column already mapped to the FK field itself.
   */
  const [extraMatch, setExtraMatch] = useState<Record<string, Record<string, string>>>({});
  /** For each FK field in label mode: map of composite normalized key -> id. */
  const [fkLabelMaps, setFkLabelMaps] = useState<Record<string, Map<string, string>>>({});
  const [labelMapsLoading, setLabelMapsLoading] = useState(false);

  /** Initialize per-FK resolve mode from the descriptor's importResolveByLabel hint. */
  useEffect(() => {
    const initial: Record<string, "id" | "label"> = {};
    for (const f of fkFields) {
      initial[f.key] = f.importResolveByLabel ? "label" : "id";
    }
    setResolveBy(initial);
    setExtraMatch({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor.name]);

  /** Load FK target rows for every FK field currently in label mode and build composite lookup maps. */
  useEffect(() => {
    let cancelled = false;
    const labelFks = fkFields.filter((f) => resolveBy[f.key] === "label" && f.fkTable);
    if (labelFks.length === 0) {
      setFkLabelMaps({});
      return;
    }
    setLabelMapsLoading(true);
    Promise.all(
      labelFks.map(async (f) => {
        const target = getTable(f.fkTable!);
        const matchFields = target ? getImportMatchByLabelFields(target) : ["id"];
        const rows = await loadFkRows(f.fkTable!);
        const m = new Map<string, string>();
        for (const r of rows) {
          const id = String((r as any).id ?? "");
          if (!id) continue;
          if (f.importMatchKeyFn) {
            // Field-level override: use a single normalized key from the candidate row
            // (e.g. users by full name). Skips composite-key matchFields entirely.
            const key = normalizeKey(f.importMatchKeyFn(r));
            if (key) m.set(key, id);
          } else {
            const key = matchFields.map((mf) => normalizeKey((r as any)[mf])).join("|");
            if (key.replace(/\|/g, "") !== "") m.set(key, id);
          }
        }
        return [f.key, m] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setFkLabelMaps(Object.fromEntries(entries));
    }).finally(() => { if (!cancelled) setLabelMapsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor.name, JSON.stringify(resolveBy)]);

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
    setExtraMatch({});
  }

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const parsed = await readSpreadsheet(file, descriptor);
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
      // Resolve FK label -> id for fields the user set to "label" mode.
      for (const f of fkFields) {
        if (resolveBy[f.key] !== "label") continue;
        const target = f.fkTable ? getTable(f.fkTable) : undefined;
        if (!target) continue;
        // Primary value comes from the column mapped to this FK field (or its default).
        const primary = out[f.key];
        if (primary === undefined || primary === null || primary === "") continue;
        const primaryStr = String(primary);
        if (UUID_RE.test(primaryStr)) continue; // Already an ID, no lookup needed.
        let lookupKey: string;
        if (f.importMatchKeyFn) {
          // Single-key override (e.g. employee by full name); ignore composite parts.
          lookupKey = normalizeKey(primaryStr);
        } else {
          const matchFields = getImportMatchByLabelFields(target);
          const parts: string[] = [normalizeKey(primaryStr)];
          for (let i = 1; i < matchFields.length; i++) {
            const extraKey = matchFields[i];
            const header = extraMatch[f.key]?.[extraKey];
            parts.push(header ? normalizeKey(r[header]) : "");
          }
          lookupKey = parts.join("|");
        }
        const id = fkLabelMaps[f.key]?.get(lookupKey);
        if (id) out[f.key] = id;
        // If not resolved, leave the raw string — preview will flag it.
      }
      return out;
    });
  }

  async function goPreview() {
    const built = buildPayloadRows();
    const issues: { index: number; message: string }[] = [];
    built.forEach((row, idx) => {
      for (const f of writableFields) {
        if (f.required && (row[f.key] === undefined || row[f.key] === null || row[f.key] === "")) {
          issues.push({ index: idx, message: `Row ${idx + 1}: missing required "${f.label}"` });
        }
      }
    });
    setPreviewRows(built);
    setBusy(true);
    setError(null);
    try {
      // Authoritative dry-run: ask the server to resolve FKs against the live
      // DB and validate every row, without actually inserting. This catches
      // unresolved label lookups even when the browser's cached FK rows are
      // stale or the user toggled label mode on a field we don't pre-resolve
      // client-side for.
      const dry = await api<ImportResult & { dryRun?: boolean }>(
        `/admin/import/${descriptor.name}`,
        { method: "POST", body: { ...buildImportBody(built), dryRun: true } },
      );
      const serverIssues = dry.results
        .filter((r) => !r.ok)
        .map((r) => ({ index: r.index, message: `Row ${r.index + 1}: ${r.error ?? "validation failed"}` }));
      // Dedupe by index+message so client and server flagging the same row
      // for the same reason doesn't double-count.
      const seen = new Set<string>();
      const merged = [...issues, ...serverIssues].filter((i) => {
        const k = `${i.index}::${i.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setPreviewIssues(merged);
      setStep("preview");
    } catch (e) {
      // If the dry-run call itself fails, fall back to local issues only and
      // let the user see the preview anyway.
      setPreviewIssues(issues);
      setError((e as Error).message);
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }

  /** Build the per-row matchExtras payload for any FK in label mode with composite keys. */
  function buildMatchExtras(): Array<Record<string, Record<string, unknown>>> {
    if (!sheet) return [];
    return sheet.rows.map((r) => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const f of fkFields) {
        if (resolveBy[f.key] !== "label") continue;
        if (f.importMatchKeyFn) continue; // Single-key override — no composite extras to send.
        const target = f.fkTable ? getTable(f.fkTable) : undefined;
        if (!target) continue;
        const matchFields = getImportMatchByLabelFields(target);
        if (matchFields.length <= 1) continue;
        const extras: Record<string, unknown> = {};
        for (let i = 1; i < matchFields.length; i++) {
          const mf = matchFields[i];
          const header = extraMatch[f.key]?.[mf];
          if (header) extras[mf] = r[header];
        }
        if (Object.keys(extras).length > 0) out[f.key] = extras;
      }
      return out;
    });
  }

  /** The body sent to /admin/import — same shape for dry-run preview and real import. */
  function buildImportBody(rowsToSend: Record<string, unknown>[]) {
    const resolve: Record<string, { by: "id" | "label" }> = {};
    for (const f of fkFields) {
      resolve[f.key] = { by: resolveBy[f.key] ?? "id" };
    }
    return {
      rows: rowsToSend,
      resolve,
      matchExtras: buildMatchExtras(),
    };
  }

  async function runImport() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ImportResult>(`/admin/import/${descriptor.name}`, {
        method: "POST",
        body: buildImportBody(previewRows),
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
          <div className="space-y-3">
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
            <details className="border rounded-lg group">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium brand-navy hover:bg-accent/30 rounded-lg">
                What this template contains ({writableFields.length} columns)
              </summary>
              <div className="px-3 pb-3 pt-1">
                <p className="text-xs text-muted-foreground mb-2">
                  Your spreadsheet should have these columns (in any order). Required columns must
                  be filled in for every row.
                </p>
                <div className="overflow-auto max-h-72 border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-card sticky top-0">
                      <tr>
                        <th className="text-left p-2">Column</th>
                        <th className="text-left p-2">Example</th>
                        <th className="text-left p-2 w-20">Required</th>
                      </tr>
                    </thead>
                    <tbody>
                      {writableFields.map((f) => {
                        const example = sampleFor(f);
                        return (
                          <tr key={f.key} className="border-t">
                            <td className="p-2 font-medium brand-navy">{f.label}</td>
                            <td className="p-2 font-mono text-muted-foreground">
                              {example === "" ? <span className="italic">(blank)</span> : example}
                            </td>
                            <td className="p-2">
                              {f.required
                                ? <span className="text-destructive font-semibold">Yes</span>
                                : <span className="text-muted-foreground">No</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </div>
        )}

        {step === "map" && sheet && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Detected <b>{sheet.headers.length}</b> columns and <b>{sheet.rows.length}</b> rows.
              Match each spreadsheet column to a field, or set a default value for any missing required fields.
            </p>
            {sheet.hintRowSkipped && (
              <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2">
                Skipped the template's example row (it only shows the expected format). Delete row 2 from the file to remove this notice.
              </div>
            )}
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

            {fkFields.length > 0 && (
              <div className="border-t pt-4">
                <div className="text-xs uppercase font-semibold brand-navy mb-1">Foreign-key matching</div>
                <p className="text-xs text-muted-foreground mb-3">
                  By default each FK column expects the row's UUID. If your spreadsheet has names,
                  emails or titles instead, switch the field to "Match by …" and we'll look up the
                  matching record before importing.
                </p>
                <div className="space-y-3">
                  {fkFields.map((f) => {
                    const target = f.fkTable ? getTable(f.fkTable) : undefined;
                    const matchFields = target ? getImportMatchByLabelFields(target) : [];
                    const labelLabel = f.importMatchLabel
                      ?? (target ? joinFieldLabels(target, matchFields) : "name");
                    const showCompositeUI = !f.importMatchKeyFn;
                    const mode = resolveBy[f.key] ?? "id";
                    const primaryHeader = Object.entries(mapping).find(([, k]) => k === f.key)?.[0];
                    return (
                      <div key={f.key} className="grid grid-cols-[160px_1fr] gap-2 items-start text-xs">
                        <Label className="pt-2 brand-navy">{f.label}</Label>
                        <div className="space-y-2">
                          <Select
                            value={mode}
                            onValueChange={(v) => setResolveBy((prev) => ({ ...prev, [f.key]: v as "id" | "label" }))}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="id">Match by ID (UUID)</SelectItem>
                              <SelectItem value="label">Match by {labelLabel}</SelectItem>
                            </SelectContent>
                          </Select>
                          {mode === "label" && showCompositeUI && matchFields.length > 1 && (
                            <div className="pl-2 border-l-2 border-brand-gold/40 space-y-1.5">
                              <div className="text-[11px] text-muted-foreground">
                                {matchFields.length} columns are needed to identify a {target ? singularize(target.label).toLowerCase() : ""}:
                              </div>
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-center">
                                <span className="text-[11px] font-medium">
                                  {target?.fields.find((x) => x.key === matchFields[0])?.label ?? matchFields[0]}
                                </span>
                                <span className="text-[11px] font-mono bg-accent/30 px-2 py-1 rounded">
                                  {primaryHeader ?? <em className="text-amber-700 not-italic">map a column to {f.label} above</em>}
                                </span>
                                {matchFields.slice(1).map((mf) => (
                                  <div key={mf} className="contents">
                                    <span className="text-[11px] font-medium">
                                      {target?.fields.find((x) => x.key === mf)?.label ?? mf}
                                    </span>
                                    <Select
                                      value={extraMatch[f.key]?.[mf] ?? ""}
                                      onValueChange={(v) => setExtraMatch((prev) => ({
                                        ...prev,
                                        [f.key]: { ...(prev[f.key] ?? {}), [mf]: v === "__none__" ? "" : v },
                                      }))}
                                    >
                                      <SelectTrigger className="h-7 text-[11px]">
                                        <SelectValue placeholder="Pick column…" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">— none —</SelectItem>
                                        {sheet.headers.map((h) => (
                                          <SelectItem key={h} value={h}>{h}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {mode === "label" && labelMapsLoading && (
                            <div className="text-[11px] text-muted-foreground">Loading {f.fkTable}…</div>
                          )}
                          {mode === "label" && !labelMapsLoading && fkLabelMaps[f.key] && (
                            <div className="text-[11px] text-muted-foreground">
                              {fkLabelMaps[f.key].size.toLocaleString()} {f.fkTable} loaded for matching.
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
            {(() => {
              // Count unique failing rows, not issues — a single row may
              // collect several issues (missing required + unresolved FK).
              const flaggedRows = new Set(previewIssues.map((i) => i.index)).size;
              const readyRows = Math.max(0, previewRows.length - flaggedRows);
              return (
                <div className="flex items-center gap-4 text-sm">
                  <span className="inline-flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" /> {readyRows} ready
                  </span>
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <AlertTriangle className="w-4 h-4" /> {flaggedRows} flagged
                  </span>
                </div>
              );
            })()}
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
            {result.autoCreated && Object.keys(result.autoCreated).length > 0 && (
              <div className="text-xs bg-amber-50 border border-amber-300 rounded p-3 space-y-1">
                <div className="font-semibold text-amber-900">
                  Auto-created placeholder records — please complete their profiles later
                </div>
                {Object.entries(result.autoCreated).map(([field, labels]) => (
                  <div key={field}>
                    <span className="font-medium">{field}:</span> {labels.length} new ({labels.slice(0, 12).join(", ")}{labels.length > 12 ? `, +${labels.length - 12} more` : ""})
                  </div>
                ))}
              </div>
            )}
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
