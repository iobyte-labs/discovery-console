/* The console.
 *
 * It has no backend and no build step beyond Hugo. Every byte it shows comes from
 * api.github.com, fetched with the reader's own fine-grained token, which means the
 * published site can be public while the dataset it reads stays private. Nothing here is
 * persisted anywhere but this browser.
 *
 * Read the gate first (signIn): that is where the one real access decision happens, and it
 * is GitHub's decision, not this page's.
 */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => {
  const n = document.createElement(t);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* The token lives in sessionStorage unless the reader asked to be remembered, in which
 * case it moves to localStorage. Reads check both; writes go to one; clearing empties
 * both, so "sign out" means signed out whichever box it was in. */
const K = { tok: "dc.token", who: "dc.login", theme: "dc.theme" };
const store = {
  get(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch { return null; } },
  set(k, v, persist) { try { (persist ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch {} }
};

const S = {
  token: "", repo: CFG.runner, branch: "main",
  companies: [], generatedAt: null, loadedAt: null,
  countries: [], sectors: [],
  runs: [],
  page: 1, size: 25, open: new Set(), chip: "", timer: null
};

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 172800) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " days ago";
}

function msg(node, kind, text) {
  node.hidden = false;
  node.className = "msg " + kind;
  node.textContent = text;
}

/* ---------------------------------------------------------------- the API */

async function api(path, opts = {}) {
  const r = await fetch("https://api.github.com" + path, {
    ...opts, cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + S.token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {})
    }
  });
  if (r.status === 204) return null;
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).message || ""; } catch {}
    const e = new Error(detail || "HTTP " + r.status);
    e.status = r.status; e.github = detail;
    throw e;
  }
  return r.json();
}

/* Repository files come back raw rather than as base64 inside JSON. That avoids decoding,
 * avoids the mojibake that atob() makes of UTF-8, and sidesteps the Contents API's 1 MB
 * ceiling on the JSON representation. */
async function contents(path) {
  const r = await fetch(`https://api.github.com/repos/${S.repo}/contents/${path}`, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github.raw",
      Authorization: "Bearer " + S.token,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    let m = ""; try { m = (await r.clone().json()).message || ""; } catch {}
    const e = new Error(m ? `${path}: ${m}` : `Could not read ${path} (HTTP ${r.status})`);
    e.status = r.status; e.github = m;
    throw e;
  }
  return r.text();
}

async function listDir(path) {
  try {
    const rows = await api(`/repos/${S.repo}/contents/${path}`);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function dispatch(workflow, inputs) {
  await api(`/repos/${S.repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: S.branch, inputs })
  });
}

/* ---------------------------------------------------------------- sign in */

async function signIn(token, remember) {
  S.token = token.trim();
  if (!S.token) throw new Error("Paste your access token.");

  // GitHub decides this, not the page: a token that cannot read the repository gets a 404
  // here and never reaches the data. Everything below is about saying so clearly.
  const repo = await api(`/repos/${S.repo}`);
  S.branch = repo.default_branch || "main";

  const permissions = repo.permissions || {};
  if (CFG.requireAdmin && !permissions.admin) {
    throw new Error(
      "This token can reach the repository but does not administer it, and this console " +
      "is limited to its owner. Use a token created by the repository's owner."
    );
  }

  let login = "";
  try { login = (await api("/user")).login; } catch { login = "signed in"; }

  // Nothing is written unless the reader asked to be remembered.
  store.set(K.tok, S.token, remember);
  store.set(K.who, login, remember);

  const pill = $("#repoPill");
  pill.hidden = false;
  pill.textContent = repo.private ? "private" : "⚠ public repo";
  pill.className = "pill " + (repo.private ? "ok" : "bad");
  $("#whoTxt").textContent = login;
  $("#actionsLink").href = $("#actionsLink2").href = `https://github.com/${S.repo}/actions`;

  $("#splash").hidden = true;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#btnOut").hidden = false;
  $("#btnRefresh").hidden = false;

  buildTabs();
  await refresh();
}

function signOut() {
  store.del(K.tok); store.del(K.who);
  S.token = ""; S.companies = [];
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  $("#app").hidden = true;
  $("#btnOut").hidden = true;
  $("#btnRefresh").hidden = true;
  $("#repoPill").hidden = true;
  $("#whoTxt").textContent = "";
  $("#inTok").value = "";
  $("#gate").hidden = false;
}

/* ---------------------------------------------------------------- loading */

async function refresh() {
  const [dataset, countries, sectors] = await Promise.all([
    contents("data/companies.json").catch(e => { throw e; }),
    listDir("config/countries"),
    listDir("config/sectors"),
    loadRuns().catch(() => {})
  ]);

  S.countries = countries.filter(f => /\.ya?ml$/.test(f.name)).map(f => f.name.replace(/\.ya?ml$/, ""));
  S.sectors = sectors.filter(f => /\.ya?ml$/.test(f.name)).map(f => f.name.replace(/\.ya?ml$/, ""));

  if (!dataset) {
    S.companies = []; S.generatedAt = null;
  } else {
    const envelope = JSON.parse(dataset);
    // The same check the private consumer makes. A file this console cannot read is better
    // refused than half-understood.
    const major = v => String(v || "").split("/")[0] + "/" + String(v || "").split("/")[1];
    if (major(envelope.schema_version) !== major(CFG.schema)) {
      throw new Error(
        `The dataset is schema ${envelope.schema_version}, and this console reads ` +
        `${CFG.schema}. Update the console.`
      );
    }
    S.companies = envelope.companies || [];
    S.generatedAt = envelope.generated_at || null;
  }
  S.loadedAt = new Date().toISOString();

  fillFilters();
  fillAddForm();
  renderOverview();
  renderCompanies();
  renderSources();
}

async function loadRuns() {
  const data = await api(`/repos/${S.repo}/actions/runs?per_page=10`);
  S.runs = data.workflow_runs || [];
  renderRuns();
}

/* ---------------------------------------------------------------- tabs */

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "companies", label: "Companies" },
  { id: "sources", label: "Sources" },
  { id: "runs", label: "Runs" }
];

function buildTabs() {
  const nav = $("#tabs");
  nav.textContent = "";
  for (const t of TABS) {
    const b = el("button", null, t.label);
    b.type = "button";
    b.id = "tab-" + t.id;
    b.addEventListener("click", () => showTab(t.id));
    nav.append(b);
  }
  const wanted = location.hash.slice(1);
  showTab(TABS.some(t => t.id === wanted) ? wanted : "overview");
}

function showTab(id) {
  for (const t of TABS) {
    $("#v-" + t.id).hidden = t.id !== id;
    const b = $("#tab-" + t.id);
    if (t.id === id) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  history.replaceState(null, "", "#" + id);
  window.scrollTo(0, 0);
}

function setBadge(id, n) {
  const b = $("#tab-" + id);
  if (!b) return;
  const old = b.querySelector(".badge");
  if (old) old.remove();
  if (n) b.append(el("span", "badge", String(n)));
}

/* ---------------------------------------------------------------- vocabulary */

const STATUS = {
  not_attempted: { label: "Not visited yet", cls: "mute", color: "var(--border)" },
  ok: { label: "Read", cls: "ok", color: "var(--ok)" },
  blocked: { label: "Refused access", cls: "warn", color: "var(--warn)" },
  refused: { label: "Refused by our rules", cls: "info", color: "var(--info)" },
  error: { label: "Could not be read", cls: "bad", color: "var(--bad)" }
};
const ORDER = ["ok", "not_attempted", "blocked", "refused", "error"];
const KIND = { recruitment: "recruitment", hr: "HR", general: "general inbox", other: "other" };

const best = c => (c.contacts || [])[0] || null;

// A label is a judgement — today a model's — and is kept well away from the fields that
// record what a page actually said. The console shows it as an opinion, with what decided
// it, so a reader can disagree.
const MEMBERSHIP = "sector_membership";
const LABEL_TEXT = {
  member: "works in the sector",
  service_provider: "sells services to it",
  unrelated: "unrelated",
  unknown: "could not tell"
};
const labelOf = (c, kind) => (c.labels || []).find(l => l.kind === kind) || null;
const sectorsOf = c => c.sectors || [];
const assocsOf = c => (c.sources || []).map(s => s.association_slug);

/* ---------------------------------------------------------------- overview */

function renderOverview() {
  const total = S.companies.length;
  const withContact = S.companies.filter(c => (c.contacts || []).length).length;
  const recruitment = S.companies.filter(c => (c.contacts || []).some(x => x.kind === "recruitment")).length;
  const careers = S.companies.filter(c => c.careers_url).length;
  const blocked = S.companies.filter(c => c.crawl_status === "blocked").length;
  const waiting = S.companies.filter(c => (c.crawl_status || "not_attempted") === "not_attempted").length;

  const tiles = [
    { n: total, l: "companies", c: "acc", go: {} },
    { n: withContact, l: "with a contact", c: "ok", go: { contact: "has" } },
    { n: recruitment, l: "recruitment address", c: "ok", go: { contact: "recruitment" } },
    { n: careers, l: "careers page found", c: "info", go: {} },
    { n: waiting, l: "not visited yet", c: "mute", go: { status: "not_attempted" } },
    { n: blocked, l: "refused access", c: "warn", go: { status: "blocked" } }
  ];
  const box = $("#tiles");
  box.textContent = "";
  for (const t of tiles) {
    const b = el("button", "tile " + t.c);
    b.type = "button";
    b.append(el("b", null, String(t.n)), el("span", null, t.l));
    // Clicking a number should take you to the rows behind it.
    b.addEventListener("click", () => {
      $("#fStatus").value = t.go.status || "";
      $("#fContact").value = t.go.contact || "";
      S.chip = ""; S.page = 1;
      renderChips(); renderCompanies(); showTab("companies");
    });
    box.append(b);
  }

  const counts = {};
  for (const c of S.companies) {
    const k = c.crawl_status || "not_attempted";
    counts[k] = (counts[k] || 0) + 1;
  }
  const meter = $("#meter"), legend = $("#legend");
  meter.textContent = ""; legend.textContent = "";
  for (const k of ORDER) {
    const n = counts[k];
    if (!n) continue;
    const bar = el("span");
    bar.style.cssText = `width:${(n / total) * 100}%;background:${STATUS[k].color}`;
    bar.title = `${STATUS[k].label}: ${n}`;
    meter.append(bar);
    const item = el("span");
    const swatch = el("i");
    swatch.style.background = STATUS[k].color;
    item.append(swatch, document.createTextNode(STATUS[k].label + " "), el("span", "num", String(n)));
    legend.append(item);
  }

  $("#dataAge").textContent = S.generatedAt
    ? `crawled ${ago(S.generatedAt)}`
    : "no dataset yet";

  const next = $("#next");
  next.textContent = "";
  const say = (kind, text, action, go) => {
    const row = el("div", "next");
    row.append(el("span", "pill " + kind, "•"));
    const body = el("div", "grow");
    body.append(el("p", null, text));
    row.append(body);
    if (action) {
      const b = el("button", "ghost", action);
      b.type = "button";
      b.addEventListener("click", go);
      row.append(b);
    }
    next.append(row);
  };

  if (!total) {
    say("info", "No dataset yet. Add an association, then start a crawl.", "Add a source",
      () => showTab("sources"));
  } else if (waiting) {
    say("info", `${waiting} companies have never been visited. The next crawl will read them.`,
      "Start a crawl", () => showTab("runs"));
  } else if (!withContact) {
    say("warn", "Every company has been visited and none published a contact. Worth checking a few by hand.",
      "See companies", () => showTab("companies"));
  } else {
    say("ok", `${withContact} of ${total} companies published a contact.`, "See them",
      () => { $("#fContact").value = "has"; S.page = 1; renderCompanies(); showTab("companies"); });
  }
  if (blocked) {
    say("warn", `${blocked} sites refused automated access. That is a result, not a problem to work around.`,
      "See which", () => { $("#fStatus").value = "blocked"; S.page = 1; renderCompanies(); showTab("companies"); });
  }
}

/* ---------------------------------------------------------------- companies */

function option(value, label) {
  const o = el("option", null, label);
  o.value = value;
  return o;
}

function fillFilters() {
  const countries = [...new Set(S.companies.map(c => c.country).filter(Boolean))].sort();
  const sectors = [...new Set(S.companies.flatMap(sectorsOf))].sort();

  const fill = (sel, all, values, labeller = v => v) => {
    const keep = sel.value;
    sel.textContent = "";
    sel.append(option("", all));
    for (const v of values) sel.append(option(v, labeller(v)));
    if (values.includes(keep)) sel.value = keep;
  };
  fill($("#fCountry"), "Any country", countries, v => v.toUpperCase());
  fill($("#fSector"), "Any sector", sectors);
  fill($("#fStatus"), "Any status", ORDER.filter(k => S.companies.some(c => (c.crawl_status || "not_attempted") === k)),
    v => STATUS[v].label);
}

const CHIPS = [
  { id: "", label: "All" },
  { id: "recruitment", label: "Can be applied to" },
  { id: "careers", label: "Has a careers page" },
  { id: "nocontact", label: "No contact yet" },
  { id: "blocked", label: "Refused access" }
];

function renderChips() {
  const box = $("#chips");
  box.textContent = "";
  for (const c of CHIPS) {
    const b = el("button", "chip", c.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(S.chip === c.id));
    b.addEventListener("click", () => { S.chip = c.id; S.page = 1; renderChips(); renderCompanies(); });
    box.append(b);
  }
}

function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const country = $("#fCountry").value, sector = $("#fSector").value;
  const status = $("#fStatus").value, contact = $("#fContact").value;
  const quality = $("#fQuality").value, sort = $("#fSort").value;
  const kind = $("#fLabel").value;

  let rows = S.companies.filter(c => {
    const contacts = c.contacts || [];
    if (country && c.country !== country) return false;
    if (sector && !sectorsOf(c).includes(sector)) return false;
    if (status && (c.crawl_status || "not_attempted") !== status) return false;
    if (quality && c.data_quality !== quality) return false;
    if (kind) {
      const judged = labelOf(c, MEMBERSHIP);
      if (kind === "none" && judged) return false;
      if (kind !== "none" && (!judged || judged.label !== kind)) return false;
    }
    if (contact === "has" && !contacts.length) return false;
    if (contact === "none" && contacts.length) return false;
    if (["recruitment", "hr"].includes(contact) && !contacts.some(x => x.kind === contact)) return false;
    if (contact === "general" && !(contacts.length && contacts.every(x => x.kind === "general"))) return false;

    if (S.chip === "recruitment" && !contacts.some(x => x.kind === "recruitment")) return false;
    if (S.chip === "careers" && !c.careers_url) return false;
    if (S.chip === "nocontact" && contacts.length) return false;
    if (S.chip === "blocked" && c.crawl_status !== "blocked") return false;

    if (q) {
      const hay = [c.name, c.canonical_domain, c.website, c.region, c.description,
        ...contacts.map(x => x.address), ...sectorsOf(c)].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const byName = (a, b) => a.name.localeCompare(b.name);
  const rank = { high: 0, medium: 1, low: 2 };
  if (sort === "quality") rows.sort((a, b) => (rank[a.data_quality] ?? 3) - (rank[b.data_quality] ?? 3) || byName(a, b));
  else if (sort === "checked") rows.sort((a, b) => String(b.last_checked_at || "").localeCompare(String(a.last_checked_at || "")) || byName(a, b));
  else if (sort === "country") rows.sort((a, b) => (a.country || "").localeCompare(b.country || "") || byName(a, b));
  else rows.sort(byName);
  return rows;
}

function renderCompanies() {
  const rows = filtered();
  const wrap = $("#tableWrap");
  wrap.textContent = "";
  setBadge("companies", rows.length !== S.companies.length ? rows.length : 0);

  if (!S.companies.length) {
    wrap.append(el("p", "empty", "No dataset yet. Add an association and start a crawl."));
    $("#pager").textContent = "";
    return;
  }
  if (!rows.length) {
    wrap.append(el("p", "empty", "Nothing matches these filters."));
    $("#pager").textContent = "";
    return;
  }

  const pages = Math.max(1, Math.ceil(rows.length / S.size));
  if (S.page > pages) S.page = pages;
  const slice = rows.slice((S.page - 1) * S.size, S.page * S.size);

  const table = el("table");
  const head = el("tr");
  for (const h of ["Company", "Where", "Contact", "Status"]) head.append(el("th", null, h));
  table.append(el("thead").appendChild(head).parentNode);
  const body = el("tbody");

  const groupBy = $("#fGroup").value;
  let lastGroup = null;
  for (const c of slice) {
    if (groupBy) {
      const g = groupBy === "country" ? (c.country || "—").toUpperCase()
        : groupBy === "sectors" ? (sectorsOf(c).join(", ") || "—")
          : (assocsOf(c).join(", ") || "—");
      if (g !== lastGroup) {
        const hr = el("tr", "grouphead");
        const td = el("td", null, g);
        td.colSpan = 4;
        hr.append(td);
        body.append(hr);
        lastGroup = g;
      }
    }
    body.append(companyRow(c, body));
  }
  table.append(body);
  wrap.append(table);

  renderPager(rows.length, pages);
}

function companyRow(c, body) {
  const tr = el("tr", "company");
  const name = el("td");
  name.append(el("span", "gname", c.name));
  if (c.canonical_domain) name.append(el("span", "gsub", c.canonical_domain));
  tr.append(name);

  const where = el("td");
  where.append(document.createTextNode((c.country || "").toUpperCase() + (c.region ? " · " + c.region : "")));
  const secs = sectorsOf(c);
  if (secs.length) where.append(el("span", "gsub", secs.join(", ")));
  tr.append(where);

  const contactCell = el("td");
  const b = best(c);
  if (b) {
    contactCell.append(el("span", "mono", b.address));
    contactCell.append(el("span", "gsub", KIND[b.kind] || b.kind));
  } else {
    contactCell.append(el("span", "muted", "—"));
  }
  tr.append(contactCell);

  const st = STATUS[c.crawl_status || "not_attempted"] || STATUS.not_attempted;
  const statusCell = el("td");
  statusCell.append(el("span", "pill " + st.cls, st.label));
  tr.append(statusCell);

  tr.addEventListener("click", () => {
    const open = tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains("detail");
    if (open) { tr.nextSibling.remove(); S.open.delete(c.company_id); return; }
    S.open.add(c.company_id);
    body.insertBefore(detailRow(c), tr.nextSibling);
  });
  if (S.open.has(c.company_id)) setTimeout(() => body.insertBefore(detailRow(c), tr.nextSibling), 0);
  return tr;
}

function detailRow(c) {
  const tr = el("tr", "detail");
  const td = el("td");
  td.colSpan = 4;
  const box = el("div", "detailbody");

  const block = (title, build) => {
    const d = el("div", "block");
    d.append(el("h4", null, title));
    build(d);
    box.append(d);
  };

  block("About", d => {
    if (c.description) d.append(el("p", null, c.description));
    else d.append(el("p", "muted", "The directory gave no description."));
    const tags = el("div");
    for (const k of (c.keywords || [])) tags.append(el("span", "tag", k));
    for (const s of sectorsOf(c)) tags.append(el("span", "tag", s));
    if (tags.children.length) d.append(tags);
  });

  block("Links", d => {
    const ul = el("ul");
    const link = (label, href) => {
      if (!href) return;
      const li = el("li");
      const a = el("a", null, label);
      a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
      li.append(a);
      ul.append(li);
    };
    link("Website", c.website);
    link("Careers page", c.careers_url);
    if (!ul.children.length) ul.append(el("li", "muted", "No website recorded."));
    d.append(ul);
  });

  block(`Contacts (${(c.contacts || []).length})`, d => {
    if (!(c.contacts || []).length) {
      d.append(el("p", "muted", "This company published no functional address on the pages that were read."));
      return;
    }
    for (const x of c.contacts) {
      const row = el("div", "contact");
      row.append(el("span", "addr", x.address));
      row.append(el("span", "prov",
        `${KIND[x.kind] || x.kind} · ${x.verification} · read from ${x.found_on_url || "an unnamed page"}` +
        (x.found_at ? ` on ${String(x.found_at).slice(0, 10)}` : "")));
      d.append(row);
    }
  });

  const judged = labelOf(c, MEMBERSHIP);
  if (judged) {
    block("Judged to be", d => {
      d.append(el("p", null, LABEL_TEXT[judged.label] || judged.label));
      if (judged.reason) d.append(el("p", "muted", judged.reason));
      // Said plainly: this is an opinion, and whose.
      d.append(el("p", "muted",
        `an opinion from ${judged.source}, not something the page states` +
        (judged.created_at ? ` · ${String(judged.created_at).slice(0, 10)}` : "")));
    });
  }

  block("Provenance", d => {
    const ul = el("ul");
    for (const s of (c.sources || [])) {
      ul.append(el("li", null, `${s.association_slug} — ${s.source_url}`));
    }
    if (!ul.children.length) ul.append(el("li", "muted", "No source recorded."));
    d.append(ul);
    const bits = [`quality: ${c.data_quality || "low"}`];
    if (c.last_checked_at) bits.push(`last visited ${ago(c.last_checked_at)}`);
    if (c.first_seen_at) bits.push(`first seen ${String(c.first_seen_at).slice(0, 10)}`);
    d.append(el("p", "muted", bits.join(" · ")));
    if (c.crawl_error) d.append(el("p", "muted", c.crawl_error));
  });

  td.append(box);
  tr.append(td);
  return tr;
}

function renderPager(total, pages) {
  const box = $("#pager");
  box.textContent = "";
  const from = (S.page - 1) * S.size + 1;
  const to = Math.min(total, S.page * S.size);

  const prev = el("button", "ghost", "Previous");
  prev.type = "button";
  prev.disabled = S.page <= 1;
  prev.addEventListener("click", () => { S.page--; renderCompanies(); });

  const next = el("button", "ghost", "Next");
  next.type = "button";
  next.disabled = S.page >= pages;
  next.addEventListener("click", () => { S.page++; renderCompanies(); });

  const size = el("select");
  for (const n of [25, 50, 100, 250]) size.append(option(String(n), n + " per page"));
  size.value = String(S.size);
  size.addEventListener("change", () => { S.size = +size.value; S.page = 1; renderCompanies(); });

  box.append(prev, next, el("span", "grow num", `${from}–${to} of ${total}`), size);
}

/* ---------------------------------------------------------------- sources */

function fillAddForm() {
  const fill = (sel, values) => {
    const keep = sel.value;
    sel.textContent = "";
    sel.append(option("", "Choose…"));
    for (const v of values) sel.append(option(v, v));
    if (values.includes(keep)) sel.value = keep;
  };
  // Straight from the runner's config directories, so the form can only offer a value
  // that `eucd config validate` will accept.
  fill($("#aCountry"), S.countries);
  fill($("#aSector"), S.sectors);
}

function renderSources() {
  const box = $("#sources");
  box.textContent = "";
  const counts = new Map();
  for (const c of S.companies) {
    for (const slug of new Set(assocsOf(c))) counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  if (!counts.size) {
    box.append(el("p", "muted", "No source has produced a company yet."));
    return;
  }
  for (const [slug, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const row = el("div", "srow");
    row.append(el("span", "slug grow", slug));
    row.append(el("span", "num muted", `${n} companies`));
    const b = el("button", "ghost", "See them");
    b.type = "button";
    b.addEventListener("click", () => {
      $("#q").value = ""; $("#fGroup").value = "association";
      S.chip = ""; S.page = 1;
      renderChips(); renderCompanies(); showTab("companies");
    });
    row.append(b);
    box.append(row);
  }
}

/* ---------------------------------------------------------------- runs */

function renderRuns() {
  for (const id of ["#runs", "#runs2"]) {
    const box = $(id);
    if (!box) continue;
    box.textContent = "";
    if (!S.runs.length) { box.append(el("p", "muted", "No runs yet.")); continue; }
    for (const r of S.runs) {
      const row = el("div", "run");
      const done = r.status === "completed";
      const good = r.conclusion === "success";
      const cls = !done ? "info" : good ? "ok" : "bad";
      const label = !done ? r.status : (r.conclusion || "—");
      const pill = el("span", "pill " + cls, label);
      if (!done) pill.prepend(el("i", "dot"));
      row.append(pill);
      const a = el("a", "grow", r.name || r.display_title || "run");
      a.href = r.html_url; a.target = "_blank"; a.rel = "noopener noreferrer";
      row.append(a, el("span", "when", ago(r.created_at)));
      box.append(row);
    }
  }
  const busy = S.runs.some(r => r.status === "in_progress" || r.status === "queued");
  $("#busyPill").hidden = !busy;
  // Poll only while something is actually running, and stop by itself afterwards.
  if (busy && !S.timer) S.timer = setInterval(() => { loadRuns().catch(() => {}); }, 20000);
  if (!busy && S.timer) { clearInterval(S.timer); S.timer = null; }
}

/* ---------------------------------------------------------------- wiring */

function explain(e) {
  if (e.status === 403 && /not accessible by personal access token/i.test(e.github || "")) {
    return "The token is valid but missing a permission. It needs Contents → Read-only and " +
      "Actions → Read and write on " + CFG.runner + ".";
  }
  if (e.status === 403) return "GitHub refused this. The organisation may be blocking the token.";
  if (e.status === 404) {
    return "The token cannot see " + CFG.runner + ". Check it was created for that repository, " +
      "with the organisation as the resource owner.";
  }
  if (e.status === 401) return "The token has expired or was revoked. Paste a new one.";
  return e.message || String(e);
}

document.addEventListener("DOMContentLoaded", () => {
  $("#runnerName").textContent = CFG.runner;
  $("#ownerName").textContent = CFG.runner.split("/")[0];
  $("#repoNameShort").textContent = CFG.runner.split("/")[1];

  $("#btnTheme").addEventListener("click", () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.getAttribute("data-theme") || (dark ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(K.theme, next); } catch {}
  });
  $("#btnOut").addEventListener("click", signOut);
  $("#btnRefresh").addEventListener("click", () => {
    refresh().catch(e => alert(explain(e)));
  });

  $("#gateForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const btn = $("#btnIn");
    btn.disabled = true;
    $("#gateMsg").hidden = true;
    try {
      await signIn($("#inTok").value, $("#inRemember").checked);
    } catch (e) {
      msg($("#gateMsg"), "bad", explain(e));
      S.token = "";
    } finally {
      btn.disabled = false;
    }
  });

  const rerender = debounce(() => { S.page = 1; renderCompanies(); }, 160);
  $("#q").addEventListener("input", rerender);
  for (const id of ["#fCountry", "#fSector", "#fStatus", "#fContact", "#fQuality", "#fLabel",
    "#fGroup", "#fSort"]) {
    $(id).addEventListener("change", () => { S.page = 1; renderCompanies(); });
  }
  $("#btnClear").addEventListener("click", () => {
    $("#q").value = "";
    for (const id of ["#fCountry", "#fSector", "#fStatus", "#fContact", "#fQuality",
      "#fLabel", "#fGroup"]) $(id).value = "";
    $("#fSort").value = "name";
    S.chip = ""; S.page = 1;
    renderChips(); renderCompanies();
  });

  $("#addForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const btn = $("#btnAdd");
    btn.disabled = true;
    try {
      await dispatch("add-source.yml", {
        url: $("#aUrl").value.trim(),
        country: $("#aCountry").value,
        sector: $("#aSector").value,
        name: $("#aName").value.trim(),
        disabled_reason: $("#aReason").value.trim()
      });
      msg($("#addMsg"), "ok",
        "Sent. GitHub is writing the config file now; it appears in Runs in a moment, and the " +
        "next crawl reads it.");
      $("#aUrl").value = ""; $("#aName").value = ""; $("#aReason").value = "";
      setTimeout(() => loadRuns().catch(() => {}), 2500);
    } catch (e) {
      msg($("#addMsg"), "bad", explain(e));
    } finally {
      btn.disabled = false;
    }
  });

  $("#btnCrawl").addEventListener("click", async () => {
    const btn = $("#btnCrawl");
    btn.disabled = true;
    try {
      await dispatch("pipeline.yml", { dry_run: $("#crawlDry").checked ? "true" : "false" });
      msg($("#crawlMsg"), "ok", "Crawl started. It appears below in a moment.");
      setTimeout(() => loadRuns().catch(() => {}), 2500);
    } catch (e) {
      msg($("#crawlMsg"), "bad", explain(e));
    } finally {
      btn.disabled = false;
    }
  });

  renderChips();

  // Boot: apply the saved theme, then sign in silently if a token was remembered.
  try {
    const t = localStorage.getItem(K.theme);
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch {}

  const saved = store.get(K.tok);
  if (!saved) {
    $("#splash").hidden = true;
    $("#gate").hidden = false;
    return;
  }
  // The field is never re-populated with the stored token: there is no reason for a secret
  // to sit in the DOM.
  signIn(saved, !!localStorage.getItem(K.tok)).catch(e => {
    store.del(K.tok); store.del(K.who);
    $("#splash").hidden = true;
    $("#gate").hidden = false;
    msg($("#gateMsg"), "warn", "Your saved session is no longer valid. " + explain(e));
  });
});
