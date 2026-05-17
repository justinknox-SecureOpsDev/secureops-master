import { db, radioChannelsTable } from "@workspace/db";
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
    logger.info(`[radio] Seeded ${SEEDS.length} default radio channels`);
  } catch (err) {
    logger.error({ err }, "[radio] Failed to seed default radio channels");
  }
}
