import { Link, useRoute, useLocation } from "wouter";
import { ShieldCheck, LogOut, ClipboardList, UserPlus } from "lucide-react";
import { TABLES } from "@/lib/tables";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [match, params] = useRoute("/tables/:table");
  const [location] = useLocation();
  const activeTable = match ? params?.table : null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="w-64 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="p-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 brand-gold" />
            <div>
              <div className="brand-wordmark text-sm leading-tight">Williams Council</div>
              <div className="brand-wordmark text-sm leading-tight brand-gold">Security Group</div>
            </div>
          </div>
          <div className="text-[10px] uppercase tracking-widest opacity-60 mt-2">Admin Portal</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-3">
          <div className="px-3 text-[10px] uppercase tracking-widest opacity-50 mb-1">Human Resources</div>
          <Link
            href="/hr/applications"
            className={`flex items-center gap-2 px-4 py-2 text-sm border-l-2 transition-colors ${
              location === "/hr/applications"
                ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
                : "border-transparent hover:bg-sidebar-accent/50"
            }`}
          ><ClipboardList className="w-4 h-4" /> Applications</Link>
          <Link
            href="/hr/onboarding"
            className={`flex items-center gap-2 px-4 py-2 text-sm border-l-2 transition-colors ${
              location === "/hr/onboarding"
                ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
                : "border-transparent hover:bg-sidebar-accent/50"
            }`}
          ><UserPlus className="w-4 h-4" /> Onboarding</Link>
          <div className="px-3 text-[10px] uppercase tracking-widest opacity-50 mb-1 mt-3">Data Tables</div>
          {TABLES.map((t) => {
            const active = activeTable === t.name;
            return (
              <Link
                key={t.name}
                href={`/tables/${t.name}`}
                className={`flex items-center justify-between px-4 py-2 text-sm border-l-2 transition-colors ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
                    : "border-transparent hover:bg-sidebar-accent/50"
                }`}
              >
                <span>{t.label}</span>
                {t.importSupported && (
                  <span className="text-[9px] brand-gold opacity-80">IMPORT</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-sidebar-border text-xs">
          <div className="opacity-80">{user?.firstName} {user?.lastName}</div>
          <div className="opacity-60 text-[11px]">{user?.email}</div>
          <Button
            variant="ghost" size="sm" onClick={logout}
            className="w-full mt-2 justify-start text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <LogOut className="w-4 h-4 mr-2" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  );
}
