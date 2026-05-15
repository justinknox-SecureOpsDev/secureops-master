import { useRoute, useLocation } from "wouter";
import { useEffect } from "react";
import { getTable, TABLES } from "@/lib/tables";
import { DataGrid } from "@/components/DataGrid";

export function TablePage() {
  const [, params] = useRoute("/tables/:table");
  const [, navigate] = useLocation();
  const tableName = params?.table ?? "";
  const descriptor = getTable(tableName);

  useEffect(() => {
    if (!descriptor) navigate(`/tables/${TABLES[0].name}`, { replace: true });
  }, [descriptor, navigate]);

  if (!descriptor) return null;
  return <DataGrid key={descriptor.name} descriptor={descriptor} />;
}

export function HomeRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(`/tables/${TABLES[0].name}`, { replace: true }); }, [navigate]);
  return null;
}
