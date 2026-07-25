import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Regression coverage for the two admin Weekly Time Card bugs:
 *
 *   1) The week controls (◀ / ▶ / jump-to-current) must actually change the
 *      displayed week. They are `disabled={!card}`, so they only work once a
 *      card is loaded — the real-world failure was that admins couldn't get a
 *      card to load (bug #2), which left the arrows permanently dead.
 *   2) With a site filter active, admins must still be able to select ANY staff
 *      officer — including one with zero entries at that site — so they can
 *      create a missing time card. Previously the dropdown only listed officers
 *      who already had entries there (an INNER JOIN), so a zero-entry officer
 *      was unreachable and no card could ever load.
 *
 * This mounts the real TimeCardPage against a memory-location router (so wouter
 * query navigation is exercised for real) with `@/lib/api` and `@/lib/auth`
 * stubbed. The time-card endpoint returns a full card object for any week —
 * including empty weeks — mirroring the server, which is what makes a card (and
 * therefore the week arrows) available for any selectable officer.
 */

const TEST_TIMEOUT_MS = 20000;

const hoisted = vi.hoisted(() => ({
  users: [] as Array<{ id: string; firstName: string | null; lastName: string | null; email: string; role: string }>,
  sites: [] as Array<{ id: string; name: string }>,
  siteOfficers: [] as Array<{ id: string; firstName: string | null; lastName: string | null; email: string }>,
  cardCalls: [] as string[],
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "admin1", role: "admin" } }),
}));

vi.mock("@/lib/api", () => {
  // Central-week chain the server would return; weekStart "" == current week.
  const WEEKS: Record<string, { weekStart: string; weekEnd: string; prevWeekStart: string; nextWeekStart: string }> = {
    "2026-07-13": { weekStart: "2026-07-13", weekEnd: "2026-07-19", prevWeekStart: "2026-07-06", nextWeekStart: "2026-07-20" },
    "2026-07-20": { weekStart: "2026-07-20", weekEnd: "2026-07-26", prevWeekStart: "2026-07-13", nextWeekStart: "2026-07-27" },
    "2026-07-27": { weekStart: "2026-07-27", weekEnd: "2026-08-02", prevWeekStart: "2026-07-20", nextWeekStart: "2026-08-03" },
  };
  const cardFor = (ws: string) => {
    const w = WEEKS[ws] ?? WEEKS["2026-07-20"];
    return {
      employeeId: "E",
      employeeName: "Erin Officer",
      timezone: "America/Chicago",
      ...w,
      days: [],
      totalHours: 0,
      approvedHours: 0,
      pendingHours: 0,
    };
  };
  return {
    api: vi.fn(async (path: string) => {
      const url = new URL(path, "http://test.local");
      const p = url.pathname;
      if (p === "/admin/tables/users") return { rows: hoisted.users };
      if (p === "/admin/tables/sites") return { rows: hoisted.sites };
      if (p === "/time-entries/time-card/site-officers") return { officers: hoisted.siteOfficers };
      if (p === "/time-entries/time-card") {
        hoisted.cardCalls.push(url.searchParams.get("weekStart") ?? "");
        return cardFor(url.searchParams.get("weekStart") ?? "");
      }
      throw new Error("unexpected api path: " + path);
    }),
    fetchWithAuth: vi.fn(),
    getToken: () => null,
  };
});

// Imported after the mocks above so the mocked modules are picked up.
import TimeCardPage from "@/pages/TimeCard";

function renderPage(searchPath: string) {
  const { hook, searchHook } = memoryLocation({
    path: "/payroll/time-card",
    searchPath,
    record: true,
  });
  return render(
    <Router hook={hook} searchHook={searchHook}>
      <TimeCardPage />
    </Router>,
  );
}

function optionGroup(select: HTMLSelectElement, value: string): string | null {
  const opt = Array.from(select.options).find((o) => o.value === value);
  if (!opt) return null;
  const parent = opt.parentElement as HTMLElement;
  return parent.tagName === "OPTGROUP" ? (parent as HTMLOptGroupElement).label : null;
}

describe("Weekly Time Card — week navigation", () => {
  beforeEach(() => {
    hoisted.users = [{ id: "E", firstName: "Erin", lastName: "Officer", email: "erin@x.com", role: "employee" }];
    hoisted.sites = [{ id: "S", name: "Downtown Tower" }];
    hoisted.siteOfficers = [];
    hoisted.cardCalls = [];
    vi.clearAllMocks();
  });

  it("prev / next / jump-to-current each change the displayed week", async () => {
    renderPage("employeeId=E");

    // Current week card loads and its range is shown.
    await waitFor(() => expect(screen.getByText("Jul 20 – Jul 26, 2026")).toBeTruthy());

    // ▶ advances a week (and refetches that week's card).
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByText("Jul 27 – Aug 2, 2026")).toBeTruthy());
    expect(hoisted.cardCalls).toContain("2026-07-27");

    // ◀ goes back a week.
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(screen.getByText("Jul 20 – Jul 26, 2026")).toBeTruthy());

    // Step back once more, then the label button jumps to the current week.
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(screen.getByText("Jul 13 – Jul 19, 2026")).toBeTruthy());
    expect(hoisted.cardCalls).toContain("2026-07-13");

    fireEvent.click(screen.getByRole("button", { name: /Jump to the current week/ }));
    await waitFor(() => expect(screen.getByText("Jul 20 – Jul 26, 2026")).toBeTruthy());
    // Jump clears the weekStart param -> last card fetch had no weekStart.
    expect(hoisted.cardCalls[hoisted.cardCalls.length - 1]).toBe("");
  }, TEST_TIMEOUT_MS);

  it("lets an admin pick ANY officer under a site filter, unblocking the week arrows", async () => {
    hoisted.users = [
      { id: "A", firstName: "Aaron", lastName: "Active", email: "aaron@x.com", role: "employee" },
      { id: "B", firstName: "Beth", lastName: "Bench", email: "beth@x.com", role: "employee" },
    ];
    // Only Aaron has entries at the site; Beth has none.
    hoisted.siteOfficers = [{ id: "A", firstName: "Aaron", lastName: "Active", email: "aaron@x.com" }];

    renderPage("siteId=S");

    const select = (await screen.findByLabelText("Select employee")) as HTMLSelectElement;

    // Once site-officers load, Aaron is grouped under "Worked at this site" and
    // Beth (zero entries) is still selectable under "All officers".
    await waitFor(() => {
      expect(optionGroup(select, "A")).toBe("Worked at this site");
      expect(optionGroup(select, "B")).toBe("All officers");
    });

    // Selecting the zero-entry officer loads her card, which enables the arrows.
    fireEvent.change(select, { target: { value: "B" } });
    await waitFor(() => {
      const next = screen.getByRole("button", { name: "Next week" }) as HTMLButtonElement;
      expect(next.disabled).toBe(false);
    });
  }, TEST_TIMEOUT_MS);
});
