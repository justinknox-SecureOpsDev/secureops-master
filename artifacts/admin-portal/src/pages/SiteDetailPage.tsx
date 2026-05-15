import { useEffect, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { ArrowLeft, MapPin, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useFkOptions } from "@/lib/fk";
import { getTable } from "@/lib/tables";
import { DataGrid } from "@/components/DataGrid";
import { RowFormDialog } from "@/components/RowFormDialog";

type Site = {
  id: string;
  name: string;
  clientId: string;
  address: string | null;
  notes: string | null;
  locationLat: string | null;
  locationLng: string | null;
};

export function SiteDetailPage() {
  const [, params] = useRoute("/sites/:id");
  const [, navigate] = useLocation();
  const siteId = params?.id ?? "";
  const sitesDescriptor = getTable("sites");
  const siteRolesDescriptor = getTable("site_roles");

  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { options: clientOptions } = useFkOptions("clients");

  async function load() {
    if (!siteId) return;
    setLoading(true);
    setError(null);
    try {
      const row = await api<Site>(`/admin/tables/sites/${siteId}`);
      setSite(row);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [siteId]);

  if (!sitesDescriptor || !siteRolesDescriptor) return null;

  const clientName = site ? clientOptions.find((o) => o.id === site.clientId)?.label ?? "—" : "";

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b bg-card">
        <Link href="/tables/sites" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="w-3.5 h-3.5 mr-1" />
          Back to all sites
        </Link>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading site…</div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : !site ? (
          <div className="text-sm text-muted-foreground">Site not found.</div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl brand-navy" style={{ fontFamily: "Georgia, serif", fontWeight: 700 }}>
                {site.name}
              </h1>
              <div className="mt-1 text-sm text-muted-foreground">
                Client: <span className="text-foreground font-medium">{clientName}</span>
              </div>
              {site.address && (
                <div className="mt-1 text-sm text-muted-foreground inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />{site.address}
                </div>
              )}
              {site.notes && (
                <div className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground max-w-3xl">
                  {site.notes}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="w-3.5 h-3.5 mr-1" />Edit site
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate("/tables/sites")}>
                All sites
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 pt-5 pb-2 bg-background">
        <h2 className="text-sm font-semibold uppercase tracking-wider brand-navy">
          Rate card
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Roles you book at this site, with the pay rate paid to the officer and the bill rate charged to the client.
          Add a role here, then on a Shift you can pick "Use site rate card" and it will auto-fill the rates.
        </p>
      </div>

      <div className="flex-1 overflow-hidden border-t">
        {site && (
          <DataGrid
            key={site.id}
            descriptor={siteRolesDescriptor}
            filter={{ siteId: site.id }}
            presetValues={{ siteId: site.id, status: "active" }}
            lockedFields={["siteId"]}
            hideHeader
            compact
          />
        )}
      </div>

      {site && (
        <RowFormDialog
          open={editing}
          onOpenChange={setEditing}
          descriptor={sitesDescriptor}
          initial={site as unknown as Record<string, unknown>}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </div>
  );
}
