import { eq, sql } from "drizzle-orm";
import { db, chatRoomsTable, sitesTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Chat channel seeding for the master template.
 *
 * This template intentionally ships with NO default chat channels — each
 * customer creates their own channels in-app ("as they wish"). The former
 * WCSG-specific defaults (regional city rooms + an elite PPO room) and the
 * generic Announcements/Ops/license-level rooms have all been removed so
 * copies of this template start with a clean slate. Re-populate `CANONICAL`
 * below to ship built-in channels for a specific tenant.
 *
 * Site channels are still seeded dynamically from the sites table (one per
 * site, slug `site:<siteId>`), so a client's channels appear as they add
 * their own sites.
 *
 * Legacy `general`/`shift` rooms from prior deploys are still retired on
 * boot so they stop showing up (message history preserved).
 */

type Canonical = {
  slug: string;
  name: string;
  type: "announcements" | "license_level" | "ops" | "city" | "elite";
  licenseLevel?: number;
  city?: string;
  joinPolicy: "auto" | "request" | "invite";
};

// Intentionally empty for the master template — no default channels are
// seeded. Add entries here to ship built-in channels for a specific tenant.
const CANONICAL: Canonical[] = [];

export async function seedChatRooms(): Promise<void> {
  try {
    // Retire legacy `general` rooms (type=general, slug=null) from older
    // deploys so they stop showing up; history is preserved because the row
    // stays put and resolveRoomMembers fails closed on the retired type.
    // The template ships NO default channels, so we deliberately do NOT
    // promote any of them into an Announcements room. Mobile-created channels
    // are stored as `announcements` (the create route aliases the legacy
    // `general` type), so this never touches them.
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
