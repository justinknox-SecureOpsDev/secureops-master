import { useEffect, useState } from "react";
import { Users, Clock, Shield, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/lib/api";
import { formatTime, formatDateTime, formatDate } from "@/lib/format";

type Officer = { name: string; licenseLevel: number | null };
type Shift = {
  id: string;
  title: string;
  siteId: string | null;
  siteName: string | null;
  startTime: string;
  endTime: string | null;
  requiredLicenseLevel: number | null;
  headcount: number;
  status: string;
  notes: string | null;
  officers: Officer[];
};

function fmt(d: string) {
  return formatDateTime(d);
}
function fmtDate(d: string) {
  return formatDate(d, { weekday: "long", month: "long", day: "numeric" });
}
function fmtTime(d: string) {
  return formatTime(d);
}
function levelLabel(n: number | null) {
  if (!n) return "—";
  const map: Record<number, string> = { 2: "L2 Unarmed", 3: "L3 Armed", 4: "L4/PPO" };
  return map[n] ?? `L${n}`;
}
function statusColors(s: string) {
  const map: Record<string, string> = {
    upcoming: "bg-sky-100 text-sky-700 border-sky-200",
    active: "bg-emerald-100 text-emerald-700 border-emerald-200",
    completed: "bg-gray-100 text-gray-500 border-gray-200",
    cancelled: "bg-red-100 text-red-600 border-red-200",
  };
  return map[s] ?? "bg-gray-100 text-gray-500 border-gray-200";
}

function groupByDate(shifts: Shift[]): Map<string, Shift[]> {
  const m = new Map<string, Shift[]>();
  for (const s of shifts) {
    const key = new Date(s.startTime).toISOString().slice(0, 10);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(s);
  }
  return m;
}

function ShiftCard({ shift }: { shift: Shift }) {
  const [expanded, setExpanded] = useState(false);
  const filled = shift.officers.length;
  const pct = shift.headcount > 0 ? (filled / shift.headcount) * 100 : 0;

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div
        className="flex items-start gap-4 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{shift.title}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wide ${statusColors(shift.status)}`}>
              {shift.status}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ""}</span>
            {shift.siteName && <span>{shift.siteName}</span>}
            {shift.requiredLicenseLevel && <span className="flex items-center gap-1"><Shield className="w-3 h-3" />{levelLabel(shift.requiredLicenseLevel)}</span>}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right">
            <div className="text-sm font-semibold text-foreground">
              {filled}/{shift.headcount}
            </div>
            <div className="text-[10px] text-muted-foreground">officers</div>
            <div className="w-20 h-1 bg-muted rounded-full mt-1 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : pct > 0 ? "bg-amber-400" : "bg-red-300"}`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t px-4 py-3 bg-muted/20">
          {shift.officers.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No officers assigned yet.</p>
          ) : (
            <ul className="space-y-2">
              {shift.officers.map((o, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <div className="w-7 h-7 rounded-full bg-[#080c18] text-[#c9a84c] flex items-center justify-center text-xs font-bold">
                    {o.name[0] ?? "O"}
                  </div>
                  <span className="font-medium">{o.name}</span>
                  {o.licenseLevel && (
                    <span className="text-xs text-muted-foreground">· {levelLabel(o.licenseLevel)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shift.notes && (
            <p className="text-xs text-muted-foreground mt-2 pt-2 border-t">{shift.notes}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ClientShifts() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(14);

  useEffect(() => {
    const to = new Date(Date.now() + days * 86_400_000).toISOString();
    api<Shift[]>(`/client/shifts?to=${to}`)
      .then(setShifts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [days]);

  const grouped = groupByDate(shifts);
  const dateKeys = [...grouped.keys()].sort();

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Users className="w-5 h-5" /> Officers on Shift
        </h1>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="text-sm border rounded px-2 py-1 bg-background"
        >
          <option value={7}>Next 7 days</option>
          <option value={14}>Next 14 days</option>
          <option value={30}>Next 30 days</option>
        </select>
      </div>

      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading shifts…</div>
      ) : dateKeys.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No shifts scheduled in the next {days} days.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {dateKeys.map((date) => (
            <div key={date}>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                {fmtDate(date)}
              </h2>
              <div className="space-y-2">
                {grouped.get(date)!.map((s) => (
                  <ShiftCard key={s.id} shift={s} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
