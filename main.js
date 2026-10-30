const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { Agent } = require("./agent");
const cc = require("./claudecode");
const { ChatStore } = require("./history");
const { Terminals } = require("./terminal");
const git = require("./git");

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
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

let win;
let settings = { model: MODELS[0], workspace: os.homedir(), apiKeyEnc: null, apiKeyPlain: null, engine: "claude-code" };

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) }; } catch {}
  if (!fs.existsSync(settings.workspace)) settings.workspace = os.homedir();
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
const chats = new Map();      // id → { id, title, engine, used, closed, createdAt, updatedAt, store, agents, running, loaded }
const approvals = new Map();  // approval id → { chat, resolve }

const META = ["id", "title", "engine", "used", "closed", "createdAt", "updatedAt"];
const chatMeta = (c) => Object.fromEntries(META.map((k) => [k, c[k]]));
const chatList = () => [...chats.values()].map((c) => ({ ...chatMeta(c), running: !!c.running }));
const broadcastChats = () => send("chats:changed", chatList());
function saveIndex() {
  fs.mkdirSync(CHATS_DIR(), { recursive: true });
  fs.writeFileSync(path.join(CHATS_DIR(), "index.json"), JSON.stringify([...chats.values()].map(chatMeta), null, 1), { mode: 0o600 });
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
function engines(emit, ask) {
  const common = { getModel: () => settings.model, getWorkspace: () => settings.workspace, emit, requestApproval: ask };
  // Default engine: your claude.ai subscription through the installed Claude Code.
  return { api: new Agent({ getApiKey, isSignedIn, ...common }), "claude-code": new cc.ClaudeCodeAgent(common) };
}
function makeChat(meta) {
  const chat = { ...meta, store: new ChatStore(path.join(CHATS_DIR(), meta.id + ".json")), running: false, loaded: false };
  chat.agents = engines((ev) => emitFor(chat, ev), (req, signal) => requestApproval(chat, req, signal));
  chats.set(chat.id, chat);
  return chat;
}
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
  const chat = makeChat({ id: newId(), title: "New chat", engine: settings.engine, used: false, closed: false, createdAt: now, updatedAt: now });
  chat.loaded = true;
  saveIndex();
  broadcastChats();
  return chat;
}
function loadChats() {
  fs.mkdirSync(CHATS_DIR(), { recursive: true });
  let index = [];
  try { index = JSON.parse(fs.readFileSync(path.join(CHATS_DIR(), "index.json"), "utf8")); } catch {}
  for (const m of Array.isArray(index) ? index : []) if (m && m.id) makeChat(m);
  // Lumen used to keep a single chat in chat.json; it becomes the first tab.
  const legacy = path.join(app.getPath("userData"), "chat.json");
  if (!chats.size && fs.existsSync(legacy)) {
    const old = new ChatStore(legacy).load();
    const first = old.transcript.find((e) => e.type === "user");
    const now = Date.now();
    const meta = { id: newId(), title: first ? titleFrom(first.text) : "New chat", engine: settings.engine, used: !!first, closed: false, createdAt: now, updatedAt: now };
    fs.renameSync(legacy, path.join(CHATS_DIR(), meta.id + ".json"));
    makeChat(meta);
    saveIndex();
  }
  if (![...chats.values()].some((c) => !c.closed)) newChat();
}
const titleFrom = (text) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > 40 ? t.slice(0, 39) + "…" : t || "New chat"; };
function closeChat(chat) {
  for (const a of Object.values(chat.agents)) a.stop();
  chat.closed = true;
  saveIndex();
  if (![...chats.values()].some((c) => !c.closed)) newChat();
  broadcastChats();
}
function deleteChat(chat) {
  closeChat(chat);
  chats.delete(chat.id);
  try { fs.rmSync(path.join(CHATS_DIR(), chat.id + ".json"), { force: true }); } catch {}
  saveIndex();
  broadcastChats();
}

// ⌘K and commit messages run outside any chat.
const util = engines(() => {}, async () => "deny");
const activeUtil = () => util[settings.engine === "api" ? "api" : "claude-code"];
let ccState = { installed: !!cc.claudePath(), loggedIn: false, method: null, email: null };
let ccLoginInFlight = null;

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
  win.webContents.on("did-start-loading", () => terminals.killAll());
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
  hasKey: !!getApiKey() || isSignedIn(),
  auth: getApiKey() ? "apikey" : isSignedIn() ? "signin" : null,
  canSignIn: !!ANT,
  keyFromEnv: !settings.apiKeyEnc && !settings.apiKeyPlain && !!process.env.ANTHROPIC_API_KEY,
});

ipcMain.handle("settings:set", (_e, { apiKey, model, engine }) => {
  if (typeof apiKey === "string") setApiKey(apiKey.trim());
  if (MODELS.includes(model)) settings.model = model;
  if (engine === "api" || engine === "claude-code") {
    settings.engine = engine;
  }
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

ipcMain.handle("chat:list", () => chatList());
ipcMain.handle("chat:new", () => newChat().id);
ipcMain.handle("chat:history", (_e, id) => { const c = chats.get(id); return c ? loadChat(c).store.data.transcript : []; });
ipcMain.handle("chat:close", (_e, id) => { const c = chats.get(id); if (c) closeChat(c); });
ipcMain.handle("chat:reopen", (_e, id) => { const c = chats.get(id); if (c) { c.closed = false; saveIndex(); broadcastChats(); } });
ipcMain.handle("chat:delete", (_e, id) => { const c = chats.get(id); if (c) deleteChat(c); });
ipcMain.handle("agent:send", async (_e, id, text, display) => {
  const chat = chats.get(id);
  if (!chat) throw new Error("That chat was closed.");
  if (chat.running) throw new Error("Claude is still answering in this chat.");
  loadChat(chat);
  const shown = display && typeof display.text === "string" ? display.text : text;
  chat.store.user(shown, display && display.ctx);
  if (!chat.used) { chat.used = true; chat.title = titleFrom(shown); }
  // Each engine keeps its own memory of the chat.
  if (chat.engine !== settings.engine) {
    if (chat.store.data.transcript.length > 1) emitFor(chat, { type: "notice", text: `This chat started on the ${chat.engine === "api" ? "Anthropic API" : "Claude subscription"}. Claude won't see the earlier messages from it.` });
    chat.engine = settings.engine;
  }
  chat.running = true;
  chat.updatedAt = Date.now();
  saveIndex();
  broadcastChats();
  try { await chat.agents[settings.engine].run(text); }
  finally {
    chat.running = false;
    chat.updatedAt = Date.now();
    saveChat(chat);
    saveIndex();
    broadcastChats();
  }
  return true;
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
