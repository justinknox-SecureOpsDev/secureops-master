import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { errorText, writeWasRefused, type SettingsMessage } from "@/lib/settingsStatus";
import { ControlMessage } from "@/components/SettingsStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, Plus, Pencil, Trash2, Check, X, ChevronUp, ChevronDown, Power, GripVertical,
} from "lucide-react";

const FIELD_TYPES = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Dropdown (single choice)" },
  { value: "multiselect", label: "Checkboxes (multiple choice)" },
  { value: "yes_no", label: "Yes / No" },
  { value: "file", label: "File upload" },
  { value: "photo", label: "Photo (camera or upload)" },
] as const;

type FieldType = (typeof FIELD_TYPES)[number]["value"];

const TYPE_LABEL: Record<FieldType, string> = Object.fromEntries(
  FIELD_TYPES.map((t) => [t.value, t.label]),
) as Record<FieldType, string>;

const NEEDS_OPTIONS = (t: FieldType) => t === "select" || t === "multiselect";

type Question = {
  id: string;
  label: string;
  helpText: string | null;
  fieldType: FieldType;
  required: boolean;
  options: string[] | null;
  sortOrder: number;
  enabled: boolean;
};

type Draft = {
  label: string;
  helpText: string;
  fieldType: FieldType;
  required: boolean;
  optionsText: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  label: "",
  helpText: "",
  fieldType: "short_text",
  required: false,
  optionsText: "",
  enabled: true,
};

function parseOptions(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function draftFromQuestion(q: Question): Draft {
  return {
    label: q.label,
    helpText: q.helpText ?? "",
    fieldType: q.fieldType,
    required: q.required,
    optionsText: (q.options ?? []).join("\n"),
    enabled: q.enabled,
  };
}

const INPUT_CLASS =
  "w-full border rounded h-10 px-3 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Mirrors APPLICATION_FIELD_SECTIONS in the api-server registry.
const FIELD_SECTIONS = [
  "Personal details",
  "I-9 & Identity",
  "TX license & experience",
  "References & documents",
  "Availability",
] as const;

type EffectiveField = {
  key: string;
  section: number;
  label: string;
  helpText: string | null;
  required: boolean;
  hidden: boolean;
  sortOrder: number;
  locked: boolean;
};

type FieldDraft = { label: string; helpText: string; required: boolean; hidden: boolean };

function fieldDraftFrom(f: EffectiveField): FieldDraft {
  return { label: f.label, helpText: f.helpText ?? "", required: f.required, hidden: f.hidden };
}

export function ApplicationBuilderPage() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Question[]>("/admin/application-questions");
      setQuestions(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function validateDraft(d: Draft): string | null {
    if (!d.label.trim()) return "Question label is required.";
    if (NEEDS_OPTIONS(d.fieldType) && parseOptions(d.optionsText).length === 0) {
      return "Add at least one option (one per line).";
    }
    return null;
  }

  function draftToBody(d: Draft) {
    return {
      label: d.label.trim(),
      helpText: d.helpText.trim() ? d.helpText.trim() : null,
      fieldType: d.fieldType,
      required: d.required,
      options: NEEDS_OPTIONS(d.fieldType) ? parseOptions(d.optionsText) : null,
      enabled: d.enabled,
    };
  }

  async function createQuestion() {
    const msg = validateDraft(createDraft);
    if (msg) {
      setError(msg);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/admin/application-questions", { method: "POST", body: draftToBody(createDraft) });
      setShowCreate(false);
      setCreateDraft(EMPTY_DRAFT);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const msg = validateDraft(editDraft);
    if (msg) {
      setError(msg);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/application-questions/${id}`, { method: "PATCH", body: draftToBody(editDraft) });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(q: Question) {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/application-questions/${q.id}`, { method: "PATCH", body: { enabled: !q.enabled } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeQuestion(q: Question) {
    if (!window.confirm(`Delete "${q.label}"? Existing applications keep their saved answers, but the question will no longer be asked.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/application-questions/${q.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reorder(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    setQuestions(next);
    setBusy(true);
    setError(null);
    try {
      await api("/admin/application-questions/reorder", {
        method: "POST",
        body: { ids: next.map((q) => q.id) },
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="brand-wordmark text-2xl">Application form builder</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Customize the public officer application: rename built-in fields, mark them optional, hide them, or reorder them — and add your own custom questions.
        </p>
      </div>

      <StandardFieldsManager />

      <div className="flex items-start justify-between gap-4 pt-2 border-t">
        <div>
          <h2 className="brand-wordmark text-xl mt-4">Custom questions</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Custom questions appear on the public officer application in an "Additional questions" step, just before review.
          </p>
        </div>
        {!showCreate && (
          <Button
            className="mt-4"
            onClick={() => {
              setCreateDraft(EMPTY_DRAFT);
              setShowCreate(true);
              setError(null);
            }}
          >
            <Plus className="w-4 h-4 mr-1.5" /> Add question
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">New question</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)} disabled={busy}>
              <X className="w-4 h-4" />
            </Button>
          </div>
          <DraftEditor draft={createDraft} onChange={setCreateDraft} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setShowCreate(false)} disabled={busy}>Cancel</Button>
            <Button onClick={createQuestion} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
              Save question
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : questions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No custom questions yet. Add one to start customizing the application.
        </div>
      ) : (
        <ul className="space-y-2">
          {questions.map((q, i) => (
            <li key={q.id} className="rounded-lg border bg-card">
              {editingId === q.id ? (
                <div className="p-4 space-y-3">
                  <DraftEditor draft={editDraft} onChange={setEditDraft} />
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="outline" onClick={() => setEditingId(null)} disabled={busy}>Cancel</Button>
                    <Button onClick={() => saveEdit(q.id)} disabled={busy}>
                      {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 p-3">
                  <div className="flex flex-col items-center pt-0.5">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      aria-label={`Move "${q.label}" up`}
                      onClick={() => reorder(i, -1)}
                      disabled={busy || i === 0}
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <GripVertical className="w-4 h-4 text-muted-foreground/40" aria-hidden="true" />
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      aria-label={`Move "${q.label}" down`}
                      onClick={() => reorder(i, 1)}
                      disabled={busy || i === questions.length - 1}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{q.label}</span>
                      {q.required && (
                        <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-amber-100 text-amber-800">
                          Required
                        </span>
                      )}
                      {!q.enabled && (
                        <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                          Hidden
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {TYPE_LABEL[q.fieldType]}
                      {NEEDS_OPTIONS(q.fieldType) && q.options?.length ? ` · ${q.options.join(", ")}` : ""}
                    </div>
                    {q.helpText && <div className="text-xs text-muted-foreground mt-0.5 italic">{q.helpText}</div>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={q.enabled ? `Hide "${q.label}"` : `Show "${q.label}"`}
                      title={q.enabled ? "Hide from form" : "Show on form"}
                      onClick={() => toggleEnabled(q)}
                      disabled={busy}
                    >
                      <Power className={`w-4 h-4 ${q.enabled ? "text-emerald-600" : "text-muted-foreground"}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit "${q.label}"`}
                      onClick={() => {
                        setEditingId(q.id);
                        setEditDraft(draftFromQuestion(q));
                        setError(null);
                      }}
                      disabled={busy}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete "${q.label}"`}
                      onClick={() => removeQuestion(q)}
                      disabled={busy}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="q-label">Question label</Label>
        <Input id="q-label" value={draft.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Do you have a valid driver's license?" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="q-type">Field type</Label>
          <select id="q-type" className={INPUT_CLASS} value={draft.fieldType} onChange={(e) => set("fieldType", e.target.value as FieldType)}>
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-4 pb-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={draft.required} onChange={(e) => set("required", e.target.checked)} />
            Required
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Visible on form
          </label>
        </div>
      </div>
      {NEEDS_OPTIONS(draft.fieldType) && (
        <div className="space-y-1">
          <Label htmlFor="q-options">Options (one per line)</Label>
          <Textarea id="q-options" rows={4} value={draft.optionsText} onChange={(e) => set("optionsText", e.target.value)} placeholder={"Option A\nOption B\nOption C"} />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="q-help">Help text (optional)</Label>
        <Input id="q-help" value={draft.helpText} onChange={(e) => set("helpText", e.target.value)} placeholder="Shown under the question" />
      </div>
    </div>
  );
}

function StandardFieldsManager() {
  const [fields, setFields] = useState<EffectiveField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<FieldDraft>({ label: "", helpText: "", required: false, hidden: false });
  // Per-field result, rendered on the row that produced it — mirrors
  // Permissions.tsx so a failed confirming reload can't make a saved edit
  // look undone (see settingsStatus.ts).
  const [messages, setMessages] = useState<Record<string, SettingsMessage | undefined>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<EffectiveField[]>("/admin/application-fields");
      setFields(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** Confirming re-read used after a write. Never throws, never clears `fields` on failure. */
  async function reloadSilently(): Promise<EffectiveField[] | null> {
    try {
      return await api<EffectiveField[]>("/admin/application-fields");
    } catch {
      return null;
    }
  }

  async function saveEdit(key: string) {
    if (!draft.label.trim()) {
      setError("Field label cannot be empty.");
      return;
    }
    setMessages((m) => ({ ...m, [key]: undefined }));
    setBusy(true);
    setError(null);
    try {
      const reply = await api<EffectiveField>(`/admin/application-fields/${key}`, {
        method: "PATCH",
        body: {
          labelOverride: draft.label.trim(),
          helpTextOverride: draft.helpText.trim() ? draft.helpText.trim() : "",
          requiredOverride: draft.required,
          hidden: draft.hidden,
        },
      });
      // The write reply is authoritative: apply it *before* the confirming
      // reload, so a reload that fails can never redraw a saved edit as if
      // it never happened.
      setFields((prev) => prev.map((f) => (f.key === reply.key ? reply : f)));
      setEditingKey(null);
      const fresh = await reloadSilently();
      if (fresh) {
        setFields(fresh);
      } else {
        setMessages((m) => ({
          ...m,
          [key]: { kind: "warn", text: "Saved — this page couldn't refresh the list, so it's showing what was just saved." },
        }));
      }
    } catch (e) {
      if (writeWasRefused(e)) {
        // The route refused it: nothing was written.
        setMessages((m) => ({ ...m, [key]: { kind: "error", text: `Not saved — ${errorText(e)}` } }));
        return;
      }
      // 5xx / no answer: unknown outcome. Re-read rather than guess, but
      // never wipe the list just because this one write's answer was lost.
      const fresh = await reloadSilently();
      if (fresh) setFields(fresh);
      setMessages((m) => ({
        ...m,
        [key]: {
          kind: "error",
          text: fresh
            ? `Couldn't confirm the change (${errorText(e)}). This field now shows what is stored.`
            : `Couldn't confirm the change (${errorText(e)}) and this page couldn't re-read the fields. Reload the page to see what is stored.`,
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  async function toggleHidden(f: EffectiveField) {
    setMessages((m) => ({ ...m, [f.key]: undefined }));
    setBusy(true);
    setError(null);
    try {
      const reply = await api<EffectiveField>(`/admin/application-fields/${f.key}`, { method: "PATCH", body: { hidden: !f.hidden } });
      // Same authoritative-response rule as saveEdit: commit the write reply
      // before the confirming reload.
      setFields((prev) => prev.map((x) => (x.key === reply.key ? reply : x)));
      const fresh = await reloadSilently();
      if (fresh) {
        setFields(fresh);
      } else {
        setMessages((m) => ({
          ...m,
          [f.key]: { kind: "warn", text: "Saved — this page couldn't refresh the list, so it's showing what was just saved." },
        }));
      }
    } catch (e) {
      if (writeWasRefused(e)) {
        setMessages((m) => ({ ...m, [f.key]: { kind: "error", text: `Not saved — ${errorText(e)}` } }));
        return;
      }
      const fresh = await reloadSilently();
      if (fresh) setFields(fresh);
      setMessages((m) => ({
        ...m,
        [f.key]: {
          kind: "error",
          text: fresh
            ? `Couldn't confirm the change (${errorText(e)}). This field now shows what is stored.`
            : `Couldn't confirm the change (${errorText(e)}) and this page couldn't re-read the fields. Reload the page to see what is stored.`,
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  async function reorder(section: number, sectionKeys: string[], index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= sectionKeys.length) return;
    const keys = [...sectionKeys];
    [keys[index], keys[target]] = [keys[target], keys[index]];
    // Optimistic: reassign sortOrder within the section, keep others as-is.
    setFields((prev) => {
      const orderByKey = new Map(keys.map((k, i) => [k, i]));
      return [...prev]
        .map((f) => (f.section === section ? { ...f, sortOrder: orderByKey.get(f.key) ?? f.sortOrder } : f))
        .sort((a, b) => (a.section - b.section) || (a.sortOrder - b.sortOrder));
    });
    setBusy(true);
    setError(null);
    try {
      await api("/admin/application-fields/reorder", { method: "POST", body: { section, keys } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const bySection = FIELD_SECTIONS.map((_, s) => fields.filter((f) => f.section === s));

  return (
    <div className="space-y-4">
      <h2 className="brand-wordmark text-xl">Standard fields</h2>
      {error && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
          {error}
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-5">
          {FIELD_SECTIONS.map((sectionLabel, s) => {
            const sectionFields = bySection[s];
            if (sectionFields.length === 0) return null;
            const sectionKeys = sectionFields.map((f) => f.key);
            return (
              <div key={s} className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sectionLabel}</div>
                <ul className="space-y-2">
                  {sectionFields.map((f, i) => (
                    <li key={f.key} className="rounded-lg border bg-card">
                      {editingKey === f.key ? (
                        <div className="p-4 space-y-3">
                          <div className="space-y-1">
                            <Label htmlFor={`f-label-${f.key}`}>Field label</Label>
                            <Input id={`f-label-${f.key}`} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`f-help-${f.key}`}>Help text (optional)</Label>
                            <Input id={`f-help-${f.key}`} value={draft.helpText} onChange={(e) => setDraft({ ...draft, helpText: e.target.value })} placeholder="Shown under the field" />
                          </div>
                          <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-sm">
                              <input type="checkbox" className="h-4 w-4" checked={draft.required} disabled={f.locked} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
                              Required
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                              <input type="checkbox" className="h-4 w-4" checked={!draft.hidden} disabled={f.locked} onChange={(e) => setDraft({ ...draft, hidden: !e.target.checked })} />
                              Visible on form
                            </label>
                          </div>
                          {f.locked && (
                            <p className="text-xs text-muted-foreground">
                              This is a core field — it's always required and visible. You can only rename it or change its help text.
                            </p>
                          )}
                          <div className="flex justify-end gap-2 pt-1">
                            <Button variant="outline" onClick={() => setEditingKey(null)} disabled={busy}>Cancel</Button>
                            <Button onClick={() => saveEdit(f.key)} disabled={busy}>
                              {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-3 p-3">
                          <div className="flex flex-col items-center pt-0.5">
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              aria-label={`Move "${f.label}" up`}
                              onClick={() => reorder(s, sectionKeys, i, -1)}
                              disabled={busy || i === 0}
                            >
                              <ChevronUp className="w-4 h-4" />
                            </button>
                            <GripVertical className="w-4 h-4 text-muted-foreground/40" aria-hidden="true" />
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              aria-label={`Move "${f.label}" down`}
                              onClick={() => reorder(s, sectionKeys, i, 1)}
                              disabled={busy || i === sectionFields.length - 1}
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{f.label}</span>
                              {f.required && (
                                <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-amber-100 text-amber-800">
                                  Required
                                </span>
                              )}
                              {f.hidden && (
                                <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                                  Hidden
                                </span>
                              )}
                              {f.locked && (
                                <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-brand-navy/10 text-brand-navy">
                                  Core
                                </span>
                              )}
                            </div>
                            {f.helpText && <div className="text-xs text-muted-foreground mt-0.5 italic">{f.helpText}</div>}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={f.hidden ? `Show "${f.label}"` : `Hide "${f.label}"`}
                              title={f.locked ? "Core fields are always visible" : f.hidden ? "Show on form" : "Hide from form"}
                              onClick={() => toggleHidden(f)}
                              disabled={busy || f.locked}
                            >
                              <Power className={`w-4 h-4 ${f.hidden ? "text-muted-foreground" : "text-emerald-600"}`} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit "${f.label}"`}
                              onClick={() => {
                                setEditingKey(f.key);
                                setDraft(fieldDraftFrom(f));
                                setError(null);
                                setMessages((m) => ({ ...m, [f.key]: undefined }));
                              }}
                              disabled={busy}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                      {messages[f.key] && (
                        <div className="px-3 pb-3">
                          <ControlMessage message={messages[f.key] ?? null} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
