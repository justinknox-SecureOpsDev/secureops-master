/**
 * Keeps the assistant's how-to knowledge base honest about this portal.
 *
 * The knowledge base (artifacts/api-server/src/lib/assistant/knowledgeBase.ts)
 * is hand-written prose that names portal pages — "Accounting > Pay Run",
 * "/hr/invitations". Nothing at runtime checks those against the real nav, so a
 * renamed, moved or deleted page leaves the assistant confidently walking
 * somebody through a screen that is not there any more. A wrong walkthrough is
 * worse than no answer, because the reader follows it.
 *
 * So this test asserts, in both directions:
 *   - every navigable portal page is either documented by an article or listed
 *     in KB_ROUTES_WITHOUT_ARTICLE with a reason (a new page cannot ship
 *     unnoticed), and
 *   - every route and every "Group > Page" breadcrumb the knowledge base names
 *     still exists in the nav.
 *
 * It lives in the admin portal because this is the side that owns the nav and
 * the route table; the knowledge base is a dependency-free data module, so it
 * imports cleanly across the artifact boundary (the same reason the licence
 * label parity test reaches into api-server).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildNavGroups } from "@/pages/AppShell";
import type { FeatureKey } from "@/lib/brand";
import {
  KB_ARTICLES,
  KB_ROUTES_WITHOUT_ARTICLE,
  knowledgeBaseRouteCoverage,
} from "../../../api-server/src/lib/assistant/knowledgeBase";

const KB_FILE = "artifacts/api-server/src/lib/assistant/knowledgeBase.ts";
const here = dirname(fileURLToPath(import.meta.url));

// Everything switched on, so the coverage requirement is about the pages that
// exist in the codebase rather than the plan a particular tenant bought.
const adminGroups = buildNavGroups(false, true, () => true, true, true);
const dispatcherGroups = buildNavGroups(true, false, () => true, false, true);

/** route -> how a human would refer to that page ("Accounting > Pay Run"). */
const navPages = new Map<string, string>();
for (const groups of [adminGroups, dispatcherGroups]) {
  for (const group of groups) {
    for (const item of group.items) {
      if (!navPages.has(item.href)) navPages.set(item.href, `${group.label} > ${item.label}`);
    }
  }
}

/**
 * The wouter route table, read from source. Parsing beats hand-listing here:
 * a hand-written copy is exactly the kind of thing that goes stale silently,
 * which is the bug this file exists to prevent.
 *
 * Skipped: routes with a `:param` (detail views of a page already listed) and
 * redirect-only routes (legacy aliases, not pages anyone documents).
 */
const appSource = readFileSync(resolve(here, "../App.tsx"), "utf8");
const routeTableRoutes: string[] = [];
for (const m of appSource.matchAll(/<Route\s+path="([^"]+)"(?:\s+component=\{(\w+)\})?/g)) {
  const [, path, component] = m;
  if (path.includes(":")) continue;
  if (component && /Redirect$/.test(component)) continue;
  if (!routeTableRoutes.includes(path)) routeTableRoutes.push(path);
}

/** Every page the knowledge base is allowed to point at. */
const portalRoutes = new Set<string>([...navPages.keys(), ...routeTableRoutes]);

const describeRoute = (route: string) =>
  navPages.get(route) ?? `${route} (route with no nav entry)`;

describe("portal route table parsing", () => {
  it("still finds the routes in App.tsx", () => {
    // Guards the regex above: if the route table is rewritten in a shape this
    // no longer matches, every coverage assertion below would pass vacuously.
    expect(
      routeTableRoutes.length,
      "no <Route path=...> entries parsed out of App.tsx — the coverage checks below are not testing anything",
    ).toBeGreaterThan(20);
    expect(routeTableRoutes).toContain("/audit-log");
    expect(routeTableRoutes).not.toContain("/tables/shifts"); // legacy redirect
  });
});

describe("assistant knowledge base covers the portal", () => {
  const coverage = knowledgeBaseRouteCoverage();

  it("documents (or knowingly skips) every page in the nav and route table", () => {
    const uncovered = [...portalRoutes]
      .filter((route) => !coverage.has(route) && !(route in KB_ROUTES_WITHOUT_ARTICLE))
      .sort();

    expect(
      uncovered,
      uncovered.length === 0
        ? ""
        : `These portal pages have no assistant knowledge-base coverage:\n` +
          uncovered.map((r) => `  - ${describeRoute(r)}  [${r}]`).join("\n") +
          `\n\nIn ${KB_FILE}, either add the route to the article that explains it ` +
          `(\`route\` / \`alsoCovers\`), or add it to KB_ROUTES_WITHOUT_ARTICLE with the reason it needs no how-to.`,
    ).toEqual([]);
  });

  it("never points at a page that has been renamed, moved or removed", () => {
    const dead: string[] = [];
    for (const [route, articleId] of coverage) {
      if (!portalRoutes.has(route)) dead.push(`  - article "${articleId}" points at ${route}`);
    }
    for (const route of Object.keys(KB_ROUTES_WITHOUT_ARTICLE)) {
      if (!portalRoutes.has(route)) dead.push(`  - KB_ROUTES_WITHOUT_ARTICLE lists ${route}`);
    }

    expect(
      dead.sort(),
      dead.length === 0
        ? ""
        : `The assistant would send people to portal pages that no longer exist:\n${dead.join("\n")}\n\n` +
          `Update ${KB_FILE} to match the current nav, or drop the reference.`,
    ).toEqual([]);
  });

  it("does not both document a page and declare it undocumented", () => {
    const contradictory = Object.keys(KB_ROUTES_WITHOUT_ARTICLE)
      .filter((route) => coverage.has(route))
      .map((route) => `  - ${route} is covered by article "${coverage.get(route)}"`);

    expect(
      contradictory,
      contradictory.length === 0
        ? ""
        : `Listed in KB_ROUTES_WITHOUT_ARTICLE but also documented:\n${contradictory.join("\n")}\n\n` +
          `Remove the KB_ROUTES_WITHOUT_ARTICLE entry in ${KB_FILE}.`,
    ).toEqual([]);
  });

  it("gives every article a route so its answer can be acted on", () => {
    const routeless = KB_ARTICLES.filter((a) => !a.route).map((a) => `  - ${a.id} (${a.title})`);
    expect(
      routeless,
      routeless.length === 0
        ? ""
        : `Articles with no portal route — the reader is told what to do but not where:\n${routeless.join("\n")}`,
    ).toEqual([]);
  });
});

describe("assistant knowledge base breadcrumbs match the nav", () => {
  // Admin nav only: the Assistant is an admin-portal surface, so its prose is
  // written against the admin tabs. Validating against the dispatcher nav too
  // would let an admin-side rename hide behind a dispatcher tab of the old name.
  const itemsByGroup = new Map<string, string[]>();
  for (const group of adminGroups) {
    itemsByGroup.set(group.label, group.items.map((i) => i.label));
  }
  const groupLabels = [...itemsByGroup.keys()].sort((a, b) => b.length - a.length);
  const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

  /** Longest label the text ends with / starts with, on a word boundary. */
  const endsWithLabel = (text: string, labels: string[]) =>
    labels.find((l) => text.endsWith(l) && !isWordChar(text[text.length - l.length - 1])) ?? null;
  const startsWithLabel = (text: string, labels: string[]) =>
    [...labels]
      .sort((a, b) => b.length - a.length)
      .find((l) => text.startsWith(l) && !isWordChar(text[l.length])) ?? null;

  const problems: string[] = [];
  let breadcrumbCount = 0;

  for (const article of KB_ARTICLES) {
    // Every " > " in an article body is a nav breadcrumb; the bodies are
    // instructions, not maths, so there is no other legitimate use.
    for (let i = article.body.indexOf(" > "); i !== -1; i = article.body.indexOf(" > ", i + 1)) {
      breadcrumbCount++;
      const before = article.body.slice(0, i);
      const after = article.body.slice(i + 3);
      // Whole words only — the page name is however much of this the author meant.
      const named = after.slice(0, 26).replace(/\s+\S*$/, "");

      const groupLabel = endsWithLabel(before, groupLabels);
      if (!groupLabel) {
        const namedGroup = (before.split(/[.,—;:]/).pop() ?? "").trim().split(/\s+/).slice(-3).join(" ");
        problems.push(
          `  - article "${article.id}" sends the reader to "…${namedGroup} > ${named}…", but no nav tab is called "${namedGroup}".` +
            ` Tabs are now: ${groupLabels.slice().sort().join(", ")}`,
        );
        continue;
      }
      const items = itemsByGroup.get(groupLabel)!;
      if (!startsWithLabel(after, items)) {
        problems.push(
          `  - article "${article.id}" sends the reader to "${groupLabel} > ${named}…", but the ${groupLabel} tab has no page by that name.` +
            ` It now lists: ${items.join(", ")}`,
        );
      }
    }
  }

  it("finds the breadcrumbs it is meant to be checking", () => {
    expect(breadcrumbCount, "no 'Tab > Page' breadcrumbs found in any article").toBeGreaterThan(15);
  });

  it("names a tab and page that really exist for every 'Tab > Page' instruction", () => {
    expect(
      problems,
      problems.length === 0
        ? ""
        : `The assistant would talk people through nav that does not exist:\n${problems.join("\n")}\n\n` +
          `Update the wording in ${KB_FILE} to match the nav in src/pages/AppShell.tsx.`,
    ).toEqual([]);
  });
});

describe("assistant knowledge base declares the plan feature the nav actually gates", () => {
  // Which FeatureKey (if any) the sidebar hides each route behind, read
  // straight off the nav items built above — not re-derived, so this can
  // never drift from the "does this page exist" checks in the same file.
  // First group wins, same as `navPages` above: admin and dispatcher agree on
  // every shared route in this codebase today (guarded by the "agree with
  // each other" test below), so the order never matters in practice. If they
  // ever disagreed, that test would fail loudly instead of this map quietly
  // picking a side.
  const navFeatureByRoute = new Map<string, FeatureKey | undefined>();
  for (const groups of [adminGroups, dispatcherGroups]) {
    for (const group of groups) {
      for (const item of group.items) {
        if (!navFeatureByRoute.has(item.href)) navFeatureByRoute.set(item.href, item.feature);
      }
    }
  }

  it("finds feature-gated nav items to check articles against", () => {
    // Guards the map above: if nothing here carries a `feature`, every
    // assertion below passes vacuously.
    const gated = [...navFeatureByRoute.values()].filter((f): f is FeatureKey => !!f);
    expect(gated.length, "no feature-gated nav items found in AppShell.tsx").toBeGreaterThan(10);
  });

  it("agrees with itself: a route shared by the admin and dispatcher nav is gated behind the same feature in both", () => {
    // navFeatureByRoute above resolves a shared route by "first group wins",
    // which would silently paper over exactly this kind of disagreement. Walk
    // the two navs independently instead, so a route the admin nav gates
    // behind one feature (or leaves ungated) while the dispatcher nav gates
    // it behind another — or vice versa — fails here rather than quietly
    // making whichever nav happened to build first the authority for it.
    const adminFeatureByRoute = new Map<string, FeatureKey | undefined>();
    for (const group of adminGroups) {
      for (const item of group.items) adminFeatureByRoute.set(item.href, item.feature);
    }
    const dispatcherFeatureByRoute = new Map<string, FeatureKey | undefined>();
    for (const group of dispatcherGroups) {
      for (const item of group.items) dispatcherFeatureByRoute.set(item.href, item.feature);
    }

    const describeFeature = (f: FeatureKey | undefined) => (f ? `"${f}"` : "no feature (always-on)");
    const problems: string[] = [];
    for (const [route, adminFeature] of adminFeatureByRoute) {
      if (!dispatcherFeatureByRoute.has(route)) continue; // dispatcher-only or admin-only route
      const dispatcherFeature = dispatcherFeatureByRoute.get(route);
      if (adminFeature !== dispatcherFeature) {
        problems.push(
          `  - ${route}: admin nav gates it behind ${describeFeature(adminFeature)}, ` +
            `dispatcher nav gates it behind ${describeFeature(dispatcherFeature)}`,
        );
      }
    }

    expect(
      problems.sort(),
      problems.length === 0
        ? ""
        : `The admin and dispatcher sidebars disagree about which plan feature guards a shared page:\n${problems.join("\n")}\n\n` +
          `A company could see the page from one role and not the other, or the assistant/plan-feature checks in this ` +
          `file would silently pick whichever nav happened to declare it first. Make the \`feature\` on both nav items ` +
          `in src/pages/AppShell.tsx agree.`,
    ).toEqual([]);
  });

  it("matches an article's declared feature to the one its route(s) are gated behind", () => {
    const problems: string[] = [];
    for (const article of KB_ARTICLES) {
      const routes = [article.route, ...(article.alsoCovers ?? [])].filter(
        (r): r is string => !!r,
      );
      for (const route of routes) {
        if (!navFeatureByRoute.has(route)) continue; // not a nav item, or a nav item with no gate — nothing to check
        const navFeature = navFeatureByRoute.get(route);
        if (!navFeature) continue; // always-on nav item; an article may still name an unrelated feature (e.g. patrol on the always-on Sites page) without misleading anyone about THIS route
        if (article.feature !== navFeature) {
          problems.push(
            `  - article "${article.id}" ${
              article.feature ? `declares feature "${article.feature}"` : "declares no feature"
            }, but the sidebar gates ${route} behind "${navFeature}"`,
          );
        }
      }
    }
    expect(
      problems.sort(),
      problems.length === 0
        ? ""
        : `An assistant article's declared \`feature\` disagrees with the plan feature the sidebar actually hides its route behind:\n${problems.join("\n")}\n\n` +
          `A company without that feature could still be walked through a page it can't see (or the reverse: told a page it has is switched off). ` +
          `Fix the \`feature\` on the article in ${KB_FILE} to match the nav item's \`feature\` in src/pages/AppShell.tsx.`,
    ).toEqual([]);
  });
});

describe("assistant suggestion cards point at real pages", () => {
  // signals.ts hands each finding a route + "Tab → Page" label, which the
  // assistant reads out as "Where: …". Same staleness, same consequence.
  const signalsSource = readFileSync(
    resolve(here, "../../../api-server/src/lib/assistant/signals.ts"),
    "utf8",
  );
  const pairs = [...signalsSource.matchAll(/route:\s*"([^"]+)",\s*\n\s*routeLabel:\s*"([^"]+)"/g)].map(
    (m) => ({ route: m[1], label: m[2] }),
  );

  it("finds the finding routes it is meant to be checking", () => {
    expect(pairs.length, "no route/routeLabel pairs parsed out of signals.ts").toBeGreaterThan(5);
  });

  it("uses a live route and the current tab name for every finding", () => {
    const problems: string[] = [];
    for (const { route, label } of pairs) {
      if (!portalRoutes.has(route)) {
        problems.push(`  - "${label}" points at ${route}, which is not a portal route`);
        continue;
      }
      // signals.ts writes the breadcrumb with an arrow; the nav is the authority.
      const expected = navPages.get(route);
      if (expected && label.replace(" → ", " > ") !== expected) {
        problems.push(`  - ${route} is labelled "${label}" but the nav calls it "${expected}"`);
      }
    }
    expect(
      problems,
      problems.length === 0
        ? ""
        : `Assistant suggestion cards name pages that have changed:\n${problems.join("\n")}\n\n` +
          `Update artifacts/api-server/src/lib/assistant/signals.ts.`,
    ).toEqual([]);
  });
});
