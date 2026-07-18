/**
 * Feature flag management for the control-plane surface.
 *
 * The DB table (`feature_flags`) is the source of truth.  Flags absent from
 * the table are "not set" — consumers apply their own hardcoded defaults.
 * The control plane may upsert (enable/disable) or clear (delete) any flag.
 */

import { z } from "zod/v4";
import { inArray } from "drizzle-orm";
import { db, featureFlagsTable } from "@workspace/db";
import { logger } from "./logger";

/** Shape returned by GET /control-plane/settings .features[] */
export type FeatureFlagDetail = {
  key:         string;
  enabled:     boolean;
  payload:     Record<string, unknown> | null;
  description: string | null;
  updatedAt:   string;
};

/** Schema for a single flag entry within a control-plane feature update. */
export const FlagEntrySchema = z.object({
  key:         z.string().min(1),
  enabled:     z.boolean(),
  payload:     z.record(z.string(), z.unknown()).nullable().optional(),
  description: z.string().nullable().optional(),
});

/**
 * Schema for PUT /api/control-plane/features.
 *
 * `flags`  — array of flags to upsert (set key+enabled, optionally payload+description).
 * `clear`  — array of flag keys to delete (reverts to application default).
 *
 * Both fields are optional; an empty body is a valid no-op.
 */
export const FeatureFlagsUpdateSchema = z.object({
  flags: z.array(FlagEntrySchema).optional(),
  clear: z.array(z.string().min(1)).optional(),
});

export type FeatureFlagsUpdate = z.infer<typeof FeatureFlagsUpdateSchema>;

/** Return all feature flags currently in the DB, sorted by key. */
export async function getFlags(): Promise<FeatureFlagDetail[]> {
  const rows = await db.select().from(featureFlagsTable);
  return rows
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({
      key:         r.key,
      enabled:     r.enabled,
      payload:     (r.payload as Record<string, unknown>) ?? null,
      description: r.description ?? null,
      updatedAt:   r.updatedAt.toISOString(),
    }));
}

/** Apply a flags update: upsert flag rows and delete cleared keys. */
export async function applyFlagsUpdate(body: FeatureFlagsUpdate): Promise<void> {
  const { flags = [], clear = [] } = body;

  for (const flag of flags) {
    await db
      .insert(featureFlagsTable)
      .values({
        key:         flag.key,
        enabled:     flag.enabled,
        payload:     flag.payload ?? null,
        description: flag.description ?? null,
      })
      .onConflictDoUpdate({
        target: featureFlagsTable.key,
        set: {
          enabled:     flag.enabled,
          payload:     flag.payload ?? null,
          description: flag.description ?? null,
          updatedAt:   new Date(),
        },
      });
  }

  if (clear.length > 0) {
    await db.delete(featureFlagsTable).where(inArray(featureFlagsTable.key, clear));
  }
}

/**
 * Load all feature flags from the DB at boot.
 * Non-fatal: if the table doesn't exist yet (first boot before push), returns [].
 */
export async function loadFeatureFlagsFromDb(): Promise<FeatureFlagDetail[]> {
  try {
    return await getFlags();
  } catch (err) {
    logger.warn({ err }, "[features] could not load feature flags from DB — table may not exist yet");
    return [];
  }
}
