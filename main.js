const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { Agent, MODES } = require("./agent");
const cc = require("./claudecode");
const { ChatStore, searchTranscript } = require("./history");
const { Terminals } = require("./terminal");
const git = require("./git");
const launch = require("./launch");
const { Checkpoints } = require("./checkpoints");

// Anthropic CLI (`ant`) handles "Sign in with Anthropic". Apps opened from Finder
// don't get Homebrew's PATH, so look in the usual install locations.
const ANT = ["/opt/homebrew/bin/ant", "/usr/local/bin/ant", path.join(os.homedir(), "go", "bin", "ant")].find((p) => fs.existsSync(p)) || null;
const ANT_DIR = process.env.ANTHROPIC_CONFIG_DIR || path.join(os.homedir(), ".config", "anthropic");
function isSignedIn() {
  try { return fs.readdirSync(path.join(ANT_DIR, "credentials")).some((f) => f.endsWith(".json")); } catch { return false; }
}
function runAnt(args) {
  return new Promise((resolve) => {
    if (!ANT) return resolve({ code: -1, out: "The Anthropic CLI isn't installed. Run: brew install anthropics/tap/ant" });
    const child = spawn(ANT, args, { env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}
let loginInFlight = null;

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const DEFAULT_MODEL = "claude-opus-5-5";
const TITLE_MODEL = "claude-haiku-5-5"; // chat titles are short; the fastest model is plenty
const TRASH_DAYS = 30;                   // deleted chats stay restorable this long

let win;
let settings = { model: DEFAULT_MODEL, workspace: os.homedir(), apiKeyEnc: null, apiKeyPlain: null, engine: "claude-code", mode: "manual" };

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) }; } catch {}
  if (!fs.existsSync(settings.workspace)) settings.workspace = os.homedir();
  if (!MODES.includes(settings.mode)) settings.mode = "manual";
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}
function getApiKey() {
  if (settings.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, "base64")); } catch {}
  }
  return settings.apiKeyPlain || process.env.ANTHROPIC_API_KEY || null;
}
function setApiKey(key) {
  settings.apiKeyEnc = null;
  settings.apiKeyPlain = null;
  if (key && safeStorage.isEncryptionAvailable()) settings.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
  else if (key) settings.apiKeyPlain = key;
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const terminals = new Terminals(send);

// Chats: every tab in the Claude panel is its own conversation with its own agents,
// so several can run at once. Everything a chat shows is saved so it survives a restart.
const CHATS_DIR = () => path.join(app.getPath("userData"), "chats");
const INDEX = () => path.join(CHATS_DIR(), "index.json");
const chats = new Map();      // id → { id, title, engine, mode, used, closed, deleted, createdAt, updatedAt, store, agents, running, loaded }
const approvals = new Map();  // approval id → { chat, resolve }

const META = ["id", "title", "engine", "mode", "used", "closed", "deleted", "deletedAt", "createdAt", "updatedAt", "note", "titled", "titleLocked"];
const chatMeta = (c) => Object.fromEntries(META.map((k) => [k, c[k]]));
const chatList = () => [...chats.values()].map((c) => ({ ...chatMeta(c), running: !!c.running }));
const broadcastChats = () => send("chats:changed", chatList());
function saveIndex() {
  fs.mkdirSync(CHATS_DIR(), { recursive: true });
  const tmp = INDEX() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify([...chats.values()].map(chatMeta), null, 1), { mode: 0o600 });
  fs.renameSync(tmp, INDEX());
}

function emitFor(chat, ev) {
  chat.store.event(ev);
  send("agent:event", { ...ev, chat: chat.id });
}
function requestApproval(chat, req, signal) {
  return new Promise((resolve) => {
    approvals.set(req.id, { chat: chat.id, resolve });
    const onAbort = () => { approvals.delete(req.id); emitFor(chat, { type: "approval_cancelled", id: req.id }); resolve("cancel"); };
    signal.addEventListener("abort", onAbort, { once: true });
    emitFor(chat, { type: "approval", ...req });
  });
}
function engines(emit, ask, beforeWrite, setMode) {
  const common = { getModel: () => settings.model, getWorkspace: () => settings.workspace, emit, requestApproval: ask, beforeWrite, setMode };
  // Default engine: your claude.ai subscription through the installed Claude Code.
  return { api: new Agent({ getApiKey, isSignedIn, ...common }), "claude-code": new cc.ClaudeCodeAgent(common) };
}
function makeChat(meta) {
  const chat = { mode: settings.mode, ...meta, store: new ChatStore(chatFile(meta.id)), running: false, loaded: false };
  if (!MODES.includes(chat.mode)) chat.mode = "manual";
  chat.ckpt = new Checkpoints(path.join(CHATS_DIR(), meta.id + ".ckpt.json"));
  chat.agents = engines(
    (ev) => emitFor(chat, ev),
    (req, signal) => requestApproval(chat, req, signal),
    (file) => chat.ckpt.before(file),
    (mode) => { if (MODES.includes(mode)) { chat.mode = mode; saveIndex(); broadcastChats(); } },
  );
  chats.set(chat.id, chat);
  return chat;
}
const chatFile = (id) => path.join(CHATS_DIR(), id + ".json");
// Transcripts and agent memory are read from disk the first time a chat is opened.
function loadChat(chat) {
  if (chat.loaded) return chat;
  chat.store.load();
  for (const [name, agent] of Object.entries(chat.agents)) agent.restore(chat.store.engine(name));
  chat.loaded = true;
  return chat;
}
function saveChat(chat) {
  if (!chat.loaded) return;
  for (const [name, agent] of Object.entries(chat.agents)) chat.store.data.engines[name] = agent.snapshot();
  chat.store.flush();
}
const newId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function newChat() {
  const now = Date.now();
  const chat = makeChat({ id: newId(), title: "New chat", engine: settings.engine, mode: settings.mode, used: false, closed: false, createdAt: now, updatedAt: now });
  chat.loaded = true;
  saveIndex();
  broadcastChats();
  return chat;
}
const isChatFile = (f) => /^c[a-z0-9]+\.json$/.test(f);
// A chat file that the index doesn't know about (the index was lost or damaged) becomes a
// closed chat again, titled after its first message, so nothing on disk is ever stranded.
function recoverChat(id) {
  const file = chatFile(id);
  const d = ChatStore.read(file);
  if (!d) return null;
  const first = d.transcript.find((e) => e.type === "user");
  let st = null;
  try { st = fs.statSync(file); } catch {}
  const t = st ? st.mtimeMs : Date.now();
  return makeChat({ id, title: first ? titleFrom(first.text) : "Recovered chat", engine: settings.engine, mode: settings.mode, used: !!first, closed: true, createdAt: st ? st.birthtimeMs || t : t, updatedAt: t });
}
function loadChats() {
  fs.mkdirSync(CHATS_DIR(), { recursive: true });
  let index = [];
  try { index = JSON.parse(fs.readFileSync(INDEX(), "utf8")); } catch {}
  for (const m of Array.isArray(index) ? index : []) if (m && m.id && fs.existsSync(chatFile(m.id))) makeChat(m);
  // Lumen used to keep a single chat in chat.json; it becomes the first tab.
  const legacy = path.join(app.getPath("userData"), "chat.json");
  if (!chats.size && fs.existsSync(legacy)) {
    const old = new ChatStore(legacy).load();
    const first = old.transcript.find((e) => e.type === "user");
    const now = Date.now();
    const meta = { id: newId(), title: first ? titleFrom(first.text) : "New chat", engine: settings.engine, used: !!first, closed: false, createdAt: now, updatedAt: now };
    fs.renameSync(legacy, chatFile(meta.id));
    makeChat(meta);
  }
  // Index recovery: chats on disk that the index lost come back into the history list.
  let recovered = 0;
  try {
    for (const f of fs.readdirSync(CHATS_DIR())) {
      if (!isChatFile(f)) continue;
      const id = f.slice(0, -5);
      if (!chats.has(id) && recoverChat(id)) recovered++;
    }
  } catch {}
  if (recovered) console.log(`Recovered ${recovered} chat${recovered > 1 ? "s" : ""} that the index had lost.`);
  // Deleted chats wait in the trash for a while, then go for good.
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  for (const c of [...chats.values()]) if (c.deleted && (c.deletedAt || 0) < cutoff) purgeChat(c);
  saveIndex();
  if (![...chats.values()].some((c) => !c.closed && !c.deleted)) newChat();
}
const titleFrom = (text) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > 40 ? t.slice(0, 39) + "…" : t || "New chat"; };
function closeChat(chat) {
  for (const a of Object.values(chat.agents)) a.stop();
  chat.closed = true;
  saveIndex();
  if (![...chats.values()].some((c) => !c.closed && !c.deleted)) newChat();
  broadcastChats();
}
// Deleting moves a chat to the trash; its files stay so it can be restored.
function deleteChat(chat) {
  closeChat(chat);
  chat.deleted = true;
  chat.deletedAt = Date.now();
  saveIndex();
  broadcastChats();
}
function undeleteChat(chat) {
  chat.deleted = false;
  chat.deletedAt = null;
  chat.closed = false;
  saveIndex();
  broadcastChats();
}
function purgeChat(chat) {
  for (const a of Object.values(chat.agents)) a.stop();
  chats.delete(chat.id);
  try { fs.rmSync(chatFile(chat.id), { force: true }); } catch {}
  chat.ckpt.remove();
}

// ⌘K, commit messages and chat titles run outside any chat.
const util = engines(() => {}, async () => "deny");
const activeUtil = () => util[settings.engine === "api" ? "api" : "claude-code"];
let ccState = { installed: !!cc.claudePath(), loggedIn: false, method: null, email: null };
let ccLoginInFlight = null;

// A short title written by Claude once the first reply is in, like Cursor and claude.ai do.
async function autoTitle(chat) {
  if (chat.titled || chat.titleLocked) return;
  chat.titled = true;
  const turns = chat.store.turns();
  const first = turns[0];
  if (!first) return;
  const prompt = `Write a title for a chat in a code editor. The user's first message and the start of the reply are below. Reply with the title only: 2 to 6 words, plain text, no quotes, no trailing period, in the language of the message.

<message>
${String(first.text || "(an image)").slice(0, 1500)}
</message>

<reply>
${String(first.reply || "").slice(0, 800)}
</reply>`;
  try {
    const raw = await activeUtil().complete(prompt, { model: TITLE_MODEL });
    const title = String(raw || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
    const clean = title.replace(/^(title:\s*)?["'“”‘’`]+|["'“”‘’`.]+$/g, "").trim();
    if (clean && clean.length <= 70 && !chat.titleLocked && chats.has(chat.id)) {
      chat.title = clean;
      saveIndex();
      broadcastChats();
    }
  } catch (err) {
    console.error("Couldn't title the chat:", err.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1016" : "#f6f7fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // A reloaded or closed window can't reach its old shells any more.
  win.webContents.on("did-start-loading", () => { terminals.killAll(); services.clear(); });
  win.on("closed", () => terminals.killAll());
}

const expand = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : path.resolve(settings.workspace, p));

ipcMain.handle("app:info", async () => {
  ccState = await cc.authStatus();
  return appInfo();
});
const appInfo = () => ({
  engine: settings.engine,
  cc: ccState,
  connected: settings.engine === "api" ? (!!getApiKey() || isSignedIn()) : ccState.loggedIn,
  workspace: settings.workspace,
  home: os.homedir(),
  model: settings.model,
  models: MODELS,
  mode: settings.mode,
  modes: MODES,
  hasKey: !!getApiKey() || isSignedIn(),
  auth: getApiKey() ? "apikey" : isSignedIn() ? "signin" : null,
  canSignIn: !!ANT,
  keyFromEnv: !settings.apiKeyEnc && !settings.apiKeyPlain && !!process.env.ANTHROPIC_API_KEY,
});

ipcMain.handle("settings:set", (_e, { apiKey, model, engine, mode }) => {
  if (typeof apiKey === "string") setApiKey(apiKey.trim());
  if (MODELS.includes(model)) settings.model = model;
  if (engine === "api" || engine === "claude-code") {
    settings.engine = engine;
  }
  if (MODES.includes(mode)) settings.mode = mode; // the mode new chats start in
  saveSettings();
  return appInfo();
});

ipcMain.handle("cc:login", async () => {
  if (!ccLoginInFlight) ccLoginInFlight = cc.login().finally(() => { ccLoginInFlight = null; });
  const r = await ccLoginInFlight;
  ccState = await cc.authStatus();
  if (win && !win.isDestroyed()) win.focus();
  if (ccState.loggedIn) return { ok: true };
  return { ok: false, message: (r.out.split("\n").filter(Boolean).pop()) || "Sign-in didn't finish. Try again." };
});
ipcMain.handle("cc:logout", async () => {
  await cc.logout();
  ccState = await cc.authStatus();
  // Claude Code sessions belong to the account that was signed in.
  for (const c of chats.values()) { if (c.loaded) { c.agents["claude-code"].reset(); saveChat(c); } }
  return appInfo();
});

ipcMain.handle("auth:login", async () => {
  if (!loginInFlight) {
    loginInFlight = runAnt(["auth", "login"]).finally(() => { loginInFlight = null; });
  }
  const r = await loginInFlight;
  if (r.code === 0 && isSignedIn()) {
    // One credential at a time: a saved API key would override the sign-in.
    setApiKey("");
    saveSettings();
    if (win && !win.isDestroyed()) win.focus();
    return { ok: true };
  }
  return { ok: false, message: /timeout|timed out/i.test(r.out) ? "The sign-in page timed out. Try again." : (r.out.split("\n").pop() || "Sign-in didn't finish.") };
});

ipcMain.handle("auth:logout", async () => {
  await runAnt(["auth", "logout"]);
  return { signedIn: isSignedIn() };
});

ipcMain.handle("workspace:choose", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], defaultPath: settings.workspace });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.workspace = r.filePaths[0];
  saveSettings();
  return settings.workspace;
});

ipcMain.handle("fs:list", async (_e, dir) => {
  const d = expand(dir);
  const entries = await fsp.readdir(d, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== ".DS_Store")
    .map((e) => ({ name: e.name, path: path.join(d, e.name), dir: e.isDirectory() || (e.isSymbolicLink() && safeIsDir(path.join(d, e.name))) }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
});
function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

ipcMain.handle("theme:set", (_e, mode) => {
  nativeTheme.themeSource = ["light", "dark"].includes(mode) ? mode : "system";
});

ipcMain.handle("fs:read", async (_e, file) => {
  const p = expand(file);
  const stat = await fsp.stat(p);
  if (stat.size > 5 * 1024 * 1024) return { path: p, error: `File is too large to open here (${(stat.size / 1048576).toFixed(1)} MB).` };
  const buf = await fsp.readFile(p);
  if (buf.subarray(0, 8000).includes(0)) return { path: p, error: "This looks like a binary file." };
  return { path: p, text: buf.toString("utf8") };
});

// Explorer drag and drop: move inside the workspace, copy in from Finder.
async function exists(p) { try { await fsp.lstat(p); return true; } catch { return false; } }
async function dropTarget(from, toDir) {
  const src = expand(from), dir = expand(toDir);
  const dest = path.join(dir, path.basename(src));
  if (dest === src) return { src, dest, same: true };
  if (dir === src || dir.startsWith(src + path.sep)) throw new Error("Can't move a folder into itself.");
  if (await exists(dest)) throw new Error(`${path.basename(src)} already exists in ${path.basename(dir)}.`);
  return { src, dest };
}
ipcMain.handle("fs:move", async (_e, { from, toDir }) => {
  const t = await dropTarget(from, toDir);
  if (t.same) return t.dest;
  try { await fsp.rename(t.src, t.dest); }
  catch (e) {
    if (e.code !== "EXDEV") throw e;
    await fsp.cp(t.src, t.dest, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(t.src, { recursive: true });
  }
  return t.dest;
});
ipcMain.handle("fs:copy", async (_e, { from, toDir }) => {
  const t = await dropTarget(from, toDir);
  if (t.same) return t.dest;
  await fsp.cp(t.src, t.dest, { recursive: true, errorOnExist: true, force: false });
  return t.dest;
});

ipcMain.handle("fs:write", async (_e, { path: file, text }) => {
  const p = expand(file);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text);
  return p;
});

/* ---------- chats ---------- */
ipcMain.handle("chat:list", () => chatList());
ipcMain.handle("chat:new", () => newChat().id);
ipcMain.handle("chat:history", (_e, id) => { const c = chats.get(id); return c ? loadChat(c).store.data.transcript : []; });
ipcMain.handle("chat:close", (_e, id) => { const c = chats.get(id); if (c) closeChat(c); });
ipcMain.handle("chat:reopen", (_e, id) => { const c = chats.get(id); if (c) { c.closed = false; if (c.deleted) undeleteChat(c); saveIndex(); broadcastChats(); } });
ipcMain.handle("chat:delete", (_e, id) => { const c = chats.get(id); if (c) deleteChat(c); });
ipcMain.handle("chat:undelete", (_e, id) => { const c = chats.get(id); if (c && c.deleted) undeleteChat(c); });
ipcMain.handle("chat:purge", async (_e, id) => {
  const c = chats.get(id);
  if (!c) return;
  const r = await dialog.showMessageBox(win, { type: "warning", buttons: ["Delete forever", "Cancel"], defaultId: 1, cancelId: 1, message: `Delete "${c.title}" forever?`, detail: "This removes the chat and its checkpoints from disk. It can't be undone." });
  if (r.response !== 0) return false;
  purgeChat(c);
  saveIndex();
  broadcastChats();
  return true;
});
ipcMain.handle("chat:rename", (_e, { id, title }) => {
  const c = chats.get(id);
  if (!c) return;
  const t = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (t) { c.title = t; c.titleLocked = true; }
  else { c.titleLocked = false; c.titled = false; }
  saveIndex();
  broadcastChats();
  return c.title;
});
ipcMain.handle("chat:setMode", (_e, { id, mode }) => {
  const c = chats.get(id);
  if (!c || !MODES.includes(mode)) return;
  c.mode = mode;
  settings.mode = mode; // new chats start in the mode you used last
  saveSettings();
  saveIndex();
  broadcastChats();
});
// Full-text search over every chat (titles and what was said), for the history list.
ipcMain.handle("chat:search", (_e, query) => {
  const q = String(query || "").trim();
  if (!q) return [];
  const out = [];
  for (const c of chats.values()) {
    const transcript = c.loaded ? c.store.data.transcript : (ChatStore.read(chatFile(c.id)) || {}).transcript || [];
    const hit = searchTranscript(transcript, q);
    const inTitle = c.title.toLowerCase().includes(q.toLowerCase());
    if (hit || inTitle) out.push({ id: c.id, count: hit ? hit.count : 0, snippet: hit ? hit.snippet : "" });
    if (out.length >= 100) break;
  }
  return out;
});

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
ipcMain.handle("agent:send", async (_e, id, text, display, images) => {
  const chat = chats.get(id);
  if (!chat) throw new Error("That chat was closed.");
  if (chat.running) throw new Error("Claude is still answering in this chat.");
  loadChat(chat);
  const shown = display && typeof display.text === "string" ? display.text : text;
  images = (Array.isArray(images) ? images : []).filter((i) => i && IMAGE_TYPES.has(i.mime) && typeof i.data === "string").slice(0, 20);
  const previews = display && Array.isArray(display.images) ? display.images.filter((s) => typeof s === "string" && s.startsWith("data:image/")).slice(0, 20) : [];
  // Turns are numbered by user message, the same way the chat panel numbers them.
  const turn = chat.store.data.transcript.filter((e) => e.type === "user").length;
  chat.store.user(shown, display && display.ctx, previews);
  chat.ckpt.begin(turn);
  // After a restore, Claude needs to know its later edits are gone.
  if (chat.note) { text = `<lumen_note>${chat.note}</lumen_note>\n\n${text}`; chat.note = null; }
  const firstTurn = !chat.used || turn === 0;
  if (!chat.used) { chat.used = true; chat.title = titleFrom(shown || (images.length ? "Image" : "")); }
  // Each engine keeps its own memory of the chat.
  if (chat.engine !== settings.engine) {
    if (chat.store.data.transcript.length > 1) emitFor(chat, { type: "notice", text: `This chat started on the ${chat.engine === "api" ? "Anthropic API" : "Claude subscription"}. Claude won't see the earlier messages from it.` });
    chat.engine = settings.engine;
  }
  chat.running = true;
  chat.updatedAt = Date.now();
  saveIndex();
  broadcastChats();
  try { await chat.agents[settings.engine].run(text, images, chat.mode); }
  finally {
    chat.ckpt.end();
    chat.running = false;
    chat.updatedAt = Date.now();
    saveChat(chat);
    saveIndex();
    broadcastChats();
  }
  if (firstTurn && !chat.titleLocked) autoTitle(chat);
  return true;
});
/* ---------- restore checkpoints ---------- */
ipcMain.handle("chat:checkpoints", (_e, id) => { const c = chats.get(id); return c ? c.ckpt.summary() : { turns: [], redo: null }; });
const shortPath = (f) => { const home = os.homedir(); return f.startsWith(home) ? "~" + f.slice(home.length) : f; };
ipcMain.handle("chat:restore", async (_e, { id, turn }) => {
  const chat = chats.get(id);
  if (!chat) return { files: [] };
  if (chat.running) throw new Error("Stop Claude in this chat before restoring a checkpoint.");
  chat.ckpt.load();
  const changed = await chat.ckpt.changedSince(turn);
  if (!changed.length) throw new Error("Nothing to restore: Claude hasn't changed any files since this message.");
  const r = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Restore", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Restore ${changed.length} file${changed.length > 1 ? "s" : ""} to this checkpoint?`,
    detail: `Changes Claude made from this message on will be undone. Your own edits to these files since then are undone too.\n\n${changed.slice(0, 12).map(shortPath).join("\n")}${changed.length > 12 ? `\n…and ${changed.length - 12} more` : ""}\n\nYou can redo this until you send the next message.`,
  });
  if (r.response !== 0) return { cancelled: true };
  const files = await chat.ckpt.restore(turn);
  for (const f of files) send("agent:event", { type: "file_changed", path: f, chat: id });
  emitFor(chat, { type: "checkpoint_restored", turn, files });
  chat.note = `The user restored their files to the checkpoint before their message #${turn + 1} in this chat. Every file change you made from that message on has been undone (${files.map(shortPath).join(", ")}). Treat those files as they are on disk now, not as you last left them.`;
  saveIndex();
  return { files };
});
ipcMain.handle("chat:redo", async (_e, id) => {
  const chat = chats.get(id);
  if (!chat || chat.running) return null;
  const r = await chat.ckpt.redoRestore();
  if (!r) throw new Error("There's no restore to redo.");
  for (const f of r.files) send("agent:event", { type: "file_changed", path: f, chat: id });
  emitFor(chat, { type: "checkpoint_redone", turn: r.turn });
  chat.note = null;
  saveIndex();
  return r;
});
// Edit & resend: go back to one of your messages. Files Claude changed since then are put
// back, the later part of this chat is removed (Claude forgets it too), and the message
// returns to the box to be edited and sent again. Only this chat is affected.
ipcMain.handle("chat:rollback", async (_e, { id, turn }) => {
  const chat = chats.get(id);
  if (!chat) return null;
  if (chat.running) throw new Error("Stop Claude in this chat before going back to an earlier message.");
  loadChat(chat);
  const turns = chat.store.turns();
  const msg = turns[turn];
  if (!msg) throw new Error("That message isn't in this chat any more.");
  chat.ckpt.load();
  const changed = await chat.ckpt.changedSince(turn);
  const later = turns.length - turn - 1;
  const r = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Go back", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Go back to message ${turn + 1} and edit it?`,
    detail: [
      changed.length ? `${changed.length} file${changed.length > 1 ? "s" : ""} Claude changed since then will be put back:\n${changed.slice(0, 10).map(shortPath).join("\n")}${changed.length > 10 ? `\n…and ${changed.length - 10} more` : ""}` : "Claude hasn't changed any files since then.",
      later ? `The reply and the ${later} later message${later > 1 ? "s" : ""} in this chat are removed; Claude won't remember them.` : "Claude's reply is removed.",
      "The message goes back into the box so you can change it and send it again. Other chats aren't affected.",
    ].join("\n\n"),
  });
  if (r.response !== 0) return { cancelled: true };
  const files = changed.length ? await chat.ckpt.restore(turn) : [];
  chat.ckpt.forget(turn);
  for (const f of files) send("agent:event", { type: "file_changed", path: f, chat: id });
  chat.store.truncate(turn);
  let forgot = true;
  for (const [name, a] of Object.entries(chat.agents)) { const ok = a.rewind(turn); if (name === chat.engine && !ok) forgot = false; }
  chat.note = forgot ? null : `The user went back to their message #${turn + 1} in this chat to change it: that message and everything after it are withdrawn${files.length ? `, and these files were restored to how they were before it: ${files.map(shortPath).join(", ")}` : ""}. Treat the next message as replacing it.`;
  if (turn === 0) { chat.used = false; chat.titled = false; if (!chat.titleLocked) chat.title = "New chat"; }
  chat.updatedAt = Date.now();
  saveChat(chat);
  saveIndex();
  broadcastChats();
  return { text: msg.text, images: msg.images, files };
});
ipcMain.handle("agent:stop", (_e, id) => { const c = chats.get(id); if (c) for (const a of Object.values(c.agents)) a.stop(); });
ipcMain.handle("agent:approve", (_e, { id, decision }) => {
  const r = approvals.get(id);
  if (!r) return;
  approvals.delete(id);
  const chat = chats.get(r.chat);
  if (chat) chat.store.event({ type: "approval_result", id, decision });
  r.resolve(decision);
});
ipcMain.handle("inline:edit", async (_e, req) => {
  try { return { text: await activeUtil().inlineEdit(req) }; }
  catch (err) { return { error: require("./agent").describeError(err) }; }
});

/* ---------- integrated terminal ---------- */
ipcMain.handle("term:create", (_e, { cwd, cols, rows } = {}) => terminals.create({ cwd: cwd ? expand(cwd) : settings.workspace, cols, rows }));
ipcMain.on("term:write", (_e, { id, data }) => terminals.write(id, data));
ipcMain.on("term:resize", (_e, { id, cols, rows }) => terminals.resize(id, cols, rows));
ipcMain.handle("term:kill", (_e, id) => terminals.kill(id));

/* ---------- run & debug: project services in their own terminals ---------- */
const services = new Map(); // config id → { id, name, termId, pid, startedAt, exitCode, url, debug }
const serviceList = () => Object.fromEntries([...services.values()].map((s) => [s.id, s]));
const broadcastServices = () => send("services:changed", serviceList());
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>)\]]*)?/;
ipcMain.handle("run:configs", () => launch.configs(settings.workspace));
ipcMain.handle("run:file", async () => launch.ensureFile(settings.workspace));
ipcMain.handle("run:list", () => serviceList());
ipcMain.handle("run:start", (_e, { config, debug, cols, rows }) => {
  if (!config || typeof config.command !== "string") throw new Error("That configuration has no command.");
  const cur = services.get(config.id);
  if (cur && terminals.alive(cur.termId)) throw new Error(`${config.name} is already running.`);
  const env = { ...(config.env || {}) };
  // Debug: Node listens for the inspector so Chrome DevTools or an IDE can attach on port 9229.
  if (debug) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--inspect"].filter(Boolean).join(" ");
  const svc = { id: config.id, name: config.name, command: config.command, cwd: config.cwd, termId: null, pid: null, startedAt: Date.now(), exitCode: null, url: null, debug: !!debug };
  const t = terminals.create({
    cwd: config.cwd || settings.workspace, cols, rows, command: config.command, env,
    onData: (data) => {
      if (svc.url) return;
      const m = URL_RE.exec(data.replace(/\x1b\[[0-9;]*m/g, ""));
      if (m) { svc.url = m[0].replace(/0\.0\.0\.0|\[::1?\]/, "localhost"); broadcastServices(); }
    },
    onExit: (code) => { svc.exitCode = code; broadcastServices(); },
  });
  svc.termId = t.id; svc.pid = t.pid;
  services.set(svc.id, svc);
  broadcastServices();
  return svc;
});
ipcMain.handle("run:stop", (_e, id) => {
  const svc = services.get(id);
  if (!svc) return false;
  terminals.stop(svc.termId);
  return true;
});
ipcMain.handle("run:dismiss", (_e, id) => {
  const svc = services.get(id);
  if (!svc) return;
  if (terminals.alive(svc.termId)) terminals.stop(svc.termId);
  services.delete(id);
  broadcastServices();
});
ipcMain.handle("run:open", (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

/* ---------- source control ---------- */
ipcMain.handle("git:status", () => git.status(settings.workspace));
ipcMain.handle("git:diff", (_e, { file, staged }) => git.diff(settings.workspace, file, staged));
ipcMain.handle("git:stage", (_e, files) => git.stage(settings.workspace, files));
ipcMain.handle("git:unstage", (_e, files) => git.unstage(settings.workspace, files));
ipcMain.handle("git:discard", async (_e, { tracked = [], untracked = [] }) => {
  const n = tracked.length + untracked.length;
  const what = n === 1 ? path.basename(tracked[0] || untracked[0]) : `${n} files`;
  const r = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Discard", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Discard changes to ${what}?`,
    detail: untracked.length ? "New files will be deleted. This can't be undone." : "Your changes will be lost. This can't be undone.",
  });
  if (r.response !== 0) return false;
  await git.discard(settings.workspace, tracked, untracked);
  return true;
});
ipcMain.handle("git:commit", async (_e, { message, amend }) => {
  let all = false;
  if (!amend && !(await git.hasStaged(settings.workspace))) {
    const r = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Stage All and Commit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "There are no staged changes.",
      detail: "Stage all your changes and commit them?",
    });
    if (r.response !== 0) return false;
    all = true;
  }
  await git.commit(settings.workspace, message, { all, amend });
  return true;
});
ipcMain.handle("git:push", () => git.push(settings.workspace));
ipcMain.handle("git:pull", () => git.pull(settings.workspace));
ipcMain.handle("git:fetch", () => git.fetch(settings.workspace));
ipcMain.handle("git:branches", () => git.branches(settings.workspace));
ipcMain.handle("git:checkout", (_e, { name, create }) => git.checkout(settings.workspace, name, create));
ipcMain.handle("git:init", () => git.init(settings.workspace));
ipcMain.handle("git:message", async () => {
  const changes = await git.changesForMessage(settings.workspace);
  if (!changes.trim()) throw new Error("There are no changes to describe.");
  const text = await activeUtil().complete(`Write a git commit message for these changes.

<changes>
${changes}
</changes>

Use a short imperative subject line (under 72 characters). Add a blank line and a brief body only if the change needs explaining. Reply with only the commit message: no quotes, no code fences, and do not use any tools.`);
  return text.replace(/^\s*```[^\n]*\n/, "").replace(/\n?```\s*$/, "").trim();
});

app.whenReady().then(() => {
  loadSettings();
  loadChats();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { for (const c of chats.values()) saveChat(c); terminals.killAll(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
