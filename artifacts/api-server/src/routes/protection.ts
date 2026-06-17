import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  shiftsTable,
  shiftAssignmentsTable,
  protectionDetailsTable,
  protectionPersonsTable,
  protectionDestinationsTable,
} from "@workspace/db";
import { UpdateProtectionDetailBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { geocodeOnelineAddress } from "../lib/geocode";

/**
 * Executive / close-protection ("PPO Detail") package routes.
 *
 * Mounted under the same `/shifts` prefix as the shifts router so the
 * router-level audit middleware classifies the PUT as `shifts.write`.
 * IMPORTANT: the PUT body carries highly sensitive PII (principal/threat
 * demographics, photos, medical notes). `auditLogMiddleware` special-cases
 * this exact path so the persisted audit snapshot is counts-only, never the
 * raw body — see lib/auditLog.ts.
 *
 * Authorization:
 *   - GET: admin/dispatcher/lead (any shift) OR an `employee` with an
 *     ACCEPTED assignment to that shift. Everyone else (incl. external
 *     `client` portal users) gets 403.
 *   - PUT: admin only (`requireAdmin`), replace-all semantics.
 *
 * This data must NEVER be exposed on public/share surfaces.
 */

const router: IRouter = Router();

// Roles that may read ANY shift's protection package without a per-shift
// assignment. Officers (`employee`) need an accepted assignment instead.
const STAFF_READ_ROLES = new Set(["admin", "dispatcher", "lead"]);

type PersonRow = typeof protectionPersonsTable.$inferSelect;
type DestRow = typeof protectionDestinationsTable.$inferSelect;
type ParsedBody = ReturnType<(typeof UpdateProtectionDetailBody)["parse"]>;
type PersonInput = NonNullable<ParsedBody["principals"]>[number];

function serializePerson(p: PersonRow) {
  return {
    id: p.id,
    kind: p.kind,
    seq: p.seq,
    name: p.name,
    relationship: p.relationship,
    sex: p.sex,
    age: p.age,
    height: p.height,
    weight: p.weight,
    hairColor: p.hairColor,
    eyeColor: p.eyeColor,
    distinguishingFeatures: p.distinguishingFeatures,
    notes: p.notes,
    photoKeys: Array.isArray(p.photoKeys) ? p.photoKeys : [],
  };
}

function serializeDest(d: DestRow) {
  return {
    id: d.id,
    seq: d.seq,
    label: d.label,
    address: d.address,
    // numeric(10,6) columns come back as strings from pg — normalize to JS
    // numbers for the JSON contract (or null when not geocoded).
    lat: d.lat === null ? null : Number(d.lat),
    lng: d.lng === null ? null : Number(d.lng),
    arrivalTime: d.arrivalTime ? d.arrivalTime.toISOString() : null,
    notes: d.notes,
  };
}

/** Assemble the full package for a shift (empty/null sections when unbuilt). */
async function buildPackage(shiftId: string) {
  const [detail] = await db
    .select()
    .from(protectionDetailsTable)
    .where(eq(protectionDetailsTable.shiftId, shiftId))
    .limit(1);
  const persons = await db
    .select()
    .from(protectionPersonsTable)
    .where(eq(protectionPersonsTable.shiftId, shiftId))
    .orderBy(asc(protectionPersonsTable.seq), asc(protectionPersonsTable.createdAt));
  const destinations = await db
    .select()
    .from(protectionDestinationsTable)
    .where(eq(protectionDestinationsTable.shiftId, shiftId))
    .orderBy(asc(protectionDestinationsTable.seq), asc(protectionDestinationsTable.createdAt));

  return {
    shiftId,
    threatLevel: detail?.threatLevel ?? null,
    missionSummary: detail?.missionSummary ?? null,
    dressCode: detail?.dressCode ?? null,
    armamentInstructions: detail?.armamentInstructions ?? null,
    communicationPlan: detail?.communicationPlan ?? null,
    medicalNotes: detail?.medicalNotes ?? null,
    emergencyRendezvous: detail?.emergencyRendezvous ?? null,
    vehicleDetails: detail?.vehicleDetails ?? null,
    specialInstructions: detail?.specialInstructions ?? null,
    principals: persons.filter((p) => p.kind === "principal").map(serializePerson),
    threats: persons.filter((p) => p.kind === "threat").map(serializePerson),
    destinations: destinations.map(serializeDest),
  };
}

/** Map a validated person input to an insert row for the given shift + kind. */
function mapPersonInput(
  shiftId: string,
  p: PersonInput,
  kind: "principal" | "threat",
  seq: number,
) {
  return {
    shiftId,
    kind,
    seq,
    name: p.name ?? null,
    relationship: p.relationship ?? null,
    sex: p.sex ?? null,
    age: p.age ?? null,
    height: p.height ?? null,
    weight: p.weight ?? null,
    hairColor: p.hairColor ?? null,
    eyeColor: p.eyeColor ?? null,
    distinguishingFeatures: p.distinguishingFeatures ?? null,
    notes: p.notes ?? null,
    photoKeys: Array.isArray(p.photoKeys) ? p.photoKeys : [],
  };
}

/**
 * GET /shifts/:id/protection-detail
 *
 * Read the PPO package. Admin/dispatcher/lead may read any shift; an officer
 * may read only a shift they have an ACCEPTED assignment to.
 */
router.get("/shifts/:id/protection-detail", requireAuth, async (req: Request, res: Response) => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const [shift] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId))
      .limit(1);
    if (!shift) {
      res.status(404).json({ error: "Not Found", message: "Shift not found" });
      return;
    }

    const role = req.user!.role;
    let authorized = STAFF_READ_ROLES.has(role);
    if (!authorized && role === "employee") {
      const [assignment] = await db
        .select({ id: shiftAssignmentsTable.id })
        .from(shiftAssignmentsTable)
        .where(
          and(
            eq(shiftAssignmentsTable.shiftId, shiftId),
            eq(shiftAssignmentsTable.employeeId, req.user!.userId),
            eq(shiftAssignmentsTable.status, "accepted"),
          ),
        )
        .limit(1);
      authorized = Boolean(assignment);
    }
    if (!authorized) {
      res.status(403).json({
        error: "Forbidden",
        message: "Not authorized to view this shift's protection package",
      });
      return;
    }

    const pkg = await buildPackage(shiftId);
    res.json(pkg);
  } catch (err) {
    req.log.error({ err }, "Failed to load protection package");
    res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load protection package" });
  }
});

/**
 * PUT /shifts/:id/protection-detail
 *
 * Admin-only replace-all. Upserts the 1:1 detail row, then deletes and
 * re-inserts persons (principals + threats) and destinations. Destinations are
 * geocoded best-effort from their address when explicit lat/lng aren't given.
 */
router.put("/shifts/:id/protection-detail", requireAdmin, async (req: Request, res: Response) => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateProtectionDetailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Bad Request",
      message: "Invalid protection package",
      details: parsed.error.flatten(),
    });
    return;
  }
  const body = parsed.data;

  try {
    const [shift] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId))
      .limit(1);
    if (!shift) {
      res.status(404).json({ error: "Not Found", message: "Shift not found" });
      return;
    }

    // Geocode destinations best-effort BEFORE opening the transaction —
    // network I/O must not hold a DB transaction open. Prefer explicit
    // client-supplied lat/lng; otherwise resolve from the free-text address.
    const inputDests = body.destinations ?? [];
    const resolvedDests = await Promise.all(
      inputDests.map(async (d) => {
        let lat = typeof d.lat === "number" ? d.lat : null;
        let lng = typeof d.lng === "number" ? d.lng : null;
        if ((lat === null || lng === null) && d.address && d.address.trim()) {
          const g = await geocodeOnelineAddress(d.address);
          if (g) {
            lat = g.lat;
            lng = g.lng;
          }
        }
        return {
          label: d.label ?? null,
          address: d.address ?? null,
          lat,
          lng,
          arrivalTime: d.arrivalTime ?? null,
          notes: d.notes ?? null,
        };
      }),
    );

    const detailValues = {
      threatLevel: body.threatLevel ?? null,
      missionSummary: body.missionSummary ?? null,
      dressCode: body.dressCode ?? null,
      armamentInstructions: body.armamentInstructions ?? null,
      communicationPlan: body.communicationPlan ?? null,
      medicalNotes: body.medicalNotes ?? null,
      emergencyRendezvous: body.emergencyRendezvous ?? null,
      vehicleDetails: body.vehicleDetails ?? null,
      specialInstructions: body.specialInstructions ?? null,
    };

    await db.transaction(async (tx) => {
      // Upsert the 1:1 detail row (unique index on shift_id).
      await tx
        .insert(protectionDetailsTable)
        .values({ shiftId, ...detailValues })
        .onConflictDoUpdate({
          target: protectionDetailsTable.shiftId,
          set: { ...detailValues, updatedAt: new Date() },
        });

      // Replace all persons. seq = position within its kind array.
      await tx.delete(protectionPersonsTable).where(eq(protectionPersonsTable.shiftId, shiftId));
      const personRows = [
        ...(body.principals ?? []).map((p, i) => mapPersonInput(shiftId, p, "principal", i)),
        ...(body.threats ?? []).map((p, i) => mapPersonInput(shiftId, p, "threat", i)),
      ];
      if (personRows.length > 0) {
        await tx.insert(protectionPersonsTable).values(personRows);
      }

      // Replace all destinations. numeric columns take string values.
      await tx
        .delete(protectionDestinationsTable)
        .where(eq(protectionDestinationsTable.shiftId, shiftId));
      const destRows = resolvedDests.map((d, i) => ({
        shiftId,
        seq: i,
        label: d.label,
        address: d.address,
        lat: d.lat === null ? null : String(d.lat),
        lng: d.lng === null ? null : String(d.lng),
        arrivalTime: d.arrivalTime,
        notes: d.notes,
      }));
      if (destRows.length > 0) {
        await tx.insert(protectionDestinationsTable).values(destRows);
      }
    });

    // Counts-only audit metadata. The raw body is independently redacted to a
    // counts-only summary by auditLogMiddleware (it never persists the PII).
    res.locals["auditMetadata"] = {
      principals: (body.principals ?? []).length,
      threats: (body.threats ?? []).length,
      destinations: inputDests.length,
    };

    const pkg = await buildPackage(shiftId);
    res.json(pkg);
  } catch (err) {
    req.log.error({ err }, "Failed to save protection package");
    res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to save protection package" });
  }
});

export default router;
