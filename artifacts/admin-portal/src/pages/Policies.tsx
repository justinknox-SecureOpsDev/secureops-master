import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadFile } from "@/lib/upload";
import {
  Loader2, Upload, FileText, Trash2, Plus, Pencil, Check, X, ExternalLink,
  Power, History, ChevronDown, ChevronRight,
} from "lucide-react";

type PolicyDto = {
  id: string;
  slug: string;
  label: string;
  version: number;
  fileKey: string | null;
  fileName: string | null;
  isActive: boolean;
  uploadedAt: string | null;
  uploadedBy: string | null;
  hasDocument: boolean;
  viewUrl: string | null;
};

type PolicyGroup = {
  slug: string;
  label: string;
  isActive: boolean;
  current: PolicyDto | null;
  history: PolicyDto[];
};

export function PoliciesPage() {
  const [groups, setGroups] = useState<PolicyGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<PolicyGroup[]>("/admin/policies");
      setGroups(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  /** Resolve which row id to act on for a group (active row, else newest). */
  function targetId(g: PolicyGroup): string {
    return g.current?.id ?? g.history[0]?.id ?? "";
  }

  async function uploadFor(g: PolicyGroup, file: File) {
    setBusySlug(g.slug);
    setError(null);
    try {
      const uploaded = await uploadFile(file);
      await api(`/admin/policies/${targetId(g)}/replace`, {
        method: "POST",
        body: { fileKey: uploaded.objectPath, fileName: uploaded.name },
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySlug(null);
    }
  }

  async function saveLabel(g: PolicyGroup) {
    if (!editLabel.trim() || editLabel === g.label) { setEditingSlug(null); return; }
    setBusySlug(g.slug);
    try {
      await api(`/admin/policies/${targetId(g)}`, { method: "PATCH", body: { label: editLabel.trim() } });
      setEditingSlug(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySlug(null);
    }
  }

  async function toggleActive(g: PolicyGroup) {
    setBusySlug(g.slug);
    setError(null);
    try {
      await api(`/admin/policies/${targetId(g)}`, {
        method: "PATCH",
        body: { isActive: !g.isActive },
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySlug(null);
    }
  }

  async function remove(g: PolicyGroup) {
    if (!window.confirm(
      `Delete the "${g.label}" policy and all ${g.history.length} version(s)?\n\n` +
      `If any employee has signed it, deletion is blocked — deactivate it instead.`
    )) return;
    setBusySlug(g.slug);
    try {
      await api(`/admin/policies/${targetId(g)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySlug(null);
    }
  }

  async function create() {
    if (!newSlug.trim() || !newLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api("/admin/policies", {
        method: "POST",
        body: { slug: newSlug.trim(), label: newLabel.trim() },
      });
      setNewSlug(""); setNewLabel(""); setShowCreate(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="brand-wordmark text-2xl">Policy Documents</h1>
            <p className="text-sm text-muted-foreground">
              Upload the PDFs applicants must read and sign during onboarding. Each upload creates a new immutable version.
            </p>
          </div>
          <Button onClick={() => setShowCreate((v) => !v)} className="bg-brand-navy hover:opacity-90 text-white">
            <Plus className="w-4 h-4 mr-1" /> New policy
          </Button>
        </div>

        {showCreate && (
          <div className="bg-card border rounded-lg p-4 mb-4 space-y-3">
            <h3 className="font-semibold">Add new policy</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs uppercase">Slug</Label>
                <Input
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                  placeholder="e.g. health_safety"
                />
                <div className="text-xs text-muted-foreground">lowercase letters, numbers, underscore</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs uppercase">Display label</Label>
                <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Health & Safety Policy" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => { setShowCreate(false); setNewSlug(""); setNewLabel(""); }}>Cancel</Button>
              <Button onClick={create} disabled={creating || !newSlug || !newLabel} className="bg-brand-navy hover:opacity-90 text-white">
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        )}

        {error && <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 p-2 rounded mb-4">{error}</div>}

        {loading ? (
          <div className="text-center py-12 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
        ) : (
          <div className="space-y-3">
            {groups.length === 0 && (
              <div className="text-center text-muted-foreground p-6 bg-card border rounded-lg">No policies defined yet.</div>
            )}
            {groups.map((g) => {
              const open = !!openHistory[g.slug];
              const display = g.current ?? g.history[0];
              return (
                <div key={g.slug} className="bg-card border rounded-lg overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <div className="flex-1 min-w-[16rem]">
                      {editingSlug === g.slug ? (
                        <div className="flex items-center gap-1">
                          <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className="h-8" autoFocus />
                          <Button size="sm" variant="ghost" onClick={() => saveLabel(g)} disabled={busySlug === g.slug}><Check className="w-4 h-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingSlug(null)}><X className="w-4 h-4" /></Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{g.label}</span>
                          <button onClick={() => { setEditingSlug(g.slug); setEditLabel(g.label); }} className="text-muted-foreground hover:text-foreground">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-xs font-mono text-muted-foreground">{g.slug}</span>
                          {g.isActive ? (
                            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">Active</span>
                          ) : (
                            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">Inactive</span>
                          )}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                        {display?.hasDocument ? (
                          <a href={display.viewUrl ?? "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-navy hover:underline">
                            <FileText className="w-3.5 h-3.5" />
                            <span className="truncate max-w-[24ch]">{display.fileName}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="italic">No document yet</span>
                        )}
                        {display && <span className="px-1.5 py-0.5 rounded bg-accent/40">v{display.version}</span>}
                        {g.history.length > 1 && (
                          <button
                            onClick={() => setOpenHistory((p) => ({ ...p, [g.slug]: !open }))}
                            className="inline-flex items-center gap-0.5 text-xs hover:text-foreground"
                          >
                            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            <History className="w-3 h-3" /> {g.history.length} versions
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <UploadButton accept=".pdf" disabled={busySlug === g.slug} onPick={(f) => uploadFor(g, f)}>
                        {busySlug === g.slug ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Working…</>
                        ) : (
                          <><Upload className="w-3.5 h-3.5 mr-1" /> {display?.hasDocument ? "Replace PDF" : "Upload PDF"}</>
                        )}
                      </UploadButton>
                      <Button size="sm" variant="ghost" disabled={busySlug === g.slug} onClick={() => toggleActive(g)} title={g.isActive ? "Deactivate" : "Activate"}>
                        <Power className={`w-3.5 h-3.5 ${g.isActive ? "text-emerald-700" : "text-muted-foreground"}`} />
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busySlug === g.slug} onClick={() => remove(g)} className="text-destructive hover:text-destructive" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  {open && g.history.length > 1 && (
                    <div className="border-t bg-muted/20 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Version history</div>
                      <ul className="space-y-1.5">
                        {g.history.map((h) => (
                          <li key={h.id} className="flex items-center gap-2 text-xs">
                            <span className="font-mono px-1.5 py-0.5 rounded bg-accent/40">v{h.version}</span>
                            {h.isActive && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">Active</span>}
                            {h.fileName && <span className="text-muted-foreground truncate">{h.fileName}</span>}
                            {h.uploadedAt && <span className="text-muted-foreground">· {formatDateTime(h.uploadedAt)}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-4">
          Applicants must open and confirm each active policy before they can tick its acknowledgement checkbox during onboarding.
          The exact version they signed is permanently recorded with their signature; signed versions cannot be deleted (deactivate them instead).
        </p>
      </div>
    </div>
  );
}

function UploadButton({
  accept, disabled, onPick, children,
}: { accept: string; disabled?: boolean; onPick: (f: File) => void; children: React.ReactNode }) {
  return (
    <label className={`inline-flex items-center text-xs px-2 py-1.5 rounded border cursor-pointer hover:bg-accent/50 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      {children}
      <input type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
    </label>
  );
}
