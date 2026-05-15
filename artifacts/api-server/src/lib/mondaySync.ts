import {
  db, usersTable, employeesTable, licensesTable,
  clientsTable, sitesTable, applicationsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

// ---------- shared types & helpers ----------

export type SyncKind = "employees" | "clients" | "sites" | "onboarding" | "candidates";

export const DEFAULT_BOARD_IDS: Record<SyncKind, string> = {
  employees: "18408899656",
  clients: "18408899653",
  sites: "18408899655",
  onboarding: "18399600913",
  candidates: "18399600911",
};

export type SyncDecision = {
  mondayId: string;
  mondayName: string;
  matchKey: string | null;
  action: "create" | "update" | "skip-no-key" | "skip-conflict" | "skip-unmatched";
  reason?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
};

export type SyncResult = {
  kind: SyncKind;
  boardId: string;
  totalFromMonday: number;
  willCreate: number;
  willUpdate: number;
  skippedNoKey: number;
  skippedConflict: number;
  skippedUnmatched: number;
  decisions: SyncDecision[];
  applied: boolean;
  errors: { mondayId: string; mondayName: string; error: string }[];
};

type MondayItem = {
  id: string;
  name: string;
  column_values: { id: string; text: string | null; value: string | null; type: string }[];
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
    const data = (await res.json()) as { data?: any; errors?: any };
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
  return item.column_values.find((c) => c.id === id)?.text?.trim() || null;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function normEmail(e: string | null): string | null {
  if (!e) return null;
  const t = e.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

function isoDate(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function mapStatus(monday: string | null): "active" | "inactive" | "pending" | null {
  if (!monday) return null;
  const s = monday.toLowerCase();
  if (s.includes("active")) return "active";
  if (s.includes("terminat") || s.includes("inactive")) return "inactive";
  return "pending";
}

function mapStatusOrDefault(monday: string | null): "active" | "inactive" | "pending" {
  return mapStatus(monday) ?? "pending";
}

function mapLicLevel(s: string | null): number | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("ppo") || t.includes("4")) return 4;
  if (t.includes("armed") || t.includes("3")) return 3;
  if (t.includes("unarmed") || t.includes("2")) return 2;
  return null;
}

function parseTermsDays(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function diff(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined || v === "") continue;
    const cur = existing[k];
    if (String(cur ?? "") !== String(v)) out[k] = { from: cur ?? null, to: v };
  }
  return out;
}

function newResult(kind: SyncKind, boardId: string, applied: boolean): SyncResult {
  return {
    kind, boardId, totalFromMonday: 0, willCreate: 0, willUpdate: 0,
    skippedNoKey: 0, skippedConflict: 0, skippedUnmatched: 0,
    decisions: [], applied, errors: [],
  };
}

// ---------- EMPLOYEES (Employee Database Master) ----------

const EMP_COL = {
  email: "email_mm04q6zj", phone: "phone_mm04yt", status: "color_mm04zr6v",
  address: "text_mm0hg184", dob: "date_mm04hmz2",
  ecName: "text_mm04tq8m", ecPhone: "phone_mm0432aw", ecRel: "dropdown_mm04eb6y",
  routing: "text_mm0h3x52", acct: "text_mm0hhzs9",
  licType: "color_mm0mhf8y", licNumber: "text_mm04zjsc", licExpiry: "date_mm041634",
  uniform: "text_mm04kj3w",
};

async function syncEmployees(items: MondayItem[], result: SyncResult, dryRun: boolean): Promise<void> {
  for (const item of items) {
    try {
      const email = normEmail(getCol(item, EMP_COL.email));
      if (!email) {
        result.skippedNoKey++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: null, action: "skip-no-key", reason: "No valid email" });
        continue;
      }
      const { firstName, lastName } = splitName(item.name);
      const statusRaw = getCol(item, EMP_COL.status);
      const status = mapStatus(statusRaw);
      const licNumber = getCol(item, EMP_COL.licNumber);
      const licExpiry = isoDate(getCol(item, EMP_COL.licExpiry));
      const licType = getCol(item, EMP_COL.licType);
      const licLevel = mapLicLevel(licType);

      const userIn: Record<string, unknown> = { email, firstName, lastName: lastName || "—", status, role: "employee" };
      const empIn: Record<string, unknown> = {
        phone: getCol(item, EMP_COL.phone),
        address: getCol(item, EMP_COL.address),
        dateOfBirth: isoDate(getCol(item, EMP_COL.dob)),
        emergencyContactName: getCol(item, EMP_COL.ecName),
        emergencyContactPhone: getCol(item, EMP_COL.ecPhone),
        emergencyContactRelationship: getCol(item, EMP_COL.ecRel),
        bankBsb: getCol(item, EMP_COL.routing),
        bankAccountNumber: getCol(item, EMP_COL.acct),
        siaLicenseNumber: licNumber,
        siaLicenseLevel: licLevel,
        siaLicenseExpiry: licExpiry,
        uniformShirt: getCol(item, EMP_COL.uniform),
      };

      const [existing] = await db.select().from(usersTable).where(eq(sql`lower(${usersTable.email})`, email)).limit(1);
      if (!existing) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries({ ...userIn, ...empIn })) if (v !== null && v !== undefined && v !== "") changes[k] = { from: null, to: v };
        result.willCreate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "create", changes });
        if (!dryRun) {
          const passwordHash = await bcrypt.hash(randomUUID(), 10);
          await db.transaction(async (tx) => {
            const [u] = await tx.insert(usersTable).values({
              email, firstName, lastName: lastName || "—", role: "employee",
              status: status ?? "pending",
              passwordHash, mustChangePassword: true,
            }).returning();
            await tx.insert(employeesTable).values({ userId: u!.id, ...(empIn as object) });
            if (licNumber && licExpiry && licLevel) {
              await tx.insert(licensesTable).values({
                employeeId: u!.id, type: licType || "TX Guard", level: licLevel,
                licenseNumber: licNumber, issuingAuthority: "TX DPS", expiryDate: licExpiry,
              });
            }
          });
        }
      } else {
        if (existing.role !== "employee") {
          result.skippedConflict++;
          result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "skip-conflict", reason: `existing role '${existing.role}'` });
          continue;
        }
        const userChanges = diff(existing as unknown as Record<string, unknown>, userIn);
        delete userChanges.role;
        const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, existing.id)).limit(1);
        const empChanges = emp ? diff(emp as unknown as Record<string, unknown>, empIn) : Object.fromEntries(
          Object.entries(empIn).filter(([_, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [k, { from: null, to: v }]),
        );
        const all = { ...userChanges, ...empChanges };
        if (!Object.keys(all).length) continue;
        result.willUpdate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "update", changes: all });
        if (!dryRun) {
          await db.transaction(async (tx) => {
            if (Object.keys(userChanges).length) {
              await tx.update(usersTable).set(Object.fromEntries(Object.entries(userChanges).map(([k, v]) => [k, v.to]))).where(eq(usersTable.id, existing.id));
            }
            const empPatch = Object.fromEntries(Object.entries(empChanges).map(([k, v]) => [k, v.to]));
            if (emp) {
              if (Object.keys(empPatch).length) await tx.update(employeesTable).set(empPatch).where(eq(employeesTable.id, emp.id));
            } else {
              await tx.insert(employeesTable).values({ userId: existing.id, ...(empPatch as object) });
            }
          });
        }
      }
    } catch (e) {
      result.errors.push({ mondayId: item.id, mondayName: item.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---------- CLIENTS ----------

const CLIENT_COL = {
  email: "email_mm0gb1md",
  phone: "phone_mm0gk41s",
  address: "location_mm0gscng",
  terms: "dropdown_mm0gaehf",
};

async function syncClients(items: MondayItem[], result: SyncResult, dryRun: boolean): Promise<void> {
  for (const item of items) {
    try {
      const name = item.name.trim();
      if (!name) {
        result.skippedNoKey++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: null, action: "skip-no-key", reason: "Empty name" });
        continue;
      }
      const incoming: Record<string, unknown> = {
        name,
        contactEmail: normEmail(getCol(item, CLIENT_COL.email)),
        contactPhone: getCol(item, CLIENT_COL.phone),
        billingAddress: getCol(item, CLIENT_COL.address),
        paymentTermsDays: parseTermsDays(getCol(item, CLIENT_COL.terms)),
      };
      const [existing] = await db.select().from(clientsTable).where(eq(sql`lower(${clientsTable.name})`, name.toLowerCase())).limit(1);
      if (!existing) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries(incoming)) if (v !== null && v !== undefined && v !== "") changes[k] = { from: null, to: v };
        result.willCreate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: name, action: "create", changes });
        if (!dryRun) {
          await db.insert(clientsTable).values({
            name,
            contactEmail: (incoming.contactEmail as string) ?? null,
            contactPhone: (incoming.contactPhone as string) ?? null,
            billingAddress: (incoming.billingAddress as string) ?? null,
            paymentTermsDays: (incoming.paymentTermsDays as number) ?? 30,
          });
        }
      } else {
        const changes = diff(existing as unknown as Record<string, unknown>, incoming);
        if (!Object.keys(changes).length) continue;
        result.willUpdate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: name, action: "update", changes });
        if (!dryRun) {
          await db.update(clientsTable).set(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]))).where(eq(clientsTable.id, existing.id));
        }
      }
    } catch (e) {
      result.errors.push({ mondayId: item.id, mondayName: item.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---------- SITES ----------

const SITE_COL = {
  address: "location_mm0g13d2",
  client: "board_relation_mm0grzg8",
  notes: "long_text_mm0gb2hw",
};

async function syncSites(items: MondayItem[], result: SyncResult, dryRun: boolean): Promise<void> {
  for (const item of items) {
    try {
      const name = item.name.trim();
      if (!name) {
        result.skippedNoKey++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: null, action: "skip-no-key", reason: "Empty name" });
        continue;
      }
      const clientName = getCol(item, SITE_COL.client)?.split(",")[0]?.trim() || null;
      if (!clientName) {
        result.skippedUnmatched++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: name, action: "skip-unmatched", reason: "No Client linked on Monday row" });
        continue;
      }
      const [client] = await db.select().from(clientsTable).where(eq(sql`lower(${clientsTable.name})`, clientName.toLowerCase())).limit(1);
      if (!client) {
        result.skippedUnmatched++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: name, action: "skip-unmatched", reason: `Client "${clientName}" not in WCSG. Sync Clients first.` });
        continue;
      }
      const incoming: Record<string, unknown> = {
        name,
        clientId: client.id,
        address: getCol(item, SITE_COL.address),
        notes: getCol(item, SITE_COL.notes),
      };
      const [existing] = await db.select().from(sitesTable).where(
        sql`lower(${sitesTable.name}) = ${name.toLowerCase()} AND ${sitesTable.clientId} = ${client.id}`,
      ).limit(1);
      if (!existing) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries(incoming)) if (v !== null && v !== undefined && v !== "") changes[k] = { from: null, to: v };
        result.willCreate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: `${clientName} / ${name}`, action: "create", changes });
        if (!dryRun) {
          await db.insert(sitesTable).values({
            name, clientId: client.id,
            address: (incoming.address as string) ?? null,
            notes: (incoming.notes as string) ?? null,
          });
        }
      } else {
        const changes = diff(existing as unknown as Record<string, unknown>, incoming);
        delete changes.clientId;
        if (!Object.keys(changes).length) continue;
        result.willUpdate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: `${clientName} / ${name}`, action: "update", changes });
        if (!dryRun) {
          await db.update(sitesTable).set(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]))).where(eq(sitesTable.id, existing.id));
        }
      }
    } catch (e) {
      result.errors.push({ mondayId: item.id, mondayName: item.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---------- ONBOARDING (matches existing employees by email, fills detail) ----------

const ONB_COL = {
  email: "email_mkxta7x9", phone: "phone_mkxta3js", status: "color_mm2a27fr",
  address: "text_mm2az7xw", dob: "date_mm2ackx", ssn: "text_mm2anxch",
  ecName: "text_mm2afe5x", ecPhone: "phone_mm2ays6r", ecRel: "color_mm2a8dqv",
  routing: "text_mm2abym6", acct: "text_mm2avgtw",
  licNumber: "text_mm2ambyt", licExpiry: "date_mm2a7bjd", licLevel: "dropdown_mm2anm9n",
  uniform: "text_mm2asp6", cityState: "text_mm2acr95",
};

async function syncOnboarding(items: MondayItem[], result: SyncResult, dryRun: boolean): Promise<void> {
  for (const item of items) {
    try {
      const email = normEmail(getCol(item, ONB_COL.email));
      if (!email) {
        result.skippedNoKey++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: null, action: "skip-no-key", reason: "No valid email on onboarding row" });
        continue;
      }
      const cityState = getCol(item, ONB_COL.cityState);
      const [city, state] = cityState ? cityState.split(",").map((s) => s.trim()) : [null, null];

      const onbStatusRaw = getCol(item, ONB_COL.status);
      const { firstName, lastName } = splitName(item.name);
      const licNumber = getCol(item, ONB_COL.licNumber);
      const licExpiry = isoDate(getCol(item, ONB_COL.licExpiry));
      const licLevel = mapLicLevel(getCol(item, ONB_COL.licLevel));

      const userIn: Record<string, unknown> = onbStatusRaw ? { status: mapStatusOrDefault(onbStatusRaw) } : {};
      const empIn: Record<string, unknown> = {
        phone: getCol(item, ONB_COL.phone),
        address: getCol(item, ONB_COL.address),
        dateOfBirth: isoDate(getCol(item, ONB_COL.dob)),
        cityOfBirth: city || null,
        stateOfBirth: state || null,
        niNumber: getCol(item, ONB_COL.ssn),
        emergencyContactName: getCol(item, ONB_COL.ecName),
        emergencyContactPhone: getCol(item, ONB_COL.ecPhone),
        emergencyContactRelationship: getCol(item, ONB_COL.ecRel),
        bankBsb: getCol(item, ONB_COL.routing),
        bankAccountNumber: getCol(item, ONB_COL.acct),
        siaLicenseNumber: licNumber,
        siaLicenseExpiry: licExpiry,
        siaLicenseLevel: licLevel,
        uniformShirt: getCol(item, ONB_COL.uniform),
      };

      const [user] = await db.select().from(usersTable).where(eq(sql`lower(${usersTable.email})`, email)).limit(1);

      if (!user) {
        // No existing employee — onboarding-in-progress people from old process.
        // Create the account so they show up; default status="pending" until onboarding finishes.
        const newUserStatus = (userIn.status as string | undefined) ?? "pending";
        const changes: Record<string, { from: unknown; to: unknown }> = {
          email: { from: null, to: email },
          firstName: { from: null, to: firstName },
          lastName: { from: null, to: lastName || "—" },
          status: { from: null, to: newUserStatus },
        };
        for (const [k, v] of Object.entries(empIn)) if (v !== null && v !== undefined && v !== "") changes[k] = { from: null, to: v };
        result.willCreate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "create", changes });
        if (!dryRun) {
          const passwordHash = await bcrypt.hash(randomUUID(), 10);
          await db.transaction(async (tx) => {
            const [u] = await tx.insert(usersTable).values({
              email, firstName, lastName: lastName || "—", role: "employee", status: newUserStatus,
              passwordHash, mustChangePassword: true,
            }).returning();
            await tx.insert(employeesTable).values({ userId: u!.id, ...(empIn as object) });
            if (licNumber && licExpiry && licLevel) {
              await tx.insert(licensesTable).values({
                employeeId: u!.id, type: "TX Guard", level: licLevel,
                licenseNumber: licNumber, issuingAuthority: "TX DPS", expiryDate: licExpiry,
              });
            }
          });
        }
        continue;
      }

      if (user.role !== "employee") {
        result.skippedConflict++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "skip-conflict", reason: `existing role '${user.role}'` });
        continue;
      }

      const userChanges = diff(user as unknown as Record<string, unknown>, userIn);
      const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, user.id)).limit(1);
      const empChanges = emp ? diff(emp as unknown as Record<string, unknown>, empIn) : Object.fromEntries(
        Object.entries(empIn).filter(([_, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [k, { from: null, to: v }]),
      );
      const all = { ...userChanges, ...empChanges };
      if (!Object.keys(all).length) continue;
      result.willUpdate++;
      result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "update", changes: all });
      if (!dryRun) {
        await db.transaction(async (tx) => {
          if (Object.keys(userChanges).length) {
            await tx.update(usersTable).set(Object.fromEntries(Object.entries(userChanges).map(([k, v]) => [k, v.to]))).where(eq(usersTable.id, user.id));
          }
          const empPatch = Object.fromEntries(Object.entries(empChanges).map(([k, v]) => [k, v.to]));
          if (emp) {
            if (Object.keys(empPatch).length) await tx.update(employeesTable).set(empPatch).where(eq(employeesTable.id, emp.id));
          } else {
            await tx.insert(employeesTable).values({ userId: user.id, ...(empPatch as object) });
          }
        });
      }
    } catch (e) {
      result.errors.push({ mondayId: item.id, mondayName: item.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---------- CANDIDATES → applications ----------

const CAND_COL = {
  email: "email_mkxta7x9", phone: "phone_mkxta3js", address: "location5voafouq",
  dob: "date_mm0gjjrb", ssn: "text_mm0g2887",
  licNumber: "short_text1uui8dl4", licExpiry: "datefuv4pwpe", licLevel: "multi_selecta5hdgsbl",
  notes: "long_text_mkxtx2m",
};

function mapAppStatus(s: string | null): "submitted" | "under_review" | "approved" | "rejected" | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("hire") || t.includes("approve") || t.includes("offer")) return "approved";
  if (t.includes("reject") || t.includes("declin") || t.includes("disqual")) return "rejected";
  if (t.includes("interview") || t.includes("screen") || t.includes("review")) return "under_review";
  return "submitted";
}

async function syncCandidates(items: MondayItem[], result: SyncResult, dryRun: boolean): Promise<void> {
  for (const item of items) {
    try {
      const email = normEmail(getCol(item, CAND_COL.email));
      const phone = getCol(item, CAND_COL.phone);
      const address = getCol(item, CAND_COL.address);
      if (!email) {
        result.skippedNoKey++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: null, action: "skip-no-key", reason: "No valid email" });
        continue;
      }
      if (!phone || !address) {
        result.skippedNoKey++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "skip-no-key", reason: "Missing required phone or address (applications require both)" });
        continue;
      }
      const { firstName, lastName } = splitName(item.name);
      const incoming: Record<string, unknown> = {
        firstName, lastName: lastName || "—", email, phone, address,
        dateOfBirth: isoDate(getCol(item, CAND_COL.dob)),
        niNumber: getCol(item, CAND_COL.ssn),
        siaLicenseNumber: getCol(item, CAND_COL.licNumber),
        siaLicenseExpiry: isoDate(getCol(item, CAND_COL.licExpiry)),
        siaLicenseLevel: mapLicLevel(getCol(item, CAND_COL.licLevel)),
        previousExperience: getCol(item, CAND_COL.notes),
        status: mapAppStatus(item.column_values.find((c) => c.id === "status")?.text ?? null),
      };
      if (incoming.status === null) delete incoming.status;

      const [existing] = await db.select().from(applicationsTable).where(eq(sql`lower(${applicationsTable.email})`, email)).limit(1);
      if (!existing) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries(incoming)) if (v !== null && v !== undefined && v !== "") changes[k] = { from: null, to: v };
        result.willCreate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "create", changes });
        if (!dryRun) {
          await db.insert(applicationsTable).values({
            firstName, lastName: lastName || "—", email, phone, address,
            dateOfBirth: (incoming.dateOfBirth as string) ?? null,
            niNumber: (incoming.niNumber as string) ?? null,
            siaLicenseNumber: (incoming.siaLicenseNumber as string) ?? null,
            siaLicenseExpiry: (incoming.siaLicenseExpiry as string) ?? null,
            siaLicenseLevel: (incoming.siaLicenseLevel as number) ?? null,
            previousExperience: (incoming.previousExperience as string) ?? null,
            status: (incoming.status as string) ?? "submitted",
          });
        }
      } else {
        const changes = diff(existing as unknown as Record<string, unknown>, incoming);
        if (!Object.keys(changes).length) continue;
        result.willUpdate++;
        result.decisions.push({ mondayId: item.id, mondayName: item.name, matchKey: email, action: "update", changes });
        if (!dryRun) {
          await db.update(applicationsTable).set(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]))).where(eq(applicationsTable.id, existing.id));
        }
      }
    } catch (e) {
      result.errors.push({ mondayId: item.id, mondayName: item.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---------- main entry ----------

export async function syncFromMonday(opts: { kind: SyncKind; boardId?: string; dryRun: boolean }): Promise<SyncResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not configured");
  const boardId = opts.boardId || DEFAULT_BOARD_IDS[opts.kind];
  if (!boardId) throw new Error("boardId is required");

  logger.info({ kind: opts.kind, boardId, dryRun: opts.dryRun }, "monday sync start");
  const items = await fetchAllItems(boardId, token);
  const result = newResult(opts.kind, boardId, !opts.dryRun);
  result.totalFromMonday = items.length;

  switch (opts.kind) {
    case "employees":  await syncEmployees(items, result, opts.dryRun); break;
    case "clients":    await syncClients(items, result, opts.dryRun); break;
    case "sites":      await syncSites(items, result, opts.dryRun); break;
    case "onboarding": await syncOnboarding(items, result, opts.dryRun); break;
    case "candidates": await syncCandidates(items, result, opts.dryRun); break;
  }

  const { decisions: _d, ...summary } = result;
  logger.info(summary, "monday sync done");
  return result;
}
