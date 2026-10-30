const fs = require("fs");
const path = require("path");

// The current chat, saved so it survives a restart: what the chat panel showed
// (as a list of agent events) plus each engine's memory of the conversation.
const TOOL_OUTPUT_KEEP = 4000; // tool output is only for the collapsed card on replay
const SKIP = new Set(["file_changed"]);

class ChatStore {
  constructor(file) {
    this.file = file;
    this.data = ChatStore.empty();
    this.timer = null;
  }

  static empty() {
    return { version: 1, transcript: [], engines: {} };
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (d && d.version === 1 && Array.isArray(d.transcript)) this.data = { ...ChatStore.empty(), ...d };
    } catch {}
    return this.data;
  }

  engine(name) { return this.data.engines[name] || null; }
  setEngine(name, state) { this.data.engines[name] = state; this.save(); }

  user(text, ctx) {
    this.data.transcript.push({ type: "user", text, ctx: ctx || "" });
    this.save();
  }

  // Record an event the renderer was sent. Streaming deltas are merged so the file stays small.
  event(ev) {
    if (SKIP.has(ev.type)) return;
    const t = this.data.transcript;
    const last = t[t.length - 1];
    if ((ev.type === "text" || ev.type === "thinking") && last && last.type === ev.type) {
      last.delta += ev.delta;
    } else if (ev.type === "tool_end") {
      t.push({ ...ev, output: String(ev.output || "").slice(0, TOOL_OUTPUT_KEEP) });
    } else if (ev.type === "approval") {
      // Full before/after file contents aren't needed to show a resolved card.
      const { before, after, ...preview } = ev.preview || {};
      t.push({ ...ev, preview });
    } else {
      t.push(ev);
    }
    if (ev.type === "done") this.flush(); else this.save();
  }

  clear() {
    this.data = ChatStore.empty();
    this.flush();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("Couldn't save chat history:", err.message);
    }
  }
}

module.exports = { ChatStore };
