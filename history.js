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

  // Read a chat file without keeping it: for search and for rebuilding the index.
  static read(file) {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      return d && d.version === 1 && Array.isArray(d.transcript) ? d : null;
    } catch { return null; }
  }

  load() {
    const d = ChatStore.read(this.file);
    if (d) this.data = { ...ChatStore.empty(), ...d };
    return this.data;
  }

  engine(name) { return this.data.engines[name] || null; }
  setEngine(name, state) { this.data.engines[name] = state; this.save(); }

  user(text, ctx, images) {
    this.data.transcript.push({ type: "user", text, ctx: ctx || "", ...(images && images.length ? { images } : {}) });
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

  // The user messages in order, each with the text Claude replied with.
  turns() {
    const out = [];
    for (const e of this.data.transcript) {
      if (e.type === "user") out.push({ text: e.text, ctx: e.ctx, images: e.images || [], reply: "" });
      else if (e.type === "text" && out.length) out[out.length - 1].reply += e.delta;
    }
    return out;
  }

  // Drop everything from the user message numbered `turn` on (going back to edit a message).
  truncate(turn) {
    const t = this.data.transcript;
    let n = -1;
    const at = t.findIndex((e) => e.type === "user" && ++n === turn);
    if (at < 0) return false;
    t.length = at;
    this.flush();
    return true;
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

// Case-insensitive search of a transcript: how many places match and a snippet around the first.
function searchTranscript(transcript, query) {
  const q = query.toLowerCase();
  let count = 0, snippet = null;
  for (const e of transcript) {
    const text = e.type === "user" ? e.text : e.type === "text" ? e.delta : null;
    if (!text) continue;
    const lower = text.toLowerCase();
    let i = lower.indexOf(q);
    while (i >= 0) {
      count++;
      if (!snippet) {
        const s = Math.max(0, i - 40), end = Math.min(text.length, i + q.length + 60);
        snippet = (s > 0 ? "…" : "") + text.slice(s, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
      }
      i = lower.indexOf(q, i + q.length);
      if (count > 999) break;
    }
  }
  return count ? { count, snippet } : null;
}

module.exports = { ChatStore, searchTranscript };
