import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadFile } from "@/lib/upload";
import { Loader2, Upload, FileText, Trash2, Plus, Pencil, Check, X, ExternalLink } from "lucide-react";

type PolicyDto = {
  id: string;
  slug: string;
  label: string;
  version: number;
  fileKey: string | null;
  fileName: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  hasDocument: boolean;
  viewUrl: string | null;
};

export function PoliciesPage() {
  const [rows, setRows] = useState<PolicyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<PolicyDto[]>("/admin/policies");
      setRows(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function uploadFor(p: PolicyDto, file: File) {
    setBusyId(p.id);
    setError(null);
    try {
      const uploaded = await uploadFile(file);
      await api(`/admin/policies/${p.id}/replace`, {
        method: "POST",
        body: { fileKey: uploaded.objectPath, fileName: uploaded.name },
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function saveLabel(p: PolicyDto) {
    if (!editLabel.trim() || editLabel === p.label) { setEditingId(null); return; }
    setBusyId(p.id);
    try {
      await api(`/admin/policies/${p.id}`, { method: "PATCH", body: { label: editLabel.trim() } });
      setEditingId(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: PolicyDto) {
    if (!window.confirm(`Remove the "${p.label}" policy? This cannot be undone.`)) return;
    setBusyId(p.id);
    try {
      await api(`/admin/policies/${p.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
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
              Upload the PDFs applicants must read and sign during onboarding. Each upload bumps the version.
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
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left p-3">Policy</th>
                  <th className="text-left p-3">Slug</th>
                  <th className="text-left p-3">Document</th>
                  <th className="text-left p-3">Version</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-muted-foreground p-6">No policies defined yet.</td></tr>
                )}
                {rows.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-3">
                      {editingId === p.id ? (
                        <div className="flex items-center gap-1">
                          <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className="h-8" autoFocus />
                          <Button size="sm" variant="ghost" onClick={() => saveLabel(p)} disabled={busyId === p.id}><Check className="w-4 h-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="w-4 h-4" /></Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{p.label}</span>
                          <button onClick={() => { setEditingId(p.id); setEditLabel(p.label); }} className="text-muted-foreground hover:text-foreground">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-xs font-mono text-muted-foreground">{p.slug}</td>
                    <td className="p-3">
                      {p.hasDocument ? (
                        <a href={p.viewUrl ?? "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-navy hover:underline">
                          <FileText className="w-4 h-4" />
                          <span className="truncate max-w-[18ch]">{p.fileName}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">No document yet</span>
                      )}
                    </td>
                    <td className="p-3">
                      {p.version > 0 ? <span className="px-2 py-0.5 rounded bg-accent/40 text-xs">v{p.version}</span> : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="p-3 text-right">
                      <div className="inline-flex gap-1 items-center">
                        <UploadButton accept=".pdf" disabled={busyId === p.id} onPick={(f) => uploadFor(p, f)}>
                          {busyId === p.id ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Uploading…</>
                          ) : (
                            <><Upload className="w-3.5 h-3.5 mr-1" /> {p.hasDocument ? "Replace PDF" : "Upload PDF"}</>
                          )}
                        </UploadButton>
                        <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => remove(p)} className="text-destructive hover:text-destructive">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-4">
          Applicants must open and read each policy before they can tick its acknowledgement checkbox during onboarding.
          The version they signed is permanently recorded with their signature.
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
