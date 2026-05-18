import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, User, Mail, Phone, ShieldCheck, AlertTriangle, Loader2,
  ExternalLink,
} from "lucide-react";

type Officer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  phone: string | null;
  maxLicenseLevel: number | null;
  licenseCount: number;
  expiringLicenseCount: number;
};

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-600 text-white",
  inactive: "bg-slate-400 text-white",
  pending: "bg-amber-500 text-black",
};

/**
 * Officer profile page reachable from the Dispatch Live Map "View profile"
 * popup action. Both dispatchers and admins can open it; the API
 * (`GET /employees/:id`) is the same role-aware projection used by the
 * personnel roster, so dispatchers see only the operational-safe subset.
 *
 * Intentionally read-only — write operations remain on the admin-only
 * `/admin/tables/employees` grid.
 */
export default function OfficerProfilePage() {
  const [, params] = useRoute<{ id: string }>("/personnel/:id");
  const id = params?.id ?? "";
  const officer = useQuery<Officer>({
    queryKey: ["officer", id],
    queryFn: () => api<Officer>(`/employees/${encodeURIComponent(id)}`),
    enabled: !!id,
  });

  return (
    <div className="p-4 lg:p-6 max-w-[900px] mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <Link href="/personnel">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Personnel
          </Button>
        </Link>
        <Link href="/dispatch">
          <Button variant="ghost" size="sm" className="opacity-70">
            <ArrowLeft className="w-4 h-4 mr-1" /> Dispatch
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="w-5 h-5 brand-gold" />
            Officer profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          {officer.isLoading && (
            <div className="text-sm opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {officer.error && (
            <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              {officer.error instanceof Error ? officer.error.message : "Could not load officer."}
            </div>
          )}
          {officer.data && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="text-xl font-semibold brand-wordmark">
                  {officer.data.lastName}, {officer.data.firstName}
                </div>
                <Badge className={`text-[10px] uppercase ${STATUS_TONE[officer.data.status] ?? "bg-slate-400 text-white"}`}>
                  {officer.data.status}
                </Badge>
                <Badge className="bg-brand-navy text-brand-gold uppercase text-[10px]">
                  {officer.data.role}
                </Badge>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded border p-3 flex items-start gap-2">
                  <Mail className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Email</div>
                    <a className="underline truncate block" href={`mailto:${officer.data.email}`}>
                      {officer.data.email}
                    </a>
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <Phone className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Phone</div>
                    {officer.data.phone ? (
                      <a className="underline" href={`tel:${officer.data.phone}`}>{officer.data.phone}</a>
                    ) : (
                      <span className="opacity-60">—</span>
                    )}
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Max licence</div>
                    <div>
                      {officer.data.maxLicenseLevel == null
                        ? <span className="opacity-50">none on file</span>
                        : `L${officer.data.maxLicenseLevel}${officer.data.maxLicenseLevel === 4 ? " / PPO" : ""}`}
                    </div>
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Licences</div>
                    <div>
                      {officer.data.licenseCount}
                      {officer.data.expiringLicenseCount > 0 && (
                        <span className="ml-1.5 text-amber-700">
                          · {officer.data.expiringLicenseCount} expiring within 30d
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="text-xs opacity-60">
                Read-only. To edit this officer, open the admin Personnel grid.
                <Link href="/personnel">
                  <Button variant="link" size="sm" className="text-xs h-auto p-0 ml-2">
                    Open roster <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
