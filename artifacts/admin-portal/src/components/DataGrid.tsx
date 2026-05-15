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
import { ArrowUpDown, ArrowDown, ArrowUp, Pencil, Trash2, Plus, Upload, Download, RefreshCw, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import type { TableDescriptor, Field } from "@/lib/tables";
import { api } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { useFkOptions } from "@/lib/fk";
import { openSignedObject } from "@/lib/upload";
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

function FileKeyCell({ value }: { value: unknown }) {
  if (!value || typeof value !== "string") return <>—</>;
  const name = value.split("/").pop() ?? value;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openSignedObject(value); }}
      className="inline-flex items-center gap-1 text-blue-700 hover:underline"
      title={value}
    >
      <ExternalLink className="w-3 h-3" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function FileKeyListCell({ value }: { value: unknown }) {
  const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  if (arr.length === 0) return <>—</>;
  return (
    <div className="flex flex-col gap-0.5">
      {arr.slice(0, 3).map((p, i) => (
        <button
          key={i}
          type="button"
          onClick={(e) => { e.stopPropagation(); openSignedObject(p); }}
          className="inline-flex items-center gap-1 text-blue-700 hover:underline text-left"
          title={p}
        >
          <ExternalLink className="w-3 h-3 shrink-0" />
          <span className="truncate">{p.split("/").pop()}</span>
        </button>
      ))}
      {arr.length > 3 && <span className="text-xs text-muted-foreground">+{arr.length - 3} more</span>}
    </div>
  );
}

function renderCell(f: Field, value: unknown) {
  if (f.type === "fk") return <FkCell field={f} value={value} />;
  if (f.type === "fileKey") return <FileKeyCell value={value} />;
  if (f.type === "fileKeyList") return <FileKeyListCell value={value} />;
  return formatCell(value, f);
}

export function DataGrid({
  descriptor, filter, presetValues, lockedFields, hideHeader, compact,
}: {
  descriptor: TableDescriptor;
  /** Equality filters appended to the list query, e.g. { siteId: "abc" }. */
  filter?: Record<string, string>;
  /** Pre-fill these field values when adding a new row (e.g. siteId on the Site detail page). */
  presetValues?: Record<string, string>;
  /** Hide these fields from the add/edit form. */
  lockedFields?: string[];
  /** Hide the page-style header (used when embedded in another page). */
  hideHeader?: boolean;
  /** Tighter padding for embedded use. */
  compact?: boolean;
}) {
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

  const filterKey = useMemo(
    () => (filter ? Object.entries(filter).map(([k, v]) => `${k}=${v}`).sort().join("&") : ""),
    [filter],
  );

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      if (debounced) params.set("search", debounced);
      params.set("sort", sort.field);
      params.set("dir", sort.dir);
      if (filter) {
        for (const [k, v] of Object.entries(filter)) {
          if (v) params.set(`filter[${k}]`, v);
        }
      }
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
  }, [descriptor.name, debounced, page, sort, filterKey]);

  const lockedSet = useMemo(() => new Set(lockedFields ?? []), [lockedFields]);
  const gridFields = useMemo(
    () => visibleFields.filter((f) => !lockedSet.has(f.key)),
    [visibleFields, lockedSet],
  );

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

  const padX = compact ? "px-3" : "px-6";

  return (
    <div className="flex flex-col h-full">
      {!hideHeader && (
        <div className={`flex items-center justify-between gap-3 ${padX} py-4 border-b bg-card`}>
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
      )}
      {hideHeader && (
        <div className={`flex items-center justify-between gap-2 ${padX} py-2 border-b bg-card`}>
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search…"
              className="w-56 h-8"
            />
            <span className="text-xs text-muted-foreground">
              {loading ? "Loading…" : `${total.toLocaleString()} ${descriptor.plural}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} title="Refresh">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" onClick={() => setCreating(true)} className="bg-brand-navy text-white hover:opacity-90">
              <Plus className="w-3.5 h-3.5 mr-1" />Add {descriptor.label.replace(/s$/, "")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto bg-background">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10">
            <TableRow>
              {gridFields.map((f) => (
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
                <TableCell colSpan={gridFields.length + 1} className="text-center text-muted-foreground py-12">
                  No {descriptor.plural} yet. Click <b>Add {descriptor.label.replace(/s$/, "")}</b> to create one
                  {descriptor.importSupported ? " or use Import to bulk-load." : "."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={String((r as any).id)} className="hover:bg-accent/40">
                {gridFields.map((f) => (
                  <TableCell key={f.key} className="text-sm max-w-[260px] truncate">
                    {renderCell(f, (r as any)[f.key])}
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  {descriptor.name === "sites" && (
                    <Link href={`/sites/${(r as any).id}`}>
                      <Button variant="ghost" size="icon" title="Open site detail">
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </Link>
                  )}
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
        presetValues={presetValues}
        lockedFields={lockedFields}
      />
      <RowFormDialog
        open={!!editing}
        onOpenChange={(b) => { if (!b) setEditing(null); }}
        descriptor={descriptor}
        initial={editing}
        onSaved={load}
        lockedFields={lockedFields}
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
