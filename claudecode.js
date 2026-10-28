// Claude Code engine: runs your installed `claude` through the Claude Agent SDK,
// so Lumen uses your claude.ai subscription. Emits the same events as agent.js,
// so the UI is shared between both engines.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

// Apps opened from Finder get a minimal PATH; give Claude Code (and its Bash tool) the usual one.
const NVM_BINS = (() => {
  try {
    const dir = path.join(os.homedir(), ".nvm", "versions", "node");
    return fs.readdirSync(dir).map((v) => path.join(dir, v, "bin")).reverse();
  } catch { return []; }
})();
// Prefer the copy your terminal uses (npm/nvm or the native installer) over older Homebrew casks.
const EXTRA_PATH = [path.join(os.homedir(), ".local", "bin"), ...NVM_BINS, "/opt/homebrew/bin", "/usr/local/bin"];
const ENV_PATH = [...EXTRA_PATH, process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");

// Several copies of Claude Code can be installed (Homebrew, npm, the native installer),
// and an interrupted update can leave the newest one without its `claude` link.
// Look everywhere and use the newest version, since old ones are refused by newer models.
function candidates() {
  const out = EXTRA_PATH.map((dir) => path.join(dir, "claude"));
  for (const bin of NVM_BINS) {
    const pkg = path.join(bin, "..", "lib", "node_modules", "@anthropic-ai", "claude-code");
    out.push(path.join(pkg, "bin", "claude.exe"), path.join(pkg, "cli.js"));
  }
  out.push(path.join(os.homedir(), ".claude", "local", "claude"));
  try {
    const v = path.join(os.homedir(), ".local", "share", "claude", "versions");
    for (const f of fs.readdirSync(v)) out.push(path.join(v, f));
  } catch {}
  return out;
}
function versionOf(p) {
  try {
    const out = execFileSync(p, ["--version"], { timeout: 8000, encoding: "utf8", env: { ...process.env, PATH: ENV_PATH } });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
}
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
function findClaude() {
  const seen = new Set();
  let best = null;
  for (const c of candidates()) {
    let real;
    try { if (!fs.statSync(c).isFile()) continue; real = fs.realpathSync(c); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const v = versionOf(real);
    if (v && (!best || newer(v, best.v))) best = { path: real, v };
  }
  return best ? { path: best.path, version: best.v.join(".") } : null;
}
// Re-checked every few minutes so a `claude update` is picked up without restarting Lumen.
let found = null, foundAt = 0;
function claude() {
  if (!found || Date.now() - foundAt > 5 * 60 * 1000 || !fs.existsSync(found.path)) {
    found = findClaude(); foundAt = Date.now();
  }
  return found;
}
const claudePath = () => (claude() || {}).path || null;

function runClaude(args) {
  return new Promise((resolve) => {
    const bin = claudePath();
    if (!bin) return resolve({ code: -1, out: "Claude Code isn't installed." });
    const child = spawn(bin, args, { env: { ...process.env, PATH: ENV_PATH } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

async function authStatus() {
  const r = await runClaude(["auth", "status"]);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf("{")));
    return { installed: true, version: claude().version, loggedIn: !!j.loggedIn, method: j.authMethod || null, email: j.email || null };
  } catch {
    return { installed: !!claudePath(), version: (claude() || {}).version || null, loggedIn: false, method: null, email: null };
  }
}
const login = () => runClaude(["auth", "login", "--claudeai"]);
const logout = () => runClaude(["auth", "logout"]);

let sdkPromise = null;
const sdk = () => (sdkPromise ||= import("@anthropic-ai/claude-agent-sdk"));

const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "Task", "Agent"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function lumenPrompt(workspace) {
  return `You are running inside Lumen, a desktop code editor on the user's Mac. The folder open in the editor is ${workspace}. The user's home folder is ${os.homedir()}. The user wants help with anything on this computer, not only this folder: use absolute paths to read or search elsewhere when a question calls for it, starting narrow because whole-disk searches are slow. Messages may begin with an <editor_context> block describing the open file and selection. Edits and commands are approved by the user in Lumen's interface.`;
}

class ClaudeCodeAgent {
  constructor({ getModel, getWorkspace, emit, requestApproval }) {
    this.getModel = getModel;
    this.getWorkspace = getWorkspace;
    this.emit = emit;
    this.requestApproval = requestApproval;
    this.sessionId = null;
    this.sessionCwd = null;
    this.controller = null;
    this.alwaysAllow = new Set();
  }

  reset() {
    this.stop();
    this.sessionId = null;
    this.alwaysAllow.clear();
  }

  stop() {
    if (this.controller) this.controller.abort();
  }

  baseOptions(signalController) {
    return {
      pathToClaudeCodeExecutable: claudePath(),
      cwd: this.getWorkspace(),
      env: { ...process.env, PATH: ENV_PATH },
      abortController: signalController,
      model: this.getModel(),
      settingSources: ["user", "project", "local"],
    };
  }

  async run(userText) {
    if (!claudePath()) {
      this.emit({ type: "error", message: "Claude Code isn't installed. Install it from claude.com/claude-code, then sign in." });
      return;
    }
    const { query } = await sdk();
    // A Claude Code session belongs to one folder; switching workspace starts a new one.
    if (this.sessionCwd && this.sessionCwd !== this.getWorkspace()) this.sessionId = null;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const inputs = new Map(); // tool_use id → input, for file_changed events

    const options = {
      ...this.baseOptions(this.controller),
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: lumenPrompt(this.getWorkspace()) },
      permissionMode: "default",
      canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };

    let sawText = false, failed = false;
    // One clear error per request: Claude Code can report the same failure several ways.
    const fail = (message) => { if (!failed) { failed = true; this.emit({ type: "error", message }); } };
    try {
      for await (const msg of query({ prompt: userText, options })) {
        if (msg.session_id) { this.sessionId = msg.session_id; this.sessionCwd = this.getWorkspace(); }
        if (msg.parent_tool_use_id) continue; // subagent internals stay inside their tool card

        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev.type === "message_start") this.emit({ type: "round" });
          else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
            this.emit({ type: "tool_pending", id: ev.content_block.id, name: ev.content_block.name });
          } else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") { sawText = true; this.emit({ type: "text", delta: ev.delta.text }); }
            else if (ev.delta.type === "thinking_delta") this.emit({ type: "thinking", delta: ev.delta.thinking });
          }
        } else if (msg.type === "assistant") {
          for (const b of msg.message.content || []) {
            if (b.type === "tool_use") {
              inputs.set(b.id, { name: b.name, input: b.input });
              this.emit({ type: "tool_start", id: b.id, name: b.name, input: summarize(b.name, b.input) });
            }
          }
          if (msg.error) fail(assistantError(msg.error, msg.message));
        } else if (msg.type === "user") {
          const content = Array.isArray(msg.message.content) ? msg.message.content : [];
          for (const b of content) {
            if (b.type !== "tool_result") continue;
            const text = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : String(b.content ?? "");
            this.emit({ type: "tool_end", id: b.tool_use_id, output: text.slice(0, 30000), error: !!b.is_error });
            const used = inputs.get(b.tool_use_id);
            if (used && EDIT_TOOLS.has(used.name) && !b.is_error && used.input.file_path) {
              this.emit({ type: "file_changed", path: path.resolve(this.getWorkspace(), used.input.file_path) });
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype !== "success") {
            fail(resultError(msg));
          } else if (msg.is_error) {
            fail(explain(String(msg.result || "")) || "Claude Code stopped with an error.");
          } else if (!sawText && msg.result) {
            this.emit({ type: "text", delta: msg.result });
          }
        }
      }
      this.emit({ type: "done" });
    } catch (err) {
      if (signal.aborted) this.emit({ type: "done", stopped: true });
      else fail(friendly(err));
    } finally {
      this.controller = null;
    }
  }

  async canUseTool(toolName, input, { signal, suggestions, toolUseID, title }) {
    if (READ_ONLY.has(toolName)) return { behavior: "allow", updatedInput: input };
    const kind = EDIT_TOOLS.has(toolName) ? "edits" : toolName;
    if (this.alwaysAllow.has(kind)) return { behavior: "allow", updatedInput: input };

    const preview = await this.preview(toolName, input, title);
    const id = toolUseID || `perm-${Date.now()}`;
    // Approval cards key off a tool name the UI knows; map Claude Code's names onto them.
    const uiName = toolName === "Bash" ? "run_command" : EDIT_TOOLS.has(toolName) ? "edit_file" : toolName;
    const decision = await this.requestApproval({ id, name: uiName, input: summarize(toolName, input), preview }, signal);
    if (decision === "allow") return { behavior: "allow", updatedInput: input };
    if (decision === "always") {
      this.alwaysAllow.add(kind);
      return { behavior: "allow", updatedInput: input, ...(suggestions ? { updatedPermissions: suggestions } : {}) };
    }
    return { behavior: "deny", message: decision === "cancel" ? "Cancelled by the user." : "The user declined this action.", interrupt: decision === "cancel" };
  }

  async preview(toolName, input, title) {
    const ws = this.getWorkspace();
    if (EDIT_TOOLS.has(toolName) && input.file_path) {
      const file = path.resolve(ws, input.file_path);
      const before = await fsp.readFile(file, "utf8").catch(() => null);
      let after = before ?? "";
      if (toolName === "Write") after = String(input.content ?? "");
      else if (toolName === "Edit") after = applyEdit(before ?? "", input);
      else if (toolName === "MultiEdit") for (const e of input.edits || []) after = applyEdit(after, e);
      else return { kind: "command", command: title || `${toolName} ${file}`, cwd: ws };
      return { kind: "diff", path: file, before: before ?? "", after, created: before === null };
    }
    if (toolName === "Bash") return { kind: "command", command: String(input.command || ""), cwd: ws };
    return { kind: "command", command: title || `${toolName} ${JSON.stringify(input).slice(0, 400)}`, cwd: ws };
  }

  // ⌘K: one tool-free turn that returns only the replacement code.
  async inlineEdit({ path: file, before, selection, after, instruction }) {
    if (!claudePath()) throw new Error("Claude Code isn't installed.");
    const { query } = await sdk();
    const prompt = `Rewrite a snippet of ${file}.

Instruction: ${instruction}

Code before the selection (context only):
<before>
${before.slice(-6000)}
</before>

Selected code to rewrite:
<selection>
${selection}
</selection>

Code after the selection (context only):
<after>
${after.slice(0, 6000)}
</after>

Reply with only the replacement for the selected code, keeping its indentation style. No explanation, no code fences, and do not use any tools.`;
    let text = "";
    for await (const msg of query({ prompt, options: { ...this.baseOptions(new AbortController()), tools: [], maxTurns: 1, persistSession: false, settingSources: [] } })) {
      if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error(resultError(msg));
        text = msg.result || "";
      }
    }
    return text.replace(/^\s*```[^\n]*\n/, "").replace(/\n?```\s*$/, "");
  }
}

function applyEdit(text, { old_string, new_string, replace_all }) {
  if (typeof old_string !== "string" || !old_string) return text;
  return replace_all ? text.split(old_string).join(new_string ?? "") : text.replace(old_string, () => new_string ?? "");
}

// Map Claude Code tool inputs onto the labels Lumen's UI shows.
function summarize(name, input = {}) {
  switch (name) {
    case "Read": case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return { path: input.file_path || input.notebook_path };
    case "Glob": return { pattern: input.pattern, path: input.path };
    case "Grep": return { pattern: input.pattern, path: input.path };
    case "LS": return { path: input.path };
    case "Bash": return { command: input.command };
    default: return { detail: JSON.stringify(input).slice(0, 200) };
  }
}

// Turns known Claude Code / API failures into an actionable sentence.
function explain(text) {
  if (/claude_code_version_too_old|does not support this model/.test(text)) {
    return "Your Claude Code is too old for this model. Update it by running `claude update` in Terminal (or `npm install -g @anthropic-ai/claude-code`), or pick another model, then try again. Lumen uses the newest Claude Code it finds.";
  }
  return null;
}
function assistantError(code, message) {
  const text = message && Array.isArray(message.content) ? message.content.map((b) => b.text || "").join(" ") : "";
  return explain(text) || ({
    authentication_failed: "Claude Code isn't signed in. Open Settings and sign in with Claude.",
    billing_error: "Your Claude plan can't run this request. Check your subscription on claude.ai.",
    rate_limit: "You've reached your Claude usage limit for now. Try again later.",
  })[code] || (text.trim() ? text.trim().slice(0, 600) : `Claude Code reported an error (${code}).`);
}
function resultError(msg) {
  if (msg.subtype === "error_max_turns") return "Claude hit its step limit for this request.";
  const errs = Array.isArray(msg.errors) ? msg.errors.join(" ") : "";
  return explain(errs) || errs || "Claude Code stopped with an error.";
}
function friendly(err) {
  const m = err && err.message ? err.message : String(err);
  if (/ENOENT/.test(m)) return "Couldn't start Claude Code. Check that it's installed.";
  return explain(m) || m;
}

module.exports = { ClaudeCodeAgent, authStatus, login, logout, claudePath };
