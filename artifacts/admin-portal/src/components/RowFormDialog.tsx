import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useFkOptions, invalidateFk } from "@/lib/fk";
import { toFormValue, fromFormValue, formatDateTime } from "@/lib/format";
import { type Field, type TableDescriptor, singularize } from "@/lib/tables";
import { api, ApiError, fetchWithAuth } from "@/lib/api";
import { FileUploadField, MultiFileUploadField } from "./FileUploadField";
import { openSignedObject, type UploadedFile } from "@/lib/upload";
import { ExternalLink, MapPin, AlertTriangle, FileDown, Link2 } from "lucide-react";
import { EmployeeShareMintDialog } from "./EmployeeShareMintDialog";

type EmployeeChangeRow = {
  id: string;
  source: "admin" | "self";
  field: string;
  fieldLabel?: string;
  oldValue: string | null;
  newValue: string | null;
  actorName: string | null;
  actorEmail: string | null;
  changedAt: string;
};

function RecentChangesPanel({ employeeUserId }: { employeeUserId: string }) {
  const [rows, setRows] = useState<EmployeeChangeRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    (async () => {
      try {
        const data = await api<{ rows: EmployeeChangeRow[] }>(`/employees/${employeeUserId}/changes?limit=20`);
        if (!cancelled) setRows(data.rows ?? []);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [employeeUserId]);
  return (
    <div className="mt-6 pt-4 border-t border-brand-gold/40">
      <h3 className="text-sm font-semibold tracking-wide brand-navy mb-2">Recent changes</h3>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {!err && rows === null && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
      {rows && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">No profile edits recorded yet.</p>
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {rows.map((r) => (
            <li key={r.id} className="text-xs border border-border rounded p-2 bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold brand-navy">{r.fieldLabel ?? r.field}</span>
                <span className="text-muted-foreground">{formatDateTime(r.changedAt)}</span>
              </div>
              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
                <span className="text-muted-foreground">From:</span>
                <span className="truncate">{r.oldValue ?? <em className="text-muted-foreground">empty</em>}</span>
                <span className="text-muted-foreground">To:</span>
                <span className="truncate">{r.newValue ?? <em className="text-muted-foreground">empty</em>}</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                By {r.actorName ?? r.actorEmail ?? "Unknown"} · {r.source === "self" ? "self-edit" : "admin"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FieldInput({
  field, value, onChange, onPickFkRow, filterValue, inputId, describedBy, invalid, autoFocus,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
  onPickFkRow?: (row: Record<string, unknown> | null) => void;
  /** When field.filterBy is set, this is the value of the source form field used to filter FK options. */
  filterValue?: string;
  inputId: string;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const ariaProps = {
    id: inputId,
    "aria-required": field.required || undefined,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  };
  const fk = useFkOptions(field.type === "fk" ? field.fkTable : undefined);
  const fkOptions = field.filterBy
    ? fk.options.filter((o) => String(o.row[field.filterBy!.fkRowKey] ?? "") === (filterValue ?? ""))
    : fk.options;
  if (field.type === "textarea") {
    return <Textarea {...ariaProps} autoFocus={autoFocus} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === "json") {
    return (
      <Textarea
        {...ariaProps}
        autoFocus={autoFocus}
        rows={6}
        value={value}
        placeholder='{ }'
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === "fileKey") {
    const current = value?.trim();
    return (
      <div className="space-y-2">
        {current && (
          <div className="flex items-center gap-2 p-2 bg-accent/40 border border-accent rounded text-xs">
            <button
              type="button"
              onClick={() => openSignedObject(current)}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline truncate flex-1 text-left"
            >
              <ExternalLink className="w-3 h-3 shrink-0" />
              <span className="truncate">{current.split("/").pop()}</span>
            </button>
            <button
              type="button"
              onClick={() => onChange("")}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Remove"
            >
              ×
            </button>
          </div>
        )}
        <FileUploadField
          label={current ? "Replace file" : "Upload file"}
          value={null}
          onChange={(f: UploadedFile | null) => { if (f) onChange(f.objectPath); }}
        />
      </div>
    );
  }
  if (field.type === "fileKeyList") {
    let arr: string[] = [];
    try {
      const parsed = value ? JSON.parse(value) : [];
      if (Array.isArray(parsed)) arr = parsed.filter((x) => typeof x === "string");
    } catch {
      // fall through with empty list
    }
    const setArr = (next: string[]) => onChange(JSON.stringify(next));
    return (
      <div className="space-y-2">
        {arr.length > 0 && (
          <div className="space-y-1">
            {arr.map((p, i) => (
              <div key={i} className="flex items-center gap-2 p-2 bg-accent/40 border border-accent rounded text-xs">
                <button
                  type="button"
                  onClick={() => openSignedObject(p)}
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline truncate flex-1 text-left"
                >
                  <ExternalLink className="w-3 h-3 shrink-0" />
                  <span className="truncate">{p.split("/").pop()}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setArr(arr.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-destructive"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <MultiFileUploadField
          label="Add files"
          value={[]}
          onChange={(files: UploadedFile[]) => setArr([...arr, ...files.map((f) => f.objectPath)])}
        />
      </div>
    );
  }
  if (field.type === "boolean") {
    return (
      <Select value={value || "false"} onValueChange={onChange}>
        <SelectTrigger {...ariaProps} autoFocus={autoFocus}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "select") {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger {...ariaProps} autoFocus={autoFocus}><SelectValue placeholder="Select…" /></SelectTrigger>
        <SelectContent>
          {field.options?.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "fk") {
    return (
      <Select
        value={value}
        onValueChange={(v) => {
          onChange(v);
          if (onPickFkRow) {
            const picked = fkOptions.find((o) => o.id === v);
            onPickFkRow(picked?.row ?? null);
          }
        }}
      >
        <SelectTrigger {...ariaProps} autoFocus={autoFocus}>
          <SelectValue placeholder={
            fk.loading ? "Loading…"
            : field.filterBy && !filterValue ? `Pick ${field.filterBy.formKey} first…`
            : fkOptions.length === 0 && field.filterBy ? "No matches for this site"
            : "Search & select…"
          } />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {fkOptions.map((o) => (
            <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const inputType =
    field.type === "datetime" ? "datetime-local"
    : field.type === "date" ? "date"
    : field.type === "number" || field.type === "integer" ? "number"
    : field.type === "email" ? "email"
    : field.type === "password" ? "password"
    : "text";
  return (
    <Input
      {...ariaProps}
      autoFocus={autoFocus}
      type={inputType}
      value={value}
      placeholder={field.placeholder}
      step={field.type === "number" ? "0.01" : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function RowFormDialog({
  open, onOpenChange, descriptor, initial, onSaved, presetValues, lockedFields,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  descriptor: TableDescriptor;
  initial: Record<string, unknown> | null;
  onSaved: () => void;
  /** Pre-fill these field values when opening for create. Ignored on edit. */
  presetValues?: Record<string, string>;
  /** Hide these fields entirely (used for nested grids where the parent FK is implicit). */
  lockedFields?: string[];
}) {
  const lockedSet = useMemo(() => new Set(lockedFields ?? []), [lockedFields]);
  const editable = useMemo(
    () => descriptor.fields.filter((f) => !f.readonly && !f.derived),
    [descriptor],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidKey, setInvalidKey] = useState<string | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null);
  const [shareMintOpen, setShareMintOpen] = useState(false);
  const formId = useId();
  const errorId = `${formId}-error`;
  const geocodeMsgId = `${formId}-geocode-msg`;

  const isSites = descriptor.name === "sites";
  const sitesAddress = (values["address"] ?? "").trim();
  const sitesHasCoords =
    (values["locationLat"] ?? "").trim() !== "" &&
    (values["locationLng"] ?? "").trim() !== "";

  async function geocodeSiteAddress() {
    if (!sitesAddress) {
      setGeocodeMsg("Enter the site's street address first.");
      return;
    }
    setGeocoding(true);
    setGeocodeMsg(null);
    try {
      const r = await api<{ lat: number; lng: number }>(`/sites/geocode`, {
        method: "POST",
        body: { address: sitesAddress },
      });
      setValues((prev) => ({
        ...prev,
        locationLat: String(r.lat),
        locationLng: String(r.lng),
      }));
      setGeocodeMsg(`Filled in coordinates (${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}).`);
    } catch (e) {
      const err = e as ApiError | Error;
      const msg =
        (err as ApiError).data && typeof (err as ApiError).data === "object"
          ? ((err as ApiError).data as { message?: string }).message ?? err.message
          : err.message;
      setGeocodeMsg(msg || "Couldn't geocode that address.");
    } finally {
      setGeocoding(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const v: Record<string, string> = {};
    for (const f of editable) {
      if (initial) {
        v[f.key] = toFormValue((initial as any)[f.key], f);
      } else if (presetValues && presetValues[f.key] !== undefined) {
        v[f.key] = presetValues[f.key];
      } else {
        v[f.key] = "";
      }
    }
    setValues(v);
    setError(null);
    setInvalidKey(null);
    setGeocodeMsg(null);
  }, [open, initial, editable, presetValues]);

  async function submit() {
    setSaving(true);
    setError(null);
    setInvalidKey(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of editable) {
        if (f.virtual) continue; // UI-only helper, never sent to API
        const raw = values[f.key] ?? "";
        if (f.type === "password" && raw === "") continue; // don't overwrite
        const v = fromFormValue(raw, f);
        if (v === null && !f.required && initial) {
          payload[f.key] = null;
        } else if (v !== "" && v !== null) {
          payload[f.key] = v;
        } else if (!initial && f.required) {
          setInvalidKey(f.key);
          throw new Error(`${f.label} is required`);
        }
      }
      if (initial) {
        await api(`/admin/tables/${descriptor.name}/${(initial as any).id}`, {
          method: "PUT", body: payload,
        });
      } else {
        await api(`/admin/tables/${descriptor.name}`, {
          method: "POST", body: payload,
        });
      }
      invalidateFk(descriptor.name);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      const err = e as ApiError | Error;
      const detail =
        (err as ApiError).data && typeof (err as ApiError).data === "object"
          ? JSON.stringify((err as ApiError).data, null, 2).slice(0, 500)
          : "";
      setError(`${err.message}${detail ? `\n${detail}` : ""}`);
    } finally {
      setSaving(false);
    }
  }

  const visibleFields = editable.filter((f) => !lockedSet.has(f.key));
  const firstFocusableKey = visibleFields[0]?.key ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initial ? `Edit ${singularize(descriptor.label)}` : `Add ${singularize(descriptor.label)}`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {initial
              ? `Edit this ${singularize(descriptor.label).toLowerCase()}. Required fields are marked.`
              : `Create a new ${singularize(descriptor.label).toLowerCase()}. Required fields are marked.`}
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="contents"
          onSubmit={(e) => { e.preventDefault(); if (!saving) submit(); }}
        >
        <div className="space-y-5 py-2">
          {(() => {
            // Group fields into sections in declared order. A field's `section`
            // starts a new section that all subsequent unsectioned fields fall
            // under, until the next field that declares a section.
            const groups: { section: string | null; fields: typeof visibleFields }[] = [];
            let current: { section: string | null; fields: typeof visibleFields } | null = null;
            for (const f of visibleFields) {
              if (f.section || !current) {
                current = { section: f.section ?? null, fields: [] };
                groups.push(current);
              }
              current.fields.push(f);
            }
            return groups.map((g, gi) => (
              <div key={gi}>
                {g.section && (
                  <div className="mb-2 pb-1 border-b border-brand-gold/40">
                    <h3 className="text-sm font-semibold tracking-wide brand-navy">{g.section}</h3>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {g.fields.map((f) => {
                    const fieldId = `${formId}-${f.key}`;
                    const fieldErrorId = invalidKey === f.key ? errorId : undefined;
                    return (
                    <div key={f.key} className={(f.type === "textarea" || f.type === "json" || f.type === "fileKeyList") ? "md:col-span-2" : ""}>
                      <Label htmlFor={fieldId} className="text-xs font-semibold uppercase tracking-wide brand-navy">
                        {f.label}
                        {f.required && (
                          <>
                            <span aria-hidden="true" className="text-destructive ml-1">*</span>
                            <span className="sr-only"> (required)</span>
                          </>
                        )}
                      </Label>
                      <div className="mt-1">
                        {descriptor.name === "sites" && f.key === "geofenceRadiusMiles" && (() => {
                          const raw = (values[f.key] ?? "").trim();
                          if (raw === "") return null;
                          const n = Number(raw);
                          if (!Number.isFinite(n) || n <= 0 || n >= 0.05) return null;
                          const feet = Math.round(n * 5280);
                          return (
                            <div
                              role="status"
                              aria-live="polite"
                              className="mb-2 flex items-start gap-1.5 text-xs text-amber-800 bg-amber-100 border border-amber-300 rounded px-2 py-1.5"
                            >
                              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                              <span>
                                <strong>{n} mi (~{feet.toLocaleString()} ft) is tighter than typical phone GPS accuracy (~30–65 ft on a good day, much worse indoors).</strong>{" "}
                                Officers may be flagged as off-site every time their signal wobbles, paging admins on every breach. We recommend <strong>≥ 0.1 mi (~528 ft)</strong>. The value will still save if you proceed.
                              </span>
                            </div>
                          );
                        })()}
                        <FieldInput
                  field={f}
                  inputId={fieldId}
                  describedBy={fieldErrorId}
                  invalid={invalidKey === f.key}
                  autoFocus={f.key === firstFocusableKey}
                  value={values[f.key] ?? ""}
                  filterValue={f.filterBy ? values[f.filterBy.formKey] ?? "" : undefined}
                  onChange={(v) => setValues((prev) => {
                    const next = { ...prev, [f.key]: v };
                    // If a parent of a virtual filtered field changed, clear the dependent virtual field.
                    for (const other of editable) {
                      if (other.virtual && other.filterBy?.formKey === f.key && next[other.key]) {
                        next[other.key] = "";
                      }
                    }
                    return next;
                  })}
                  onPickFkRow={f.autofill ? (row) => {
                    if (!row || !f.autofill) return;
                    setValues((prev) => {
                      const next = { ...prev };
                      for (const [target, source] of Object.entries(f.autofill!)) {
                        const v = row[source];
                        if (v !== null && v !== undefined) next[target] = String(v);
                      }
                      return next;
                    });
                  } : undefined}
                />
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            ));
          })()}
        </div>
        {isSites && (
          <div className="rounded border border-brand-gold/40 bg-brand-gold/5 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs">
                <div className="font-semibold brand-navy uppercase tracking-wide flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> Site coordinates
                </div>
                {sitesHasCoords ? (
                  <div className="text-muted-foreground mt-0.5">
                    Saved: {values["locationLat"]}, {values["locationLng"]}
                  </div>
                ) : (
                  <div className="text-amber-700 mt-0.5 inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    Needs coordinates — the live map and clock-in picker can't use this site until lat/lng are set.
                  </div>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={geocodeSiteAddress}
                disabled={geocoding || !sitesAddress}
                title={sitesAddress ? "Look up lat/lng from the address above" : "Enter an address first"}
              >
                {geocoding ? "Geocoding…" : sitesHasCoords ? "Re-geocode" : "Geocode address"}
              </Button>
            </div>
            <div id={geocodeMsgId} aria-live="polite" className="text-xs text-muted-foreground min-h-0">
              {geocodeMsg}
            </div>
          </div>
        )}
        {error && (
          <pre
            id={errorId}
            role="alert"
            aria-live="assertive"
            className="text-xs text-destructive whitespace-pre-wrap bg-destructive/5 p-2 rounded border border-destructive/20"
          >
            {error}
          </pre>
        )}
        {descriptor.name === "employees" && initial && (initial as { userId?: string }).userId && (
          <RecentChangesPanel employeeUserId={String((initial as { userId: string }).userId)} />
        )}
        <DialogFooter>
          {initial && descriptor.name === "employees" && (
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                // Personnel grid rows are keyed by employees.id, but the
                // profile-PDF route resolves by users.id — prefer userId
                // (fall back to id), matching the "Share with client" button.
                const id = String(
                  (initial as { userId?: unknown; id?: unknown }).userId ??
                    (initial as { id?: unknown }).id ??
                    "",
                );
                if (!id) return;
                try {
                  const res = await fetchWithAuth(`/api/employees/${id}/profile/pdf`);
                  if (!res.ok) throw new Error(`Request failed (${res.status})`);
                  const blob = await res.blob();
                  const cd = res.headers.get("Content-Disposition") ?? "";
                  const m = /filename="?([^";]+)"?/i.exec(cd);
                  const filename = m?.[1] ?? `wcsg-profile-${id.slice(0, 8)}.pdf`;
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = filename;
                  document.body.appendChild(a); a.click(); a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (e) {
                  alert(`Could not download profile PDF: ${(e as Error).message}`);
                }
              }}
              className="mr-auto"
              title="Download a branded PDF of this officer's full profile (bank + SSN masked)"
            >
              <FileDown className="w-4 h-4 mr-1.5" />
              Download profile PDF
            </Button>
          )}
          {initial && descriptor.name === "employees" && (() => {
            // Personnel grid rows are keyed by employees.id, but the
            // share/profile surfaces are keyed by users.id. Prefer
            // userId; the server accepts either form.
            const init = initial as { id?: unknown; userId?: unknown; firstName?: unknown; lastName?: unknown };
            const id = String(init.userId ?? init.id ?? "");
            const name = [init.firstName, init.lastName].filter(Boolean).join(" ").trim() || undefined;
            return (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShareMintOpen(true)}
                  disabled={!id}
                  title="Mint a no-login link to share this officer's profile with a client (sensitive fields always redacted; pick which optional sections show)"
                >
                  <Link2 className="w-4 h-4 mr-1.5" />
                  Share with client…
                </Button>
                {id && (
                  <EmployeeShareMintDialog
                    open={shareMintOpen}
                    onOpenChange={setShareMintOpen}
                    employeeUserId={id}
                    employeeName={name}
                  />
                )}
              </>
            );
          })()}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={saving} className="bg-brand-navy text-white hover:opacity-90">
            {saving ? "Saving…" : initial ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
