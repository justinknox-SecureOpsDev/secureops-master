import { eq, sql } from "drizzle-orm";
import { db, chatRoomsTable, sitesTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Canonical chat channels seeded on boot. Idempotent via the `slug`
 * column — re-running upserts name/type/metadata without duplicating
 * rooms. Site channels are seeded dynamically from the sites table
 * (one per site, slug `site:<siteId>`).
 *
 * Old `general` rooms from prior deploys are migrated to the new
 * announcements channel by setting their slug + type the first time
 * this runs (preserves message history).
 */

type Canonical = {
  slug: string;
  name: string;
  type: "announcements" | "license_level" | "ops" | "city" | "elite";
  licenseLevel?: number;
  city?: string;
  joinPolicy: "auto" | "request" | "invite";
};

const CANONICAL: Canonical[] = [
  { slug: "announcements", name: "General Announcements", type: "announcements", joinPolicy: "auto" },
  { slug: "level-2", name: "Level 2 (Unarmed)", type: "license_level", licenseLevel: 2, joinPolicy: "auto" },
  { slug: "level-3", name: "Level 3 (Armed)", type: "license_level", licenseLevel: 3, joinPolicy: "auto" },
  { slug: "level-4", name: "Level 4 PPO", type: "license_level", licenseLevel: 4, joinPolicy: "auto" },
  { slug: "ops", name: "OPS (Admin)", type: "ops", joinPolicy: "auto" },
  { slug: "city-dfw", name: "DFW", type: "city", city: "Dallas", joinPolicy: "request" },
  { slug: "city-houston", name: "Houston", type: "city", city: "Houston", joinPolicy: "request" },
  { slug: "city-san-antonio", name: "San Antonio", type: "city", city: "San Antonio", joinPolicy: "request" },
  { slug: "city-austin", name: "Austin", type: "city", city: "Austin", joinPolicy: "request" },
  { slug: "elite-chiefs-ppo", name: "Chiefs Elite PPO", type: "elite", joinPolicy: "invite" },
];

export async function seedChatRooms(): Promise<void> {
  try {
    // Migrate the OLDEST legacy "general" room (type=general, slug=null) into
    // the new announcements channel so its message history is preserved.
    // Only one row is promoted to avoid colliding on the unique slug;
    // any extra legacy `general` rooms (e.g. stray dev test rooms) keep
    // their old type and just disappear from listings.
    await db.execute(sql`
      UPDATE chat_rooms
      SET slug = 'announcements', type = 'announcements', name = 'General Announcements', join_policy = 'auto'
      WHERE id = (
        SELECT id FROM chat_rooms
        WHERE type = 'general' AND slug IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM chat_rooms WHERE slug = 'announcements')
    `);
    // Retire remaining legacy general rooms so they stop showing up.
    await db.execute(sql`
      UPDATE chat_rooms SET type = 'retired'
      WHERE type = 'general' AND slug IS NULL
    `);

    // Retire any legacy per-shift rooms — the new channel set replaces them.
    // Deleted rows cascade to messages, but we keep messages in place by
    // first detaching: set type='retired' so resolveRoomMembers fails
    // closed and they disappear from listings without losing history.
    await db.execute(sql`UPDATE chat_rooms SET type = 'retired' WHERE type = 'shift'`);

    for (const c of CANONICAL) {
      await db
        .insert(chatRoomsTable)
        .values({
          slug: c.slug,
          name: c.name,
          type: c.type,
          licenseLevel: c.licenseLevel ?? null,
          city: c.city ?? null,
          joinPolicy: c.joinPolicy,
        })
        .onConflictDoUpdate({
          target: chatRoomsTable.slug,
          set: {
            name: c.name,
            type: c.type,
            licenseLevel: c.licenseLevel ?? null,
            city: c.city ?? null,
            joinPolicy: c.joinPolicy,
          },
        });
    }

    // One channel per site, slug "site:<siteId>". Dropped sites leave
    // their rooms behind (history preserved); they just become unreachable
    // via the auto-membership query (no shifts → admins only).
    const sites = await db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable);
    for (const s of sites) {
      const slug = `site:${s.id}`;
      await db
        .insert(chatRoomsTable)
        .values({
          slug,
          name: s.name,
          type: "site",
          siteId: s.id,
          joinPolicy: "auto",
        })
        .onConflictDoUpdate({
          target: chatRoomsTable.slug,
          set: { name: s.name, type: "site", siteId: s.id, joinPolicy: "auto" },
        });
    }

    logger.info(`[chat] Seeded ${CANONICAL.length} canonical + ${sites.length} site channels`);
  } catch (err) {
    logger.error({ err }, "[chat] Failed to seed canonical chat rooms");
  }
}
