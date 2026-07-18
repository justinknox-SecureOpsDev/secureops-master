import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { useLocation } from "wouter";
import {
  Search, X, Loader2, Users, Calendar, AlertTriangle,
  Wallet, ClipboardList, MessageCircle, AlertCircle, type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";

type SearchItem = {
  id: number;
  domain: string;
  label: string;
  sublabel?: string | null;
};

type SearchResponse = {
  q: string;
  employees: SearchItem[];
  shifts: SearchItem[];
  incidents: SearchItem[];
  payroll: SearchItem[];
  applications: SearchItem[];
  chatRooms: SearchItem[];
  featureStatus: {
    incidents: boolean;
    payroll: boolean;
    applications: boolean;
    chatRooms: boolean;
  };
};

type DomainConfig = {
  key: keyof Omit<SearchResponse, "q" | "featureStatus">;
  label: string;
  Icon: LucideIcon;
  /**
   * Returns the navigation path for a specific result.
   * Domains backed by TablePage use `?focus=<id>` so the DataGrid scrolls to
   * and highlights the matching row. The employee domain navigates to the
   * dedicated OfficerProfile page instead.
   */
  toRoute: (id: number) => string;
  featureKey?: keyof SearchResponse["featureStatus"];
};

const DOMAINS: DomainConfig[] = [
  {
    key: "employees",
    label: "Employees",
    Icon: Users,
    // Dedicated detail page — navigate directly to the officer profile.
    toRoute: (id) => `/personnel/${id}`,
  },
  {
    key: "shifts",
    label: "Shifts",
    Icon: Calendar,
    // ShiftsPage — pass ?focus so the URL is record-specific; ShiftsPage will
    // gain focus-open support in a follow-up task.
    toRoute: (id) => `/tables/shifts?focus=${id}`,
  },
  {
    key: "incidents",
    label: "Incidents",
    Icon: AlertTriangle,
    // TablePage: ?focus is wired to DataGrid.focusId → scrolls + highlights row.
    toRoute: (id) => `/tables/incidents?focus=${id}`,
    featureKey: "incidents",
  },
  {
    key: "payroll",
    label: "Payroll",
    Icon: Wallet,
    // TablePage: ?focus is wired to DataGrid.focusId → scrolls + highlights row.
    toRoute: (id) => `/tables/payroll_entries?focus=${id}`,
    featureKey: "payroll",
  },
  {
    key: "applications",
    label: "Applications",
    Icon: ClipboardList,
    // ApplicationsPage — pass ?focus so the URL is record-specific; page will
    // gain focus-open support in a follow-up task.
    toRoute: (id) => `/hr/applications?focus=${id}`,
    featureKey: "applications",
  },
  {
    key: "chatRooms",
    label: "Chat Rooms",
    Icon: MessageCircle,
    // ChatPage reads ?room=<id> and selects the room immediately.
    toRoute: (id) => `/chat?room=${id}`,
    featureKey: "chatRooms",
  },
];

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

type GlobalSearchProps = {
  /**
   * When provided, only domains whose key is in this list are shown in results.
   * Use this to restrict the dispatcher view to routes it actually supports.
   * Omit (or pass undefined) to show all domains (admin default).
   */
  allowedDomainKeys?: Array<DomainConfig["key"]>;
};

export function GlobalSearch({ allowedDomainKeys }: GlobalSearchProps = {}) {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const debouncedQuery = useDebouncedValue(query.trim(), 300);

  useEffect(() => {
    if (!debouncedQuery) {
      setResults(null);
      setError(null);
      setLoading(false);
      setActiveIndex(-1);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    api<SearchResponse>(`/admin/search?q=${encodeURIComponent(debouncedQuery)}`)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResults(data);
          setError(null);
          setActiveIndex(-1);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setResults(null);
        if (err instanceof ApiError) {
          setError(err.status === 403 ? "Search requires admin access." : "Search unavailable.");
        } else {
          setError("Search unavailable.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [debouncedQuery]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const visibleDomains = results
    ? DOMAINS.filter((d) => {
        if (allowedDomainKeys && !allowedDomainKeys.includes(d.key)) return false;
        if (d.featureKey && !results.featureStatus[d.featureKey]) return false;
        return results[d.key].length > 0;
      })
    : [];

  const flatItems: { domain: DomainConfig; item: SearchItem }[] = visibleDomains.flatMap((d) =>
    (results![d.key] as SearchItem[]).map((item) => ({ domain: d, item })),
  );

  const navigate = useCallback(
    (domain: DomainConfig, item: SearchItem) => {
      setOpen(false);
      setQuery("");
      setResults(null);
      setError(null);
      setLocation(domain.toRoute(item.id));
    },
    [setLocation],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const hit = flatItems[activeIndex];
      if (hit) navigate(hit.domain, hit.item);
    }
  };

  const showDropdown = open && query.trim().length > 0;

  let flatIdx = 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-xs lg:max-w-sm">
      <div className="relative flex items-center">
        <Search className="absolute left-2.5 w-3.5 h-3.5 text-sidebar-foreground/50 pointer-events-none" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          aria-label="Search employees, shifts, incidents and more"
          aria-controls="global-search-listbox"
          aria-activedescendant={activeIndex >= 0 ? `gsr-${activeIndex}` : undefined}
          placeholder="Search…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full h-8 rounded-md bg-sidebar-accent/60 border border-sidebar-border/60 pl-8 pr-7 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/40 focus:outline-none focus:ring-1 focus:ring-brand-gold focus:border-brand-gold transition-colors"
        />
        {loading && (
          <Loader2 className="absolute right-2 w-3.5 h-3.5 text-sidebar-foreground/50 animate-spin" aria-hidden="true" />
        )}
        {!loading && query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { setQuery(""); setResults(null); setError(null); inputRef.current?.focus(); }}
            className="absolute right-2 w-3.5 h-3.5 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          id="global-search-listbox"
          role="listbox"
          aria-label="Search results"
          className="absolute top-full mt-1 left-0 right-0 z-50 rounded-md border border-sidebar-border bg-white shadow-lg overflow-hidden text-gray-900 max-h-[70vh] overflow-y-auto"
        >
          {error && (
            <div className="px-4 py-3 text-sm text-red-600 flex items-center gap-2" role="alert">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              {error}
            </div>
          )}

          {!error && !results && loading && (
            <div className="px-4 py-3 text-sm text-gray-500 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              Searching…
            </div>
          )}

          {!error && results && visibleDomains.length === 0 && (
            <div className="px-4 py-3 text-sm text-gray-500">
              No results for <span className="font-medium">"{results.q}"</span>
            </div>
          )}

          {!error && results && visibleDomains.map((domain) => {
            const items = results[domain.key] as SearchItem[];
            if (items.length === 0) return null;
            const Icon = domain.Icon;
            return (
              <div key={domain.key}>
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border-b border-gray-100 sticky top-0">
                  <Icon className="w-3 h-3 text-gray-400" aria-hidden="true" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                    {domain.label}
                  </span>
                </div>
                {items.map((item) => {
                  const myIdx = flatIdx++;
                  const isActive = myIdx === activeIndex;
                  return (
                    <div
                      key={item.id}
                      id={`gsr-${myIdx}`}
                      role="option"
                      aria-selected={isActive}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        navigate(domain, item);
                      }}
                      onPointerEnter={() => setActiveIndex(myIdx)}
                      className={`px-4 py-2 cursor-pointer transition-colors ${
                        isActive ? "bg-brand-navy text-white" : "hover:bg-gray-50"
                      }`}
                    >
                      <div className={`text-sm font-medium truncate ${isActive ? "text-white" : "text-gray-800"}`}>
                        {item.label}
                      </div>
                      {item.sublabel && (
                        <div className={`text-xs truncate mt-0.5 ${isActive ? "text-white/70" : "text-gray-400"}`}>
                          {item.sublabel}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
