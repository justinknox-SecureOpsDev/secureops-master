/**
 * Licence-level helpers shared by every invoice surface (admin invoice board,
 * the send-review dialogs and the client portal). The server mirrors these
 * labels in `invoicePdf.ts` so the PDF a client receives reads the same as the
 * board the invoice was approved from — update both together.
 */

const LEVEL_LABELS: Record<number, string> = {
  1: "Support Staff",
  2: "Unarmed",
  3: "Armed",
  4: "L4/PPO",
};

/** Human label for a line item's licence level. Unknown levels render "L<n>". */
export const levelLabel = (level: number | null | undefined): string =>
  level == null ? "Unspecified" : LEVEL_LABELS[level] ?? `L${level}`;

/** Minimal shape needed to roll hours up — matches every page's LineItem type. */
export type LevelledLineItem = {
  level?: number | null;
  hours?: number | null;
  amount: number;
};

export type LevelTotal = { level: number | null; hours: number; amount: number };

/**
 * Total hours and billed amount per licence level.
 *
 * Line items are grouped per officer (and rate, and holiday premium), so a
 * single invoice normally carries several rows at the same level. This collapses
 * them so an invoice can be read as "how many armed vs unarmed hours did we
 * bill". Sorted by level ascending, with unspecified-level rows last.
 */
export function hoursByLevel(
  items: readonly LevelledLineItem[] | null | undefined,
): LevelTotal[] {
  const acc = new Map<number | null, LevelTotal>();
  for (const li of items ?? []) {
    const key = li.level ?? null;
    const cur = acc.get(key) ?? { level: key, hours: 0, amount: 0 };
    cur.hours += li.hours ?? 0;
    cur.amount += li.amount ?? 0;
    acc.set(key, cur);
  }
  return Array.from(acc.values()).sort(
    (a, b) => (a.level ?? Number.MAX_SAFE_INTEGER) - (b.level ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Sum of hours across all levels. */
export const totalHours = (levels: readonly LevelTotal[]): number =>
  levels.reduce((s, lv) => s + lv.hours, 0);
