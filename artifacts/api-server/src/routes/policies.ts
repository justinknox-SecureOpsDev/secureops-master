import { Router, type IRouter } from "express";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import {
  db,
  policiesTable,
  onboardingSubmissionsTable,
  seedPolicies,
  type Policy,
} from "@workspace/db";
import { z } from "zod/v4";
import { requireAdmin } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const SLUG_RE = /^[a-z0-9_]+$/;

type PolicyDto = {
  id: string;
  slug: string;
  label: string;
  version: number;
  fileKey: string | null;
  fileName: string | null;
  isActive: boolean;
  uploadedAt: string | null;
  uploadedBy: string | null;
  hasDocument: boolean;
  viewUrl: string | null;
};

async function rowToDto(r: Policy, includeViewUrl: boolean): Promise<PolicyDto> {
  let viewUrl: string | null = null;
  if (includeViewUrl && r.fileKey) {
    try { viewUrl = await storage.getSignedDownloadURL(r.fileKey); } catch { viewUrl = null; }
  }
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    version: r.version,
    fileKey: r.fileKey,
    fileName: r.fileName,
    isActive: r.isActive,
    uploadedAt: r.uploadedAt ? r.uploadedAt.toISOString() : null,
    uploadedBy: r.uploadedBy,
    hasDocument: !!r.fileKey,
    viewUrl,
  };
}

/** Group rows by slug; for each slug return the current (active) row plus history. */
type PolicyGroupDto = {
  slug: string;
  label: string;
  isActive: boolean;
  current: PolicyDto | null;
  history: PolicyDto[];
};

function groupBySlug(rows: Policy[]): Map<string, Policy[]> {
  const m = new Map<string, Policy[]>();
  for (const r of rows) {
    const arr = m.get(r.slug) ?? [];
    arr.push(r);
    m.set(r.slug, arr);
  }
  return m;
}

// ---- Admin -----------------------------------------------------------------

router.get("/admin/policies", requireAdmin, async (_req, res): Promise<void> => {
  await seedPolicies();
  const rows = await db.select().from(policiesTable).orderBy(asc(policiesTable.label), desc(policiesTable.version));
  const groups = groupBySlug(rows);
  const out: PolicyGroupDto[] = [];
  for (const [slug, versions] of groups) {
    versions.sort((a, b) => b.version - a.version);
    const active = versions.find((v) => v.isActive) ?? null;
    const label = active?.label ?? versions[0].label;
    const isActive = !!active;
    const currentDto = active ? await rowToDto(active, true) : null;
    const history = await Promise.all(versions.map((v) => rowToDto(v, false)));
    out.push({ slug, label, isActive, current: currentDto, history });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  res.json(out);
});

const CreatePolicyBody = z.object({
  slug: z.string().regex(SLUG_RE, "slug must be lowercase letters, numbers, underscore"),
  label: z.string().min(1),
});

router.post("/admin/policies", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreatePolicyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", message: parsed.error.message }); return; }

  const [existing] = await db.select().from(policiesTable).where(eq(policiesTable.slug, parsed.data.slug)).limit(1);
  if (existing) { res.status(409).json({ error: "Conflict", message: "A policy with that slug already exists" }); return; }

  const [row] = await db.insert(policiesTable).values({
    slug: parsed.data.slug,
    label: parsed.data.label,
    version: 1,
    isActive: true,
  }).returning();
  res.status(201).json(await rowToDto(row, false));
});

const UpdatePolicyBody = z.object({
  label: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/admin/policies/:id", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdatePolicyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", message: parsed.error.message }); return; }
  if (parsed.data.label === undefined && parsed.data.isActive === undefined) {
    res.status(400).json({ error: "Bad Request", message: "Provide label and/or isActive" }); return;
  }

  const [target] = await db.select().from(policiesTable).where(eq(policiesTable.id, req.params.id as string)).limit(1);
  if (!target) { res.status(404).json({ error: "Not Found", message: "Policy not found" }); return; }

  await db.transaction(async (tx) => {
    if (parsed.data.label !== undefined) {
      // Rename applies to ALL versions of this slug for consistency in admin UI.
      await tx.update(policiesTable)
        .set({ label: parsed.data.label })
        .where(eq(policiesTable.slug, target.slug));
    }
    if (parsed.data.isActive !== undefined) {
      if (parsed.data.isActive) {
        // Activate this row, deactivate every other row of this slug.
        await tx.update(policiesTable)
          .set({ isActive: false })
          .where(and(eq(policiesTable.slug, target.slug), sql`${policiesTable.id} <> ${target.id}`));
        await tx.update(policiesTable)
          .set({ isActive: true })
          .where(eq(policiesTable.id, target.id));
      } else {
        await tx.update(policiesTable)
          .set({ isActive: false })
          .where(eq(policiesTable.id, target.id));
      }
    }
  });

  const [updated] = await db.select().from(policiesTable).where(eq(policiesTable.id, target.id)).limit(1);
  res.json(await rowToDto(updated, true));
});

const ReplaceDocBody = z.object({
  fileKey: z.string().min(1),
  fileName: z.string().min(1),
});

/**
 * "Replace" = insert a NEW row for this slug at version+1, mark active,
 * and demote all prior versions to inactive. Old versions are retained
 * forever as immutable audit history.
 */
router.post("/admin/policies/:id/replace", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ReplaceDocBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", message: parsed.error.message }); return; }

  const normalized = storage.normalizeObjectEntityPath(parsed.data.fileKey);
  try {
    await storage.getObjectEntityFile(normalized);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "Bad Request", message: "Uploaded file not found in storage" }); return;
    }
    throw err;
  }

  const [seed] = await db.select().from(policiesTable).where(eq(policiesTable.id, req.params.id as string)).limit(1);
  if (!seed) { res.status(404).json({ error: "Not Found", message: "Policy not found" }); return; }

  const newRow = await db.transaction(async (tx) => {
    const versions = await tx.select().from(policiesTable).where(eq(policiesTable.slug, seed.slug));
    const maxVersion = versions.reduce((m, v) => Math.max(m, v.version), 0);
    await tx.update(policiesTable)
      .set({ isActive: false })
      .where(eq(policiesTable.slug, seed.slug));
    const [inserted] = await tx.insert(policiesTable).values({
      slug: seed.slug,
      label: seed.label,
      version: maxVersion + 1,
      fileKey: normalized,
      fileName: parsed.data.fileName,
      isActive: true,
      uploadedBy: req.user!.userId,
      uploadedAt: new Date(),
    }).returning();
    return inserted;
  });

  res.json(await rowToDto(newRow, true));
});

/**
 * Hard delete a policy slug (all versions). Refuses with 409 if any
 * version of the slug is referenced by an existing onboarding
 * submission's acknowledgement entries — admin must deactivate instead.
 */
router.delete("/admin/policies/:id", requireAdmin, async (req, res): Promise<void> => {
  const [target] = await db.select().from(policiesTable).where(eq(policiesTable.id, req.params.id as string)).limit(1);
  if (!target) { res.status(404).json({ error: "Not Found", message: "Policy not found" }); return; }

  const versions = await db.select().from(policiesTable).where(eq(policiesTable.slug, target.slug));
  const ids = versions.map((v) => v.id);

  // Scan all submissions for any ack entry whose policyId matches one of
  // this slug's versions. Use jsonb containment with one literal per id.
  for (const id of ids) {
    const literal = JSON.stringify([{ policyId: id }]);
    const used = await db.execute(sql`
      SELECT 1 FROM ${onboardingSubmissionsTable}
      WHERE ${onboardingSubmissionsTable.acknowledgements} @> ${literal}::jsonb
      LIMIT 1
    `);
    if (used.rows.length > 0) {
      res.status(409).json({
        error: "Conflict",
        message: "This policy has been signed by one or more employees and cannot be deleted. Deactivate it instead.",
      });
      return;
    }
  }

  await db.delete(policiesTable).where(eq(policiesTable.slug, target.slug));
  res.status(204).end();
});

// ---- Public (used by onboarding page) --------------------------------------

router.get("/policies/active", async (_req, res): Promise<void> => {
  await seedPolicies();
  const rows = await db.select().from(policiesTable)
    .where(and(eq(policiesTable.isActive, true), sql`${policiesTable.fileKey} IS NOT NULL`));
  const out: PolicyDto[] = [];
  for (const r of rows) {
    try {
      const viewUrl = await storage.getSignedDownloadURL(r.fileKey!);
      const dto = await rowToDto(r, false);
      out.push({ ...dto, viewUrl });
    } catch {
      // Skip rows whose object can't be signed (transient storage issue).
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  res.json(out);
});

export default router;
