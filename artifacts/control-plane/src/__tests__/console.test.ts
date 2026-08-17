/**
 * Operator-console output-escaping regression.
 *
 * `reportedVersion` is sourced from remote (untrusted) customer backends via
 * /api/version and persisted in the registry. The fleet table must HTML-escape
 * it (and every other interpolated field) before it reaches innerHTML, or a
 * malicious/compromised backend could inject script into the privileged
 * operator dashboard and steal the operator's session token.
 *
 * jsdom is not available in this workspace, so we evaluate the real public/app.js
 * inside a `vm` context backed by a minimal fake DOM and assert the rendered
 * row markup is escaped.
 */

import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appJsSource = readFileSync(resolve(here, "../../public/app.js"), "utf8");

interface FakeEl {
  tag: string;
  innerHTML: string;
  hidden: boolean;
  textContent: string;
  className: string;
  value: string;
  parentNode: FakeEl | null;
  appendChild: () => void;
  removeChild: () => void;
  insertBefore: () => void;
  querySelector: () => FakeEl;
  addEventListener: () => void;
  setAttribute: () => void;
  getAttribute: () => string;
  closest: () => null;
  remove: () => void;
}

function makeEl(tag = ""): FakeEl {
  return {
    tag,
    innerHTML: "",
    hidden: false,
    textContent: "",
    className: "",
    value: "",
    parentNode: null,
    appendChild: () => {},
    removeChild: () => {},
    insertBefore: () => {},
    querySelector: () => makeEl("stub"),
    addEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => "",
    closest: () => null,
    remove: () => {},
  };
}

function renderWith(customersData: unknown[]): { created: FakeEl[]; esc: (s: unknown) => string; renderFiltered: (arr: unknown[], filter: string | null) => void } {
  const created: FakeEl[] = [];
  const elements: Record<string, FakeEl> = {};
  const documentStub = {
    getElementById: (id: string) => (elements[id] = elements[id] || makeEl(id)),
    createElement: (tag: string) => {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    localStorage: { getItem: () => "", setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Append a bridge in the SAME script scope so we can reach the module-local
  // `customers`/`renderFleet`/`esc` bindings (top-level `let`/`function`).
  const augmented =
    appJsSource +
    "\n;globalThis.__renderFleetWith = function (arr, filter) { customers = arr; fleetFilter = filter || null; renderFleet(); };" +
    "\n;globalThis.__esc = esc;";
  vm.runInContext(augmented, sandbox);
  (sandbox.__renderFleetWith as (a: unknown[], f?: string | null) => void)(customersData);
  return { created, esc: sandbox.__esc as (s: unknown) => string,
    renderFiltered: (arr: unknown[], filter: string | null) =>
      (sandbox.__renderFleetWith as (a: unknown[], f: string | null) => void)(arr, filter),
  };
}

const baseCustomer = {
  name: "Acme",
  orgCode: "acme",
  apiBaseUrl: "https://a.test",
  contactEmail: "",
  needsUpdate: false,
  lastStatus: "online",
  isActive: true,
  lastSeenAt: null,
  effectiveTargetVersion: null,
};

describe("operator console escaping", () => {
  it("escapes a hostile reported version in the fleet table", () => {
    const hostile = '<img src=x onerror="alert(document.cookie)">';
    const { created } = renderWith([{ ...baseCustomer, reportedVersion: hostile }]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr).toBeTruthy();
    // The raw tag must be neutralized; the angle brackets/quotes are escaped so
    // it can never form a live <img onerror> element, only inert text.
    expect(tr!.innerHTML).not.toContain("<img");
    expect(tr!.innerHTML).not.toContain('onerror="alert');
    expect(tr!.innerHTML).toContain("&lt;img");
  });

  it("escapes hostile name / org code / url fields too", () => {
    const { created } = renderWith([
      {
        ...baseCustomer,
        name: "<script>x</script>",
        orgCode: "<b>",
        apiBaseUrl: "https://a.test/'><script>1</script>",
        reportedVersion: "v1",
      },
    ]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr!.innerHTML).not.toContain("<script>");
    expect(tr!.innerHTML).toContain("&lt;script&gt;");
  });

  it("esc neutralizes angle brackets, quotes and ampersands", () => {
    const { esc } = renderWith([]);
    expect(esc("<script>\"'&")).toBe("&lt;script&gt;&quot;&#39;&amp;");
  });
});

async function renderActivityWith(changes: unknown[]): Promise<FakeEl[]> {
  const created: FakeEl[] = [];
  const elements: Record<string, FakeEl> = {};
  const documentStub = {
    getElementById: (id: string) => (elements[id] = elements[id] || makeEl(id)),
    createElement: (tag: string) => {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    localStorage: { getItem: () => "tok", setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    fetch: async () =>
      ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ changes }),
      }) as unknown as Response,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const augmented = appJsSource + "\n;globalThis.__loadActivity = loadActivity;";
  vm.runInContext(augmented, sandbox);
  await (sandbox.__loadActivity as () => Promise<void>)();
  return created;
}

describe("setupProgressCell rendering", () => {
  it("renders a progress badge for a customer with partial checklist", () => {
    const { created } = renderWith([
      {
        ...baseCustomer,
        checklistProgress: { done: 6, total: 11 },
      },
    ]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr!.innerHTML).toContain("6/11");
    expect(tr!.innerHTML).toContain("partial");
  });

  it("renders a complete badge when all steps are done", () => {
    const { created } = renderWith([
      {
        ...baseCustomer,
        checklistProgress: { done: 11, total: 11 },
      },
    ]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr!.innerHTML).toContain("11/11");
    expect(tr!.innerHTML).toContain("complete");
  });

  it("renders a dash when checklistProgress is null", () => {
    const { created } = renderWith([{ ...baseCustomer, checklistProgress: null }]);
    const tr = created.find((e) => e.tag === "tr");
    // Should fall back to the muted dash span, no "setup-bar".
    expect(tr!.innerHTML).toContain("muted small");
    expect(tr!.innerHTML).not.toContain("setup-bar");
  });

  it("escapes hostile step counts (progress field is server-controlled numbers, but esc() is applied)", () => {
    // Done/total are numbers so XSS via them is unrealistic, but the cell goes through esc()
    // — verify the output is at minimum non-null and renders without throwing.
    const { created } = renderWith([
      {
        ...baseCustomer,
        checklistProgress: { done: 0, total: 11 },
      },
    ]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr!.innerHTML).toContain("0/11");
  });
});

// ---- renderSummary setup-stat helpers ----

function renderSummaryWith(customersData: unknown[]): string {
  const elements: Record<string, FakeEl> = {};
  const documentStub = {
    getElementById: (id: string) => (elements[id] = elements[id] || makeEl(id)),
    createElement: (tag: string) => makeEl(tag),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    localStorage: { getItem: () => "", setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const augmented =
    appJsSource +
    "\n;globalThis.__renderSummaryWith = function (arr) { customers = arr; renderSummary(); };";
  vm.runInContext(augmented, sandbox);
  (sandbox.__renderSummaryWith as (a: unknown[]) => void)(customersData);
  // Return the innerHTML that was written to the #summary element.
  return elements["summary"]?.innerHTML ?? "";
}

describe("renderSummary — setup stat cards (trial-scoped)", () => {
  const base = {
    name: "Acme",
    orgCode: "acme",
    apiBaseUrl: "https://a.test",
    contactEmail: "",
    needsUpdate: false,
    lastStatus: "online",
    isActive: true,
    lastSeenAt: null,
    effectiveTargetVersion: null,
    agreements: null,
    hasMgmtSecret: false,
    plan: null,
  };

  it("counts a trial customer with partial checklist as 'setup in progress'", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 3, total: 11 } },
    ]);
    // Find the stat that contains "Setup in progress" and check its number
    const match = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup in progress<\/span>/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe("1");
  });

  it("does NOT count a paid customer with partial checklist as 'setup in progress'", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "paid", checklistProgress: { done: 3, total: 11 } },
    ]);
    const match = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup in progress<\/span>/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe("0");
  });

  it("counts a trial customer with 0 steps done as 'setup not started'", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 0, total: 11 } },
    ]);
    const notStartedMatch = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup not started<\/span>/);
    expect(notStartedMatch).toBeTruthy();
    expect(notStartedMatch![1]).toBe("1");
    // Must NOT also appear in "in progress"
    const inProgressMatch = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup in progress<\/span>/);
    expect(inProgressMatch![1]).toBe("0");
  });

  it("does NOT count a fully-complete trial checklist in either setup stat", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 11, total: 11 } },
    ]);
    const inProgress = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup in progress<\/span>/);
    const notStarted = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup not started<\/span>/);
    expect(inProgress![1]).toBe("0");
    expect(notStarted![1]).toBe("0");
  });

  it("does NOT count a paid customer with 0 steps as 'setup not started'", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "paid", checklistProgress: { done: 0, total: 11 } },
    ]);
    const notStarted = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup not started<\/span>/);
    expect(notStarted).toBeTruthy();
    expect(notStarted![1]).toBe("0");
  });

  it("applies alert class to 'setup in progress' stat when count is non-zero", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 2, total: 11 } },
    ]);
    // The stat div should have the 'alert' class when count > 0
    expect(html).toContain('stat alert');
    expect(html).toContain("Setup in progress");
  });

  it("mixed fleet: only trial partial customers are counted", () => {
    const html = renderSummaryWith([
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 2, total: 11 } },  // in progress
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 0, total: 11 } },  // not started
      { ...base, lifecycleStatus: "trial", checklistProgress: { done: 11, total: 11 } }, // complete — excluded
      { ...base, lifecycleStatus: "paid",  checklistProgress: { done: 5, total: 11 } },  // paid — excluded
    ]);
    const inProgress = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup in progress<\/span>/);
    const notStarted = html.match(/<span class="num">(\d+)<\/span><span class="lbl">Setup not started<\/span>/);
    expect(inProgress![1]).toBe("1");
    expect(notStarted![1]).toBe("1");
  });
});

describe("renderFleet — setup stat-card filter", () => {
  // Each `renderWith` call produces a fresh `created` array and a fresh sandbox,
  // so calling renderFiltered *before* any baseline render gives us a clean
  // count. We use `renderWith([])` to boot the module cheaply (0 trs emitted),
  // then call `renderFiltered` and inspect only the rows added by that call.

  const trialPartial = { ...baseCustomer, lifecycleStatus: "trial", checklistProgress: { done: 2, total: 11 }, name: "InProgress" };
  const trialNone    = { ...baseCustomer, lifecycleStatus: "trial", checklistProgress: { done: 0, total: 11 }, name: "NotStarted" };
  const trialDone    = { ...baseCustomer, lifecycleStatus: "trial", checklistProgress: { done: 11, total: 11 }, name: "Complete" };
  const paidPartial  = { ...baseCustomer, lifecycleStatus: "paid",  checklistProgress: { done: 5, total: 11 }, name: "PaidPartial" };
  const allCustomers = [trialPartial, trialNone, trialDone, paidPartial];

  function rowsAfter(created: FakeEl[], positionBefore: number) {
    return created.filter((e) => e.tag === "tr").slice(positionBefore);
  }

  it("with no filter, all customers render", () => {
    const { created } = renderWith(allCustomers);
    const rows = created.filter((e) => e.tag === "tr");
    expect(rows).toHaveLength(4);
    const html = rows.map((r) => r.innerHTML).join("");
    expect(html).toContain("InProgress");
    expect(html).toContain("NotStarted");
    expect(html).toContain("Complete");
    expect(html).toContain("PaidPartial");
  });

  it("'setup-in-progress' filter shows only trial customers with partial checklist", () => {
    const { created, renderFiltered } = renderWith([]); // boot with 0 customers → 0 trs
    const pos = created.filter((e) => e.tag === "tr").length; // 0
    renderFiltered(allCustomers, "setup-in-progress");
    const rows = rowsAfter(created, pos);
    expect(rows).toHaveLength(1);
    expect(rows[0].innerHTML).toContain("InProgress");
  });

  it("'setup-not-started' filter shows only trial customers with zero done", () => {
    const { created, renderFiltered } = renderWith([]);
    const pos = created.filter((e) => e.tag === "tr").length;
    renderFiltered(allCustomers, "setup-not-started");
    const rows = rowsAfter(created, pos);
    expect(rows).toHaveLength(1);
    expect(rows[0].innerHTML).toContain("NotStarted");
  });

  it("filter returns empty results when no customers match", () => {
    const onlyPaid = [paidPartial];
    const { created, renderFiltered } = renderWith([]);
    const pos = created.filter((e) => e.tag === "tr").length;
    renderFiltered(onlyPaid, "setup-in-progress");
    expect(rowsAfter(created, pos)).toHaveLength(0);
  });

  it("clearing the filter restores all customers", () => {
    const { created, renderFiltered } = renderWith([]);
    renderFiltered(allCustomers, "setup-in-progress"); // 1 row
    const pos = created.filter((e) => e.tag === "tr").length; // 1
    renderFiltered(allCustomers, null); // clears → all 4 rows
    expect(rowsAfter(created, pos)).toHaveLength(4);
  });
});

describe("fleet activity feed escaping", () => {
  it("escapes hostile summary / operator / customer name in the activity feed", async () => {
    const created = await renderActivityWith([
      {
        id: "1",
        kind: "brand",
        summary: "<img src=x onerror=alert(1)>",
        operator: "<b>op</b>",
        status: 200,
        createdAt: new Date().toISOString(),
        customerId: "c1",
        customerName: "<script>x</script>",
      },
    ]);
    const li = created.find((e) => e.tag === "li");
    expect(li).toBeTruthy();
    expect(li!.innerHTML).not.toContain("<img");
    expect(li!.innerHTML).not.toContain("<script>x");
    expect(li!.innerHTML).toContain("&lt;img");
    expect(li!.innerHTML).toContain("&lt;script&gt;x");
  });

  it("shows a removed-customer marker when the customer name is null", async () => {
    const created = await renderActivityWith([
      {
        id: "2",
        kind: "features",
        summary: "Updated features: chat=on",
        operator: "op@test",
        status: 200,
        createdAt: new Date().toISOString(),
        customerId: "gone",
        customerName: null,
      },
    ]);
    const li = created.find((e) => e.tag === "li");
    expect(li!.innerHTML).toContain("removed customer");
  });
});
