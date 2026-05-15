import { Router, type IRouter } from "express";
import { eq, asc, sql } from "drizzle-orm";
import { db, policiesTable } from "@workspace/db";
import { z } from "zod/v4";
import { requireAdmin } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const SLUG_RE = /^[a-z0-9_]+$/;

const DEFAULT_POLICIES: { slug: string; label: string }[] = [
  { slug: "drug_free", label: "Drug-Free Workplace Policy" },
  { slug: "uniform_sou", label: "Uniform Standard of Use" },
  { slug: "non_disclosure", label: "Non-Disclosure Agreement" },
  { slug: "contract", label: "Employment Contract" },
];

async function ensureDefaults(): Promise<void> {
  const existing = await db.select({ id: policiesTable.id }).from(policiesTable).limit(1);
  if (existing.length > 0) return;
  await db.insert(policiesTable).values(DEFAULT_POLICIES).onConflictDoNothing();
}

type PolicyRow = typeof policiesTable.$inferSelect;

async function rowToDto(r: PolicyRow, includeViewUrl: boolean) {
  let viewUrl: string | null = null;
  if (includeViewUrl && r.fileKey) {
    try {
      viewUrl = await storage.getSignedDownloadURL(r.fileKey);
    } catch {
      viewUrl = null;
    }
  }
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    version: r.version,
    fileKey: r.fileKey,
    fileName: r.fileName,
    uploadedAt: r.uploadedAt ? r.uploadedAt.toISOString() : null,
    uploadedBy: r.uploadedBy,
    hasDocument: !!r.fileKey,
    viewUrl,
  };
}

// ---- Admin -----------------------------------------------------------------

router.get("/admin/policies", requireAdmin, async (_req, res): Promise<void> => {
  await ensureDefaults();
  const rows = await db.select().from(policiesTable).orderBy(asc(policiesTable.label));
  const out = await Promise.all(rows.map((r) => rowToDto(r, true)));
  res.json(out);
});

const CreatePolicyBody = z.object({
  slug: z.string().regex(SLUG_RE, "slug must be lowercase letters, numbers, underscore"),
  label: z.string().min(1),
});

router.post("/admin/policies", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreatePolicyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", message: parsed.error.message }); return; }
  try {
    const [row] = await db.insert(policiesTable).values({
      slug: parsed.data.slug,
      label: parsed.data.label,
    }).returning();
    res.status(201).json(await rowToDto(row, false));
  } catch (err) {
    const msg = (err as { message?: string }).message ?? "";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "Conflict", message: "A policy with that slug already exists" });
      return;
    }
    req.log.error({ err }, "Create policy failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not create policy" });
  }
});

const UpdatePolicyBody = z.object({
  label: z.string().min(1).optional(),
});

router.patch("/admin/policies/:id", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdatePolicyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", message: parsed.error.message }); return; }
  if (!parsed.data.label) { res.status(400).json({ error: "Bad Request", message: "label required" }); return; }
  const [row] = await db.update(policiesTable)
    .set({ label: parsed.data.label })
    .where(eq(policiesTable.id, req.params.id as string))
    .returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "Policy not found" }); return; }
  res.json(await rowToDto(row, true));
});

const ReplaceDocBody = z.object({
  fileKey: z.string().min(1),
  fileName: z.string().min(1),
});

router.post("/admin/policies/:id/replace", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ReplaceDocBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", message: parsed.error.message }); return; }

  const normalized = storage.normalizeObjectEntityPath(parsed.data.fileKey);
  // sanity-check that the object exists
  try {
    await storage.getObjectEntityFile(normalized);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "Bad Request", message: "Uploaded file not found in storage" });
      return;
    }
    throw err;
  }

  const [row] = await db.update(policiesTable)
    .set({
      fileKey: normalized,
      fileName: parsed.data.fileName,
      uploadedBy: req.user!.userId,
      uploadedAt: new Date(),
      version: sql`${policiesTable.version} + 1`,
    })
    .where(eq(policiesTable.id, req.params.id as string))
    .returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "Policy not found" }); return; }
  res.json(await rowToDto(row, true));
});

router.delete("/admin/policies/:id", requireAdmin, async (req, res): Promise<void> => {
  const [row] = await db.delete(policiesTable).where(eq(policiesTable.id, req.params.id as string)).returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "Policy not found" }); return; }
  res.status(204).end();
});

// ---- Public (used by onboarding page) --------------------------------------

router.get("/policies/active", async (_req, res): Promise<void> => {
  await ensureDefaults();
  const rows = await db.select().from(policiesTable).orderBy(asc(policiesTable.label));
  const active = rows.filter((r) => !!r.fileKey);
  const out = await Promise.all(active.map((r) => rowToDto(r, true)));
  res.json(out);
});

export default router;
