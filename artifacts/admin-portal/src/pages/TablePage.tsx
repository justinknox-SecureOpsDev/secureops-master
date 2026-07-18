import { useRoute, useLocation, useSearch } from "wouter";
import { useEffect, useMemo } from "react";
import { getTable, TABLES } from "@/lib/tables";
import { DataGrid } from "@/components/DataGrid";
import { isFeatureEnabled, type FeatureKey } from "@/lib/brand";
import { UpgradeRequired } from "@/components/FeatureGate";

/**
 * Generic admin tables that mirror a tier-gated product surface. Hidden from
 * the nav by buildNavGroups, but also guarded here so a deep-link / bookmark to
 * the raw grid shows the upgrade affordance instead of empty/forbidden data.
 */
const TABLE_FEATURE: Partial<Record<string, FeatureKey>> = {
  incidents: "incidents",
  invoices: "invoicing",
  payroll_entries: "payroll",
  payment_discrepancies: "payroll",
  "training-certifications": "trainings",
};

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

  // Deep-link target row. Accept a generic `focus` id plus the entity-specific
  // names the mobile push payloads carry (e.g. `incidentId`) so a link/alert
  // can scroll to + highlight the exact row on any table page.
  const focusId = useMemo(() => {
    const sp = new URLSearchParams(search);
    const singular = tableName.replace(/s$/, "");
    return sp.get("focus") || (singular ? sp.get(`${singular}Id`) : null) || null;
  }, [search, tableName]);

  if (!descriptor) return null;
  const gatedFeature = TABLE_FEATURE[descriptor.name];
  if (gatedFeature && !isFeatureEnabled(gatedFeature)) {
    return <UpgradeRequired feature={gatedFeature} />;
  }
  const key = `${descriptor.name}:${urlFilter ? Object.entries(urlFilter).map(([k, v]) => `${k}=${v}`).sort().join("&") : ""}`;
  return <DataGrid key={key} descriptor={descriptor} filter={urlFilter} focusId={focusId} />;
}

export function HomeRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(`/tables/${TABLES[0].name}`, { replace: true }); }, [navigate]);
  return null;
}
