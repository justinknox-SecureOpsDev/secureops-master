import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { api } from "@/lib/api";
import { BUSINESS_TIME_ZONE } from "@/lib/format";
import { uploadFile } from "@/lib/upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, Plus, Trash2, Shield, ShieldAlert, MapPin, User,
  ImagePlus, X, Loader2, Save, AlertTriangle, Lock, ChevronUp, ChevronDown,
} from "lucide-react";

/**
 * Admin editor for a shift's executive-protection ("PPO Detail") package.
 *
 * Route: /shifts/:id/protection (admin shell only). Reads + writes the package
 * via GET/PUT /shifts/:id/protection-detail. The PUT is admin-only and audited
 * (counts-only) server-side. This data is highly sensitive PII and must never
 * appear on public/share surfaces.
 *
 * Photos are stored as object-storage keys (string[]); thumbnails are fetched
 * through the admin signing endpoint. Destinations are geocoded server-side on
 * save (best-effort from the free-text address) — after a save we re-hydrate
 * from the response so the map reflects the resolved coordinates.
 */

// ── Contract shapes (mirrors lib/api-client-react generated types) ───────────
type PersonResponse = {
  id: string;
  kind: "principal" | "threat";
  seq: number;
  name: string | null;
  relationship: string | null;
  sex: string | null;
  age: string | null;
  height: string | null;
  weight: string | null;
  hairColor: string | null;
  eyeColor: string | null;
  distinguishingFeatures: string | null;
  notes: string | null;
  photoKeys: string[];
};
type DestResponse = {
  id: string;
  seq: number;
  label: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  arrivalTime: string | null;
  departureTime: string | null;
  notes: string | null;
};
type ProtectionResponse = {
  shiftId: string;
  threatLevel: string | null;
  missionSummary: string | null;
  dressCode: string | null;
  armamentInstructions: string | null;
  communicationPlan: string | null;
  medicalNotes: string | null;
  emergencyRendezvous: string | null;
  vehicleDetails: string | null;
  specialInstructions: string | null;
  principals: PersonResponse[];
  threats: PersonResponse[];
  destinations: DestResponse[];
};
type ShiftInfo = {
  id: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  location?: string | null;
  clientName?: string | null;
  shiftType?: string | null;
};

// ── Local draft shapes (string-keyed for controlled inputs) ──────────────────
type PersonDraft = {
  _uid: string;
  name: string;
  relationship: string;
  sex: string;
  age: string;
  height: string;
  weight: string;
  hairColor: string;
  eyeColor: string;
  distinguishingFeatures: string;
  notes: string;
  photoKeys: string[];
};
type DestDraft = {
  _uid: string;
  label: string;
  address: string;
  arrivalTime: string;
  departureTime: string;
  notes: string;
  lat: number | null;
  lng: number | null;
};

const MAX_PRINCIPALS = 20;
const MAX_THREATS = 50;
const MAX_DESTINATIONS = 50;
const MAX_PHOTOS = 12;

const THREAT_LEVELS: { value: string; label: string }[] = [
  { value: "none", label: "— Not set —" },
  { value: "low", label: "Low" },
  { value: "guarded", label: "Guarded" },
  { value: "elevated", label: "Elevated" },
  { value: "high", label: "High" },
  { value: "severe", label: "Severe" },
];

let _uidSeq = 0;
function uid(): string {
  _uidSeq += 1;
  return `d${Date.now().toString(36)}${_uidSeq.toString(36)}`;
}

function emptyPerson(): PersonDraft {
  return {
    _uid: uid(), name: "", relationship: "", sex: "", age: "", height: "",
    weight: "", hairColor: "", eyeColor: "", distinguishingFeatures: "",
    notes: "", photoKeys: [],
  };
}
function emptyDest(): DestDraft {
  return { _uid: uid(), label: "", address: "", arrivalTime: "", departureTime: "", notes: "", lat: null, lng: null };
}

function personToDraft(p: PersonResponse): PersonDraft {
  return {
    _uid: uid(),
    name: p.name ?? "",
    relationship: p.relationship ?? "",
    sex: p.sex ?? "",
    age: p.age ?? "",
    height: p.height ?? "",
    weight: p.weight ?? "",
    hairColor: p.hairColor ?? "",
    eyeColor: p.eyeColor ?? "",
    distinguishingFeatures: p.distinguishingFeatures ?? "",
    notes: p.notes ?? "",
    photoKeys: Array.isArray(p.photoKeys) ? p.photoKeys : [],
  };
}
function destToDraft(d: DestResponse): DestDraft {
  return {
    _uid: uid(),
    label: d.label ?? "",
    address: d.address ?? "",
    arrivalTime: isoToLocal(d.arrivalTime),
    departureTime: isoToLocal(d.departureTime),
    notes: d.notes ?? "",
    lat: typeof d.lat === "number" ? d.lat : null,
    lng: typeof d.lng === "number" ? d.lng : null,
  };
}

function isoToLocal(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
function strOrU(s: string | null | undefined): string | undefined {
  const t = (s ?? "").trim();
  return t ? t : undefined;
}

// Re-randomized each module load so dev edits to the map template take effect.
const MAP_BUILD_ID = Math.random().toString(36).slice(2, 10);

/** Read-only numbered-pin route map of the geocoded destinations. */
function buildDestinationsMapHtml(
  points: { lat: number; lng: number; label: string; seq: number }[],
): string {
  const safe = JSON.stringify(points)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#080c18}
.dest-pin{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#080c18;color:#c9a84c;border:2px solid #c9a84c;font:bold 12px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.45)}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const PTS = ${safe};
const BUILD = ${JSON.stringify(MAP_BUILD_ID)};
void BUILD;
const map = L.map('m', { zoomControl: true, attributionControl: true });
map.setView([PTS[0].lat, PTS[0].lng], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19
}).addTo(map);
const latlngs = [];
PTS.forEach(function(p) {
  const ll = L.latLng(p.lat, p.lng);
  latlngs.push(ll);
  const icon = L.divIcon({
    className: '', html: '<div class="dest-pin">' + String(p.seq) + '</div>',
    iconSize: [26, 26], iconAnchor: [13, 13]
  });
  const m = L.marker(ll, { icon: icon }).addTo(map);
  const tip = document.createElement('div');
  const b = document.createElement('b');
  b.appendChild(document.createTextNode(String(p.label || '')));
  tip.appendChild(b);
  m.bindTooltip(tip, { direction: 'top', offset: [0, -10], opacity: 0.95 });
});
if (latlngs.length > 1) {
  L.polyline(latlngs, { color: '#c9a84c', weight: 2, opacity: 0.7, dashArray: '6 6' }).addTo(map);
  map.fitBounds(L.latLngBounds(latlngs).pad(0.3), { maxZoom: 16 });
} else {
  map.setView(latlngs[0], 15);
}
</script></body></html>`;
}

/** Thumbnail that resolves a private object key through the admin sign endpoint. */
function SignedImage({ objectPath, onRemove }: { objectPath: string; onRemove?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    api<{ url: string }>(`/admin/storage/sign?path=${encodeURIComponent(objectPath)}`)
      .then((r) => { if (!cancelled) setUrl(r.url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [objectPath]);
  return (
    <div className="relative w-20 h-20 rounded-md overflow-hidden border border-brand-gold/40 bg-muted">
      {url ? (
        <img src={url} alt="Attached photo" className="w-full h-full object-cover" />
      ) : failed ? (
        <div className="flex items-center justify-center w-full h-full text-[10px] text-muted-foreground px-1 text-center">
          Unavailable
        </div>
      ) : (
        <div className="flex items-center justify-center w-full h-full">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove photo"
          className="absolute top-0.5 right-0.5 rounded-full bg-black/60 text-white p-0.5 hover:bg-black/80"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function PersonEditor({
  person, label, accent, onChange, onRemove,
}: {
  person: PersonDraft;
  label: string;
  accent: "principal" | "threat";
  onChange: (patch: Partial<PersonDraft>) => void;
  onRemove: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    const room = MAX_PHOTOS - person.photoKeys.length;
    if (room <= 0) { setUploadErr(`Up to ${MAX_PHOTOS} photos.`); return; }
    setUploading(true);
    setUploadErr(null);
    try {
      const added: string[] = [];
      for (const f of files.slice(0, room)) {
        if (!f.type.startsWith("image/")) { setUploadErr("Only image files are allowed."); continue; }
        const u = await uploadFile(f);
        added.push(u.objectPath);
      }
      if (added.length) onChange({ photoKeys: [...person.photoKeys, ...added] });
    } catch (err) {
      setUploadErr((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const isThreat = accent === "threat";
  return (
    <div className={`rounded-lg border p-4 space-y-3 ${isThreat ? "border-red-300 bg-red-50/40" : "border-brand-gold/40 bg-brand-cream/30"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-sm">
          {isThreat ? <ShieldAlert className="w-4 h-4 text-red-600" /> : <User className="w-4 h-4 text-brand-gold" />}
          {label}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Name</Label>
          <Input value={person.name} maxLength={200} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div>
          <Label>{isThreat ? "Threat type / relationship" : "Relationship"}</Label>
          <Input value={person.relationship} maxLength={200} onChange={(e) => onChange({ relationship: e.target.value })} />
        </div>
        <div>
          <Label>Sex</Label>
          <Input value={person.sex} maxLength={40} onChange={(e) => onChange({ sex: e.target.value })} />
        </div>
        <div>
          <Label>Age</Label>
          <Input value={person.age} maxLength={40} placeholder="e.g. early 40s" onChange={(e) => onChange({ age: e.target.value })} />
        </div>
        <div>
          <Label>Height</Label>
          <Input value={person.height} maxLength={40} placeholder={`e.g. 6'1"`} onChange={(e) => onChange({ height: e.target.value })} />
        </div>
        <div>
          <Label>Weight</Label>
          <Input value={person.weight} maxLength={40} placeholder="e.g. 190 lbs" onChange={(e) => onChange({ weight: e.target.value })} />
        </div>
        <div>
          <Label>Hair color</Label>
          <Input value={person.hairColor} maxLength={40} onChange={(e) => onChange({ hairColor: e.target.value })} />
        </div>
        <div>
          <Label>Eye color</Label>
          <Input value={person.eyeColor} maxLength={40} onChange={(e) => onChange({ eyeColor: e.target.value })} />
        </div>
      </div>

      <div>
        <Label>Distinguishing features</Label>
        <Textarea rows={2} value={person.distinguishingFeatures} onChange={(e) => onChange({ distinguishingFeatures: e.target.value })} />
      </div>
      <div>
        <Label>Notes</Label>
        <Textarea rows={2} value={person.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </div>

      <div>
        <Label>Photos</Label>
        <div className="flex flex-wrap gap-2 mt-1">
          {person.photoKeys.map((key, i) => (
            <SignedImage
              key={key}
              objectPath={key}
              onRemove={() => onChange({ photoKeys: person.photoKeys.filter((_, j) => j !== i) })}
            />
          ))}
          {person.photoKeys.length < MAX_PHOTOS && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="w-20 h-20 rounded-md border-2 border-dashed border-brand-gold/50 flex flex-col items-center justify-center text-[10px] text-muted-foreground hover:bg-brand-cream/60 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
              <span className="mt-0.5">{uploading ? "Uploading" : "Add"}</span>
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onFiles}
          />
        </div>
        {uploadErr && <p className="text-xs text-destructive mt-1">{uploadErr}</p>}
      </div>
    </div>
  );
}

function DestEditor({
  dest, index, onChange, onRemove, onMoveUp, onMoveDown, isFirst, isLast,
}: {
  dest: DestDraft;
  index: number;
  onChange: (patch: Partial<DestDraft>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className="rounded-lg border border-brand-gold/40 bg-brand-cream/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-navy text-brand-gold text-xs font-bold">
            {index + 1}
          </span>
          Destination {index + 1}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            disabled={isFirst}
            onClick={onMoveUp}
            aria-label={`Move destination ${index + 1} up`}
          >
            <ChevronUp className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            disabled={isLast}
            onClick={onMoveDown}
            aria-label={`Move destination ${index + 1} down`}
          >
            <ChevronDown className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label>Label</Label>
          <Input value={dest.label} maxLength={200} placeholder="e.g. Hotel, Venue, Airport" onChange={(e) => onChange({ label: e.target.value })} />
        </div>
        <div>
          <Label>Arrival time</Label>
          <Input type="datetime-local" value={dest.arrivalTime} onChange={(e) => onChange({ arrivalTime: e.target.value })} />
        </div>
        <div>
          <Label>Departure time</Label>
          <Input type="datetime-local" value={dest.departureTime} onChange={(e) => onChange({ departureTime: e.target.value })} />
        </div>
      </div>

      <div>
        <Label>Address</Label>
        {/* Editing the address invalidates any previously geocoded coords so the
            server re-resolves them on the next save. */}
        <Input
          value={dest.address}
          maxLength={500}
          placeholder="Full street address — geocoded on save"
          onChange={(e) => onChange({ address: e.target.value, lat: null, lng: null })}
        />
        <p className="mt-1 text-xs text-muted-foreground inline-flex items-center gap-1">
          <MapPin className="w-3 h-3" />
          {dest.lat != null && dest.lng != null
            ? `Geocoded: ${dest.lat.toFixed(5)}, ${dest.lng.toFixed(5)}`
            : "Not geocoded yet — save to look up coordinates from the address."}
        </p>
      </div>

      <div>
        <Label>Notes</Label>
        <Textarea rows={2} value={dest.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </div>
    </div>
  );
}

export default function ProtectionDetailPage() {
  const [, params] = useRoute("/shifts/:id/protection");
  const shiftId = params?.id ?? "";

  const [shift, setShift] = useState<ShiftInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [markingType, setMarkingType] = useState(false);

  // Pre-plan fields
  const [threatLevel, setThreatLevel] = useState("none");
  const [missionSummary, setMissionSummary] = useState("");
  const [dressCode, setDressCode] = useState("");
  const [armamentInstructions, setArmamentInstructions] = useState("");
  const [communicationPlan, setCommunicationPlan] = useState("");
  const [medicalNotes, setMedicalNotes] = useState("");
  const [emergencyRendezvous, setEmergencyRendezvous] = useState("");
  const [vehicleDetails, setVehicleDetails] = useState("");
  const [specialInstructions, setSpecialInstructions] = useState("");

  const [principals, setPrincipals] = useState<PersonDraft[]>([]);
  const [threats, setThreats] = useState<PersonDraft[]>([]);
  const [destinations, setDestinations] = useState<DestDraft[]>([]);

  function hydrate(pkg: ProtectionResponse) {
    setThreatLevel(pkg.threatLevel || "none");
    setMissionSummary(pkg.missionSummary ?? "");
    setDressCode(pkg.dressCode ?? "");
    setArmamentInstructions(pkg.armamentInstructions ?? "");
    setCommunicationPlan(pkg.communicationPlan ?? "");
    setMedicalNotes(pkg.medicalNotes ?? "");
    setEmergencyRendezvous(pkg.emergencyRendezvous ?? "");
    setVehicleDetails(pkg.vehicleDetails ?? "");
    setSpecialInstructions(pkg.specialInstructions ?? "");
    setPrincipals((pkg.principals ?? []).map(personToDraft));
    setThreats((pkg.threats ?? []).map(personToDraft));
    setDestinations((pkg.destinations ?? []).map(destToDraft));
  }

  useEffect(() => {
    if (!shiftId) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    (async () => {
      try {
        const [shiftRes, pkg] = await Promise.all([
          api<ShiftInfo>(`/shifts/${shiftId}`).catch(() => null),
          api<ProtectionResponse>(`/shifts/${shiftId}/protection-detail`),
        ]);
        if (cancelled) return;
        setShift(shiftRes);
        hydrate(pkg);
      } catch (e) {
        if (!cancelled) setLoadErr((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shiftId]);

  function patchPerson(
    list: "principal" | "threat",
    uidKey: string,
    patch: Partial<PersonDraft>,
  ) {
    const setter = list === "principal" ? setPrincipals : setThreats;
    setter((prev) => prev.map((p) => (p._uid === uidKey ? { ...p, ...patch } : p)));
  }
  function removePerson(list: "principal" | "threat", uidKey: string) {
    const setter = list === "principal" ? setPrincipals : setThreats;
    setter((prev) => prev.filter((p) => p._uid !== uidKey));
  }
  function patchDest(uidKey: string, patch: Partial<DestDraft>) {
    setDestinations((prev) => prev.map((d) => (d._uid === uidKey ? { ...d, ...patch } : d)));
  }
  function removeDest(uidKey: string) {
    setDestinations((prev) => prev.filter((d) => d._uid !== uidKey));
  }
  // Reorder the itinerary by swapping adjacent stops. seq is derived from array
  // position on save, so reordering the array is all that's needed to persist.
  function moveDest(index: number, dir: -1 | 1) {
    setDestinations((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }

  function personPayload(p: PersonDraft) {
    const out: Record<string, unknown> = {};
    // Age is a free-text string in the contract ("42", "early 40s", …), not a
    // number — send it as-is so demographic descriptors survive.
    const fields: (keyof PersonDraft)[] = [
      "name", "relationship", "sex", "age", "height", "weight",
      "hairColor", "eyeColor", "distinguishingFeatures", "notes",
    ];
    for (const f of fields) {
      const v = strOrU(p[f] as string);
      if (v !== undefined) out[f] = v;
    }
    if (p.photoKeys.length) out.photoKeys = p.photoKeys;
    return Object.keys(out).length ? out : null;
  }
  function destPayload(d: DestDraft) {
    const out: Record<string, unknown> = {};
    const label = strOrU(d.label);
    if (label) out.label = label;
    const address = strOrU(d.address);
    if (address) out.address = address;
    const notes = strOrU(d.notes);
    if (notes) out.notes = notes;
    if (d.arrivalTime) {
      const iso = localToIso(d.arrivalTime);
      if (iso) out.arrivalTime = iso;
    }
    if (d.departureTime) {
      const iso = localToIso(d.departureTime);
      if (iso) out.departureTime = iso;
    }
    if (typeof d.lat === "number" && typeof d.lng === "number") {
      out.lat = d.lat;
      out.lng = d.lng;
    }
    return Object.keys(out).length ? out : null;
  }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      const body: Record<string, unknown> = {
        principals: principals.map(personPayload).filter(Boolean),
        threats: threats.map(personPayload).filter(Boolean),
        destinations: destinations.map(destPayload).filter(Boolean),
      };
      if (threatLevel !== "none") body.threatLevel = threatLevel;
      const preplan: Record<string, string> = {
        missionSummary, dressCode, armamentInstructions, communicationPlan,
        medicalNotes, emergencyRendezvous, vehicleDetails, specialInstructions,
      };
      for (const [k, v] of Object.entries(preplan)) {
        const t = strOrU(v);
        if (t !== undefined) body[k] = t;
      }
      const updated = await api<ProtectionResponse>(`/shifts/${shiftId}/protection-detail`, {
        method: "PUT",
        body,
      });
      hydrate(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function markAsPpo() {
    setMarkingType(true);
    setSaveErr(null);
    try {
      await api(`/shifts/${shiftId}`, { method: "PUT", body: { shiftType: "ppo_detail" } });
      setShift((s) => (s ? { ...s, shiftType: "ppo_detail" } : s));
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setMarkingType(false);
    }
  }

  const mapPoints = useMemo(
    () =>
      destinations
        .map((d, i) => ({ d, i }))
        .filter((x) => typeof x.d.lat === "number" && typeof x.d.lng === "number")
        .map((x) => ({
          lat: x.d.lat as number,
          lng: x.d.lng as number,
          label: x.d.label || x.d.address || `Stop ${x.i + 1}`,
          seq: x.i + 1,
        })),
    [destinations],
  );
  const mapHtml = useMemo(
    () => (mapPoints.length ? buildDestinationsMapHtml(mapPoints) : ""),
    [mapPoints],
  );

  const whenLabel = shift?.startTime
    ? new Date(shift.startTime).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        timeZone: BUSINESS_TIME_ZONE,
      })
    : null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <Link href="/shifts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to shifts
        </Link>
        <div className="mt-2 flex items-start gap-3">
          <Shield className="w-7 h-7 text-brand-gold shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">Protection Detail</h1>
            <p className="text-sm text-muted-foreground truncate">
              {shift?.title ?? "Shift"}
              {whenLabel ? ` · ${whenLabel}` : ""}
              {shift?.location ? ` · ${shift.location}` : ""}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-brand-gold/50 bg-brand-navy text-brand-cream px-4 py-3 flex items-start gap-2 text-sm">
        <Lock className="w-4 h-4 mt-0.5 shrink-0 text-brand-gold" />
        <span>
          Highly sensitive. This package is visible only to admins and to officers with an{" "}
          <strong>accepted</strong> assignment to this shift. It is never shown on public or client
          share links. Every change is audited.
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading protection package…
        </div>
      ) : loadErr ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {loadErr}
        </div>
      ) : (
        <>
          {shift && shift.shiftType !== "ppo_detail" && (
            <div className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                This shift isn't marked as a PPO Detail, so assigned officers won't see this package.
              </span>
              <Button size="sm" variant="outline" onClick={markAsPpo} disabled={markingType}>
                {markingType ? "Marking…" : "Mark as PPO Detail"}
              </Button>
            </div>
          )}

          {/* ── Pre-plan ─────────────────────────────────────────────── */}
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <h2 className="font-semibold">Pre-plan</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Threat level</Label>
                <Select value={threatLevel} onValueChange={setThreatLevel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {THREAT_LEVELS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Dress code</Label>
                <Input value={dressCode} maxLength={300} onChange={(e) => setDressCode(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Mission summary</Label>
              <Textarea rows={3} value={missionSummary} onChange={(e) => setMissionSummary(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Communication plan</Label>
                <Textarea rows={3} value={communicationPlan} onChange={(e) => setCommunicationPlan(e.target.value)} />
              </div>
              <div>
                <Label>Armament instructions</Label>
                <Textarea rows={3} value={armamentInstructions} onChange={(e) => setArmamentInstructions(e.target.value)} />
              </div>
              <div>
                <Label>Vehicle details</Label>
                <Textarea rows={3} value={vehicleDetails} onChange={(e) => setVehicleDetails(e.target.value)} />
              </div>
              <div>
                <Label>Emergency rendezvous</Label>
                <Textarea rows={3} value={emergencyRendezvous} onChange={(e) => setEmergencyRendezvous(e.target.value)} />
              </div>
              <div>
                <Label>Medical notes</Label>
                <Textarea rows={3} value={medicalNotes} onChange={(e) => setMedicalNotes(e.target.value)} />
              </div>
              <div>
                <Label>Special instructions</Label>
                <Textarea rows={3} value={specialInstructions} onChange={(e) => setSpecialInstructions(e.target.value)} />
              </div>
            </div>
          </section>

          {/* ── Principals ───────────────────────────────────────────── */}
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold inline-flex items-center gap-2">
                <User className="w-4 h-4 text-brand-gold" /> Principals
              </h2>
              <Button
                size="sm"
                variant="outline"
                disabled={principals.length >= MAX_PRINCIPALS}
                onClick={() => setPrincipals((prev) => [...prev, emptyPerson()])}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add principal
              </Button>
            </div>
            {principals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No principals added yet.</p>
            ) : (
              <div className="space-y-3">
                {principals.map((p, i) => (
                  <PersonEditor
                    key={p._uid}
                    person={p}
                    label={`Principal ${i + 1}`}
                    accent="principal"
                    onChange={(patch) => patchPerson("principal", p._uid, patch)}
                    onRemove={() => removePerson("principal", p._uid)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Threats ──────────────────────────────────────────────── */}
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold inline-flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red-600" /> Threats / persons of interest
              </h2>
              <Button
                size="sm"
                variant="outline"
                disabled={threats.length >= MAX_THREATS}
                onClick={() => setThreats((prev) => [...prev, emptyPerson()])}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add threat
              </Button>
            </div>
            {threats.length === 0 ? (
              <p className="text-sm text-muted-foreground">No threats logged.</p>
            ) : (
              <div className="space-y-3">
                {threats.map((p, i) => (
                  <PersonEditor
                    key={p._uid}
                    person={p}
                    label={`Threat ${i + 1}`}
                    accent="threat"
                    onChange={(patch) => patchPerson("threat", p._uid, patch)}
                    onRemove={() => removePerson("threat", p._uid)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Destinations ─────────────────────────────────────────── */}
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold inline-flex items-center gap-2">
                <MapPin className="w-4 h-4 text-brand-gold" /> Destinations
              </h2>
              <Button
                size="sm"
                variant="outline"
                disabled={destinations.length >= MAX_DESTINATIONS}
                onClick={() => setDestinations((prev) => [...prev, emptyDest()])}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add destination
              </Button>
            </div>

            {mapHtml && (
              <iframe
                title="Destinations map"
                sandbox="allow-scripts"
                srcDoc={mapHtml}
                className="w-full h-72 rounded-lg border"
              />
            )}

            {destinations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No destinations added yet.</p>
            ) : (
              <div className="space-y-3">
                {destinations.map((d, i) => (
                  <DestEditor
                    key={d._uid}
                    dest={d}
                    index={i}
                    onChange={(patch) => patchDest(d._uid, patch)}
                    onRemove={() => removeDest(d._uid)}
                    onMoveUp={() => moveDest(i, -1)}
                    onMoveDown={() => moveDest(i, 1)}
                    isFirst={i === 0}
                    isLast={i === destinations.length - 1}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Save bar ─────────────────────────────────────────────── */}
          <div className="sticky bottom-4 z-10">
            <div className="rounded-lg border bg-card shadow-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                {saveErr ? (
                  <span className="text-destructive">{saveErr}</span>
                ) : savedAt ? (
                  <span className="text-emerald-700">Saved.</span>
                ) : (
                  <span className="text-muted-foreground">All fields optional.</span>
                )}
              </div>
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                {saving ? "Saving…" : "Save package"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
