import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useFkOptions, invalidateFk } from "@/lib/fk";
import { toFormValue, fromFormValue } from "@/lib/format";
import type { Field, TableDescriptor } from "@/lib/tables";
import { api, ApiError } from "@/lib/api";

function FieldInput({
  field, value, onChange, onPickFkRow, filterValue,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
  onPickFkRow?: (row: Record<string, unknown> | null) => void;
  /** When field.filterBy is set, this is the value of the source form field used to filter FK options. */
  filterValue?: string;
}) {
  const fk = useFkOptions(field.type === "fk" ? field.fkTable : undefined);
  const fkOptions = field.filterBy
    ? fk.options.filter((o) => String(o.row[field.filterBy!.fkRowKey] ?? "") === (filterValue ?? ""))
    : fk.options;
  if (field.type === "textarea") {
    return <Textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === "boolean") {
    return (
      <Select value={value || "false"} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
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
        <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
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
        <SelectTrigger>
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
    () => descriptor.fields.filter((f) => !f.readonly),
    [descriptor],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [open, initial, editable, presetValues]);

  async function submit() {
    setSaving(true);
    setError(null);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initial ? `Edit ${descriptor.label.replace(/s$/, "")}` : `Add ${descriptor.label.replace(/s$/, "")}`}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
          {editable.filter((f) => !lockedSet.has(f.key)).map((f) => (
            <div key={f.key} className={f.type === "textarea" ? "md:col-span-2" : ""}>
              <Label className="text-xs font-semibold uppercase tracking-wide brand-navy">
                {f.label}{f.required && <span className="text-destructive ml-1">*</span>}
              </Label>
              <div className="mt-1">
                <FieldInput
                  field={f}
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
          ))}
        </div>
        {error && (
          <pre className="text-xs text-destructive whitespace-pre-wrap bg-destructive/5 p-2 rounded border border-destructive/20">
            {error}
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-brand-navy text-white hover:opacity-90">
            {saving ? "Saving…" : initial ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
