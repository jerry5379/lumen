const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { Agent } = require("./agent");
const cc = require("./claudecode");

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

// Approvals: the agent waits on a promise the renderer resolves.
const approvals = new Map();
function requestApproval(req, signal) {
  return new Promise((resolve) => {
    approvals.set(req.id, resolve);
    const onAbort = () => { approvals.delete(req.id); send("agent:event", { type: "approval_cancelled", id: req.id }); resolve("cancel"); };
    signal.addEventListener("abort", onAbort, { once: true });
    send("agent:event", { type: "approval", ...req });
  });
}

const apiAgent = new Agent({
  getApiKey,
  isSignedIn,
  getModel: () => settings.model,
  getWorkspace: () => settings.workspace,
  emit: (ev) => send("agent:event", ev),
  requestApproval,
});
// Default engine: your claude.ai subscription through the installed Claude Code.
const ccAgent = new cc.ClaudeCodeAgent({
  getModel: () => settings.model,
  getWorkspace: () => settings.workspace,
  emit: (ev) => send("agent:event", ev),
  requestApproval,
});
const activeAgent = () => (settings.engine === "api" ? apiAgent : ccAgent);
let ccState = { installed: !!cc.CLAUDE, loggedIn: false, method: null, email: null };
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
    if (engine !== settings.engine) activeAgent().reset();
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
  ccAgent.reset();
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

ipcMain.handle("fs:write", async (_e, { path: file, text }) => {
  const p = expand(file);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text);
  return p;
});

ipcMain.handle("agent:send", async (_e, text) => {
  await activeAgent().run(text);
  return true;
});
ipcMain.handle("agent:stop", () => activeAgent().stop());
ipcMain.handle("agent:reset", () => activeAgent().reset());
ipcMain.handle("agent:approve", (_e, { id, decision }) => {
  const r = approvals.get(id);
  if (r) { approvals.delete(id); r(decision); }
});
ipcMain.handle("inline:edit", async (_e, req) => {
  try { return { text: await activeAgent().inlineEdit(req) }; }
  catch (err) { return { error: require("./agent").describeError(err) }; }
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
