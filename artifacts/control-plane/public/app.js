"use strict";

const TOKEN_KEY = "cp_operator_token";
let customers = [];

function token() {
  return localStorage.getItem(TOKEN_KEY) || "";
}
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, opts) {
  const options = opts || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (token()) headers["Authorization"] = "Bearer " + token();
  const res = await fetch("/api" + path, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    setToken("");
    showLogin();
    throw new Error("Unauthorized");
  }
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_e) {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || "Request failed (" + res.status + ")";
    const err = new Error(msg);
    err.body = body;
    err.status = res.status;
    throw err;
  }
  return body;
}

function $(id) {
  return document.getElementById(id);
}

function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  setTimeout(function () {
    t.hidden = true;
  }, 3200);
}

function showLogin() {
  $("login-view").hidden = false;
  $("dash-view").hidden = true;
}
function showDash() {
  $("login-view").hidden = true;
  $("dash-view").hidden = false;
}

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

// Friendly label + badge color for a remote-change kind. The DB stores the raw
// token (brand / features / plan_billing); the UI shows a readable label.
function kindLabel(kind) {
  if (kind === "brand") return "Brand";
  if (kind === "features") return "Features";
  if (kind === "plan_billing") return "Plan & billing";
  if (kind === "agreement") return "Agreement";
  return String(kind == null ? "" : kind);
}
function kindBadgeClass(kind) {
  if (kind === "brand") return "warn";
  if (kind === "plan_billing") return "plan";
  if (kind === "agreement") return "warn";
  return "ok";
}

// Human label for a plan tier token; unknown/empty tiers fall back to the raw
// value so a control plane that predates a new tier still shows something.
function tierLabel(tier) {
  if (tier === "starter") return "Starter";
  if (tier === "professional") return "Professional";
  if (tier === "enterprise") return "Enterprise";
  if (tier === "custom") return "Custom";
  return String(tier == null ? "" : tier);
}

// "$899/mo" style price from cents; null/unknown → "—".
function fmtMonthlyPrice(cents) {
  if (cents == null || isNaN(Number(cents))) return "—";
  return "$" + Number(Number(cents) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 }) + "/mo";
}

// Plan snapshots older than this are flagged as stale. The poller refreshes each
// backend roughly every 60s, so a snapshot this old means the backend has been
// unreachable for many cycles and its plan/price can no longer be trusted.
var PLAN_STALE_MS = 15 * 60 * 1000;

// Compact "x ago" label from an ISO timestamp; null/invalid → null.
function relativeAge(iso) {
  if (!iso) return null;
  var t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  var diff = Date.now() - t;
  if (diff < 0) diff = 0;
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + " hr" + (hrs === 1 ? "" : "s") + " ago";
  var days = Math.floor(hrs / 24);
  return days + " day" + (days === 1 ? "" : "s") + " ago";
}

// True when a plan snapshot's fetchedAt is older than the stale threshold.
function planIsStale(plan) {
  if (!plan || !plan.fetchedAt) return false;
  var t = new Date(plan.fetchedAt).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t > PLAN_STALE_MS;
}

// Fleet plan cell: tier badge + monthly price. Degrades to "unknown" when the
// plan snapshot was never fetched (no secret / unreachable backend), and to
// "not set" when the backend was reached but no commercial config is saved.
function planCell(c) {
  var plan = c.plan;
  if (!plan) {
    var why = c.hasMgmtSecret
      ? "Plan not yet fetched from this backend"
      : "No management secret — plan unknowable";
    return "<span class='badge warn' title='" + esc(why) + "'>unknown</span>";
  }
  if (!plan.tier && plan.monthlyPriceCents == null) {
    return "<span class='muted small' title='Backend reached, but no plan/price is configured'>not set</span>";
  }
  var tier = plan.tier
    ? "<span class='badge plan'>" + esc(tierLabel(plan.tier)) + "</span>"
    : "<span class='muted small'>no tier</span>";
  var age = relativeAge(plan.fetchedAt);
  var freshTip = plan.fetchedAt
    ? "Plan snapshot fetched " + (age || fmtDate(plan.fetchedAt)) + " (" + fmtDate(plan.fetchedAt) + ")"
    : "Snapshot freshness unknown";
  var body =
    "<span title='" + esc(freshTip) + "'>" +
    tier +
    " <span class='small'>" + esc(fmtMonthlyPrice(plan.monthlyPriceCents)) + "</span>" +
    "</span>";
  if (planIsStale(plan)) {
    var staleTip =
      "Snapshot is " + (age || "old") +
      " — backend has been unreachable; plan & price may be out of date";
    body += " <span class='badge bad' title='" + esc(staleTip) + "'>stale</span>";
  }
  return body;
}

function statusBadge(c) {
  const cls = c.lastStatus === "online" ? "ok" : c.lastStatus === "offline" ? "bad" : "warn";
  const label = c.isActive ? c.lastStatus : "paused";
  return '<span class="badge ' + (c.isActive ? cls : "warn") + '">' + label + "</span>";
}

// Trial/Paid billing lifecycle badge. "Paid" shows the conversion date in its
// tooltip; "Trial" has no timestamp (never converted, or reverted).
function lifecycleBadge(c) {
  var status = c.lifecycleStatus || "trial";
  if (status === "paid") {
    var tip = c.convertedAt ? "Converted to paid on " + fmtDate(c.convertedAt) : "Paid";
    return "<span class='badge ok' title='" + esc(tip) + "'>Paid</span>";
  }
  return "<span class='badge warn' title='Trial account — not yet converted to paid'>Trial</span>";
}

function agreementsCell(c) {
  if (!c.hasMgmtSecret) {
    return "<span class='muted small'>no secret</span>";
  }
  if (!c.agreements || !c.agreements.slots) {
    return "<span class='badge warn' title='Agreement status not yet fetched from this backend'>unknown</span>";
  }
  var slots = c.agreements.slots;
  var parts = [];
  [["msa", "MSA"], ["user_agreement", "UA"]].forEach(function (pair) {
    var key = pair[0];
    var label = pair[1];
    var slot = slots[key];
    if (!slot) return;
    if (slot.signed) {
      var tip = label + " signed";
      if (slot.signerName) tip += " by " + slot.signerName;
      if (slot.signedAt) tip += " on " + fmtDate(slot.signedAt);
      if (slot.documentSha256) tip += " · SHA-256 " + String(slot.documentSha256).slice(0, 12) + "…";
      parts.push("<span class='badge ok' title='" + esc(tip) + "'>" + esc(label) + " ✓</span>");
      if (key === "msa" && slot.guarantyExecuted === false) {
        parts.push("<span class='badge warn' title='MSA signed but the personal guaranty was NOT executed'>no guaranty</span>");
      }
    } else {
      parts.push("<span class='badge bad' title='" + esc(label) + " not signed'>" + esc(label) + " ✗</span>");
    }
  });
  if (parts.length === 0) {
    return "<span class='badge warn'>unknown</span>";
  }
  return parts.join(" ");
}

function agreementsIncomplete(c) {
  if (!c.hasMgmtSecret) return false; // status unknowable without a secret — never count as unsigned
  if (!c.agreements || !c.agreements.slots) return false; // unknown ≠ unsigned
  var slots = c.agreements.slots;
  var msa = slots.msa;
  var ua = slots.user_agreement;
  if (msa && (!msa.signed || msa.guarantyExecuted === false)) return true;
  if (ua && !ua.signed) return true;
  return false;
}

function renderSummary() {
  const total = customers.length;
  const online = customers.filter(function (c) {
    return c.lastStatus === "online" && c.isActive;
  }).length;
  const needs = customers.filter(function (c) {
    return c.needsUpdate;
  }).length;
  const unsigned = customers.filter(agreementsIncomplete).length;
  const setupInProgress = customers.filter(function (c) {
    if ((c.lifecycleStatus || "trial") !== "trial") return false;
    var p = c.checklistProgress;
    return p && p.total > 0 && p.done > 0 && p.done < p.total;
  }).length;
  const setupNotStarted = customers.filter(function (c) {
    if ((c.lifecycleStatus || "trial") !== "trial") return false;
    var p = c.checklistProgress;
    return p && p.total > 0 && p.done === 0;
  }).length;
  const trialCount = customers.filter(function (c) {
    return (c.lifecycleStatus || "trial") === "trial";
  }).length;
  const paidCount = total - trialCount;

  // Fleet-wide monthly recurring revenue = sum of known monthly prices, plus a
  // count of customers whose price we couldn't read (so the MRR isn't silently
  // understated). A per-tier breakdown answers "who's on which plan?" at a glance.
  var mrrCents = 0;
  var priced = 0;
  var unknownPrice = 0;
  var stalePriced = 0;
  var tierCounts = { starter: 0, professional: 0, enterprise: 0, custom: 0, other: 0 };
  customers.forEach(function (c) {
    var plan = c.plan;
    if (plan && plan.monthlyPriceCents != null) {
      mrrCents += Number(plan.monthlyPriceCents);
      priced += 1;
      if (planIsStale(plan)) stalePriced += 1;
    } else {
      unknownPrice += 1;
    }
    if (plan && plan.tier) {
      if (Object.prototype.hasOwnProperty.call(tierCounts, plan.tier)) tierCounts[plan.tier] += 1;
      else tierCounts.other += 1;
    }
  });
  var mrrLabel = "$" + Number(mrrCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 }) + "/mo";
  var mrrSub = priced + " of " + total + " priced" +
    (unknownPrice ? " · " + unknownPrice + " unknown" : "") +
    (stalePriced ? " · " + stalePriced + " stale" : "");
  var tierParts = [];
  [["starter", "Starter"], ["professional", "Professional"], ["enterprise", "Enterprise"], ["custom", "Custom"]].forEach(function (pair) {
    if (tierCounts[pair[0]]) tierParts.push(esc(pair[1]) + " " + tierCounts[pair[0]]);
  });
  if (tierCounts.other) tierParts.push("Other " + tierCounts.other);
  var tierSub = tierParts.length ? tierParts.join(" · ") : "no plans set";

  $("summary").innerHTML =
    '<div class="stat"><span class="num">' + total + '</span><span class="lbl">Customers</span></div>' +
    '<div class="stat"><span class="num">' + online + '</span><span class="lbl">Online</span></div>' +
    '<div class="stat"><span class="num">' + paidCount + ' / ' + trialCount + '</span><span class="lbl">Paid / Trial</span></div>' +
    '<div class="stat ' + (needs ? "alert" : "") + '"><span class="num">' + needs + '</span><span class="lbl">Needs update</span></div>' +
    '<div class="stat ' + (unsigned ? "alert" : "") + '"><span class="num">' + unsigned + '</span><span class="lbl">Agreements incomplete</span></div>' +
    '<div class="stat ' + (setupInProgress ? "alert" : "") + '"><span class="num">' + setupInProgress + '</span><span class="lbl">Setup in progress</span></div>' +
    '<div class="stat ' + (setupNotStarted ? "alert" : "") + '"><span class="num">' + setupNotStarted + '</span><span class="lbl">Setup not started</span></div>' +
    '<div class="stat"><span class="num">' + mrrLabel + '</span><span class="lbl">MRR · ' + esc(mrrSub) + '</span></div>' +
    '<div class="stat"><span class="num small-num">' + esc(tierSub) + '</span><span class="lbl">Plan tiers</span></div>';
}

function setupProgressCell(c) {
  var p = c.checklistProgress;
  if (!p) return "<span class='muted small'>\u2014</span>";
  var cls = p.total === 0 ? "" : p.done === p.total ? "complete" : p.done > 0 ? "partial" : "";
  return "<span class='setup-bar " + cls + "' title='" + esc(p.done + " of " + p.total + " onboarding steps done") + "'>" +
    esc(p.done + "/" + p.total) + "</span>";
}

function renderFleet() {
  const body = $("fleet-body");
  body.innerHTML = "";
  $("empty").hidden = customers.length > 0;
  customers.forEach(function (c) {
    const tr = document.createElement("tr");
    const versionCell =
      esc(c.reportedVersion || "—") +
      (c.needsUpdate ? ' <span class="badge bad">update</span>' : "");
    tr.innerHTML =
      "<td><strong>" + esc(c.name) + "</strong><br><span class='muted small'>" + esc(c.contactEmail || "") + "</span></td>" +
      "<td><code>" + esc(c.orgCode) + "</code></td>" +
      "<td class='small'><a href='" + esc(c.apiBaseUrl) + "' target='_blank' rel='noopener'>" + esc(c.apiBaseUrl) + "</a></td>" +
      "<td>" + statusBadge(c) + "</td>" +
      "<td>" + lifecycleBadge(c) + "</td>" +
      "<td class='setup-cell small'>" + setupProgressCell(c) + "</td>" +
      "<td class='small'>" + agreementsCell(c) + "</td>" +
      "<td class='small'>" + planCell(c) + "</td>" +
      "<td class='small'>" + versionCell + "</td>" +
      "<td class='small'>" + esc(c.effectiveTargetVersion || "—") + "</td>" +
      "<td class='small'>" + fmtDate(c.lastSeenAt) + "</td>" +
      "<td class='actions'></td>";
    const actions = tr.querySelector(".actions");
    actions.appendChild(btn("Settings", "ghost small", function () {
      openSettings(c);
    }));
    actions.appendChild(btn("Edit", "ghost small", function () {
      openEditor(c);
    }));
    if ((c.lifecycleStatus || "trial") === "trial") {
      actions.appendChild(btn("Mark Paid", "ghost small", function () {
        markPaid(c);
      }));
    }
    actions.appendChild(btn("Delete", "ghost small danger", function () {
      deleteCustomer(c);
    }));
    body.appendChild(tr);
  });
}

function btn(label, cls, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

async function loadFleet() {
  const data = await api("/customers");
  customers = data.customers || [];
  renderSummary();
  renderFleet();
  populateActivityCustomers();
  const s = await api("/settings");
  $("fleet-target").value = s.targetVersion || "";
  await loadActivity();
}

// ---- Fleet-wide recent activity ----
function populateActivityCustomers() {
  const sel = $("filter-customer");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = "<option value=''>All customers</option>";
  customers.forEach(function (c) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
  // Preserve the operator's selection across fleet reloads if still valid.
  if (current && customers.some(function (c) { return c.id === current; })) {
    sel.value = current;
  }
}

function activityFiltersActive() {
  return Boolean(
    ($("filter-customer") && $("filter-customer").value) ||
    ($("filter-kind") && $("filter-kind").value) ||
    ($("filter-since") && $("filter-since").value) ||
    ($("filter-until") && $("filter-until").value),
  );
}

function activityQueryString() {
  const parts = [];
  const add = function (key, val) {
    if (val) parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(val));
  };
  add("customerId", $("filter-customer") ? $("filter-customer").value : "");
  add("kind", $("filter-kind") ? $("filter-kind").value : "");
  add("since", $("filter-since") ? $("filter-since").value : "");
  add("until", $("filter-until") ? $("filter-until").value : "");
  return parts.length ? "?" + parts.join("&") : "";
}

async function loadActivity() {
  const el = $("activity-body");
  el.innerHTML = "<p class='muted small'>Loading…</p>";
  try {
    const data = await api("/remote-changes" + activityQueryString());
    const changes = data.changes || [];
    if (changes.length === 0) {
      el.innerHTML = activityFiltersActive()
        ? "<p class='muted small'>No remote changes match these filters.</p>"
        : "<p class='muted small'>No remote changes across the fleet yet.</p>";
      return;
    }
    el.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "history-list";
    changes.forEach(function (ch) {
      const li = document.createElement("li");
      li.innerHTML =
        "<span class='badge " + kindBadgeClass(ch.kind) + "'>" + esc(kindLabel(ch.kind)) + "</span> " +
        esc(ch.summary) +
        "<br><span class='muted small'>" +
        (ch.customerName
          ? "<a href='#' class='activity-link'>" + esc(ch.customerName) + "</a>"
          : "<span class='muted'>(removed customer)</span>") +
        " · " + esc(ch.operator) + " · " + fmtDate(ch.createdAt) + "</span>";
      const link = li.querySelector(".activity-link");
      if (link) {
        link.addEventListener("click", function (e) {
          e.preventDefault();
          const c = customers.find(function (x) {
            return x.id === ch.customerId;
          });
          if (c) openSettings(c);
          else toast("Customer no longer in registry", true);
        });
      }
      ul.appendChild(li);
    });
    el.appendChild(ul);
  } catch (err) {
    el.innerHTML = "<p class='muted small'>Could not load activity: " + esc(err.message) + "</p>";
  }
}

async function downloadActivityCsv() {
  const btn = $("download-activity");
  btn.disabled = true;
  try {
    const res = await fetch("/api/remote-changes.csv", {
      headers: token() ? { Authorization: "Bearer " + token() } : {},
    });
    if (res.status === 401) {
      setToken("");
      showLogin();
      return;
    }
    if (!res.ok) {
      toast("Could not export CSV (" + res.status + ")", true);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fleet-change-history-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("CSV downloaded");
  } catch (err) {
    toast(err.message || "CSV export failed", true);
  } finally {
    btn.disabled = false;
  }
}

// ---- Customer editor ----
function openEditor(c) {
  $("modal-title").textContent = c ? "Edit customer" : "Add customer";
  $("c-id").value = c ? c.id : "";
  $("c-name").value = c ? c.name : "";
  $("c-orgCode").value = c ? c.orgCode : "";
  $("c-apiBaseUrl").value = c ? c.apiBaseUrl : "";
  $("c-contactName").value = c ? c.contactName || "" : "";
  $("c-contactEmail").value = c ? c.contactEmail || "" : "";
  $("c-targetVersion").value = c ? c.targetVersion || "" : "";
  $("c-isActive").checked = c ? c.isActive : true;
  $("c-lifecycleStatus").value = c ? (c.lifecycleStatus || "trial") : "trial";
  $("c-mgmtSecret").value = "";
  $("c-notes").value = c ? c.notes || "" : "";
  $("lifecycle-hint").textContent = c && c.lifecycleStatus === "paid" && c.convertedAt
    ? "Converted to paid on " + fmtDate(c.convertedAt) + ". Switching back to Trial clears this date."
    : "New customers start in Trial. Switching to Paid stamps today as the conversion date.";
  $("secret-hint").textContent = c && c.hasMgmtSecret
    ? "A management secret is set. Leave blank to keep it, or type a new one to replace."
    : "No management secret yet. Set the same value as the customer's CONTROL_PLANE_SHARED_SECRET to manage it remotely.";
  $("modal-error").hidden = true;
  $("modal").hidden = false;
}

function closeEditor() {
  $("modal").hidden = true;
}

async function submitCustomer(e) {
  e.preventDefault();
  const id = $("c-id").value;
  const payload = {
    name: $("c-name").value.trim(),
    orgCode: $("c-orgCode").value.trim(),
    apiBaseUrl: $("c-apiBaseUrl").value.trim(),
    contactName: $("c-contactName").value.trim(),
    contactEmail: $("c-contactEmail").value.trim(),
    targetVersion: $("c-targetVersion").value.trim(),
    isActive: $("c-isActive").checked,
    notes: $("c-notes").value.trim(),
  };
  // lifecycleStatus is only settable on existing customers (new ones always
  // start in Trial via the DB default) — omit it from create payloads since
  // createSchema doesn't accept the field.
  if (id) payload.lifecycleStatus = $("c-lifecycleStatus").value;
  const secret = $("c-mgmtSecret").value;
  if (secret) payload.mgmtSecret = secret;
  try {
    if (id) await api("/customers/" + id, { method: "PUT", body: JSON.stringify(payload) });
    else await api("/customers", { method: "POST", body: JSON.stringify(payload) });
    closeEditor();
    await loadFleet();
    toast("Saved");
  } catch (err) {
    $("modal-error").textContent = err.message;
    $("modal-error").hidden = false;
  }
}

async function markPaid(c) {
  if (!window.confirm("Mark " + c.name + " as Paid? This stamps today's date as their conversion date.")) return;
  try {
    await api("/customers/" + c.id, {
      method: "PUT",
      body: JSON.stringify({ lifecycleStatus: "paid" }),
    });
    await loadFleet();
    toast(c.name + " is now Paid");
  } catch (err) {
    toast(err.message || "Could not update lifecycle status", true);
  }
}

async function deleteCustomer(c) {
  if (!window.confirm("Remove " + c.name + " from the registry? This does not touch their backend.")) return;
  await api("/customers/" + c.id, { method: "DELETE" });
  await loadFleet();
  toast("Removed");
}

// ---- Remote settings ----
let settingsCustomer = null;
// Monotonically-increasing generation counter. Incremented each time
// openSettings() is called so that any in-flight checklist fetches or
// toggle callbacks started for a previous customer can detect they are stale
// and discard their results instead of overwriting the current modal.
let settingsGeneration = 0;

// ---- Onboarding checklist ----

/** Render the checklist section into `settings-checklist` element. */
function renderChecklist(steps) {
  var el = $("settings-checklist");
  if (!el) return;
  var done = steps.filter(function (s) { return s.isDone; }).length;
  var total = steps.length;
  var progCls = total === 0 ? "" : done === total ? "prog-done" : "";
  var html = "<h3>Onboarding checklist</h3>";
  html += "<p class='checklist-progress'><span class='" + progCls + "'>" + done + "</span> / <span class='prog-all'>" + total + "</span> steps complete</p>";
  html += "<div class='checklist' id='checklist-items'>";
  steps.forEach(function (s) {
    var doneCls = s.isDone ? " done" : "";
    var doneAt = s.isDone && s.doneAt ? "<span class='checklist-done-at'>" + esc(fmtDate(s.doneAt)) + "</span>" : "";
    html +=
      "<label class='checklist-item" + doneCls + "' data-step-key='" + esc(s.stepKey) + "'>" +
      "<input type='checkbox'" + (s.isDone ? " checked" : "") + " data-step='" + esc(s.stepKey) + "'>" +
      "<span class='checklist-label'>" + esc(s.stepLabel) + "</span>" +
      doneAt +
      "</label>";
  });
  html += "</div>";
  el.innerHTML = html;

  // Wire up toggle handlers.
  el.querySelectorAll("input[data-step]").forEach(function (chk) {
    chk.addEventListener("change", function () {
      var stepKey = chk.getAttribute("data-step");
      toggleChecklistStep(stepKey, chk.checked, chk);
    });
  });
}

/**
 * Load and render the onboarding checklist for customer `c`.
 * `gen` must equal `settingsGeneration` at each await boundary; if the modal
 * has been switched to a different customer in the meantime the result is
 * silently discarded to prevent cross-customer data bleeding into the UI.
 */
async function loadChecklist(c, gen) {
  var el = $("settings-checklist");
  if (!el) return;
  el.innerHTML = "<p class='muted small'>Loading checklist\u2026</p>";
  try {
    var data = await api("/customers/" + c.id + "/checklist");
    // Discard if the modal moved to a different customer while we were waiting.
    if (settingsGeneration !== gen) return;
    renderChecklist(data.checklist || []);
  } catch (err) {
    if (settingsGeneration !== gen) return;
    el.innerHTML = "<p class='muted small'>Could not load checklist: " + esc(err.message) + "</p>";
  }
}

async function toggleChecklistStep(stepKey, isDone, chkEl) {
  if (!settingsCustomer) return;
  // Capture both the customer ID and modal generation at the moment the toggle
  // fires. Any await that follows could let the user switch to a different
  // customer; if that happens we discard the result rather than writing it into
  // the wrong customer's modal or fleet row.
  var capturedId = settingsCustomer.id;
  var capturedGen = settingsGeneration;
  // Optimistic: disable while saving.
  chkEl.disabled = true;
  try {
    var data = await api("/customers/" + capturedId + "/checklist/" + encodeURIComponent(stepKey), {
      method: "PUT",
      body: JSON.stringify({ isDone: isDone }),
    });
    // Bail if the modal has moved to a different customer.
    if (settingsGeneration !== capturedGen) return;
    // Re-render the toggled item from server truth.
    var el = $("settings-checklist");
    if (el) {
      var itemEl = el.querySelector("[data-step-key='" + stepKey + "']");
      if (itemEl) {
        itemEl.className = "checklist-item" + (data.step.isDone ? " done" : "");
        var existing = itemEl.querySelector(".checklist-done-at");
        if (existing) existing.remove();
        if (data.step.isDone && data.step.doneAt) {
          var span = document.createElement("span");
          span.className = "checklist-done-at";
          span.textContent = fmtDate(data.step.doneAt);
          itemEl.appendChild(span);
        }
      }
    }
    // Refresh the progress counter.
    var progress = await api("/customers/" + capturedId + "/checklist");
    // Check again after the second await.
    if (settingsGeneration !== capturedGen) return;
    var steps = progress.checklist || [];
    var done = steps.filter(function (s) { return s.isDone; }).length;
    var total = steps.length;
    var progEl = el && el.querySelector(".checklist-progress");
    if (progEl) {
      var progCls = total === 0 ? "" : done === total ? "prog-done" : "";
      progEl.innerHTML = "<span class='" + progCls + "'>" + done + "</span> / <span class='prog-all'>" + total + "</span> steps complete";
    }
    // Update the fleet table row for this specific customer (by captured ID,
    // not `settingsCustomer` which may now point at another customer).
    var idx = customers.findIndex(function (x) { return x.id === capturedId; });
    if (idx !== -1) {
      customers[idx].checklistProgress = { done: done, total: total };
      renderFleet();
    }
  } catch (err) {
    toast("Could not save: " + err.message, true);
    // Only revert the checkbox if we're still showing the same customer.
    if (settingsGeneration === capturedGen) chkEl.checked = !isDone;
  } finally {
    chkEl.disabled = false;
  }
}

async function openSettings(c) {
  settingsCustomer = c;
  // Increment the modal generation so any in-flight load from the previous
  // customer can detect it is stale and discard its results.
  var myGen = ++settingsGeneration;
  $("settings-title").childNodes[0].textContent = "Remote settings \u2014 " + c.name + " ";
  $("settings-lifecycle").innerHTML = lifecycleBadge(c);
  $("settings-body").innerHTML = "Loading\u2026";
  $("settings-checklist").innerHTML = "";
  $("settings-modal").hidden = false;
  $("settings-history").innerHTML = "";

  // Load checklist independently of the mgmt-secret gate; pass generation so
  // stale results are discarded if the user switches customers quickly.
  loadChecklist(c, myGen);

  if (!c.hasMgmtSecret) {
    $("settings-body").innerHTML =
      "<p class='muted'>No management secret is configured for this customer. Add one via Edit to manage brand, features &amp; plan/billing remotely.</p>";
    await loadHistory(c);
    return;
  }
  try {
    const data = await api("/customers/" + c.id + "/remote-settings");
    if (data.status !== 200) {
      $("settings-body").innerHTML =
        "<p class='error'>Customer backend returned " + data.status +
        ". Check that its CONTROL_PLANE_SHARED_SECRET matches the one stored here.</p>";
      await loadHistory(c);
      return;
    }
    renderSettings(data.remote);
  } catch (err) {
    $("settings-body").innerHTML = "<p class='error'>" + esc(err.message) + "</p>";
  }
  await loadHistory(c);
}

async function loadHistory(c) {
  const el = $("settings-history");
  el.innerHTML = "<h3>Recent remote changes</h3><p class='muted small'>Loading…</p>";
  try {
    const data = await api("/customers/" + c.id + "/remote-settings/history");
    const changes = data.changes || [];
    if (changes.length === 0) {
      el.innerHTML = "<h3>Recent remote changes</h3><p class='muted small'>No remote changes recorded yet.</p>";
      return;
    }
    let html = "<h3>Recent remote changes</h3><ul class='history-list'>";
    changes.forEach(function (ch) {
      html +=
        "<li><span class='badge " + kindBadgeClass(ch.kind) + "'>" + esc(kindLabel(ch.kind)) + "</span> " +
        esc(ch.summary) +
        "<br><span class='muted small'>" + esc(ch.operator) + " · " + fmtDate(ch.createdAt) + "</span></li>";
    });
    html += "</ul>";
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = "<h3>Recent remote changes</h3><p class='muted small'>Could not load history: " + esc(err.message) + "</p>";
  }
}

function renderSettings(remote) {
  const brand = (remote && remote.brand) || {};
  const features = (remote && remote.features) || [];
  const customerConfig = (remote && remote.customerConfig) || {};
  let html = renderPlanBilling(customerConfig);
  html += "<h3>Brand</h3><div class='settings-grid'>";
  html += brandField("companyName", "Company name", brand.companyName);
  html += brandField("shortName", "Short name", brand.shortName);
  html += brandField("tagline", "Tagline", brand.tagline);
  html += brandField("companyLicense", "Company license #", brand.companyLicense);
  html += brandField("appName", "App name", brand.appName);
  html += brandField("colorNavy", "Navy color", brand.colorNavy);
  html += brandField("colorGold", "Gold color", brand.colorGold);
  html += brandField("colorCream", "Cream color", brand.colorCream);
  html += brandField("billingEmail", "Billing email", brand.billingEmail);
  html += brandField("hrEmail", "HR email", brand.hrEmail);
  html += brandField("adminNotifyEmail", "Admin notify email", brand.adminNotifyEmail);
  html += "</div><button id='save-brand' class='primary'>Save brand</button>";

  html += "<h3>Feature flags</h3><div class='features'>";
  features.forEach(function (f) {
    html +=
      "<label class='check'><input type='checkbox' data-feature='" + esc(f.key) + "' " +
      (f.enabled ? "checked" : "") + (f.envDisabled ? " disabled" : "") + "> " + esc(f.key) +
      (f.envDisabled ? " <span class='muted small'>(env-locked)</span>" : "") + "</label>";
  });
  html += "</div><button id='save-features' class='primary'>Save features</button>";

  html += renderAgreements((remote && remote.agreementDocs) || []);
  $("settings-body").innerHTML = html;

  wirePlanBilling();
  wireAgreements();
  $("save-brand").addEventListener("click", saveBrand);
  $("save-features").addEventListener("click", saveFeatures);
}

// ---- Agreement documents (MSA / User Agreement PDFs) ----
var AGREEMENT_LABELS = { msa: "Master Services Agreement", user_agreement: "User Agreement" };

function agreementStatusText(doc) {
  if (!doc || !doc.custom) return "Bundled template in effect — no custom document uploaded.";
  var c = doc.custom;
  var parts = ["Custom PDF: " + esc(c.fileName)];
  if (c.uploadedAt) parts.push("uploaded " + fmtDate(c.uploadedAt));
  if (c.uploadedBy) parts.push("by " + esc(c.uploadedBy));
  if (c.documentSha256) parts.push("SHA-256 " + esc(String(c.documentSha256).slice(0, 12)) + "…");
  return parts.join(" · ");
}

function renderAgreements(docs) {
  var bySlot = {};
  (docs || []).forEach(function (d) {
    bySlot[d.slot] = d;
  });
  var html = "<h3>Signed agreement documents</h3>";
  html += "<p class='muted small'>Upload the executed MSA / User Agreement PDF to replace the bundled template on this customer's backend.</p>";
  html += "<div class='agreements'>";
  ["msa", "user_agreement"].forEach(function (slot) {
    var doc = bySlot[slot];
    html +=
      "<div class='agreement-row'>" +
      "<div><strong>" + esc(AGREEMENT_LABELS[slot]) + "</strong>" +
      "<br><span class='muted small' id='agr-status-" + slot + "'>" + agreementStatusText(doc) + "</span></div>" +
      "<div class='agreement-actions'>" +
      "<input type='file' accept='application/pdf,.pdf' data-agr-file='" + slot + "' style='display:none'>" +
      "<button type='button' class='ghost small' data-agr-upload='" + slot + "'>" +
      (doc && doc.custom ? "Replace PDF" : "Upload PDF") + "</button>" +
      (doc && doc.custom
        ? "<button type='button' class='ghost small danger' data-agr-remove='" + slot + "'>Remove custom PDF</button>"
        : "") +
      "</div></div>";
  });
  html += "</div>";
  return html;
}

function wireAgreements() {
  document.querySelectorAll("[data-agr-upload]").forEach(function (btnEl) {
    var slot = btnEl.getAttribute("data-agr-upload");
    var fileEl = document.querySelector("[data-agr-file='" + slot + "']");
    if (!fileEl) return;
    btnEl.addEventListener("click", function () {
      fileEl.click();
    });
    fileEl.addEventListener("change", function () {
      var file = fileEl.files && fileEl.files[0];
      if (file) uploadAgreement(slot, file, btnEl);
      fileEl.value = "";
    });
  });
  document.querySelectorAll("[data-agr-remove]").forEach(function (btnEl) {
    var slot = btnEl.getAttribute("data-agr-remove");
    btnEl.addEventListener("click", function () {
      removeAgreement(slot, btnEl);
    });
  });
}

function agreementContentType(file) {
  var declared = (file.type || "").trim().toLowerCase();
  if (declared) return declared;
  return /\.pdf$/i.test(file.name) ? "application/pdf" : "application/octet-stream";
}

async function uploadAgreement(slot, file, btnEl) {
  if (!/\.pdf$/i.test(file.name)) {
    toast("Please choose a PDF file", true);
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    toast("PDF exceeds the 15 MB limit", true);
    return;
  }
  var label = btnEl ? btnEl.textContent : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Uploading…";
  }
  try {
    // 1) Ask the customer backend (via the proxy) for a presigned upload URL.
    var minted = await api("/customers/" + settingsCustomer.id + "/remote-settings/agreement-upload-url", {
      method: "POST",
      body: JSON.stringify({ name: file.name, size: file.size, contentType: agreementContentType(file) }),
    });
    if (minted.status !== 200 || !minted.remote || !minted.remote.uploadURL) {
      throw new Error("Backend returned " + minted.status + " requesting an upload URL");
    }
    // 2) PUT the bytes straight to object storage.
    var put = await fetch(minted.remote.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": agreementContentType(file) },
      body: file,
    });
    if (!put.ok) throw new Error("Upload to storage failed (" + put.status + ")");
    // 3) Register the uploaded object as the slot's document.
    var reg = await api("/customers/" + settingsCustomer.id + "/remote-settings/agreements/" + slot, {
      method: "PUT",
      body: JSON.stringify({ fileKey: minted.remote.objectPath, fileName: file.name }),
    });
    if (reg.status !== 200) {
      var msg = reg.remote && (reg.remote.message || reg.remote.error);
      throw new Error(msg || "Backend returned " + reg.status);
    }
    var statusEl = $("agr-status-" + slot);
    if (statusEl) statusEl.textContent = agreementStatusText(reg.remote);
    if (btnEl) label = "Replace PDF";
    toast("Agreement document updated");
    await loadHistory(settingsCustomer);
  } catch (err) {
    toast((err && err.message) || "Upload failed", true);
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = label || "Upload PDF";
    }
  }
}

async function removeAgreement(slot, btnEl) {
  var label = AGREEMENT_LABELS[slot] || slot;
  if (!window.confirm("Remove the custom " + label + " PDF and revert to the bundled template?")) {
    return;
  }
  var prev = btnEl ? btnEl.textContent : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Removing…";
  }
  try {
    var del = await api("/customers/" + settingsCustomer.id + "/remote-settings/agreements/" + slot, {
      method: "DELETE",
    });
    if (del.status !== 200) {
      var msg = del.remote && (del.remote.message || del.remote.error);
      throw new Error(msg || "Backend returned " + del.status);
    }
    var statusEl = $("agr-status-" + slot);
    if (statusEl) statusEl.textContent = agreementStatusText(del.remote);
    if (btnEl && btnEl.parentNode) btnEl.parentNode.removeChild(btnEl);
    var uploadEl = document.querySelector("[data-agr-upload='" + slot + "']");
    if (uploadEl) uploadEl.textContent = "Upload PDF";
    toast("Reverted to bundled template");
    await loadHistory(settingsCustomer);
  } catch (err) {
    toast((err && err.message) || "Remove failed", true);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = prev || "Remove custom PDF";
    }
  }
}

function brandField(key, label, val) {
  return (
    "<label>" + esc(label) +
    "<input data-brand='" + esc(key) + "' type='text' value='" + esc(val || "") + "'></label>"
  );
}

// ---- Plan & billing (commercial config) ----
// Standard preset prices in cents, matching the in-app super-admin Platform page.
var PRESET_CENTS = { starter: 34900, professional: 89900, enterprise: 199500 };

function tierOption(val, label, current) {
  return (
    "<option value='" + esc(val) + "'" +
    ((current || "") === val ? " selected" : "") +
    ">" + esc(label) + "</option>"
  );
}

function renderPlanBilling(config) {
  var c = config || {};
  var priceDollars = c.monthlyPriceCents != null ? String(c.monthlyPriceCents / 100) : "";
  var startDate = c.planStartDate ? String(c.planStartDate).slice(0, 10) : "";
  var html = "<h3>Plan &amp; billing</h3>";
  html += "<div class='preset-row'><span class='muted small'>Presets:</span>";
  html += "<button type='button' class='ghost small' data-preset='starter'>Starter · $349</button>";
  html += "<button type='button' class='ghost small' data-preset='professional'>Professional · $899</button>";
  html += "<button type='button' class='ghost small' data-preset='enterprise'>Enterprise · $1,995</button>";
  html += "<button type='button' class='ghost small' data-preset='custom'>Custom</button>";
  html += "</div>";
  html += "<div class='settings-grid'>";
  html += "<label>Customer name<input id='pb-customerName' type='text' value='" + esc(c.customerName || "") + "'></label>";
  html +=
    "<label>Plan tier<select id='pb-planTier'>" +
    tierOption("", "— not set —", c.planTier) +
    tierOption("starter", "Starter", c.planTier) +
    tierOption("professional", "Professional", c.planTier) +
    tierOption("enterprise", "Enterprise", c.planTier) +
    tierOption("custom", "Custom", c.planTier) +
    "</select></label>";
  html += "<label>Monthly price (USD)<input id='pb-monthlyPrice' type='number' min='0' step='1' placeholder='e.g. 899' value='" + esc(priceDollars) + "'></label>";
  html += "<label>Active officers<input id='pb-officerCount' type='number' min='1' step='1' placeholder='e.g. 47' value='" + esc(c.officerCount != null ? String(c.officerCount) : "") + "'></label>";
  html += "<label>Plan start date<input id='pb-planStartDate' type='date' value='" + esc(startDate) + "'></label>";
  html += "<label>Officer time-edit window (hrs)<input id='pb-timeWindow' type='number' min='0' step='0.25' placeholder='2 (default)' value='" + esc(c.timeConfirmEditWindowHours || "") + "'></label>";
  html += "</div>";
  html += "<div class='pb-fee'>";
  html += "<label class='check'><input id='pb-feeEnabled' type='checkbox' " + (c.processingFeeEnabled ? "checked" : "") + "> Invoice processing fee</label>";
  html += "<label id='pb-feeRate-wrap'>Fee rate %<input id='pb-feeRate' type='number' min='0' max='100' step='0.01' placeholder='8.25 (default)' value='" + esc(c.processingFeeRate || "") + "'></label>";
  html += "</div>";
  html += "<label>Billing notes<textarea id='pb-billingNotes' rows='2'>" + esc(c.billingNotes || "") + "</textarea></label>";
  html += "<button id='save-plan-billing' class='primary'>Save plan &amp; billing</button>";
  return html;
}

function applyPreset(preset) {
  var tierEl = $("pb-planTier");
  if (tierEl) tierEl.value = preset;
  if (preset !== "custom" && PRESET_CENTS[preset] != null) {
    var priceEl = $("pb-monthlyPrice");
    if (priceEl) priceEl.value = String(PRESET_CENTS[preset] / 100);
  }
}

function wirePlanBilling() {
  var save = $("save-plan-billing");
  if (save) save.addEventListener("click", savePlanBilling);
  document.querySelectorAll("[data-preset]").forEach(function (el) {
    el.addEventListener("click", function () {
      applyPreset(el.getAttribute("data-preset"));
    });
  });
  var fee = $("pb-feeEnabled");
  if (fee) {
    var sync = function () {
      var wrap = $("pb-feeRate-wrap");
      if (wrap) wrap.style.display = fee.checked ? "" : "none";
    };
    fee.addEventListener("change", sync);
    sync();
  }
}

function numOrNull(str, isInt) {
  var s = String(str == null ? "" : str).trim();
  if (s === "") return null;
  var n = isInt ? parseInt(s, 10) : parseFloat(s);
  return isNaN(n) ? null : n;
}

// Pull the clearest message out of a failed plan/billing save: the customer
// backend's re-validation issue if present, otherwise the generic error.
function planBillingErrorMessage(err) {
  var b = err && err.body;
  var remote = b && b.remote;
  if (remote && Array.isArray(remote.issues) && remote.issues.length) {
    var i = remote.issues[0];
    var path = Array.isArray(i.path) ? i.path.join(".") : "";
    return (path ? path + ": " : "") + (i.message || "invalid value");
  }
  return (err && err.message) || "Save failed";
}

async function savePlanBilling() {
  var dollars = numOrNull($("pb-monthlyPrice").value, false);
  var rateStr = $("pb-feeRate").value.trim();
  var body = {
    customerName: $("pb-customerName").value.trim() || null,
    planTier: $("pb-planTier").value || null,
    monthlyPriceCents: dollars == null ? null : Math.round(dollars * 100),
    officerCount: numOrNull($("pb-officerCount").value, true),
    planStartDate: $("pb-planStartDate").value || null,
    billingNotes: $("pb-billingNotes").value.trim() || null,
    processingFeeEnabled: $("pb-feeEnabled").checked,
    processingFeeRate: rateStr === "" ? null : rateStr,
    timeConfirmEditWindowHours: $("pb-timeWindow").value.trim(),
  };
  try {
    const r = await api("/customers/" + settingsCustomer.id + "/remote-settings/plan-billing", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (r.status === 200) {
      toast("Plan & billing updated");
      await loadHistory(settingsCustomer);
    } else toast("Backend returned " + r.status, true);
  } catch (err) {
    toast(planBillingErrorMessage(err), true);
  }
}

async function saveBrand() {
  const inputs = document.querySelectorAll("[data-brand]");
  const body = {};
  inputs.forEach(function (el) {
    body[el.getAttribute("data-brand")] = el.value.trim();
  });
  try {
    const r = await api("/customers/" + settingsCustomer.id + "/remote-settings/brand", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (r.status === 200) {
      toast("Brand updated");
      await loadHistory(settingsCustomer);
    } else toast("Backend returned " + r.status, true);
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveFeatures() {
  const inputs = document.querySelectorAll("[data-feature]");
  const updates = [];
  inputs.forEach(function (el) {
    if (el.disabled) return;
    updates.push({ key: el.getAttribute("data-feature"), enabled: el.checked });
  });
  try {
    const r = await api("/customers/" + settingsCustomer.id + "/remote-settings/features", {
      method: "PUT",
      body: JSON.stringify({ updates: updates }),
    });
    if (r.status === 200) {
      toast("Features updated");
      await loadHistory(settingsCustomer);
    } else toast("Backend returned " + r.status, true);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Login ----
async function submitLogin(e) {
  e.preventDefault();
  $("login-error").hidden = true;
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("login-email").value.trim(),
        password: $("login-password").value,
      }),
    });
    setToken(data.token);
    showDash();
    await loadFleet();
  } catch (err) {
    $("login-error").textContent = err.message;
    $("login-error").hidden = false;
  }
}

async function init() {
  $("login-form").addEventListener("submit", submitLogin);
  $("logout").addEventListener("click", function () {
    setToken("");
    showLogin();
  });
  $("add-customer").addEventListener("click", function () {
    openEditor(null);
  });
  $("modal-cancel").addEventListener("click", closeEditor);
  $("customer-form").addEventListener("submit", submitCustomer);
  $("settings-close").addEventListener("click", function () {
    $("settings-modal").hidden = true;
  });
  $("refresh-activity").addEventListener("click", loadActivity);
  $("filter-customer").addEventListener("change", loadActivity);
  $("filter-kind").addEventListener("change", loadActivity);
  $("filter-since").addEventListener("change", loadActivity);
  $("filter-until").addEventListener("change", loadActivity);
  $("clear-filters").addEventListener("click", function () {
    $("filter-customer").value = "";
    $("filter-kind").value = "";
    $("filter-since").value = "";
    $("filter-until").value = "";
    loadActivity();
  });
  $("download-activity").addEventListener("click", downloadActivityCsv);
  $("poll-now").addEventListener("click", async function () {
    toast("Polling…");
    await api("/customers/poll", { method: "POST" });
    await loadFleet();
    toast("Fleet refreshed");
  });
  $("save-fleet-target").addEventListener("click", async function () {
    await api("/settings", {
      method: "PUT",
      body: JSON.stringify({ targetVersion: $("fleet-target").value.trim() }),
    });
    await loadFleet();
    toast("Fleet target saved");
  });

  if (token()) {
    try {
      showDash();
      await loadFleet();
      return;
    } catch (_e) {
      // fall through to login
    }
  }
  showLogin();
}

document.addEventListener("DOMContentLoaded", init);
