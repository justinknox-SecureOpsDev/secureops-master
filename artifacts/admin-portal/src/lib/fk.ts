import { useEffect, useState } from "react";
import { api } from "./api";
import { getTable } from "./tables";

type Row = Record<string, unknown>;
const cache = new Map<string, Promise<Row[]>>();

export function loadFkRows(tableName: string): Promise<Row[]> {
  let p = cache.get(tableName);
  if (!p) {
    p = fetchAll(tableName);
    cache.set(tableName, p);
  }
  return p;
}

async function fetchAll(table: string): Promise<Row[]> {
  let offset = 0;
  const all: Row[] = [];
  for (;;) {
    const page = await api<{ rows: Row[]; total: number }>(
      `/admin/tables/${table}?limit=500&offset=${offset}`,
    );
    all.push(...page.rows);
    if (all.length >= page.total || page.rows.length === 0) break;
    offset += page.rows.length;
    if (offset > 5000) break;
  }
  return all;
}

export function useFkOptions(tableName: string | undefined) {
  const [opts, setOpts] = useState<{ id: string; label: string; row: Row }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tableName) return;
    const t = getTable(tableName);
    const labelField = t?.primaryLabelField ?? "id";
    setLoading(true);
    const p = loadFkRows(tableName);
    p.then((rows) => {
      const mapped = rows.map((r) => ({
        id: String(r.id ?? ""),
        label: String(r[labelField] ?? r.id ?? ""),
        row: r,
      }));
      setOpts(mapped);
    }).finally(() => setLoading(false));
  }, [tableName]);

  return { options: opts, loading, refresh: () => { if (tableName) cache.delete(tableName); } };
}

export function invalidateFk(tableName: string): void {
  cache.delete(tableName);
}
