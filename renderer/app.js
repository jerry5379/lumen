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
  busy: false,
  expanded: new Set(),
  fileIndex: null,
  attachments: [],     // { path, dir } dragged into the chat
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
    b.draggable = true;
    b.addEventListener("dragstart", (e) => dragPath(e, en.path, en.dir));
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
        if (open) { state.expanded.add(en.path); if (!kids.childElementCount) await renderDir(kids, en.path, depth + 1); }
        else state.expanded.delete(en.path);
      };
      b.onclick = toggle;
      if (state.expanded.has(en.path)) await toggle();
    } else {
      b.onclick = () => openFile(en.path);
    }
  }
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
    d.addEventListener("dragstart", (e) => dragPath(e, t.path, false));
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
function renderDiff() {
  const d = state.pending;
  const show = d && d.path === state.active;
  $("diff").hidden = !show;
  if (!show) return;
  const r = diffHtml(d.before, d.after, d.path);
  $("diffTitle").textContent = d.label;
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
const log = $("log");
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
  return `<div class="cb"><div class="cb-head"><span class="grow">${esc(info || "code")}</span>${open ? "" : `<button type="button" data-act="insert" data-id="${id}">Insert at cursor</button><button type="button" data-act="copy" data-id="${id}">Copy</button>`}</div><pre>${highlight(code, "x." + lang)}</pre></div>`;
}
log.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const code = blocks[b.dataset.id];
  if (b.dataset.act === "copy") {
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

api.onEvent((ev) => {
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
    case "approval": showApproval(ev); break;
    case "approval_cancelled": {
      const card = log.querySelector(`.approval[data-id="${CSS.escape(ev.id)}"]`);
      if (card) resolveCard(card, "Cancelled");
      if (state.pending && state.pending.approvalId === ev.id) { state.pending = null; renderDiff(); }
      break;
    }
    case "file_changed": reloadFromDisk(ev.path); state.fileIndex = null; break;
    case "notice": r.el.insertAdjacentHTML("beforeend", `<div class="notice">${esc(ev.text)}</div>`); break;
    case "error": r.el.insertAdjacentHTML("beforeend", `<div class="error">${esc(ev.message)}</div>`); if (/API key|Sign in|sign in|signed in/.test(ev.message)) openSettings(); break;
    case "done":
      if (ev.stopped) r.el.insertAdjacentHTML("beforeend", `<div class="notice">Stopped.</div>`);
      r.el.querySelectorAll(".pulse").forEach((p) => p.remove());
      r.el.querySelectorAll(".tool.running").forEach((t) => { t.className = "tool err"; });
      break;
  }
});

function showApproval(ev) {
  const r = replyEl();
  const card = document.createElement("div");
  card.className = "approval";
  card.dataset.id = ev.id;
  const p = ev.preview;
  let body = "";
  if (p.kind === "command") {
    body = `<div class="q">Run this command?</div><pre>${esc(p.command)}</pre><div class="verdict">in ${esc(p.cwd)}</div>`;
  } else {
    const st = diffHtml(p.before, p.after, p.path);
    body = `<div class="q">${p.created ? "Create" : "Change"} ${esc(base(p.path))}? <span class="stat"><span style="color:var(--add-fg)">+${st.adds}</span> <span style="color:var(--del-fg)">−${st.dels}</span></span></div><div class="verdict">${esc(p.path)}</div>`;
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

  const decide = (decision) => {
    if (card.classList.contains("resolved")) return;
    if (state.pending && state.pending.approvalId === ev.id) { state.pending = null; renderDiff(); }
    resolveCard(card, decision === "deny" ? "Declined" : decision === "always" ? "Allowed (and for the rest of this chat)" : "Allowed");
    api.approve(ev.id, decision);
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
  if (p.kind === "diff") view();
}
function resolveCard(card, verdict) {
  card.classList.add("resolved");
  card.querySelector(".acts").innerHTML = `<span class="verdict">${esc(verdict)}</span>`;
}

/* ---------- composer ---------- */
const promptEl = $("prompt"), sendBtn = $("send");
const SEND_ICON = sendBtn.innerHTML;
const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
function updateSend() {
  if (state.busy) { sendBtn.disabled = false; sendBtn.classList.add("stop"); sendBtn.innerHTML = STOP_ICON; sendBtn.setAttribute("aria-label", "Stop"); return; }
  sendBtn.classList.remove("stop"); sendBtn.innerHTML = SEND_ICON; sendBtn.setAttribute("aria-label", "Send");
  sendBtn.disabled = !promptEl.value.trim();
}
promptEl.addEventListener("input", () => { promptEl.style.height = "auto"; promptEl.style.height = Math.min(200, promptEl.scrollHeight) + "px"; updateSend(); });
promptEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!state.busy) send(); } });
sendBtn.onclick = () => (state.busy ? api.stop() : send());

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
    const icon = a.dir ? "📁 " : `<span class="dot" style="background:${DOT[ext(a.path)] || "var(--faint)"}"></span>`;
    bar.insertAdjacentHTML("beforeend", `<span class="pill att" title="${esc(a.path)}">${icon}${esc(base(a.path) || a.path)}<button type="button" class="rm" data-i="${i}" aria-label="Remove ${esc(base(a.path))}">×</button></span>`);
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

async function attachmentContext(list) {
  const parts = [];
  for (const a of list) {
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
  if (!q || state.busy) return;
  if (!state.info.connected) { openSettings(); return; }
  const t = tab(), sel = currentSel();
  promptEl.value = ""; promptEl.dispatchEvent(new Event("input"));
  const atts = state.attachments.splice(0);
  renderCtx();
  const ctxNote = [t ? base(t.path) : null, sel ? `L${sel.l1}${sel.l2 !== sel.l1 ? "–" + sel.l2 : ""}` : null, ...atts.map((a) => base(a.path))].filter(Boolean).join(" · ");
  addEl("msg user", esc(q) + (ctxNote ? `<span class="ctx">${esc(ctxNote)}</span>` : ""));

  let full = q;
  const ctx = [];
  if (t) {
    ctx.push(`Open in editor: ${t.path}${t.text !== t.savedText ? " (has unsaved changes; the editor buffer is below)" : ""}`);
    if (t.text !== t.savedText && t.text.length < 60000) ctx.push("Unsaved editor buffer:\n```\n" + t.text + "\n```");
  }
  ctx.push(...(await attachmentContext(atts)));
  if (sel) ctx.push(`Selected lines ${sel.l1}-${sel.l2}:\n\`\`\`\n${sel.text}\n\`\`\``);
  if (ctx.length) full = `<editor_context>\n${ctx.join("\n\n")}\n</editor_context>\n\n${q}`;

  reply = null;
  replyEl().el.insertAdjacentHTML("beforeend", "");
  state.busy = true; updateSend();
  try { await api.send(full); }
  catch (e) { replyEl().el.insertAdjacentHTML("beforeend", `<div class="error">${esc(e.message)}</div>`); }
  finally { state.busy = false; updateSend(); reply = null; }
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
  return mode;
}
let themeMode = "system";
try { themeMode = localStorage.getItem("lumen.theme") || "system"; } catch {}
themeMode = applyTheme(themeMode);
$("themeBtn").onclick = () => { themeMode = applyTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]); toast(`Theme: ${themeMode}`); };

$("clearChat").onclick = async () => { await api.reset(); state.pending = null; renderDiff(); welcome(); };

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
async function openPalette() {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="palette" role="dialog" aria-label="Go to file"><input placeholder="Go to file in ${esc(base(state.workspace) || "/")}…" aria-label="File name"><div class="items"><div class="empty">Indexing…</div></div></div>`;
  document.body.appendChild(ov);
  const inp = ov.querySelector("input"), items = ov.querySelector(".items");
  inp.focus();
  let sel = 0, list = [];
  const close = () => ov.remove();
  const rel = (p) => p.startsWith(state.workspace + "/") ? p.slice(state.workspace.length + 1) : p;
  const draw = () => {
    const q = inp.value.toLowerCase().replace(/\s+/g, "");
    const files = state.fileIndex || [];
    list = [];
    for (const p of files) {
      const s = rel(p).toLowerCase(); let i = 0;
      for (const c of s) if (c === q[i]) i++;
      if (i === q.length) { list.push(p); if (list.length > 200) break; }
    }
    if (q) list.sort((a, b) => (base(a).toLowerCase().includes(q) ? 0 : 1) - (base(b).toLowerCase().includes(q) ? 0 : 1));
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
  if (mod && k === "k") { e.preventDefault(); openInline(); }
  else if (mod && k === "l") { e.preventDefault(); if (document.activeElement === ta) selMemo = ta.selectionStart !== ta.selectionEnd ? { s: ta.selectionStart, e: ta.selectionEnd } : null; promptEl.focus(); renderCtx(); }
  else if (mod && k === "p") { e.preventDefault(); openPalette(); }
  else if (mod && k === "o") { e.preventDefault(); chooseFolder(); }
  else if (mod && k === "s") { e.preventDefault(); saveActive(); }
  else if (mod && k === "w") { e.preventDefault(); if (state.active) closeTab(state.active); }
  else if (mod && e.key === "Enter" && state.pending && state.pending.path === state.active) { e.preventDefault(); resolveDiff(true); }
  else if (e.key === "Escape" && state.pending && state.pending.path === state.active && $("inline").hidden && !document.querySelector(".overlay:not([hidden])")) { resolveDiff(false); }
});

/* ---------- boot ---------- */
(async () => {
  state.info = await api.info();
  syncModel(); setStatus();
  await setWorkspace(state.info.workspace);
  renderTabs(); renderEditor(); welcome();
  if (!state.info.connected) openSettings();
})();
})();
