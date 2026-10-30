(() => {
const api = window.lumen;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const base = (p) => p.split("/").pop();

const state = {
  info: null,
  workspace: "",
  tabs: [],            // { path, text, savedText }
  active: null,
  pending: null,       // { path, before, after, label, onAccept, onReject }
  chats: [],           // chat tabs from the main process: { id, title, running, closed, used, updatedAt }
  chat: null,          // the chat shown in the Claude panel
  expanded: new Set(),
  fileIndex: null,
  attachments: [],     // { path, dir } dragged into the chat, or { label, text } from the terminal
  terms: [],           // { id, x, fit, el, title, n } integrated terminals
  activeTerm: null,
  git: null,           // last git status for the workspace
  view: "files",       // sidebar view: files | scm
};

/* ---------- language + highlighting ---------- */
const LANG = { ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", mjs: "JavaScript", cjs: "JavaScript", css: "CSS", scss: "SCSS", json: "JSON", md: "Markdown", html: "HTML", py: "Python", php: "PHP", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", sh: "Shell", zsh: "Shell", yml: "YAML", yaml: "YAML", sql: "SQL", csv: "CSV", swift: "Swift", c: "C", h: "C", cpp: "C++", toml: "TOML" };
const DOT = { ts: "#3f7fd0", tsx: "#3f7fd0", js: "#d4b23c", jsx: "#d4b23c", mjs: "#d4b23c", css: "#a65fd6", json: "#c08a3e", md: "#7d8899", html: "#d8653c", py: "#4a9a6b", php: "#7a86c2", go: "#3ba6c4", rs: "#c56a3c", sql: "#c08a3e", csv: "#4a9a6b", sh: "#6f8f6a", yml: "#b05a7a", yaml: "#b05a7a" };
const ext = (p) => (p.includes(".") ? p.split(".").pop() : "").toLowerCase();
const langOf = (p) => LANG[ext(p)] || "Plain text";
const HASH_COMMENT = new Set(["py", "sh", "zsh", "rb", "yml", "yaml", "toml", "php"]);
const KW = "import export from const let var function return if else elif for while of in new class extends interface type enum as async await try catch except finally throw raise default switch case break continue true false null undefined this self typeof instanceof void public private protected readonly static implements def lambda None True False package func struct fn pub use mod impl match echo select where insert update delete create table and or not".split(" ");
const TOKRE = new RegExp(
  "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*|--[^\\n]*)" +
  "|(`(?:\\\\[\\s\\S]|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*')" +
  "|\\b(\\d+(?:\\.\\d+)?)\\b" +
  "|\\b(" + KW.join("|") + ")\\b" +
  "|([A-Za-z_$][\\w$]*)(?=\\s*\\()", "g");
function highlight(src, p) {
  const e = ext(p || "");
  if (src.length > 400000) return esc(src);
  if (e === "md") return esc(src).replace(/^(#{1,6} .*)$/gm, '<span class="t-kw">$1</span>').replace(/^(\s*[-*] )/gm, '<span class="t-num">$1</span>');
  if (e === "csv" || e === "txt" || e === "log" || !e) return esc(src);
  let out = "", last = 0, m;
  TOKRE.lastIndex = 0;
  while ((m = TOKRE.exec(src))) {
    if (m[1]) {
      if (m[1][0] === "#" && !HASH_COMMENT.has(e)) { TOKRE.lastIndex = m.index + 1; continue; }
      if (m[1].startsWith("--") && e !== "sql") { TOKRE.lastIndex = m.index + 2; continue; }
    }
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? "com" : m[2] ? (e === "json" && /^\s*:/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 4)) ? "prop" : "str") : m[3] ? "num" : m[4] ? "kw" : "fn";
    out += `<span class="t-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}

/* ---------- explorer ---------- */
const CHEV = '<svg class="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
async function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  await renderDir(tree, state.workspace, 0);
  decorateTree();
}
async function renderDir(container, dir, depth) {
  let entries;
  try { entries = await api.list(dir); }
  catch (e) { container.insertAdjacentHTML("beforeend", `<div class="muted" style="padding-left:${12 + depth * 14}px">Can't open this folder</div>`); return; }
  if (!entries.length) { container.insertAdjacentHTML("beforeend", `<div class="muted" style="padding-left:${28 + depth * 14}px">Empty</div>`); return; }
  for (const en of entries.slice(0, 2000)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row" + (en.dir ? " dir" : "") + (en.path === state.active ? " active" : "");
    b.style.paddingLeft = (8 + depth * 14) + "px";
    b.dataset.path = en.path;
    b.title = en.path;
    b.dataset.dir = en.dir ? "1" : "";
    b.draggable = true;
    b.addEventListener("dragstart", (e) => { dragPath(e, en.path, en.dir); treeDrag = en.path; b.classList.add("dragging"); });
    b.addEventListener("dragend", () => { treeDrag = null; b.classList.remove("dragging"); clearTreeDrop(); });
    b.innerHTML = en.dir ? `${CHEV}${esc(en.name)}` : `<span style="width:12px"></span><span class="dot" style="background:${DOT[ext(en.name)] || "var(--faint)"}"></span>${esc(en.name)}`;
    container.appendChild(b);
    if (en.dir) {
      const kids = document.createElement("div");
      kids.hidden = true;
      container.appendChild(kids);
      const toggle = async () => {
        const open = kids.hidden;
        kids.hidden = !open;
        b.classList.toggle("open", open);
        if (open) { state.expanded.add(en.path); if (!kids.childElementCount) { await renderDir(kids, en.path, depth + 1); decorateTree(); } }
        else state.expanded.delete(en.path);
      };
      b.onclick = toggle;
      if (state.expanded.has(en.path)) await toggle();
    } else {
      b.onclick = () => openFile(en.path);
    }
  }
}
// New files an agent writes appear in the explorer; batched because agents write in bursts.
let treeTimer = null;
function scheduleTree(p) {
  if (treeTimer || [...treeEl.querySelectorAll(".row")].some((r) => r.dataset.path === p)) return;
  treeTimer = setTimeout(() => { treeTimer = null; renderTree(); }, 600);
}
function markActiveInTree() {
  document.querySelectorAll("#tree .row.active").forEach((r) => r.classList.remove("active"));
  if (!state.active) return;
  const r = [...document.querySelectorAll("#tree .row")].find((x) => x.dataset.path === state.active);
  if (r) r.classList.add("active");
}

async function setWorkspace(ws) {
  state.workspace = ws;
  state.expanded.clear();
  state.fileIndex = null;
  const home = state.info.home;
  const pretty = ws.startsWith(home) ? "~" + ws.slice(home.length) : ws;
  $("wsName").textContent = base(ws) || ws;
  $("wsPath").textContent = pretty || "~";
  $("wsPath").title = ws;
  await renderTree();
  refreshGit();
}

/* ---------- tabs + editor ---------- */
const ta = $("ta"), hl = $("hl"), gutter = $("gutter");
const tab = (p = state.active) => state.tabs.find((t) => t.path === p);
function renderTabs() {
  const el = $("tabs");
  el.innerHTML = "";
  for (const t of state.tabs) {
    const d = document.createElement("div");
    d.className = "tab" + (t.path === state.active ? " active" : "");
    d.title = t.path;
    d.draggable = true;
    d.dataset.path = t.path;
    d.addEventListener("dragstart", (e) => { dragPath(e, t.path, false); e.dataTransfer.setData(TAB_DRAG, t.path); d.classList.add("dragging"); });
    d.addEventListener("dragend", () => { d.classList.remove("dragging"); clearTabDrop(); });
    const dirty = t.text !== t.savedText;
    d.innerHTML = `<span class="dot" style="background:${DOT[ext(t.path)] || "var(--faint)"}"></span><button type="button" class="nm">${esc(base(t.path))}${dirty ? " •" : ""}</button><button type="button" class="x" aria-label="Close"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
    d.querySelector(".nm").onclick = () => activate(t.path);
    d.querySelector(".x").onclick = () => closeTab(t.path);
    el.appendChild(d);
  }
}
function renderEditor() {
  const t = tab();
  $("emptyEditor").hidden = !!t;
  $("codeWrap").hidden = !t;
  $("fileMsg").hidden = true;
  if (t) {
    const home = state.info.home;
    const shown = t.path.startsWith(home) ? "~" + t.path.slice(home.length) : t.path;
    const parts = shown.split("/").filter(Boolean);
    $("crumbs").innerHTML = parts.map((s, i) => i === parts.length - 1 ? `<b>${esc(s)}</b>` : `${esc(s)} <span>›</span>`).join(" ");
    if (ta.value !== t.text) ta.value = t.text;
    paint();
    $("stLang").textContent = langOf(t.path);
  } else {
    $("crumbs").innerHTML = "";
    $("stLang").textContent = "";
  }
  renderDiff();
  renderCtx();
}
function paint() {
  const text = ta.value;
  hl.innerHTML = highlight(text, state.active) + "\n ";
  const n = text.split("\n").length;
  const cur = text.slice(0, ta.selectionStart).split("\n").length;
  const rows = new Array(n);
  for (let i = 1; i <= n; i++) rows[i - 1] = i === cur ? `<div class="cur">${i}</div>` : `<div>${i}</div>`;
  gutter.innerHTML = rows.join("");
  sync();
}
function sync() {
  hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
}
function cursorInfo() {
  const before = ta.value.slice(0, ta.selectionStart).split("\n");
  $("stCursor").textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
  gutter.querySelectorAll(".cur").forEach((d) => d.classList.remove("cur"));
  const el = gutter.children[before.length - 1];
  if (el) el.classList.add("cur");
  renderCtx();
}
ta.addEventListener("input", () => {
  const t = tab(); if (!t) return;
  const wasDirty = t.text !== t.savedText;
  t.text = ta.value;
  if (wasDirty !== (t.text !== t.savedText)) renderTabs();
  paint();
});
ta.addEventListener("scroll", sync);
["keyup", "click"].forEach((ev) => ta.addEventListener(ev, cursorInfo));
document.addEventListener("selectionchange", () => { if (document.activeElement === ta) cursorInfo(); });
ta.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd;
    if (s === en) ta.setRangeText("  ", s, en, "end");
    else {
      const ls = ta.value.lastIndexOf("\n", s - 1) + 1;
      const block = ta.value.slice(ls, en);
      ta.setRangeText(e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  "), ls, en, "select");
    }
    ta.dispatchEvent(new Event("input"));
  } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    const s = ta.selectionStart;
    const line = ta.value.slice(ta.value.lastIndexOf("\n", s - 1) + 1, s);
    let indent = line.match(/^\s*/)[0];
    if (/[{[(:]\s*$/.test(line)) indent += "  ";
    e.preventDefault();
    ta.setRangeText("\n" + indent, s, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  }
});

async function openFile(p, { focus = true } = {}) {
  if (!tab(p)) {
    const r = await api.read(p).catch((e) => ({ error: e.message }));
    if (r.error) { toast(r.error); return false; }
    state.tabs.push({ path: r.path, text: r.text, savedText: r.text });
    p = r.path;
  }
  activate(p);
  if (focus) ta.focus();
  return true;
}
function activate(p) {
  // A source control diff isn't tied to a tab; switching tabs closes it.
  if (state.pending && state.pending.standalone) state.pending = null;
  state.active = p;
  ta.scrollTop = 0; ta.scrollLeft = 0;
  renderTabs(); renderEditor(); markActiveInTree();
  ta.setSelectionRange(0, 0);
  cursorInfo();
}
function closeTab(p) {
  const i = state.tabs.findIndex((t) => t.path === p);
  if (i < 0) return;
  const t = state.tabs[i];
  if (t.text !== t.savedText && !t.confirmClose) {
    t.confirmClose = true;
    toast(`${base(p)} has unsaved changes. Close again to discard them.`);
    setTimeout(() => { t.confirmClose = false; }, 4000);
    return;
  }
  state.tabs.splice(i, 1);
  if (state.active === p) state.active = (state.tabs[Math.max(0, i - 1)] || {}).path || null;
  renderTabs(); renderEditor(); markActiveInTree();
}
async function saveActive() {
  const t = tab(); if (!t) return;
  try {
    await api.write(t.path, t.text);
    t.savedText = t.text;
    renderTabs();
    toast("Saved " + base(t.path));
    refreshGit();
  } catch (e) { toast("Couldn't save: " + e.message); }
}
async function reloadFromDisk(p) {
  const t = tab(p); if (!t) return;
  const r = await api.read(p).catch(() => null);
  if (!r || r.error) return;
  const dirty = t.text !== t.savedText;
  t.savedText = r.text;
  if (!dirty) t.text = r.text;
  if (p === state.active) { ta.value = t.text; paint(); }
  renderTabs();
}

/* ---------- diff view ---------- */
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const n = a2.length, m = b2.length, ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: "eq", b: i, s: A[i] });
  if (n * m > 4e6) {
    a2.forEach((s) => ops.push({ t: "del", s }));
    b2.forEach((s, j) => ops.push({ t: "add", b: pre + j, s }));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { ops.push({ t: "eq", b: pre + j, s: a2[i] }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { ops.push({ t: "add", b: pre + j, s: b2[j] }); j++; }
      else { ops.push({ t: "del", s: a2[i] }); i++; }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: "eq", b: B.length - suf + k, s: B[B.length - suf + k] });
  return ops;
}
function diffHtml(before, after, p) {
  const ops = lineDiff(before, after);
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== "eq") for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep[k] = true; });
  let html = "", skipped = 0;
  const fold = () => { if (skipped) { html += `<div class="dl fold"><span class="n"></span><span class="s"></span><span class="c">⋯ ${skipped} unchanged line${skipped > 1 ? "s" : ""}</span></div>`; skipped = 0; } };
  ops.forEach((o, i) => {
    if (!keep[i]) { skipped++; return; }
    fold();
    const sign = o.t === "add" ? "+" : o.t === "del" ? "−" : "";
    const body = o.t === "del" ? esc(o.s) : highlight(o.s, p);
    html += `<div class="dl ${o.t}"><span class="n">${o.t === "del" ? "" : o.b + 1}</span><span class="s">${sign}</span><span class="c">${body || " "}</span></div>`;
  });
  fold();
  return { html, adds: ops.filter((o) => o.t === "add").length, dels: ops.filter((o) => o.t === "del").length };
}
function showDiff(d) {
  state.pending = d;
  renderDiff();
}
const diffShown = () => !!state.pending && (state.pending.standalone || state.pending.path === state.active);
function renderDiff() {
  const d = state.pending;
  const show = diffShown();
  $("diff").hidden = !show;
  if (!show) return;
  const r = diffHtml(d.before, d.after, d.path);
  $("diffTitle").textContent = d.label;
  $("acceptBtn").firstElementChild.textContent = d.acceptLabel || "Accept";
  $("rejectBtn").firstElementChild.textContent = d.rejectLabel || "Reject";
  $("diffStat").innerHTML = `<span style="color:var(--add-fg)">+${r.adds}</span> <span style="color:var(--del-fg)">−${r.dels}</span>`;
  $("diffBody").innerHTML = r.html;
  const first = $("diffBody").querySelector(".add,.del");
  if (first) first.scrollIntoView({ block: "center" });
}
function resolveDiff(accept) {
  const d = state.pending; if (!d) return;
  state.pending = null;
  renderDiff();
  (accept ? d.onAccept : d.onReject)();
}
$("acceptBtn").onclick = () => resolveDiff(true);
$("rejectBtn").onclick = () => resolveDiff(false);

/* ---------- chat ---------- */
// Each chat has its own log element; `log` and `reply` point at the one being drawn into.
let log = null;
const SPARK = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function welcome() {
  log.innerHTML = `<div class="welcome">
    <h3>Claude can see your whole Mac</h3>
    <p>Nothing is uploaded up front. When you ask something, Claude lists folders, searches and reads files on demand, anywhere on this computer. It asks before it edits a file or runs a command.</p>
    <div class="chips">
      <button class="chip" type="button" data-q="Give me a map of my home folder: which folders hold code projects, what languages they use, and anything that looks out of place.">Map my home folder<small>Finds your projects and what they're built with</small></button>
      <button class="chip" type="button" data-q="Find every git repository on this Mac under my home folder and tell me which ones have uncommitted changes.">Find my git repos<small>Runs read-only git commands after you approve</small></button>
      <button class="chip" type="button" data-q="Explain what the open workspace folder contains and how its main pieces fit together.">Explain this workspace<small>Reads the folder that's open in the explorer</small></button>
    </div></div>`;
  log.querySelectorAll(".chip").forEach((c) => c.onclick = () => { $("prompt").value = c.dataset.q; send(); });
}

function md(text) {
  const parts = text.split(/```/);
  return parts.map((part, i) => {
    if (i % 2 === 0) return mdText(part);
    const nl = part.indexOf("\n");
    const info = (nl >= 0 ? part.slice(0, nl) : "").trim();
    const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, "");
    return codeBlock(info, code, i === parts.length - 1);
  }).join("");
}
function mdText(t) {
  const inl = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return t.trim().split(/\n{2,}/).filter(Boolean).map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*[-*] /.test(l))) return "<ul>" + lines.map((l) => "<li>" + inl(l.replace(/^\s*[-*] /, "")) + "</li>").join("") + "</ul>";
    if (lines.every((l) => /^\s*\d+[.)] /.test(l))) return "<ol>" + lines.map((l) => "<li>" + inl(l.replace(/^\s*\d+[.)] /, "")) + "</li>").join("") + "</ol>";
    if (/^#{1,6} /.test(lines[0])) return `<h4>${inl(lines[0].replace(/^#+ /, ""))}</h4>` + (lines.length > 1 ? `<p>${lines.slice(1).map(inl).join("<br>")}</p>` : "");
    return "<p>" + lines.map(inl).join("<br>") + "</p>";
  }).join("");
}
let blockSeq = 0; const blocks = {};
function codeBlock(info, code, open) {
  const lang = info.split(/\s+/)[0] || "";
  const id = "b" + (++blockSeq);
  blocks[id] = code;
  const run = SHELL_LANGS.has(lang.toLowerCase()) ? `<button type="button" data-act="run" data-id="${id}">Run in terminal</button>` : "";
  return `<div class="cb"><div class="cb-head"><span class="grow">${esc(info || "code")}</span>${open ? "" : `${run}<button type="button" data-act="insert" data-id="${id}">Insert at cursor</button><button type="button" data-act="copy" data-id="${id}">Copy</button>`}</div><pre>${highlight(code, "x." + lang)}</pre></div>`;
}
$("logs").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const code = blocks[b.dataset.id];
  if (b.dataset.act === "run") runInTerminal(code);
  else if (b.dataset.act === "copy") {
    try { await navigator.clipboard.writeText(code); toast("Copied"); } catch { toast("Couldn't copy"); }
  } else if (b.dataset.act === "insert") {
    const t = tab(); if (!t) return toast("Open a file first");
    const s = selMemo ? selMemo.s : ta.selectionStart, en = selMemo ? selMemo.e : ta.selectionEnd;
    const after = t.text.slice(0, s) + code + t.text.slice(en);
    showDiff({ path: t.path, before: t.text, after, label: "Insert into " + base(t.path), onAccept: () => { t.text = after; ta.value = after; paint(); renderTabs(); }, onReject: () => {} });
  }
});

function addEl(cls, html) {
  if (log.querySelector(".welcome")) log.innerHTML = "";
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  log.appendChild(d);
  scrollLog();
  return d;
}
const scrollLog = () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight; };

// Per-reply render state
let reply = null; // { el, seg, text, thinking, tools: {id: el} }
function replyEl() {
  if (!reply) {
    const el = addEl("msg ai", `<div class="who">${SPARK}Claude</div>`);
    reply = { el, seg: null, text: "", think: null, thinkText: "", tools: {} };
  }
  return reply;
}
function endSegment() { if (reply) { reply.seg = null; reply.text = ""; reply.think = null; reply.thinkText = ""; } }

function toolLabel(name, input = {}) {
  const home = state.info.home;
  const short = (p) => (p && p.startsWith(home) ? "~" + p.slice(home.length) : p || "");
  switch (name) {
    case "list_directory": return ["List", short(input.path)];
    case "find_files": return ["Find", `${input.pattern}${input.path ? " in " + short(input.path) : ""}`];
    case "search_text": return ["Search", `${input.pattern}${input.path ? " in " + short(input.path) : ""}`];
    case "read_file": return ["Read", short(input.path)];
    case "edit_file": return ["Edit", short(input.path)];
    case "write_file": return ["Write", short(input.path)];
    case "run_command": case "Bash": return ["Run", input.command];
    case "Read": return ["Read", short(input.path)];
    case "Glob": return ["Find", `${input.pattern || ""}${input.path ? " in " + short(input.path) : ""}`];
    case "Grep": return ["Search", `${input.pattern || ""}${input.path ? " in " + short(input.path) : ""}`];
    case "LS": return ["List", short(input.path)];
    case "Edit": case "MultiEdit": case "NotebookEdit": return ["Edit", short(input.path)];
    case "Write": return ["Write", short(input.path)];
    case "WebFetch": return ["Fetch", input.detail || ""];
    case "WebSearch": return ["Web search", input.detail || ""];
    case "Task": case "Agent": return ["Subagent", input.detail || ""];
    case "TodoWrite": return ["Plan", ""];
    default: return [name, (input && input.detail) || ""];
  }
}

// Live events and saved ones replayed at launch (replay = true) render the same way.
function handleEvent(ev, replay = false) {
  const r = replyEl();
  switch (ev.type) {
    case "round": endSegment(); break;
    case "thinking": {
      if (!r.think) {
        r.think = document.createElement("details");
        r.think.className = "thinking";
        r.think.innerHTML = `<summary><span class="pulse"></span>Thinking</summary><div class="tt"></div>`;
        r.el.appendChild(r.think);
      }
      r.thinkText += ev.delta;
      r.think.querySelector(".tt").textContent = r.thinkText;
      break;
    }
    case "text": {
      if (r.think) { const p = r.think.querySelector(".pulse"); if (p) p.remove(); }
      if (!r.seg) { r.seg = document.createElement("div"); r.seg.className = "seg-text"; r.el.appendChild(r.seg); r.text = ""; }
      r.text += ev.delta;
      r.seg.innerHTML = md(r.text);
      scrollLog();
      break;
    }
    case "tool_pending": {
      if (r.think) { const p = r.think.querySelector(".pulse"); if (p) p.remove(); }
      r.seg = null;
      const [verb] = toolLabel(ev.name);
      const d = document.createElement("details");
      d.className = "tool running";
      d.innerHTML = `<summary><span class="tstate"></span><span class="tname">${esc(verb)}</span><span class="targ">…</span></summary><pre></pre>`;
      r.el.appendChild(d);
      r.tools[ev.id] = d;
      scrollLog();
      break;
    }
    case "tool_start": {
      const d = r.tools[ev.id]; if (!d) break;
      const [verb, arg] = toolLabel(ev.name, ev.input);
      d.querySelector(".tname").textContent = verb;
      d.querySelector(".targ").textContent = arg;
      d.querySelector(".targ").title = arg;
      break;
    }
    case "tool_end": {
      const d = r.tools[ev.id]; if (!d) break;
      d.className = "tool " + (ev.error ? "err" : "ok");
      d.querySelector("pre").textContent = ev.output;
      if (ev.error) d.open = false;
      break;
    }
    case "approval": showApproval(ev, replay); break;
    case "approval_result": {
      const card = log.querySelector(`.approval[data-id="${CSS.escape(ev.id)}"]`);
      if (card) resolveCard(card, ev.decision === "deny" ? "Declined" : ev.decision === "always" ? "Allowed (and for the rest of this chat)" : "Allowed");
      break;
    }
    case "approval_cancelled": {
      const card = log.querySelector(`.approval[data-id="${CSS.escape(ev.id)}"]`);
      if (card) resolveCard(card, "Cancelled");
      if (state.pending && state.pending.approvalId === ev.id) { state.pending = null; renderDiff(); }
      break;
    }
    case "file_changed": reloadFromDisk(ev.path); state.fileIndex = null; scheduleGit(); scheduleTree(ev.path); break;
    case "notice": r.el.insertAdjacentHTML("beforeend", `<div class="notice">${esc(ev.text)}</div>`); break;
    case "error": r.el.insertAdjacentHTML("beforeend", `<div class="error">${esc(ev.message)}</div>`); if (!replay && ev.chat === state.chat && /API key|Sign in|sign in|signed in/.test(ev.message)) openSettings(); break;
    case "done":
      if (!replay) refreshGit();
      if (ev.stopped) r.el.insertAdjacentHTML("beforeend", `<div class="notice">Stopped.</div>`);
      r.el.querySelectorAll(".pulse").forEach((p) => p.remove());
      r.el.querySelectorAll(".tool.running").forEach((t) => { t.className = "tool err"; });
      break;
  }
}
api.onEvent((ev) => {
  inChat(ev.chat, () => handleEvent(ev));
  if (["done", "error", "approval", "approval_cancelled"].includes(ev.type)) {
    const c = chatUI[ev.chat];
    if (c && ev.chat !== state.chat && ev.type !== "approval_cancelled") c.unread = true;
    renderChatTabs();
  }
});

const userEl = (text, ctx) => addEl("msg user", esc(text) + (ctx ? `<span class="ctx">${esc(ctx)}</span>` : ""));

// Show a chat's saved transcript.
async function restoreChat(id) {
  let saved = [];
  try { saved = await api.chats.history(id); } catch {}
  inChat(id, () => {
    if (!saved.length) return welcome();
    log.innerHTML = "";
    reply = null;
    for (const ev of saved) {
      if (ev.type === "user") { reply = null; userEl(ev.text, ev.ctx); continue; }
      handleEvent(ev, true);
      if (ev.type === "done") reply = null;
    }
    // The app may have quit mid-reply.
    log.querySelectorAll(".pulse").forEach((p) => p.remove());
    log.querySelectorAll(".tool.running").forEach((t) => { t.className = "tool err"; });
    reply = null;
    log.scrollTop = log.scrollHeight;
  });
}

function showApproval(ev, replay = false) {
  const r = replyEl();
  const card = document.createElement("div");
  card.className = "approval";
  card.dataset.id = ev.id;
  const p = ev.preview;
  let body = "";
  if (p.kind === "command") {
    body = `<div class="q">Run this command?</div><pre>${esc(p.command)}</pre><div class="verdict">in ${esc(p.cwd)}</div>`;
  } else {
    // Saved approvals drop the file contents, so there's no line count to show.
    const st = p.before != null ? diffHtml(p.before, p.after, p.path) : null;
    const stat = st ? ` <span class="stat"><span style="color:var(--add-fg)">+${st.adds}</span> <span style="color:var(--del-fg)">−${st.dels}</span></span>` : "";
    body = `<div class="q">${p.created ? "Create" : "Change"} ${esc(base(p.path))}?${stat}</div><div class="verdict">${esc(p.path)}</div>`;
  }
  const kind = ev.name === "run_command" ? "commands" : "file edits";
  card.innerHTML = `${body}<div class="acts">
    <button class="btn primary" data-d="allow" type="button">${p.kind === "command" ? "Run" : "Apply"}</button>
    ${p.kind === "diff" ? '<button class="btn" data-d="view" type="button">View diff</button>' : ""}
    <button class="btn" data-d="always" type="button">Always allow ${kind}</button>
    <button class="btn danger" data-d="deny" type="button">Decline</button></div>`;
  r.el.appendChild(card);
  r.seg = null;
  scrollLog();
  // A saved decision (approval_result / approval_cancelled) replaces this if there was one.
  if (replay) return resolveCard(card, "Not answered");

  const decide = (decision) => {
    if (card.classList.contains("resolved")) return;
    if (state.pending && state.pending.approvalId === ev.id) { state.pending = null; renderDiff(); }
    resolveCard(card, decision === "deny" ? "Declined" : decision === "always" ? "Allowed (and for the rest of this chat)" : "Allowed");
    api.approve(ev.id, decision);
    renderChatTabs();
  };
  const view = async () => {
    // A file Claude creates may not exist yet; show the diff over a placeholder tab.
    if (!tab(p.path)) {
      const ok = await openFile(p.path, { focus: false });
      if (!ok) { state.tabs.push({ path: p.path, text: p.before, savedText: p.before }); activate(p.path); }
    } else activate(p.path);
    showDiff({ path: p.path, before: p.before, after: p.after, label: `Claude wants to ${p.created ? "create" : "edit"} ${base(p.path)}`, approvalId: ev.id, onAccept: () => decide("allow"), onReject: () => decide("deny") });
  };
  card.querySelectorAll("[data-d]").forEach((b) => b.onclick = () => (b.dataset.d === "view" ? view() : decide(b.dataset.d)));
  // Only the chat you're looking at may take over the editor with its diff.
  if (p.kind === "diff" && ev.chat === state.chat) view();
}
function resolveCard(card, verdict) {
  card.classList.add("resolved");
  card.querySelector(".acts").innerHTML = `<span class="verdict">${esc(verdict)}</span>`;
}

/* ---------- composer ---------- */
const promptEl = $("prompt"), sendBtn = $("send");
const SEND_ICON = sendBtn.innerHTML;
const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
const chatBusy = () => !!(state.chats.find((c) => c.id === state.chat) || {}).running;
function updateSend() {
  if (chatBusy()) { sendBtn.disabled = false; sendBtn.classList.add("stop"); sendBtn.innerHTML = STOP_ICON; sendBtn.setAttribute("aria-label", "Stop"); return; }
  sendBtn.classList.remove("stop"); sendBtn.innerHTML = SEND_ICON; sendBtn.setAttribute("aria-label", "Send");
  sendBtn.disabled = !promptEl.value.trim();
}
promptEl.addEventListener("input", () => { promptEl.style.height = "auto"; promptEl.style.height = Math.min(200, promptEl.scrollHeight) + "px"; updateSend(); });
promptEl.addEventListener("keydown", (e) => { if (mention.open) return; if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!chatBusy()) send(); } });
sendBtn.onclick = () => (chatBusy() ? api.stop(state.chat) : send());

let selMemo = null;
ta.addEventListener("blur", () => { selMemo = ta.selectionStart !== ta.selectionEnd ? { s: ta.selectionStart, e: ta.selectionEnd } : null; });
ta.addEventListener("focus", () => { selMemo = null; });
function currentSel() {
  const t = tab(); if (!t) return null;
  const s = selMemo ? selMemo.s : ta.selectionStart, e = selMemo ? selMemo.e : ta.selectionEnd;
  if (s === e) return null;
  const text = t.text.slice(s, e);
  const l1 = t.text.slice(0, s).split("\n").length;
  return { s, e, text, l1, l2: l1 + text.split("\n").length - 1 };
}
function renderCtx() {
  const bar = $("ctxbar");
  bar.innerHTML = "";
  const t = tab();
  if (t) bar.insertAdjacentHTML("beforeend", `<span class="pill on" title="${esc(t.path)}"><span class="dot" style="background:${DOT[ext(t.path)] || "var(--faint)"}"></span>${esc(base(t.path))}</span>`);
  const sel = currentSel();
  if (sel) bar.insertAdjacentHTML("beforeend", `<span class="pill on">lines ${sel.l1}${sel.l2 !== sel.l1 ? "–" + sel.l2 : ""}</span>`);
  state.attachments.forEach((a, i) => {
    const name = a.label || base(a.path) || a.path;
    const icon = a.text != null ? "&gt;_ " : a.dir ? "📁 " : `<span class="dot" style="background:${DOT[ext(a.path)] || "var(--faint)"}"></span>`;
    bar.insertAdjacentHTML("beforeend", `<span class="pill att" title="${esc(a.text != null ? a.text.slice(-400) : a.path)}">${icon}${esc(name)}<button type="button" class="rm" data-i="${i}" aria-label="Remove ${esc(name)}">×</button></span>`);
  });
  bar.insertAdjacentHTML("beforeend", `<span class="pill" title="${esc(state.workspace)}">workspace: ${esc(base(state.workspace) || "/")}</span>`);
}

$("ctxbar").addEventListener("click", (e) => {
  const rm = e.target.closest(".rm");
  if (!rm) return;
  state.attachments.splice(+rm.dataset.i, 1);
  renderCtx();
});

/* ---------- drag files into the chat ---------- */
const LUMEN_DRAG = "application/x-lumen-path";
const TAB_DRAG = "application/x-lumen-tab";
function dragPath(e, p, dir) {
  e.dataTransfer.setData(LUMEN_DRAG, JSON.stringify({ path: p, dir }));
  e.dataTransfer.setData("text/plain", p);
  e.dataTransfer.effectAllowed = "copy";
}
function attach(p, dir) {
  if (!p || state.attachments.some((a) => a.path === p)) return;
  state.attachments.push({ path: p, dir: !!dir });
}
function droppedPaths(dt) {
  const out = [];
  const own = dt.getData(LUMEN_DRAG);
  if (own) { try { out.push(JSON.parse(own)); } catch {} return out; }
  const items = [...(dt.items || [])];
  [...dt.files].forEach((f, i) => {
    const p = api.pathForFile(f);
    const entry = items[i] && items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
    if (p) out.push({ path: p, dir: !!(entry && entry.isDirectory) });
  });
  return out;
}
const isFileDrag = (e) => [...e.dataTransfer.types].some((t) => t === "Files" || t === LUMEN_DRAG);
// Never let a stray drop navigate the window to the file.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());
{
  const chat = document.querySelector(".chat"), zone = $("dropzone");
  let depth = 0;
  chat.addEventListener("dragenter", (e) => { if (!isFileDrag(e)) return; depth++; zone.hidden = false; });
  chat.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; zone.hidden = true; } });
  chat.addEventListener("dragover", (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  chat.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    depth = 0; zone.hidden = true;
    const got = droppedPaths(e.dataTransfer);
    got.forEach((g) => attach(g.path, g.dir));
    renderCtx();
    if (got.length) promptEl.focus();
  });
  // Dropping a file from Finder onto the editor opens it.
  const stage = document.querySelector(".stage");
  stage.addEventListener("dragover", (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  stage.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    droppedPaths(e.dataTransfer).filter((g) => !g.dir).forEach((g) => openFile(g.path));
  });
}

/* ---------- explorer drag and drop: move within, copy in from Finder ---------- */
let treeDrag = null, hoverTimer = null, hoverRow = null;
const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const treeEl = $("tree");
function clearTreeDrop() {
  treeEl.classList.remove("drop-root");
  treeEl.querySelectorAll(".drop-into").forEach((r) => r.classList.remove("drop-into"));
  clearTimeout(hoverTimer); hoverRow = null;
}
function treeDropDir(e) {
  const row = e.target.closest(".row");
  if (!row) return state.workspace;
  return row.dataset.dir ? row.dataset.path : parentOf(row.dataset.path);
}
function remapPath(from, to) {
  const fix = (p) => (p === from ? to : p && p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  state.tabs.forEach((t) => { t.path = fix(t.path); });
  state.active = fix(state.active);
  state.attachments.forEach((a) => { a.path = fix(a.path); });
  state.expanded = new Set([...state.expanded].map(fix));
}
treeEl.addEventListener("dragover", (e) => {
  const own = [...e.dataTransfer.types].includes(LUMEN_DRAG);
  if (own ? !treeDrag : !isFileDrag(e)) return;   // tabs can't be dropped on the tree
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = treeDrag ? "move" : "copy";
  const dir = treeDropDir(e);
  const row = [...treeEl.querySelectorAll(".row")].find((r) => r.dataset.dir && r.dataset.path === dir);
  if (row === hoverRow && (row || treeEl.classList.contains("drop-root"))) return;
  clearTreeDrop();
  if (row) {
    row.classList.add("drop-into"); hoverRow = row;
    if (!row.classList.contains("open")) hoverTimer = setTimeout(() => row.click(), 700);  // spring-load folders
  } else if (dir === state.workspace) treeEl.classList.add("drop-root");
});
treeEl.addEventListener("dragleave", (e) => { if (!treeEl.contains(e.relatedTarget)) clearTreeDrop(); });
treeEl.addEventListener("drop", async (e) => {
  e.preventDefault(); e.stopPropagation();
  const dir = treeDropDir(e), moving = treeDrag;
  clearTreeDrop();
  const sources = moving ? [{ path: moving }] : droppedPaths(e.dataTransfer);
  let done = 0;
  for (const src of sources) {
    if (parentOf(src.path) === dir) continue;
    try {
      const dest = moving ? await api.move(src.path, dir) : await api.copy(src.path, dir);
      if (moving) remapPath(src.path, dest);
      done++;
    } catch (err) { toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
  }
  if (!done) return;
  state.expanded.add(dir); state.fileIndex = null;
  await renderTree(); renderTabs(); renderCtx(); markActiveInTree();
  toast(`${moving ? "Moved" : "Copied"} ${done === 1 ? base(sources[0].path) : done + " items"} to ${base(dir) || "/"}`);
});

/* ---------- tab bar: reorder by dragging, drop files to open ---------- */
const tabsEl = $("tabs");
function clearTabDrop() { tabsEl.querySelectorAll(".drop-before,.drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after")); }
function tabSlot(e) {
  const t = e.target.closest(".tab");
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { el: t, after: e.clientX > r.left + r.width / 2 };
}
tabsEl.addEventListener("dragover", (e) => {
  if (!isFileDrag(e) && ![...e.dataTransfer.types].includes(TAB_DRAG)) return;
  e.preventDefault(); e.stopPropagation();
  clearTabDrop();
  if ([...e.dataTransfer.types].includes(TAB_DRAG)) {
    e.dataTransfer.dropEffect = "move";
    const s = tabSlot(e);
    if (s) s.el.classList.add(s.after ? "drop-after" : "drop-before");
  } else e.dataTransfer.dropEffect = "copy";
});
tabsEl.addEventListener("dragleave", (e) => { if (!tabsEl.contains(e.relatedTarget)) clearTabDrop(); });
tabsEl.addEventListener("drop", (e) => {
  e.preventDefault(); e.stopPropagation();
  clearTabDrop();
  const moved = e.dataTransfer.getData(TAB_DRAG);
  if (moved) {
    const s = tabSlot(e);
    const from = state.tabs.findIndex((t) => t.path === moved);
    if (from < 0) return;
    const [t] = state.tabs.splice(from, 1);
    let to = state.tabs.length;
    if (s) { to = state.tabs.findIndex((x) => x.path === s.el.dataset.path); if (to < 0) to = state.tabs.length; else if (s.after) to++; }
    state.tabs.splice(to, 0, t);
    renderTabs();
    return;
  }
  droppedPaths(e.dataTransfer).filter((g) => !g.dir).forEach((g) => openFile(g.path));
});

/* ---------- resizable panels ---------- */
function setupResizer(id, prop, fromLeft, min, max) {
  const el = $(id), root = document.querySelector(".main"), key = "lumen." + prop;
  const apply = (w) => { w = Math.round(Math.max(min, Math.min(max, w, root.clientWidth - 420))); root.style.setProperty(prop, w + "px"); return w; };
  try { const v = +localStorage.getItem(key); if (v) apply(v); } catch {}
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging"); document.body.classList.add("resizing");
    const rect = root.getBoundingClientRect();
    let w = 0;
    const move = (ev) => { w = apply(fromLeft ? ev.clientX - rect.left : rect.right - ev.clientX); };
    const up = () => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      el.classList.remove("dragging"); document.body.classList.remove("resizing");
      if (w) try { localStorage.setItem(key, w); } catch {}
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  });
  el.addEventListener("dblclick", () => { root.style.removeProperty(prop); try { localStorage.removeItem(key); } catch {} });
}
setupResizer("resizeLeft", "--left-w", true, 160, 560);
setupResizer("resizeRight", "--right-w", false, 300, 820);

/* ---------- @ to attach a file ---------- */
const mentionEl = $("mention");
const mention = { open: false, list: [], sel: 0 };
function mentionQuery() {
  const upto = promptEl.value.slice(0, promptEl.selectionStart);
  const m = /(^|\s)@([^\s@]*)$/.exec(upto);
  return m ? { q: m[2], start: upto.length - m[2].length - 1 } : null;
}
function closeMention() { mention.open = false; mentionEl.hidden = true; }
function drawMention() {
  mentionEl.innerHTML = mention.list.map((p, i) => `<button type="button" class="it${i === mention.sel ? " sel" : ""}" data-i="${i}" role="option"><span class="dot" style="background:${DOT[ext(p)] || "var(--faint)"}"></span>${esc(base(p))}<small>${esc(relPath(p))}</small></button>`).join("") || `<div class="empty">No matching files</div>`;
  const cur = mentionEl.querySelector(".sel"); if (cur) cur.scrollIntoView({ block: "nearest" });
}
async function updateMention() {
  const mq = mentionQuery();
  if (!mq) return closeMention();
  mention.open = true; mentionEl.hidden = false;
  if (!state.fileIndex) {
    mentionEl.innerHTML = `<div class="empty">Indexing ${esc(base(state.workspace) || "/")}…</div>`;
    state.fileIndex = await buildIndex();
    if (!mentionQuery()) return closeMention();
  }
  const q = mentionQuery().q;
  const open = state.tabs.map((t) => t.path).filter((p) => !q || base(p).toLowerCase().includes(q.toLowerCase()));
  mention.list = [...new Set([...open, ...fuzzyFiles(q, 60)])].slice(0, 50);
  mention.sel = 0;
  drawMention();
}
function pickMention(i) {
  const p = mention.list[i], mq = mentionQuery();
  if (!p || !mq) return closeMention();
  const end = promptEl.selectionStart;
  promptEl.setRangeText("", mq.start, end, "end");
  attach(p, false);
  closeMention(); renderCtx(); promptEl.focus();
  promptEl.dispatchEvent(new Event("input"));
}
promptEl.addEventListener("input", updateMention);
promptEl.addEventListener("keydown", (e) => {
  if (!mention.open) return;
  const n = mention.list.length;
  if (e.key === "ArrowDown" && n) { mention.sel = (mention.sel + 1) % n; drawMention(); }
  else if (e.key === "ArrowUp" && n) { mention.sel = (mention.sel - 1 + n) % n; drawMention(); }
  else if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) pickMention(mention.sel);
  else if (e.key === "Escape") closeMention();
  else return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
}, true);
promptEl.addEventListener("blur", () => setTimeout(closeMention, 150));
mentionEl.addEventListener("mousedown", (e) => e.preventDefault());
mentionEl.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) pickMention(+b.dataset.i); });

async function attachmentContext(list) {
  const parts = [];
  for (const a of list) {
    if (a.text != null) { parts.push(`${a.label}:\n\`\`\`\n${a.text}\n\`\`\``); continue; }
    if (a.dir) { parts.push(`Attached folder: ${a.path}`); continue; }
    let r = null;
    try { r = await api.read(a.path); } catch {}
    if (r && r.text != null && r.text.length <= 50000) parts.push(`Attached file: ${a.path}\n\`\`\`\n${r.text}\n\`\`\``);
    else parts.push(`Attached file: ${a.path}${r && r.error ? ` (${r.error} Not inlined.)` : " (large; read it with your tools if needed)"}`);
  }
  return parts;
}

async function send() {
  const q = promptEl.value.trim();
  if (!q || chatBusy()) return;
  if (!state.info.connected) { openSettings(); return; }
  const t = tab(), sel = currentSel();
  promptEl.value = ""; promptEl.dispatchEvent(new Event("input"));
  const atts = state.attachments.splice(0);
  renderCtx();
  const ctxNote = [t ? base(t.path) : null, sel ? `L${sel.l1}${sel.l2 !== sel.l1 ? "–" + sel.l2 : ""}` : null, ...atts.map((a) => a.label || base(a.path))].filter(Boolean).join(" · ");
  userEl(q, ctxNote);

  let full = q;
  const ctx = [];
  if (t) {
    ctx.push(`Open in editor: ${t.path}${t.text !== t.savedText ? " (has unsaved changes; the editor buffer is below)" : ""}`);
    if (t.text !== t.savedText && t.text.length < 60000) ctx.push("Unsaved editor buffer:\n```\n" + t.text + "\n```");
  }
  ctx.push(...(await attachmentContext(atts)));
  if (sel) ctx.push(`Selected lines ${sel.l1}-${sel.l2}:\n\`\`\`\n${sel.text}\n\`\`\``);
  if (ctx.length) full = `<editor_context>\n${ctx.join("\n\n")}\n</editor_context>\n\n${q}`;

  const id = state.chat;
  reply = null;
  replyEl();
  setRunning(id, true);
  try { await api.send(id, full, { text: q, ctx: ctxNote }); }
  catch (e) { inChat(id, () => replyEl().el.insertAdjacentHTML("beforeend", `<div class="error">${esc(errMsg(e))}</div>`)); setRunning(id, false); }
  finally { inChat(id, () => { reply = null; }); }
}

/* ---------- theme ---------- */
const THEMES = ["system", "light", "dark"];
const THEME_ICON = {
  system: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
  light: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.8" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  dark: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};
function applyTheme(mode) {
  if (!THEMES.includes(mode)) mode = "system";
  if (mode === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  const b = $("themeBtn");
  b.innerHTML = THEME_ICON[mode];
  b.title = b.ariaLabel = `Theme: ${mode} (click to change)`;
  try { localStorage.setItem("lumen.theme", mode); } catch {}
  api.setTheme(mode).catch(() => {});
  refreshTermTheme();
  return mode;
}
let themeMode = "system";
try { themeMode = localStorage.getItem("lumen.theme") || "system"; } catch {}
themeMode = applyTheme(themeMode);
$("themeBtn").onclick = () => { themeMode = applyTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]); toast(`Theme: ${themeMode}`); };


/* ---------- ⌘K inline edit ---------- */
let inlineRange = null, inlineBusy = false;
function openInline() {
  const t = tab(); if (!t) return toast("Open a file first");
  const s = ta.selectionStart, e = ta.selectionEnd;
  inlineRange = s === e ? { s: 0, e: t.text.length, whole: true } : { s, e };
  const l1 = t.text.slice(0, s).split("\n").length, l2 = l1 + t.text.slice(s, e).split("\n").length - 1;
  $("inlineHint").textContent = inlineRange.whole ? "No selection: Claude rewrites the whole file · Enter to generate · Esc to close" : `Editing lines ${l1}–${l2} · Enter to generate · Esc to close`;
  $("inline").hidden = false;
  $("inlineInput").value = "";
  $("inlineInput").focus();
}
function closeInline() { $("inline").hidden = true; ta.focus(); }
async function runInline() {
  const instr = $("inlineInput").value.trim();
  const t = tab();
  if (!instr || !t || inlineBusy) return;
  if (!state.info.connected) { openSettings(); return; }
  const r = inlineRange;
  const original = t.text;
  inlineBusy = true;
  $("inlineGo").disabled = true; $("inlineGo").textContent = "Generating…";
  $("inlineHint").textContent = "Claude is writing the change…";
  const res = await api.inlineEdit({ path: t.path, before: original.slice(0, r.s), selection: original.slice(r.s, r.e), after: original.slice(r.e), instruction: instr });
  inlineBusy = false;
  $("inlineGo").disabled = false; $("inlineGo").textContent = "Generate";
  if (res.error) { $("inlineHint").textContent = res.error; return; }
  let out = res.text;
  const target = original.slice(r.s, r.e);
  if (target.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  if (!target.endsWith("\n") && out.endsWith("\n")) out = out.replace(/\n+$/, "");
  $("inline").hidden = true;
  const after = original.slice(0, r.s) + out + original.slice(r.e);
  showDiff({ path: t.path, before: original, after, label: "⌘K · " + instr, onAccept: () => { t.text = after; ta.value = after; paint(); renderTabs(); ta.focus(); }, onReject: () => ta.focus() });
}
$("inlineGo").onclick = runInline;
$("inlineInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runInline(); }
  if (e.key === "Escape") { e.preventDefault(); closeInline(); }
});

/* ---------- ⌘P palette ---------- */
const SKIP = new Set(["node_modules", ".git", "Library", ".Trash", ".cache", ".npm", "dist", "build", ".next", "__pycache__", ".venv", "Pictures", "Movies", "Music"]);
async function buildIndex() {
  const files = [];
  const queue = [state.workspace];
  let dirs = 0;
  while (queue.length && files.length < 5000 && dirs < 600) {
    const d = queue.shift(); dirs++;
    let entries; try { entries = await api.list(d); } catch { continue; }
    for (const en of entries) {
      if (en.dir) { if (!SKIP.has(en.name) && !en.name.startsWith(".")) queue.push(en.path); }
      else files.push(en.path);
    }
  }
  return files;
}
const relPath = (p) => p.startsWith(state.workspace + "/") ? p.slice(state.workspace.length + 1) : p;
function fuzzyFiles(query, limit = 200) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const list = [];
  for (const p of state.fileIndex || []) {
    const s = relPath(p).toLowerCase(); let i = 0;
    for (const c of s) if (c === q[i]) i++;
    if (i === q.length) { list.push(p); if (list.length > limit) break; }
  }
  const rank = (p) => { const b = base(p).toLowerCase(); return b.startsWith(q) ? 0 : b.includes(q) ? 1 : 2; };
  if (q) list.sort((a, b) => rank(a) - rank(b) || base(a).length - base(b).length || a.length - b.length);
  return list;
}
async function openPalette() {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="palette" role="dialog" aria-label="Go to file"><input placeholder="Go to file in ${esc(base(state.workspace) || "/")}…" aria-label="File name"><div class="items"><div class="empty">Indexing…</div></div></div>`;
  document.body.appendChild(ov);
  const inp = ov.querySelector("input"), items = ov.querySelector(".items");
  inp.focus();
  let sel = 0, list = [];
  const close = () => ov.remove();
  const rel = relPath;
  const draw = () => {
    list = fuzzyFiles(inp.value);
    sel = Math.min(sel, Math.max(0, list.length - 1));
    items.innerHTML = list.slice(0, 100).map((p, i) => `<button type="button" class="it${i === sel ? " sel" : ""}" data-p="${esc(p)}"><span class="dot" style="background:${DOT[ext(p)] || "var(--faint)"}"></span>${esc(base(p))}<small>${esc(rel(p))}</small></button>`).join("") || `<div class="empty">No matching files</div>`;
  };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(list.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && list[sel]) { close(); openFile(list[sel]); }
    else if (e.key === "Escape") close();
  };
  items.onclick = (e) => { const b = e.target.closest("[data-p]"); if (b) { close(); openFile(b.dataset.p); } };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  if (!state.fileIndex) state.fileIndex = await buildIndex();
  if (document.body.contains(ov)) draw();
}
$("openPalette").onclick = openPalette;

/* ---------- settings ---------- */
let chosenEngine = "claude-code";
function renderAuth() {
  const info = state.info;
  document.querySelectorAll('input[name="engine"]').forEach((r) => { r.checked = r.value === chosenEngine; });
  $("ccBox").hidden = chosenEngine !== "claude-code";
  $("apiBox").hidden = chosenEngine !== "api";

  const c = info.cc || {};
  $("ccBox").classList.toggle("ok", !!c.loggedIn);
  $("ccSignInBtn").hidden = !!c.loggedIn;
  $("ccSignOutBtn").hidden = !c.loggedIn;
  $("ccSignInBtn").disabled = !c.installed;
  if (!c.installed) $("ccState").textContent = "This needs Claude Code installed. Get it at claude.com/claude-code, then come back.";
  else if (c.loggedIn && c.method === "claude.ai") $("ccState").textContent = `Signed in with claude.ai${c.email ? " as " + c.email : ""}. Lumen uses your subscription.`;
  else if (c.loggedIn) $("ccState").textContent = `Claude Code is signed in with ${c.method || "another method"}. Sign out and sign in with Claude to use your subscription.`;
  else $("ccState").textContent = "Your browser opens claude.ai. Sign in and approve, then come back here.";

  const box = $("signinBox"), st = $("authState");
  box.classList.toggle("ok", info.auth === "signin");
  $("signInBtn").hidden = info.auth === "signin";
  $("signOutBtn").hidden = info.auth !== "signin";
  $("signInBtn").disabled = !info.canSignIn;
  if (!info.canSignIn) st.textContent = "Console sign-in needs the Anthropic CLI: brew install anthropics/tap/ant";
  else if (info.auth === "signin") st.textContent = "Signed in with your Anthropic Console account.";
  else if (info.auth === "apikey") st.textContent = info.keyFromEnv ? "Using ANTHROPIC_API_KEY from your environment." : "Using a saved API key.";
  else st.textContent = "Billed per use to your Anthropic Console account at platform.claude.com.";
  $("keyInput").placeholder = info.auth === "apikey" ? "Saved. Paste a new key to replace it." : "sk-ant-…";
}
function openSettings() {
  const info = state.info;
  chosenEngine = info.engine || "claude-code";
  $("keyInput").value = "";
  $("keyAlt").open = info.auth === "apikey";
  $("modelSel").innerHTML = info.models.map((m) => `<option value="${m}"${m === info.model ? " selected" : ""}>${modelName(m)}</option>`).join("");
  renderAuth();
  $("settings").hidden = false;
  $("setSave").focus();
}
document.querySelectorAll('input[name="engine"]').forEach((r) => r.onchange = () => { chosenEngine = r.value; renderAuth(); });
const modelName = (m) => ({ "claude-opus-5-5": "Claude Opus 5.5 (best)", "claude-sonnet-5-5": "Claude Sonnet 5.5 (faster)", "claude-haiku-5-5": "Claude Haiku 5.5 (fastest)" }[m] || m);
$("settingsBtn").onclick = openSettings;
$("setCancel").onclick = () => { $("settings").hidden = true; };

async function runSignIn(btn, stateEl, call, waitingText, doneMsg) {
  btn.disabled = true;
  const label = btn.querySelector("span"), orig = label.textContent;
  label.textContent = "Waiting for your browser…";
  stateEl.textContent = waitingText;
  const r = await call();
  btn.disabled = false; label.textContent = orig;
  state.info = await api.info();
  renderAuth(); setStatus();
  if (r.ok) toast(doneMsg); else stateEl.textContent = r.message;
  return r.ok;
}
$("ccSignInBtn").onclick = async () => {
  const ok = await runSignIn($("ccSignInBtn"), $("ccState"), api.claudeSignIn, "Finish signing in on the claude.ai page that just opened in your browser.", "Signed in with Claude");
  if (ok) { Object.assign(state.info, await api.setSettings({ engine: "claude-code" })); setStatus(); $("settings").hidden = true; promptEl.focus(); }
};
$("ccSignOutBtn").onclick = async () => { state.info = await api.claudeSignOut(); renderAuth(); setStatus(); toast("Signed out of Claude"); };
$("signInBtn").onclick = async () => {
  const ok = await runSignIn($("signInBtn"), $("authState"), api.signIn, "Finish signing in on the page that just opened in your browser.", "Signed in");
  if (ok) { Object.assign(state.info, await api.setSettings({ engine: "api" })); setStatus(); $("settings").hidden = true; promptEl.focus(); }
};
$("signOutBtn").onclick = async () => { await api.signOut(); state.info = await api.info(); renderAuth(); setStatus(); toast("Signed out"); };
$("setSave").onclick = async () => {
  const key = $("keyInput").value.trim();
  const r = await api.setSettings({ apiKey: key && chosenEngine === "api" ? key : undefined, model: $("modelSel").value, engine: chosenEngine });
  Object.assign(state.info, r);
  if (key) state.info.keyFromEnv = false;
  $("settings").hidden = true;
  syncModel(); setStatus();
  toast("Settings saved");
};
function syncModel() {
  $("model").innerHTML = state.info.models.map((m) => `<option value="${m}"${m === state.info.model ? " selected" : ""}>${modelName(m).replace(/ \(.*\)/, "")}</option>`).join("");
}
$("model").onchange = async () => { const r = await api.setSettings({ model: $("model").value }); state.info.model = r.model; };
function setStatus() {
  const st = $("stClaude"), info = state.info;
  const via = info.engine === "api" ? "API" : "Claude subscription";
  if (info.connected) { st.className = "ok"; st.textContent = `${via} · ${modelName(info.model).replace(/ \(.*\)/, "")}`; }
  else { st.className = "bad"; st.innerHTML = 'Not connected · <button type="button" id="stSet">Sign in</button>'; $("stSet").onclick = openSettings; }
}

/* ---------- misc ---------- */
$("openFolderBtn").onclick = chooseFolder;
async function chooseFolder() { const ws = await api.chooseWorkspace(); if (ws) { await setWorkspace(ws); renderCtx(); } }
$("refreshBtn").onclick = () => { state.fileIndex = null; renderTree(); };
$("newFileBtn").onclick = () => { $("newFileRow").hidden = false; $("newFileInput").value = ""; $("newFileInput").focus(); };
$("newFileInput").addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { $("newFileRow").hidden = true; return; }
  if (e.key !== "Enter") return;
  const rel = $("newFileInput").value.trim();
  if (!rel || rel.endsWith("/")) return;
  $("newFileRow").hidden = true;
  try {
    const p = await api.write(rel.startsWith("/") || rel.startsWith("~") ? rel : state.workspace + "/" + rel, "");
    state.fileIndex = null;
    await renderTree();
    openFile(p);
  } catch (err) { toast("Couldn't create file: " + err.message); }
});
$("newFileInput").addEventListener("blur", () => { $("newFileRow").hidden = true; });

let toastT;
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2800);
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (!$("settings").hidden) { if (e.key === "Escape") $("settings").hidden = true; return; }
  const inTerm = !!(document.activeElement && document.activeElement.closest(".term-panel"));
  if (e.ctrlKey && !e.metaKey && e.code === "Backquote") { e.preventDefault(); if (e.shiftKey) newTerminal(); else toggleTerminal(); }
  else if (e.metaKey && !e.shiftKey && k === "j") { e.preventDefault(); toggleTerminal(); }
  else if (e.metaKey && e.shiftKey && k === "e") { e.preventDefault(); showView("files"); }
  else if (e.ctrlKey && e.shiftKey && k === "g") { e.preventDefault(); showView("scm"); }
  else if (inTerm && mod && k === "k") { e.preventDefault(); clearTerminal(); }
  else if (inTerm && mod && k === "l") { e.preventDefault(); termToChat(); }
  else if (inTerm && (e.key === "Escape" || (mod && (k === "w" || e.key === "Enter")))) { /* leave these to the shell */ }
  else if (e.metaKey && !e.shiftKey && k === "t") { e.preventDefault(); newChat(); }
  else if (mod && k === "k") { e.preventDefault(); openInline(); }
  else if (mod && k === "l") { e.preventDefault(); if (document.activeElement === ta) selMemo = ta.selectionStart !== ta.selectionEnd ? { s: ta.selectionStart, e: ta.selectionEnd } : null; promptEl.focus(); renderCtx(); }
  else if (mod && k === "p") { e.preventDefault(); openPalette(); }
  else if (mod && k === "o") { e.preventDefault(); chooseFolder(); }
  else if (mod && k === "s") { e.preventDefault(); saveActive(); }
  else if (mod && k === "w") { e.preventDefault(); if (state.active) closeTab(state.active); }
  else if (mod && e.key === "Enter" && diffShown() && document.activeElement !== $("commitMsg")) { e.preventDefault(); resolveDiff(true); }
  else if (e.key === "Escape" && diffShown() && $("inline").hidden && !document.querySelector(".overlay:not([hidden])")) { resolveDiff(false); }
});

/* ---------- integrated terminal ---------- */
const SHELL_LANGS = new Set(["sh", "bash", "zsh", "shell", "console", "terminal"]);
const termPanel = $("termPanel"), termBody = $("termBody");
const termBuf = {};   // output that arrives before its terminal is registered
let termSeq = 0;
const ANSI_DARK = { black: "#1b212c", red: "#f07178", green: "#a3d48d", yellow: "#e4c06c", blue: "#7fbaf0", magenta: "#c59df0", cyan: "#76d0d6", white: "#d9dfe9", brightBlack: "#5c6677", brightRed: "#ff8b92", brightGreen: "#bde6a8", brightYellow: "#f2d38a", brightBlue: "#9fcdf7", brightMagenta: "#d7b8f6", brightCyan: "#9be1e5", brightWhite: "#ffffff" };
const ANSI_LIGHT = { black: "#1c2330", red: "#c4343b", green: "#2e7a33", yellow: "#946100", blue: "#1d61b0", magenta: "#7b3fc2", cyan: "#13808a", white: "#8b95a5", brightBlack: "#5a6577", brightRed: "#d9464d", brightGreen: "#3b8f41", brightYellow: "#a7651a", brightBlue: "#2f74c4", brightMagenta: "#8f55d4", brightCyan: "#1d939e", brightWhite: "#1c2330" };
function termTheme() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  const dark = !/light/.test(cs.getPropertyValue("color-scheme"));
  return { ...(dark ? ANSI_DARK : ANSI_LIGHT), background: v("--editor"), foreground: v("--fg"), cursor: v("--accent"), cursorAccent: v("--editor"), selectionBackground: dark ? "rgba(127,186,240,.3)" : "rgba(29,97,176,.22)" };
}
function refreshTermTheme() {
  if (!state.terms.length) return;
  const theme = termTheme();
  state.terms.forEach((t) => { t.x.options.theme = theme; });
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshTermTheme);

const termById = (id) => state.terms.find((t) => t.id === id);
const activeTerm = () => termById(state.activeTerm);
function renderTermTabs() {
  const el = $("termTabs");
  el.innerHTML = state.terms.map((t) => `<div class="term-tab${t.id === state.activeTerm ? " active" : ""}" role="tab" data-id="${t.id}"><button type="button" class="nm">${t.n}: ${esc(t.title)}</button><button type="button" class="x" aria-label="Kill terminal ${t.n}"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></div>`).join("");
  $("stTerm").classList.toggle("on", !termPanel.hidden);
}
$("termTabs").addEventListener("click", (e) => {
  const tabEl = e.target.closest(".term-tab"); if (!tabEl) return;
  const id = +tabEl.dataset.id;
  if (e.target.closest(".x")) closeTerminal(id); else activateTerm(id, true);
});
function fitTerm(t = activeTerm()) {
  if (!t || termPanel.hidden) return;
  try { t.fit.fit(); } catch {}
}
new ResizeObserver(() => requestAnimationFrame(() => fitTerm())).observe(termBody);

function showTermPanel(show) {
  termPanel.hidden = !show;
  if (!show) document.querySelector(".editor-col").classList.remove("term-max");
  renderTermTabs();
  if (show) requestAnimationFrame(() => fitTerm());
}
async function newTerminal(cwd) {
  if (!window.Terminal || !window.FitAddon) { toast("The terminal couldn't load. Run npm install and restart Lumen."); return null; }
  showTermPanel(true);
  const el = document.createElement("div");
  el.className = "term-view";
  termBody.appendChild(el);
  const x = new window.Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim() || "Menlo, monospace",
    fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, scrollback: 10000,
    macOptionIsMeta: true, macOptionClickForcesSelection: true, theme: termTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  x.loadAddon(fit);
  if (window.WebLinksAddon) x.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
  // Let the app's shortcuts reach the document instead of the shell.
  x.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && ((e.ctrlKey && e.code === "Backquote") || (e.metaKey && /^[jklpos]$/i.test(e.key)) || (e.metaKey && e.shiftKey && /^e$/i.test(e.key)) || (e.ctrlKey && e.shiftKey && /^g$/i.test(e.key)))));
  x.open(el);
  try { fit.fit(); } catch {}
  let r;
  try { r = await api.term.create({ cwd: cwd || state.workspace, cols: x.cols, rows: x.rows }); }
  catch (err) { x.dispose(); el.remove(); toast("Couldn't start a shell: " + errMsg(err)); if (!state.terms.length) showTermPanel(false); return null; }
  const t = { id: r.id, x, fit, el, title: r.shell, n: ++termSeq };
  state.terms.push(t);
  x.onData((d) => api.term.write(t.id, d));
  x.onResize(({ cols, rows }) => api.term.resize(t.id, cols, rows));
  x.onTitleChange((title) => { if (title) { t.title = title.length > 28 ? "…" + title.slice(-27) : title; renderTermTabs(); } });
  (termBuf[t.id] || []).forEach((d) => x.write(d));
  delete termBuf[t.id];
  activateTerm(t.id, true);
  return t;
}
function activateTerm(id, focus) {
  const t = termById(id); if (!t) return;
  state.activeTerm = id;
  state.terms.forEach((o) => { o.el.hidden = o !== t; });
  renderTermTabs();
  requestAnimationFrame(() => { fitTerm(t); if (focus) t.x.focus(); });
}
function closeTerminal(id = state.activeTerm) {
  const i = state.terms.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = state.terms.splice(i, 1);
  api.term.kill(t.id).catch(() => {});
  t.x.dispose(); t.el.remove();
  if (state.activeTerm === id) {
    const next = state.terms[Math.max(0, i - 1)];
    state.activeTerm = next ? next.id : null;
    if (next) activateTerm(next.id, true);
  }
  if (!state.terms.length) { showTermPanel(false); ta.focus(); }
  renderTermTabs();
}
async function toggleTerminal() {
  if (termPanel.hidden) {
    showTermPanel(true);
    if (!state.terms.length) await newTerminal(); else activateTerm(state.activeTerm, true);
  } else if (document.activeElement && document.activeElement.closest(".term-panel")) {
    showTermPanel(false);
    if (state.active) ta.focus();
  } else {
    activateTerm(state.activeTerm, true);
  }
}
function clearTerminal() { const t = activeTerm(); if (t) { t.x.clear(); t.x.focus(); } }
// Cursor-style: the selection, or the last screenful of output, goes to the chat as context.
function termToChat() {
  const t = activeTerm(); if (!t) return;
  let text = t.x.getSelection();
  if (!text.trim()) {
    const b = t.x.buffer.active, lines = [];
    for (let i = Math.max(0, b.length - 200); i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
    text = lines.join("\n");
  }
  text = text.replace(/\s+$/, "");
  if (!text) return toast("Nothing in the terminal to add yet");
  if (text.length > 20000) text = "…\n" + text.slice(-20000);
  state.attachments.push({ label: `Terminal ${t.n} (${t.title})`, text });
  renderCtx();
  promptEl.focus();
}
async function runInTerminal(code) {
  const cmd = code.split("\n").map((l) => l.replace(/^\s*\$ /, "")).filter((l) => l.trim()).join("\r");
  if (!cmd) return;
  let t = activeTerm();
  if (termPanel.hidden || !t) { showTermPanel(true); t = t || (await newTerminal()); }
  if (!t) return;
  activateTerm(t.id, true);
  api.term.write(t.id, cmd + "\r");
}
api.term.onData(({ id, data }) => {
  const t = termById(id);
  if (t) t.x.write(data); else (termBuf[id] = termBuf[id] || []).push(data);
  scheduleGit();
});
api.term.onExit(({ id }) => { if (termById(id)) closeTerminal(id); });

$("termNew").onclick = () => newTerminal();
$("termKill").onclick = () => closeTerminal();
$("termClear").onclick = clearTerminal;
$("termChat").onclick = termToChat;
$("termHide").onclick = () => { showTermPanel(false); if (state.active) ta.focus(); };
$("termMax").onclick = () => {
  const col = document.querySelector(".editor-col");
  const max = col.classList.toggle("term-max");
  $("termMax").title = max ? "Restore panel size" : "Maximize panel";
  $("termMax").querySelector("svg").style.transform = max ? "rotate(180deg)" : "";
  requestAnimationFrame(() => fitTerm());
};
$("stTerm").onclick = toggleTerminal;
{
  const handle = $("termResize"), key = "lumen.--term-h";
  const apply = (h) => { const col = document.querySelector(".editor-col"); h = Math.round(Math.max(90, Math.min(h, col.clientHeight - 120))); termPanel.style.setProperty("--term-h", h + "px"); return h; };
  try { const v = +localStorage.getItem(key); if (v) apply(v); } catch {}
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging"); document.body.classList.add("resizing-v");
    const bottom = termPanel.getBoundingClientRect().bottom;
    let h = 0;
    const move = (ev) => { h = apply(bottom - ev.clientY); };
    const up = () => {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up);
      handle.classList.remove("dragging"); document.body.classList.remove("resizing-v");
      if (h) try { localStorage.setItem(key, h); } catch {}
      fitTerm();
    };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => { termPanel.style.removeProperty("--term-h"); try { localStorage.removeItem(key); } catch {} fitTerm(); });
}

/* ---------- sidebar views ---------- */
function showView(v) {
  state.view = v;
  document.querySelectorAll(".view-tab").forEach((b) => { b.classList.toggle("active", b.dataset.view === v); b.setAttribute("aria-selected", b.dataset.view === v); });
  $("filesView").hidden = v !== "files";
  $("scmView").hidden = v !== "scm";
  if (v === "scm") { refreshGit(); if (!$("scmMain").hidden) $("commitMsg").focus(); }
}
document.querySelectorAll(".view-tab").forEach((b) => b.onclick = () => showView(b.dataset.view));

/* ---------- source control ---------- */
const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const scmCollapsed = new Set(["commits"]);
let gitBusy = false, gitAgain = false, gitTimer = null, gitLast = 0;
async function refreshGit() {
  if (gitBusy) { gitAgain = true; return; }
  gitBusy = true; gitLast = Date.now();
  try { state.git = await api.git.status(); }
  catch (e) { state.git = { repo: null, error: errMsg(e) }; }
  gitBusy = false;
  renderScm(); renderBranch(); decorateTree();
  if (gitAgain) { gitAgain = false; refreshGit(); }
}
// Terminal output and file events arrive in bursts; refresh at most every few seconds.
function scheduleGit() {
  if (gitTimer) return;
  gitTimer = setTimeout(() => { gitTimer = null; refreshGit(); }, Math.max(400, 2500 - (Date.now() - gitLast)));
}
window.addEventListener("focus", () => refreshGit());

function groupsOf(files) {
  const conflict = [], staged = [], changes = [];
  for (const f of files) {
    if (f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D")) { conflict.push({ ...f, st: "!" }); continue; }
    if (f.x !== " " && f.x !== "?") staged.push({ ...f, st: f.x });
    if (f.y !== " ") changes.push({ ...f, st: f.y === "?" ? "U" : f.y, untracked: f.y === "?" });
  }
  return { conflict, staged, changes };
}
const ICON = {
  open: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  stage: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  unstage: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  discard: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H6M3.5 6.5 6 4M3.5 6.5 6 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const actBtn = (act, title) => `<button type="button" data-a="${act}" title="${title}" aria-label="${title}">${ICON[act]}</button>`;
function renderScm() {
  const g = state.git || {};
  const n = (g.files || []).length;
  $("scmBadge").hidden = !g.repo || !n;
  $("scmBadge").textContent = n > 999 ? "999+" : n;
  $("scmNoRepo").hidden = !!g.repo;
  $("scmMain").hidden = !g.repo;
  if (!g.repo) { $("scmNoRepoText").textContent = g.error || `${base(state.workspace) || "This folder"} isn't a git repository.`; return; }

  const { conflict, staged, changes } = groupsOf(g.files);
  $("commitBtn").textContent = $("amendChk").checked ? "Amend last commit" : staged.length ? `Commit ${staged.length} staged` : "Commit";
  const rows = (list, group) => list.map((f) => {
    const slash = f.path.lastIndexOf("/");
    const acts = group === "staged" ? actBtn("open", "Open file") + actBtn("unstage", "Unstage")
      : group === "conflict" ? actBtn("open", "Open file") + actBtn("stage", "Mark resolved (stage)")
      : actBtn("open", "Open file") + actBtn("discard", "Discard changes") + actBtn("stage", "Stage");
    return `<div class="scm-row" tabindex="0" data-g="${group}" data-path="${esc(f.path)}" data-st="${esc(f.st)}"${f.untracked ? ' data-new="1"' : ""} title="${esc(f.orig ? f.orig + " → " + f.path : f.path)}"><span class="dot" style="background:${DOT[ext(f.path)] || "var(--faint)"}"></span><span class="nm${f.st === "D" ? " del" : ""}">${esc(f.path.slice(slash + 1))}</span><small>${esc(slash > 0 ? f.path.slice(0, slash) : "")}</small><span class="scm-acts">${acts}</span><span class="st ${f.st === "!" ? "st-conflict" : "st-" + f.st}">${esc(f.st)}</span></div>`;
  }).join("");
  const head = (key, title, count, acts = "") => `<div class="scm-group${scmCollapsed.has(key) ? "" : " open"}" data-key="${key}" role="button" tabindex="0">${CHEV}<span>${title}</span><span class="count">${count}</span><span class="grow"></span><span class="scm-acts">${acts}</span></div>`;
  let html = "";
  if (conflict.length) html += head("conflict", "Merge Changes", conflict.length) + (scmCollapsed.has("conflict") ? "" : rows(conflict, "conflict"));
  if (staged.length) html += head("staged", "Staged Changes", staged.length, actBtn("unstage", "Unstage all")) + (scmCollapsed.has("staged") ? "" : rows(staged, "staged"));
  html += head("changes", "Changes", changes.length, changes.length ? actBtn("discard", "Discard all changes") + actBtn("stage", "Stage all changes") : "") + (scmCollapsed.has("changes") ? "" : changes.length ? rows(changes, "changes") : `<div class="scm-empty">${staged.length ? "Everything is staged." : "No changes. Working tree clean."}</div>`);
  html += head("commits", "Commits", g.commits.length) + (scmCollapsed.has("commits") ? "" : g.commits.length
    ? g.commits.map((c) => `<div class="commit-row" title="${esc(c.hash)}\n${esc(c.subject)}"><span class="subj">${esc(c.subject)}</span><small><code>${esc(c.short)}</code> · ${esc(c.author)} · ${esc(c.when)}</small></div>`).join("")
    : `<div class="scm-empty">No commits yet.</div>`);
  const list = $("scmList"), top = list.scrollTop;
  list.innerHTML = html;
  list.scrollTop = top;
  const sel = state.pending && state.pending.gitKey;
  if (sel) list.querySelectorAll(".scm-row").forEach((r) => r.classList.toggle("sel", r.dataset.g + ":" + r.dataset.path === sel));
}
function renderBranch() {
  const g = state.git || {};
  const st = $("stBranch");
  st.hidden = !g.repo;
  if (!g.repo) return;
  const BR = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.7" stroke="currentColor" stroke-width="1.4"/><circle cx="4.5" cy="12.5" r="1.7" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5.2v5.6M11.5 7.2c0 2.6-2.2 3-5.6 4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const sync = (g.behind ? ` ↓${g.behind}` : "") + (g.ahead ? ` ↑${g.ahead}` : "");
  st.innerHTML = `${BR}${esc(g.branch || "?")}${(g.files.length ? "*" : "")}${sync}`;
  $("scmBranch").innerHTML = `${BR}<span>${esc(g.branch || "?")}</span>${g.upstream ? `<small style="color:var(--faint)">→ ${esc(g.upstream)}</small>` : ""}`;
  const sb = $("gitSync");
  if (!g.upstream) { sb.textContent = "Publish"; sb.title = g.remotes.length ? `Push ${g.branch} to ${g.remotes.includes("origin") ? "origin" : g.remotes[0]}` : "Add a remote first"; sb.disabled = !g.remotes.length; }
  else { sb.textContent = `↓${g.behind} ↑${g.ahead}`; sb.title = `Sync with ${g.upstream}: pull, then push`; sb.disabled = false; }
}
function decorateTree() {
  const g = state.git;
  const rows = treeEl.querySelectorAll(".row");
  rows.forEach((r) => r.classList.remove("g-M", "g-A", "g-U", "g-D", "g-C", "g-dir"));
  if (!g || !g.repo || !g.files.length) return;
  const files = new Map(), dirs = new Set();
  for (const f of g.files) {
    const conflict = groupsOf([f]).conflict.length;
    const st = conflict ? "C" : f.y === "?" ? "U" : f.y !== " " ? f.y : f.x;
    const abs = g.repo + "/" + f.path;
    files.set(abs, st);
    for (let d = parentOf(abs); d.length > g.repo.length; d = parentOf(d)) dirs.add(d);
  }
  rows.forEach((r) => {
    const st = files.get(r.dataset.path);
    if (st) r.classList.add("g-" + (st === "R" ? "M" : st));
    else if (r.dataset.dir && dirs.has(r.dataset.path)) r.classList.add("g-dir");
  });
}

async function gitDo(fn, done) {
  try { const r = await fn(); if (done) toast(done); return r; }
  catch (e) { toast(errMsg(e).split("\n").filter(Boolean).slice(-2).join(" ")); return undefined; }
  finally { refreshGit(); }
}
// After git rewrites files (pull, checkout, discard) the open tabs and tree follow.
async function afterGitWrite() {
  await Promise.all(state.tabs.map((t) => reloadFromDisk(t.path)));
  state.fileIndex = null;
  renderTree();
}
async function openGitDiff(path, staged) {
  const g = state.git;
  let d;
  try { d = await api.git.diff(path, staged); } catch (e) { return toast(errMsg(e)); }
  if (d.binary) return toast(`${base(path)} is a binary file`);
  const key = (staged ? "staged:" : "changes:") + path;
  showDiff({
    path: d.path, before: d.before, after: d.after, standalone: true, gitKey: key,
    label: `${base(path)} · ${staged ? "Staged" : "Working tree"} (${g.repo === state.workspace ? path : g.repo.split("/").pop() + "/" + path})`,
    acceptLabel: staged ? "Unstage" : "Stage", rejectLabel: "Close",
    onAccept: () => gitDo(() => (staged ? api.git.unstage([path]) : api.git.stage([path]))),
    onReject: () => renderScm(),
  });
  renderScm();
}
$("scmList").addEventListener("click", async (e) => {
  const grp = e.target.closest(".scm-group");
  const act = e.target.closest("[data-a]");
  const { conflict, staged, changes } = groupsOf((state.git && state.git.files) || []);
  if (grp && act) {
    const key = grp.dataset.key, a = act.dataset.a;
    if (key === "staged" && a === "unstage") gitDo(() => api.git.unstage(staged.map((f) => f.path)));
    else if (key === "changes" && a === "stage") gitDo(() => api.git.stage(changes.map((f) => f.path)));
    else if (key === "changes" && a === "discard") {
      const ok = await gitDo(() => api.git.discard(changes.filter((f) => !f.untracked).map((f) => f.path), changes.filter((f) => f.untracked).map((f) => f.path)));
      if (ok) afterGitWrite();
    }
    return;
  }
  if (grp) { const k = grp.dataset.key; scmCollapsed.has(k) ? scmCollapsed.delete(k) : scmCollapsed.add(k); renderScm(); return; }
  const row = e.target.closest(".scm-row"); if (!row) return;
  const path = row.dataset.path, group = row.dataset.g, abs = state.git.repo + "/" + path;
  if (!act) return openGitDiff(path, group === "staged");
  if (act.dataset.a === "open") { if (row.dataset.st === "D") toast(`${base(path)} was deleted`); else openFile(abs); }
  else if (act.dataset.a === "stage") gitDo(() => api.git.stage([path]));
  else if (act.dataset.a === "unstage") gitDo(() => api.git.unstage([path]));
  else if (act.dataset.a === "discard") {
    const ok = await gitDo(() => (row.dataset.new ? api.git.discard([], [path]) : api.git.discard([path], [])));
    if (ok) { if (state.pending && state.pending.gitKey === group + ":" + path) { state.pending = null; renderDiff(); } afterGitWrite(); }
  }
});
$("scmList").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".scm-row, .scm-group")) { e.preventDefault(); e.target.click(); } });

async function commit() {
  const msg = $("commitMsg").value.trim();
  if (!msg) { toast("Write a commit message first, or press Generate"); $("commitMsg").focus(); return; }
  const amend = $("amendChk").checked;
  const ok = await gitDo(() => api.git.commit(msg, amend));
  if (ok) { $("commitMsg").value = ""; $("amendChk").checked = false; toast(amend ? "Amended the last commit" : "Committed"); if (state.pending && state.pending.standalone) { state.pending = null; renderDiff(); } }
}
$("commitBtn").onclick = commit;
$("amendChk").onchange = renderScm;
$("commitMsg").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); } });
$("genMsg").onclick = async () => {
  if (!state.info.connected) return openSettings();
  const b = $("genMsg"), label = b.querySelector("span");
  b.disabled = true; label.textContent = "Writing…";
  try { $("commitMsg").value = await api.git.message(); $("commitMsg").focus(); }
  catch (e) { toast(errMsg(e)); }
  finally { b.disabled = false; label.textContent = "Generate"; }
};
$("gitRefresh").onclick = () => refreshGit();
$("gitFetch").onclick = () => gitDo(() => api.git.fetch(), "Fetched");
$("gitPull").onclick = async () => { const r = await gitDo(() => api.git.pull(), "Pulled"); if (r !== undefined) afterGitWrite(); };
$("gitPush").onclick = () => gitDo(() => api.git.push(), "Pushed");
$("gitSync").onclick = async () => {
  const g = state.git; if (!g || !g.repo) return;
  if (!g.upstream) return gitDo(() => api.git.push(), `Published ${g.branch}`);
  $("gitSync").disabled = true;
  try {
    if (g.behind) { await api.git.pull(); await afterGitWrite(); }
    await api.git.push();
    toast("Synced with " + g.upstream);
  } catch (e) { toast(errMsg(e).split("\n").filter(Boolean).slice(-2).join(" ")); }
  finally { $("gitSync").disabled = false; refreshGit(); }
};
$("gitInit").onclick = () => gitDo(() => api.git.init(), "Initialized a git repository");
$("scmOpenFolder").onclick = chooseFolder;

// Branch picker, in the same style as ⌘P.
async function openBranchPicker() {
  let all;
  try { all = await api.git.branches(); } catch (e) { return toast(errMsg(e)); }
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="palette" role="dialog" aria-label="Switch branch"><input placeholder="Switch to a branch, or type a name to create one" aria-label="Branch name"><div class="items"></div></div>`;
  document.body.appendChild(ov);
  const inp = ov.querySelector("input"), items = ov.querySelector(".items");
  let sel = 0, list = [];
  const close = () => ov.remove();
  const draw = () => {
    const q = inp.value.trim();
    list = all.filter((b) => b.name.toLowerCase().includes(q.toLowerCase())).map((b) => ({ ...b }));
    if (q && !all.some((b) => b.name === q)) list.unshift({ name: q, create: true });
    sel = Math.min(sel, Math.max(0, list.length - 1));
    items.innerHTML = list.map((b, i) => `<button type="button" class="it${i === sel ? " sel" : ""}" data-i="${i}">${b.create ? "+ Create branch " : ""}${esc(b.name)}<small>${b.current ? "current" : b.create ? "from " + esc(state.git.branch || "HEAD") : b.name.includes("/") && !all.some((x) => x.name === b.name.split("/").slice(1).join("/")) ? "remote" : ""}</small></button>`).join("") || `<div class="empty">No branches</div>`;
  };
  const pick = async (b) => {
    close();
    if (!b || b.current) return;
    const r = await gitDo(() => api.git.checkout(b.name, !!b.create), b.create ? `Created ${b.name}` : `Switched to ${b.name}`);
    if (r !== undefined) afterGitWrite();
  };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(list.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") pick(list[sel]);
    else if (e.key === "Escape") close();
  };
  items.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) pick(list[+b.dataset.i]); };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  draw(); inp.focus();
}
$("scmBranch").onclick = openBranchPicker;
$("stBranch").onclick = openBranchPicker;

/* ---------- chats: tabs in the Claude panel, each with its own agent ---------- */
const chatUI = {};   // id → { el, reply, loaded, unread }
function chatEl(id) {
  if (!chatUI[id]) {
    const el = document.createElement("div");
    el.className = "log";
    el.hidden = true;
    $("logs").appendChild(el);
    chatUI[id] = { el, reply: null, loaded: false, unread: false };
  }
  return chatUI[id];
}
// Draw into another chat's log (a background agent's events) without disturbing the visible one.
function inChat(id, fn) {
  if (!id || id === state.chat) return fn();
  const c = chatEl(id), keepLog = log, keepReply = reply;
  log = c.el; reply = c.reply;
  try { return fn(); } finally { c.reply = reply; log = keepLog; reply = keepReply; }
}
async function switchChat(id) {
  if (state.chat && chatUI[state.chat]) chatUI[state.chat].reply = reply;
  state.chat = id;
  const c = chatEl(id);
  Object.values(chatUI).forEach((o) => { o.el.hidden = o !== c; });
  log = c.el; reply = c.reply; c.unread = false;
  try { localStorage.setItem("lumen.chat", id); } catch {}
  renderChatTabs(); updateSend();
  if (!c.loaded) { c.loaded = true; await restoreChat(id); }
}
function setRunning(id, running) {
  const ch = state.chats.find((c) => c.id === id);
  if (ch) ch.running = running;
  renderChatTabs(); updateSend();
}
const pendingApprovals = (id) => (chatUI[id] ? chatUI[id].el.querySelectorAll(".approval:not(.resolved)").length : 0);
function chatState(ch) {
  if (ch.running && pendingApprovals(ch.id)) return { cls: "wait", label: "Waiting for your approval" };
  if (ch.running) return { cls: "run", label: "Working…" };
  if (chatUI[ch.id] && chatUI[ch.id].unread) return { cls: "unread", label: "Finished" };
  return { cls: "", label: "" };
}
function renderChatTabs() {
  const open = state.chats.filter((c) => !c.closed);
  $("chatTabs").innerHTML = open.map((ch) => {
    const st = chatState(ch);
    return `<div class="chat-tab${ch.id === state.chat ? " active" : ""}" role="tab" aria-selected="${ch.id === state.chat}" data-id="${esc(ch.id)}" title="${esc(ch.title)}${st.label ? " · " + st.label : ""}"><span class="cstate ${st.cls}"></span><button type="button" class="nm">${esc(ch.title)}</button><button type="button" class="x" aria-label="Close ${esc(ch.title)}"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></div>`;
  }).join("");
  const act = $("chatTabs").querySelector(".active");
  if (act) act.scrollIntoView({ block: "nearest", inline: "nearest" });
}
let closeArmed = null;
$("chatTabs").addEventListener("click", async (e) => {
  const t = e.target.closest(".chat-tab"); if (!t) return;
  const id = t.dataset.id, ch = state.chats.find((c) => c.id === id);
  if (!e.target.closest(".x")) return switchChat(id);
  if (ch && ch.running && closeArmed !== id) {
    closeArmed = id; setTimeout(() => { if (closeArmed === id) closeArmed = null; }, 4000);
    return toast("Claude is still working in this chat. Close it again to stop it.");
  }
  closeArmed = null;
  const open = state.chats.filter((c) => !c.closed);
  const i = open.findIndex((c) => c.id === id);
  await api.chats.close(id);
  if (id === state.chat) {
    const list = await api.chats.list();
    applyChats(list);
    const rest = list.filter((c) => !c.closed);
    switchChat((rest[Math.min(i, rest.length - 1)] || rest[0]).id);
  }
});
function applyChats(list) {
  state.chats = list;
  if (state.chat && !list.some((c) => c.id === state.chat && !c.closed)) {
    const next = list.find((c) => !c.closed);
    if (next) switchChat(next.id);
  }
  renderChatTabs(); updateSend();
}
api.chats.onChange(applyChats);
async function newChat() {
  // An untouched chat is already a new one.
  const cur = state.chats.find((c) => c.id === state.chat);
  if (cur && !cur.used && !cur.running) { promptEl.focus(); return; }
  const id = await api.chats.create();
  applyChats(await api.chats.list());
  await switchChat(id);
  promptEl.focus();
}
$("newChatBtn").onclick = newChat;
async function initChats() {
  state.chats = await api.chats.list();
  let want = null;
  try { want = localStorage.getItem("lumen.chat"); } catch {}
  const open = state.chats.filter((c) => !c.closed);
  await switchChat((open.find((c) => c.id === want) || open[open.length - 1]).id);
}
// Every chat, including closed ones, newest first.
$("chatHistory").onclick = () => {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="palette" role="dialog" aria-label="All chats"><input placeholder="Search chats" aria-label="Search chats"><div class="items"></div></div>`;
  document.body.appendChild(ov);
  const inp = ov.querySelector("input"), items = ov.querySelector(".items");
  let sel = 0, list = [];
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  const close = () => ov.remove();
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    list = [...state.chats].filter((c) => c.used || c.id === state.chat).filter((c) => c.title.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
    sel = Math.min(sel, Math.max(0, list.length - 1));
    items.innerHTML = list.map((c, i) => `<div class="it${i === sel ? " sel" : ""}" data-i="${i}" role="option"><span class="cstate ${chatState(c).cls}"></span>${esc(c.title)}<small>${c.closed ? "closed · " : ""}${ago(c.updatedAt)}</small><button type="button" class="del" title="Delete chat" aria-label="Delete ${esc(c.title)}">×</button></div>`).join("") || `<div class="empty">No chats yet</div>`;
  };
  const pick = async (c) => {
    close();
    if (!c) return;
    if (c.closed) { await api.chats.reopen(c.id); applyChats(await api.chats.list()); }
    switchChat(c.id);
  };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(list.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") pick(list[sel]);
    else if (e.key === "Escape") close();
  };
  items.onclick = async (e) => {
    const row = e.target.closest("[data-i]"); if (!row) return;
    const c = list[+row.dataset.i];
    if (e.target.closest(".del")) {
      if (c.running) return toast("Stop this chat before deleting it");
      await api.chats.remove(c.id);
      if (chatUI[c.id]) { chatUI[c.id].el.remove(); delete chatUI[c.id]; }
      applyChats(await api.chats.list());
      return draw();
    }
    pick(c);
  };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  draw(); inp.focus();
};

/* ---------- boot ---------- */
(async () => {
  state.info = await api.info();
  syncModel(); setStatus();
  await setWorkspace(state.info.workspace);
  renderTabs(); renderEditor(); await initChats();
  if (!state.info.connected) openSettings();
})();
})();
