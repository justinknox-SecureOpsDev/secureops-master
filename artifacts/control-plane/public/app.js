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

function statusBadge(c) {
  const cls = c.lastStatus === "online" ? "ok" : c.lastStatus === "offline" ? "bad" : "warn";
  const label = c.isActive ? c.lastStatus : "paused";
  return '<span class="badge ' + (c.isActive ? cls : "warn") + '">' + label + "</span>";
}

function renderSummary() {
  const total = customers.length;
  const online = customers.filter(function (c) {
    return c.lastStatus === "online" && c.isActive;
  }).length;
  const needs = customers.filter(function (c) {
    return c.needsUpdate;
  }).length;
  $("summary").innerHTML =
    '<div class="stat"><span class="num">' + total + '</span><span class="lbl">Customers</span></div>' +
    '<div class="stat"><span class="num">' + online + '</span><span class="lbl">Online</span></div>' +
    '<div class="stat ' + (needs ? "alert" : "") + '"><span class="num">' + needs + '</span><span class="lbl">Needs update</span></div>';
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
        "<span class='badge " + (ch.kind === "brand" ? "warn" : "ok") + "'>" + esc(ch.kind) + "</span> " +
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
  $("c-mgmtSecret").value = "";
  $("c-notes").value = c ? c.notes || "" : "";
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

async function deleteCustomer(c) {
  if (!window.confirm("Remove " + c.name + " from the registry? This does not touch their backend.")) return;
  await api("/customers/" + c.id, { method: "DELETE" });
  await loadFleet();
  toast("Removed");
}

// ---- Remote settings ----
let settingsCustomer = null;

async function openSettings(c) {
  settingsCustomer = c;
  $("settings-title").textContent = "Remote settings — " + c.name;
  $("settings-body").innerHTML = "Loading…";
  $("settings-modal").hidden = false;
  $("settings-history").innerHTML = "";
  if (!c.hasMgmtSecret) {
    $("settings-body").innerHTML =
      "<p class='muted'>No management secret is configured for this customer. Add one via Edit to manage brand &amp; features remotely.</p>";
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
        "<li><span class='badge " + (ch.kind === "brand" ? "warn" : "ok") + "'>" + esc(ch.kind) + "</span> " +
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
  let html = "<h3>Brand</h3><div class='settings-grid'>";
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
  $("settings-body").innerHTML = html;

  $("save-brand").addEventListener("click", saveBrand);
  $("save-features").addEventListener("click", saveFeatures);
}

function brandField(key, label, val) {
  return (
    "<label>" + esc(label) +
    "<input data-brand='" + esc(key) + "' type='text' value='" + esc(val || "") + "'></label>"
  );
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
