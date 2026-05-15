import { useRoute, useLocation, useSearch } from "wouter";
import { useEffect, useMemo } from "react";
import { getTable, TABLES } from "@/lib/tables";
import { DataGrid } from "@/components/DataGrid";

export function TablePage() {
  const [, params] = useRoute("/tables/:table");
  const [, navigate] = useLocation();
  const search = useSearch();
  const tableName = params?.table ?? "";
  const descriptor = getTable(tableName);

  useEffect(() => {
    if (!descriptor) navigate(`/tables/${TABLES[0].name}`, { replace: true });
  }, [descriptor, navigate]);

  // Parse `?filter[field]=value` query params so deep-links from derived Name
  // cells (e.g. /tables/employees?filter[userId]=…) pre-filter the grid.
  const urlFilter = useMemo(() => {
    const out: Record<string, string> = {};
    const sp = new URLSearchParams(search);
    for (const [k, v] of sp.entries()) {
      const m = /^filter\[(.+)\]$/.exec(k);
      if (m && v) out[m[1]] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }, [search]);

  if (!descriptor) return null;
  const key = `${descriptor.name}:${urlFilter ? Object.entries(urlFilter).map(([k, v]) => `${k}=${v}`).sort().join("&") : ""}`;
  return <DataGrid key={key} descriptor={descriptor} filter={urlFilter} />;
}

export function HomeRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(`/tables/${TABLES[0].name}`, { replace: true }); }, [navigate]);
  return null;
}
