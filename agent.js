// Claude agent loop with system-wide tools. Runs in Electron's main process.
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT = 30000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".Trash", "Library", ".cache", ".npm", "dist", "build", ".next", "__pycache__", ".venv"]);

const TOOLS = [
  {
    name: "list_directory",
    description: "List files and folders at a path anywhere on the user's computer. Folders end with '/'. Use depth 2-3 to see structure; heavy folders like node_modules and .git are summarized, not expanded.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, ~/path, or path relative to the workspace" },
        depth: { type: "integer", description: "How many levels deep to list (1-4). Default 1." },
      },
      required: ["path"],
    },
  },
  {
    name: "find_files",
    description: "Find files by name pattern (glob, e.g. '*.py' or '**/config*.json') under a folder. Respects .gitignore. Returns up to 300 paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern for file names" },
        path: { type: "string", description: "Folder to search under. Default: the workspace." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_text",
    description: "Search file contents with a regular expression (ripgrep). Returns matching lines as path:line:text, up to 200 matches.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for" },
        path: { type: "string", description: "File or folder to search. Default: the workspace." },
        glob: { type: "string", description: "Optional file filter, e.g. '*.ts'" },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file. Returns numbered lines. For large files pass offset (1-based line) and limit.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Prefer this over write_file for changes to existing files. The user reviews a diff before it is applied.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_file",
    description: "Create a file or overwrite it with the full contents given. Parent folders are created. The user reviews a diff before it is applied.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command (zsh) on the user's Mac and return stdout/stderr. The user approves each command. Times out after 120 seconds; do not start servers or interactive programs.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Working directory. Default: the workspace." },
      },
      required: ["command"],
    },
  },
];

const REQUIRED = Object.fromEntries(TOOLS.map((t) => [t.name, t.input_schema.required]));
const NEEDS_APPROVAL = new Set(["edit_file", "write_file", "run_command"]);

function systemPrompt(workspace) {
  return `You are Claude, the AI pair programmer inside Lumen, a desktop code editor on the user's Mac.

You have tools that reach the user's whole computer, not just one project: you can list folders, find files, search contents, read files, edit and write files, and run shell commands. Nothing is preloaded into your context, so explore with tools whenever a question depends on what is on disk. Start narrow (the workspace, or the folder the user names) and widen only when needed; searching the entire disk is slow.

Machine: ${os.type()} ${os.release()} (${os.arch()}), user ${os.userInfo().username}
Home folder: ${os.homedir()}
Workspace (the folder open in the editor): ${workspace}
Relative paths resolve against the workspace; ~ means the home folder.

Edits and commands are shown to the user for approval. If the user declines, accept that and continue or ask what they would prefer. Prefer edit_file for small changes to existing files. Never run destructive commands (rm -rf, disk formatting, force pushes) unless the user explicitly asked for exactly that.

Be concise. Use fenced code blocks with a language tag when showing code. Refer to files by full path.`;
}

class Agent {
  constructor({ getApiKey, isSignedIn, getModel, getWorkspace, emit, requestApproval }) {
    this.getApiKey = getApiKey;
    this.isSignedIn = isSignedIn;
    this.getModel = getModel;
    this.getWorkspace = getWorkspace;
    this.emit = emit;
    this.requestApproval = requestApproval;
    this.messages = [];
    this.alwaysAllow = new Set();
    this.controller = null;
  }

  reset() {
    this.stop();
    this.messages = [];
    this.alwaysAllow.clear();
  }

  stop() {
    if (this.controller) this.controller.abort();
  }

  client() {
    const apiKey = this.getApiKey();
    if (apiKey) return new Anthropic({ apiKey });
    // Signed in with Anthropic: the SDK reads the `ant auth login` profile on its own.
    if (this.isSignedIn && this.isSignedIn()) return new Anthropic();
    throw Object.assign(new Error("Sign in with Anthropic (or add an API key) in Settings to start."), { friendly: true });
  }

  resolve(p) {
    if (!p) return this.getWorkspace();
    if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
    return path.resolve(this.getWorkspace(), p);
  }

  requestParams(model) {
    const params = {
      model,
      max_tokens: 64000,
      system: systemPrompt(this.getWorkspace()),
      tools: TOOLS,
      messages: this.messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
    };
    // Server-side refusal fallback for Opus/Sonnet 5.5 on the Claude API.
    if (/opus|sonnet/.test(model)) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return params;
  }

  // One user message → as many model/tool rounds as Claude needs.
  async run(userText) {
    let client;
    try { client = this.client(); }
    catch (err) { this.emit({ type: "error", message: err.message }); return; }
    const model = this.getModel();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.messages.push({ role: "user", content: userText });
    let jsonRetries = 0;

    try {
      while (true) {
        this.emit({ type: "round" });
        const stream = client.beta.messages.stream(this.requestParams(model), { signal });
        stream.on("text", (delta) => this.emit({ type: "text", delta }));
        stream.on("thinking", (delta) => this.emit({ type: "thinking", delta }));
        stream.on("streamEvent", (ev) => {
          if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
            this.emit({ type: "tool_pending", id: ev.content_block.id, name: ev.content_block.name });
          }
        });

        let message;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (err instanceof Anthropic.APIUserAbortError || signal.aborted) throw err;
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          this.emit({ type: "notice", text: "A tool call arrived garbled; asking Claude again." });
          continue;
        }

        if (message.stop_reason === "refusal") {
          this.emit({ type: "notice", text: "Claude declined this request." });
          break;
        }
        if (message.stop_reason === "pause_turn") {
          this.messages.push({ role: "assistant", content: message.content });
          continue;
        }
        const toolUses = message.content.filter((b) => b.type === "tool_use");
        if (message.stop_reason === "max_tokens" && toolUses.length) {
          this.emit({ type: "notice", text: "Claude's reply hit the length limit mid tool call. Ask for a smaller step." });
          break;
        }
        this.messages.push({ role: "assistant", content: message.content });
        if (toolUses.length === 0) break;

        const results = [];
        for (const tu of toolUses) {
          if (signal.aborted) {
            results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: "Cancelled by the user." });
            continue;
          }
          results.push(await this.runTool(tu, signal));
        }
        // All results for one assistant turn go back in a single user message.
        this.messages.push({ role: "user", content: results });
        if (signal.aborted) break;
      }
      this.emit({ type: "done" });
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || signal.aborted) {
        this.repairAfterAbort();
        this.emit({ type: "done", stopped: true });
      } else {
        this.repairAfterAbort();
        this.emit({ type: "error", message: describeError(err) });
      }
    } finally {
      this.controller = null;
    }
  }

  // Keep history valid: every tool_use needs a tool_result, and history must end on a user turn's answer.
  repairAfterAbort() {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.content)) {
      const pending = last.content.filter((b) => b.type === "tool_use");
      if (pending.length) {
        this.messages.push({
          role: "user",
          content: pending.map((b) => ({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Cancelled by the user." })),
        });
      }
    }
    if (last && last.role === "user" && typeof last.content === "string") {
      // The model never answered this message; drop it so the next turn starts clean.
      this.messages.pop();
    }
  }

  async runTool(tu, signal) {
    const input = tu.input || {};
    const missing = (REQUIRED[tu.name] || []).filter((k) => typeof input[k] !== "string" && typeof input[k] !== "number");
    if (!REQUIRED[tu.name]) return this.result(tu, `Unknown tool ${tu.name}`, true);
    if (missing.length) {
      return this.result(tu, JSON.stringify({ INVALID_JSON: `Missing or invalid fields: ${missing.join(", ")}` }), true);
    }

    this.emit({ type: "tool_start", id: tu.id, name: tu.name, input: summarizeInput(tu.name, input) });
    try {
      if (NEEDS_APPROVAL.has(tu.name) && !this.alwaysAllow.has(tu.name)) {
        const preview = await this.preview(tu.name, input);
        if (preview.error) return this.result(tu, preview.error, true);
        const decision = await this.requestApproval({ id: tu.id, name: tu.name, input: summarizeInput(tu.name, input), preview }, signal);
        if (decision === "always") this.alwaysAllow.add(tu.name);
        if (decision === "deny" || decision === "cancel") {
          return this.result(tu, decision === "cancel" ? "Cancelled by the user." : "The user declined this action.", true);
        }
      }
      const out = await this.execute(tu.name, input, signal);
      return this.result(tu, out, false);
    } catch (err) {
      return this.result(tu, err.message || String(err), true);
    }
  }

  result(tu, content, isError) {
    const text = truncate(String(content));
    this.emit({ type: "tool_end", id: tu.id, name: tu.name, output: text, error: !!isError });
    return { type: "tool_result", tool_use_id: tu.id, content: text, ...(isError ? { is_error: true } : {}) };
  }

  async preview(name, input) {
    if (name === "run_command") return { kind: "command", command: input.command, cwd: this.resolve(input.cwd) };
    const file = this.resolve(input.path);
    const before = await fs.readFile(file, "utf8").catch(() => null);
    if (name === "write_file") return { kind: "diff", path: file, before: before ?? "", after: input.content, created: before === null };
    if (before === null) return { error: `File not found: ${file}` };
    const next = applyEdit(before, input);
    if (next.error) return { error: next.error };
    return { kind: "diff", path: file, before, after: next.text };
  }

  async execute(name, input, signal) {
    switch (name) {
      case "list_directory": return listDirectory(this.resolve(input.path), Math.min(4, Math.max(1, input.depth || 1)));
      case "find_files": return rg(["--files", "--hidden", "-g", input.pattern, "-g", "!.git"], this.resolve(input.path), signal, 300);
      case "search_text": {
        const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "300", "--hidden", "-g", "!.git"];
        if (input.ignore_case) args.push("-i");
        if (input.glob) args.push("-g", input.glob);
        args.push("-e", input.pattern, "--", ".");
        return rg(args, this.resolve(input.path), signal, 200);
      }
      case "read_file": return readFile(this.resolve(input.path), input.offset, input.limit);
      case "edit_file": {
        const file = this.resolve(input.path);
        const before = await fs.readFile(file, "utf8");
        const next = applyEdit(before, input);
        if (next.error) throw new Error(next.error);
        await fs.writeFile(file, next.text);
        this.emit({ type: "file_changed", path: file });
        return `Edited ${file}`;
      }
      case "write_file": {
        const file = this.resolve(input.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, input.content);
        this.emit({ type: "file_changed", path: file });
        return `Wrote ${input.content.split("\n").length} lines to ${file}`;
      }
      case "run_command": return runCommand(input.command, this.resolve(input.cwd), signal);
    }
    throw new Error(`Unknown tool ${name}`);
  }

  // ⌘K: rewrite a snippet in one call, no tools.
  async inlineEdit({ path: file, before, selection, after, instruction }) {
    const client = this.client();
    const prompt = `You are editing ${file} inside a code editor.

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

Reply with only the replacement for the selected code, keeping its indentation style. No explanation, no code fences.`;
    const msg = await client.messages.stream({
      model: this.getModel(),
      max_tokens: 32000,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt }],
    }).finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this edit.");
    let text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    text = text.replace(/^\s*```[^\n]*\n/, "").replace(/\n?```\s*$/, "");
    return text;
  }
}

function applyEdit(text, { old_string, new_string, replace_all }) {
  if (old_string === "") return { error: "old_string is empty. Use write_file to create a file." };
  const count = text.split(old_string).length - 1;
  if (count === 0) return { error: "old_string was not found in the file. Read the file again and copy the text exactly." };
  if (count > 1 && !replace_all) return { error: `old_string matches ${count} places. Include more surrounding lines or set replace_all.` };
  return { text: replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string) };
}

async function listDirectory(dir, depth) {
  const lines = [];
  let count = 0;
  async function walk(d, level, prefix) {
    if (count > 600) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch (e) { lines.push(`${prefix}(cannot read: ${e.code || e.message})`); return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++count > 600) { lines.push(`${prefix}… (truncated)`); return; }
      const isDir = e.isDirectory();
      lines.push(`${prefix}${e.name}${isDir ? "/" : ""}`);
      if (isDir && level < depth) {
        if (SKIP_DIRS.has(e.name)) lines.push(`${prefix}  (skipped; list it directly to see inside)`);
        else await walk(path.join(d, e.name), level + 1, prefix + "  ");
      }
    }
  }
  await walk(dir, 1, "");
  return `${dir}\n${lines.join("\n") || "(empty)"}`;
}

async function readFile(file, offset, limit) {
  const stat = await fs.stat(file);
  if (stat.isDirectory()) return listDirectory(file, 1);
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES * 4));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return `${file} looks like a binary file (${stat.size} bytes); not shown.`;
    const all = buf.toString("utf8").split("\n");
    const start = Math.max(1, offset || 1);
    const end = Math.min(all.length, start - 1 + (limit || 2000));
    let out = "", bytes = 0, i;
    for (i = start; i <= end; i++) {
      const line = `${String(i).padStart(5)}  ${all[i - 1]}\n`;
      bytes += line.length;
      if (bytes > MAX_READ_BYTES) break;
      out += line;
    }
    const shownEnd = i - 1;
    const more = shownEnd < all.length ? `\n(showing lines ${start}-${shownEnd} of ${all.length}; pass offset to read more)` : "";
    return `${file}\n${out}${more}`;
  } finally {
    await fh.close();
  }
}

function rg(args, cwd, signal, maxLines) {
  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd, signal, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT * 2) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    child.on("error", (e) => resolve(e.code === "ENOENT" ? "ripgrep (rg) is not installed. Install it with: brew install ripgrep" : `Search failed: ${e.message}`));
    child.on("close", () => {
      const lines = out.split("\n").filter(Boolean);
      if (!lines.length) return resolve(err.trim() ? `No results. ${err.trim().split("\n")[0]}` : `No results under ${cwd}`);
      const shown = lines.slice(0, maxLines).join("\n");
      resolve(`${cwd}\n${shown}${lines.length > maxLines ? `\n… ${lines.length - maxLines} more; narrow the search` : ""}`);
    });
  });
}

function runCommand(command, cwd, signal) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const child = spawn(shell, ["-lc", command], { cwd, signal, timeout: 120000, env: process.env });
    let out = "";
    const add = (d) => { out += d; if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (e) => resolve(`Could not run command: ${e.message}`));
    child.on("close", (code, sig) => {
      const status = sig ? `killed (${sig === "SIGTERM" ? "timed out or stopped" : sig})` : `exit code ${code}`;
      resolve(`$ ${command}\n(cwd ${cwd}, ${status})\n${out.trim() || "(no output)"}`);
    });
  });
}

function summarizeInput(name, input) {
  const s = { ...input };
  if (typeof s.content === "string") s.content = `${s.content.split("\n").length} lines`;
  if (typeof s.old_string === "string") s.old_string = s.old_string.slice(0, 200);
  if (typeof s.new_string === "string") s.new_string = s.new_string.slice(0, 200);
  return s;
}

function truncate(s) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… (${s.length - MAX_OUTPUT} more characters cut)` : s;
}

function describeError(err) {
  if (err.friendly) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Your sign-in or API key was rejected. Sign in again in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key can't use that model. Pick another model in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limit reached. Wait a moment, then send again.";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status}): ${err.message}`;
  return err.message || String(err);
}

module.exports = { Agent, describeError };
