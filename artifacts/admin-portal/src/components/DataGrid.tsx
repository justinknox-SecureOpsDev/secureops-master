import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowUpDown, ArrowDown, ArrowUp, Pencil, Trash2, Plus, Upload, Download, RefreshCw } from "lucide-react";
import type { TableDescriptor } from "@/lib/tables";
import { api } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { useFkOptions } from "@/lib/fk";
import { RowFormDialog } from "./RowFormDialog";
import { ImportWizard } from "./ImportWizard";
import { downloadTemplateXlsx } from "@/lib/import";

type Row = Record<string, unknown>;

function FkCell({ field, value }: { field: { fkTable?: string; fkLabel?: string }; value: unknown }) {
  const { options } = useFkOptions(field.fkTable);
  if (!value) return <>—</>;
  const o = options.find((x) => x.id === String(value));
  return <span title={String(value)}>{o?.label ?? String(value).slice(0, 8) + "…"}</span>;
}

export function DataGrid({ descriptor }: { descriptor: TableDescriptor }) {
  const visibleFields = useMemo(
    () => descriptor.fields.filter((f) => !f.hiddenInGrid),
    [descriptor],
  );

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" }>({
    field: "createdAt", dir: "desc",
  });
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => { setPage(0); }, [descriptor.name]);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      if (debounced) params.set("search", debounced);
      params.set("sort", sort.field);
      params.set("dir", sort.dir);
      const data = await api<{ rows: Row[]; total: number }>(
        `/admin/tables/${descriptor.name}?${params}`,
      );
      setRows(data.rows);
      setTotal(data.total);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor.name, debounced, page, sort]);

  function toggleSort(fieldKey: string) {
    setSort((s) => s.field === fieldKey
      ? { field: fieldKey, dir: s.dir === "asc" ? "desc" : "asc" }
      : { field: fieldKey, dir: "asc" });
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api(`/admin/tables/${descriptor.name}/${(deleting as any).id}`, { method: "DELETE" });
      setDeleting(null);
      load();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-b bg-card">
        <div>
          <h1 className="text-2xl brand-navy" style={{ fontFamily: "Georgia, serif", fontWeight: 700 }}>
            {descriptor.label}
          </h1>
          <p className="text-xs text-muted-foreground">
            {loading ? "Loading…" : `${total.toLocaleString()} ${descriptor.plural}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search…"
            className="w-64"
          />
          <Button variant="outline" size="icon" onClick={load} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
          {descriptor.importSupported && (
            <>
              <Button variant="outline" onClick={() => downloadTemplateXlsx(descriptor)}>
                <Download className="w-4 h-4 mr-2" />Template
              </Button>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="w-4 h-4 mr-2" />Import
              </Button>
            </>
          )}
          <Button onClick={() => setCreating(true)} className="bg-brand-navy text-white hover:opacity-90">
            <Plus className="w-4 h-4 mr-2" />Add {descriptor.label.replace(/s$/, "")}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10">
            <TableRow>
              {visibleFields.map((f) => (
                <TableHead key={f.key}>
                  <button
                    onClick={() => toggleSort(f.key)}
                    className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-xs brand-navy"
                  >
                    {f.label}
                    {sort.field === f.key
                      ? (sort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                      : <ArrowUpDown className="w-3 h-3 opacity-30" />}
                  </button>
                </TableHead>
              ))}
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={visibleFields.length + 1} className="text-center text-muted-foreground py-12">
                  No {descriptor.plural} yet. Click <b>Add {descriptor.label.replace(/s$/, "")}</b> to create one
                  {descriptor.importSupported ? " or use Import to bulk-load." : "."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={String((r as any).id)} className="hover:bg-accent/40">
                {visibleFields.map((f) => (
                  <TableCell key={f.key} className="text-sm max-w-[260px] truncate">
                    {f.type === "fk"
                      ? <FkCell field={f} value={(r as any)[f.key]} />
                      : formatCell((r as any)[f.key], f)}
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(r)} title="Edit">
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(r)} title="Delete">
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between px-6 py-3 border-t bg-card text-sm">
        <span className="text-muted-foreground">
          Page {page + 1} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
          <Button variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>

      <RowFormDialog
        open={creating}
        onOpenChange={setCreating}
        descriptor={descriptor}
        initial={null}
        onSaved={load}
      />
      <RowFormDialog
        open={!!editing}
        onOpenChange={(b) => { if (!b) setEditing(null); }}
        descriptor={descriptor}
        initial={editing}
        onSaved={load}
      />
      <ImportWizard
        open={importOpen}
        onOpenChange={setImportOpen}
        descriptor={descriptor}
        onDone={load}
      />

      <AlertDialog open={!!deleting} onOpenChange={(b) => { if (!b) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {descriptor.label.replace(/s$/, "").toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Related records that depend on this row may be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
