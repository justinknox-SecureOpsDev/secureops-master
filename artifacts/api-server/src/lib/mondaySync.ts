import { db, usersTable, employeesTable, licensesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

const MONDAY_BOARD_DEFAULT = process.env.MONDAY_BOARD_ID;

const COL = {
  email: "email_mm04q6zj",
  phone: "phone_mm04yt",
  status: "color_mm04zr6v",
  address: "text_mm0hg184",
  hireDate: "date_mm04d9b7",
  termDate: "date_mm04wykg",
  dob: "date_mm04hmz2",
  ecName: "text_mm04tq8m",
  ecPhone: "phone_mm0432aw",
  ecRel: "dropdown_mm04eb6y",
  routing: "text_mm0h3x52",
  acct: "text_mm0hhzs9",
  licType: "color_mm0mhf8y",
  licNumber: "text_mm04zjsc",
  licExpiry: "date_mm041634",
  uniform: "text_mm04kj3w",
  cityState: "short_textp81mmg9i",
} as const;

type MondayItem = {
  id: string;
  name: string;
  column_values: { id: string; text: string | null; value: string | null; type: string }[];
};

export type SyncDecision = {
  mondayId: string;
  mondayName: string;
  email: string | null;
  action: "create" | "update" | "skip-no-email" | "skip-conflict";
  reason?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
};

export type SyncResult = {
  boardId: string;
  totalFromMonday: number;
  willCreate: number;
  willUpdate: number;
  skippedNoEmail: number;
  skippedConflict: number;
  decisions: SyncDecision[];
  applied: boolean;
  errors: { mondayId: string; mondayName: string; error: string }[];
};

async function fetchAllItems(boardId: string, token: string): Promise<MondayItem[]> {
  const items: MondayItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: "${cursor}") { cursor items { id name column_values { id text value type } } } }`
      : `query { boards(ids: [${boardId}]) { items_page(limit: 100) { cursor items { id name column_values { id text value type } } } } }`;
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-10" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json() as { data?: any; errors?: any };
    if (data.errors) throw new Error("Monday API: " + JSON.stringify(data.errors));
    const page_data: { cursor: string | null; items: MondayItem[] } =
      cursor ? data.data.next_items_page : data.data.boards[0].items_page;
    items.push(...page_data.items);
    cursor = page_data.cursor;
    if (!cursor) break;
  }
  return items;
}

function getCol(item: MondayItem, id: string): string | null {
  const c = item.column_values.find((c) => c.id === id);
  return c?.text?.trim() || null;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function mapStatus(monday: string | null): "active" | "inactive" | "pending" {
  if (!monday) return "pending";
  const s = monday.toLowerCase();
  if (s.includes("active")) return "active";
  if (s.includes("terminat") || s.includes("inactive")) return "inactive";
  return "pending";
}

function mapLicenseLevel(licType: string | null): number | null {
  if (!licType) return null;
  const s = licType.toLowerCase();
  if (s.includes("ppo") || s.includes("level 4") || s.includes("l4")) return 4;
  if (s.includes("armed") || s.includes("level 3") || s.includes("l3")) return 3;
  if (s.includes("unarmed") || s.includes("level 2") || s.includes("l2")) return 2;
  return 2;
}

function normalizeEmail(e: string | null): string | null {
  if (!e) return null;
  const t = e.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

function isoDate(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function diff(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined || v === "") continue;
    const cur = existing[k];
    if (String(cur ?? "") !== String(v)) changes[k] = { from: cur ?? null, to: v };
  }
  return changes;
}

export async function syncFromMonday(opts: { boardId?: string; dryRun: boolean }): Promise<SyncResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not configured");
  const boardId = opts.boardId || MONDAY_BOARD_DEFAULT;
  if (!boardId) throw new Error("boardId is required");

  const items = await fetchAllItems(boardId, token);
  const result: SyncResult = {
    boardId, totalFromMonday: items.length, willCreate: 0, willUpdate: 0,
    skippedNoEmail: 0, skippedConflict: 0, decisions: [], applied: !opts.dryRun, errors: [],
  };

  for (const item of items) {
    try {
      const email = normalizeEmail(getCol(item, COL.email));
      if (!email) {
        result.skippedNoEmail++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, email: null, action: "skip-no-email", reason: "No valid email on Monday row" });
        continue;
      }

      const { firstName, lastName } = splitName(item.name);
      const status = mapStatus(getCol(item, COL.status));
      const phone = getCol(item, COL.phone);
      const address = getCol(item, COL.address);
      const dob = isoDate(getCol(item, COL.dob));
      const ecName = getCol(item, COL.ecName);
      const ecPhone = getCol(item, COL.ecPhone);
      const ecRel = getCol(item, COL.ecRel);
      const routing = getCol(item, COL.routing);
      const acct = getCol(item, COL.acct);
      const licType = getCol(item, COL.licType);
      const licNumber = getCol(item, COL.licNumber);
      const licExpiry = isoDate(getCol(item, COL.licExpiry));
      const uniform = getCol(item, COL.uniform);
      const licLevel = mapLicenseLevel(licType);

      const userIncoming: Record<string, unknown> = { email, firstName, lastName, status, role: "employee" };
      const empIncoming: Record<string, unknown> = {
        phone, address, dateOfBirth: dob,
        emergencyContactName: ecName, emergencyContactPhone: ecPhone, emergencyContactRelationship: ecRel,
        bankBsb: routing, bankAccountNumber: acct,
        siaLicenseNumber: licNumber, siaLicenseLevel: licLevel, siaLicenseExpiry: licExpiry,
        uniformShirt: uniform,
      };

      const [existing] = await db.select().from(usersTable).where(eq(sql`lower(${usersTable.email})`, email)).limit(1);

      if (!existing) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries({ ...userIncoming, ...empIncoming })) {
          if (v !== null && v !== undefined && v !== "") changes[k] = { from: null, to: v };
        }
        result.willCreate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, email, action: "create", changes });
        if (!opts.dryRun) {
          const passwordHash = await bcrypt.hash(randomUUID(), 10);
          const [newUser] = await db.insert(usersTable).values({
            email, firstName, lastName: lastName || "—", role: "employee", status,
            passwordHash, mustChangePassword: true,
          }).returning();
          await db.insert(employeesTable).values({
            userId: newUser!.id,
            phone: phone || null, address: address || null,
            dateOfBirth: dob || null,
            emergencyContactName: ecName || null,
            emergencyContactPhone: ecPhone || null,
            emergencyContactRelationship: ecRel || null,
            bankBsb: routing || null, bankAccountNumber: acct || null,
            siaLicenseNumber: licNumber || null, siaLicenseLevel: licLevel,
            siaLicenseExpiry: licExpiry || null,
            uniformShirt: uniform || null,
          });
          if (licNumber && licExpiry && licLevel) {
            await db.insert(licensesTable).values({
              employeeId: newUser!.id, type: licType || "TX Guard",
              level: licLevel, licenseNumber: licNumber,
              issuingAuthority: "TX DPS", expiryDate: licExpiry,
            });
          }
        }
      } else {
        if (existing.role !== "employee") {
          result.skippedConflict++;
          result.decisions.push({ mondayId: item.id, mondayName: item.name, email, action: "skip-conflict", reason: `Existing user has role '${existing.role}' — sync only touches employees` });
          continue;
        }
        const userChanges = diff(existing as unknown as Record<string, unknown>, userIncoming);
        delete userChanges.role;
        const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, existing.id)).limit(1);
        const empChanges = emp ? diff(emp as unknown as Record<string, unknown>, empIncoming) : Object.fromEntries(
          Object.entries(empIncoming).filter(([_, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [k, { from: null, to: v }]),
        );
        const allChanges = { ...userChanges, ...empChanges };
        if (Object.keys(allChanges).length === 0) continue;
        result.willUpdate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, email, action: "update", changes: allChanges });
        if (!opts.dryRun) {
          if (Object.keys(userChanges).length) {
            await db.update(usersTable).set(
              Object.fromEntries(Object.entries(userChanges).map(([k, v]) => [k, v.to])),
            ).where(eq(usersTable.id, existing.id));
          }
          const empPatch = Object.fromEntries(Object.entries(empChanges).map(([k, v]) => [k, v.to]));
          if (emp) {
            if (Object.keys(empPatch).length) await db.update(employeesTable).set(empPatch).where(eq(employeesTable.id, emp.id));
          } else {
            await db.insert(employeesTable).values({ userId: existing.id, ...(empPatch as object) });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ mondayId: item.id, err: msg }, "monday sync row failed");
      result.errors.push({ mondayId: item.id, mondayName: item.name, error: msg });
    }
  }

  return result;
}
