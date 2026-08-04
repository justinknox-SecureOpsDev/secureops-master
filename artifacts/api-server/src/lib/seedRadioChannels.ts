import { db, radioChannelsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Idempotently provision the default radio channels so officers/admins
 * always see "All Officers" and admins always see "Admins". Site-scoped
 * channels are created on demand by admins.
 */
type Seed = {
  slug: string;
  name: string;
  scope: "global" | "all_officers" | "admins";
  adminOnly: boolean;
};

const SEEDS: Seed[] = [
  { slug: "radio:all-officers", name: "All Officers", scope: "all_officers", adminOnly: false },
  { slug: "radio:admins",       name: "Admins",       scope: "admins",       adminOnly: true  },
];

/**
 * One-time designation of the always-on channel on existing installs.
 *
 * `alwaysOn` marks the single channel a clocked-in officer's phone keeps
 * connected in the background. Existing deployments predate the flag, so
 * nothing would be held open until an admin found the switch. If exactly one
 * live channel is named "Dispatch", adopt it — matching how these fleets
 * already use the radio.
 *
 * Strictly one-time: it is skipped as soon as ANY channel has an
 * `alwaysOnSetAt` stamp, which the admin routes write on every explicit choice
 * (including turning the designation off). An admin who decides they want no
 * always-on channel therefore isn't overruled by the next deploy. Written as a
 * single conditional UPDATE so two booting instances can't both adopt.
 */
async function adoptDefaultAlwaysOnChannel(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE radio_channels SET always_on = true
    WHERE id = (
      SELECT c.id FROM radio_channels c
      WHERE lower(c.name) = 'dispatch' AND c.archived_at IS NULL
        AND (
          SELECT count(*) FROM radio_channels d
          WHERE lower(d.name) = 'dispatch' AND d.archived_at IS NULL
        ) = 1
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM radio_channels e
      WHERE e.always_on = true OR e.always_on_set_at IS NOT NULL
    )
    RETURNING name
  `);
  const adopted = (result.rows as Array<{ name: string }>)[0];
  if (adopted) logger.info(`[radio] Designated "${adopted.name}" as the always-on channel`);
}

export async function seedRadioChannels(): Promise<void> {
  try {
    for (const s of SEEDS) {
      await db
        .insert(radioChannelsTable)
        .values({ slug: s.slug, name: s.name, scope: s.scope, adminOnly: s.adminOnly })
        .onConflictDoUpdate({
          target: radioChannelsTable.slug,
          set: { name: s.name, scope: s.scope, adminOnly: s.adminOnly },
        });
    }
    await adoptDefaultAlwaysOnChannel();
    logger.info(`[radio] Seeded ${SEEDS.length} default radio channels`);
  } catch (err) {
    logger.error({ err }, "[radio] Failed to seed default radio channels");
  }
}
