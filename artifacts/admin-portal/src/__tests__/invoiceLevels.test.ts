/**
 * Licence-level rollup shown on every invoice surface.
 *
 * Invoice line items are grouped per officer (and rate, and holiday premium),
 * so "how many armed vs unarmed hours are on this invoice" is only answerable
 * by rolling the rows up. That rollup renders in three places in this app
 * (invoice board, send-review dialog, client portal) and a fourth on the server
 * (the invoice PDF the client actually receives).
 *
 * The labels are duplicated across the client/server boundary by necessity —
 * the PDF is generated in api-server and cannot import from admin-portal — so
 * the last test here fails loudly if the two copies drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hoursByLevel, levelLabel, totalHours } from "../lib/invoiceLevels";

describe("levelLabel", () => {
  it("names each known licence level", () => {
    expect(levelLabel(1)).toBe("Support Staff");
    expect(levelLabel(2)).toBe("Unarmed");
    expect(levelLabel(3)).toBe("Armed");
    expect(levelLabel(4)).toBe("L4/PPO");
  });

  it("falls back to L<n> for an unrecognised level rather than rendering blank", () => {
    expect(levelLabel(9)).toBe("L9");
  });

  it("labels a missing level rather than dropping the row", () => {
    expect(levelLabel(null)).toBe("Unspecified");
    expect(levelLabel(undefined)).toBe("Unspecified");
  });
});

describe("hoursByLevel", () => {
  it("sums hours and amount across the several rows that share a level", () => {
    const rows = hoursByLevel([
      { level: 3, hours: 8, amount: 240 },
      { level: 3, hours: 4.5, amount: 135 },
      { level: 2, hours: 12, amount: 300 },
    ]);
    expect(rows).toEqual([
      { level: 2, hours: 12, amount: 300 },
      { level: 3, hours: 12.5, amount: 375 },
    ]);
  });

  it("sorts by level ascending and puts unspecified last", () => {
    const rows = hoursByLevel([
      { level: null, hours: 1, amount: 10 },
      { level: 3, hours: 1, amount: 10 },
      { level: 1, hours: 1, amount: 10 },
      { level: 2, hours: 1, amount: 10 },
    ]);
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, null]);
  });

  it("groups missing and null levels together", () => {
    const rows = hoursByLevel([
      { level: null, hours: 2, amount: 20 },
      { hours: 3, amount: 30 },
    ]);
    expect(rows).toEqual([{ level: null, hours: 5, amount: 50 }]);
  });

  it("treats a missing hours value as zero instead of NaN", () => {
    // An unpriced/hours-less line item must not poison the whole rollup.
    const rows = hoursByLevel([
      { level: 2, hours: null, amount: 0 },
      { level: 2, hours: 6, amount: 150 },
    ]);
    expect(rows[0].hours).toBe(6);
    expect(Number.isNaN(rows[0].hours)).toBe(false);
  });

  it("returns nothing for an invoice with no line items", () => {
    expect(hoursByLevel([])).toEqual([]);
    expect(hoursByLevel(null)).toEqual([]);
    expect(hoursByLevel(undefined)).toEqual([]);
  });
});

describe("totalHours", () => {
  it("adds every level's hours together", () => {
    const rows = hoursByLevel([
      { level: 2, hours: 8, amount: 200 },
      { level: 3, hours: 10, amount: 300 },
      { level: null, hours: 1.25, amount: 0 },
    ]);
    expect(totalHours(rows)).toBe(19.25);
  });

  it("is zero for an empty invoice", () => {
    expect(totalHours([])).toBe(0);
  });
});

describe("client/server label parity", () => {
  it("uses the same licence-level names as the invoice PDF", () => {
    // The PDF is built in api-server and cannot import this module, so the map
    // is duplicated there. If someone renames a level on one side only, the
    // board and the client's PDF disagree — catch that here.
    const here = dirname(fileURLToPath(import.meta.url));
    const pdfSource = readFileSync(
      resolve(here, "../../../api-server/src/lib/invoicePdf.ts"),
      "utf8",
    );

    const block = pdfSource.match(
      /const LEVEL_LABELS: Record<number, string> = \{([\s\S]*?)\}/,
    );
    expect(block, "LEVEL_LABELS not found in invoicePdf.ts").toBeTruthy();

    const serverLabels: Record<string, string> = {};
    for (const m of block![1].matchAll(/(\d+)\s*:\s*"([^"]+)"/g)) {
      serverLabels[m[1]] = m[2];
    }
    expect(Object.keys(serverLabels).length).toBeGreaterThan(0);

    for (const [level, label] of Object.entries(serverLabels)) {
      expect(levelLabel(Number(level)), `level ${level} label drifted`).toBe(label);
    }
  });
});
