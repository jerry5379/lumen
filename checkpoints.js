// Restore checkpoints, like Cursor: the first time Claude changes a file during a turn, the
// file's previous contents are saved, so "Restore checkpoint" on a message can put every file
// back the way it was before that message. Contents are stored as base64 so binary files survive.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const MAX_FILE = 20 * 1024 * 1024;

class Checkpoints {
  constructor(file) {
    this.file = file;
    this.turns = [];     // [{ turn, files: { path: base64 | null (didn't exist) } }]
    this.redo = null;    // { turn, turns, after: { path: base64 | null } } from the last restore
    this.current = null; // the turn Claude is answering
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(d.turns)) this.turns = d.turns;
      this.redo = d.redo || null;
    } catch {}
    return this;
  }

  save() {
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ turns: this.turns, redo: this.redo }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("Couldn't save checkpoints:", err.message);
    }
  }

  remove() { try { fs.rmSync(this.file, { force: true }); } catch {} }

  // Going back to edit a message: checkpoints from that turn on no longer apply, and there is
  // nothing to redo because the later messages are gone.
  forget(turn) {
    this.load();
    this.turns = this.turns.filter((t) => t.turn < turn);
    this.redo = null;
    this.save();
  }

  // A new message: redo of an earlier restore no longer applies.
  begin(turn) {
    this.load();
    this.current = turn;
    if (this.redo) { this.redo = null; this.save(); }
  }
  end() { this.current = null; }

  // Called just before Claude writes `file`.
  async before(file) {
    if (this.current == null) return;
    let t = this.turns.find((x) => x.turn === this.current);
    if (!t) { t = { turn: this.current, files: {} }; this.turns.push(t); }
    if (file in t.files) return;
    t.files[file] = await snapshot(file);
    this.save();
  }

  // Each file touched from `turn` on, with the contents it had before that turn.
  originals(turn) {
    const out = new Map();
    for (const t of [...this.turns].sort((a, b) => a.turn - b.turn)) {
      if (t.turn < turn) continue;
      for (const [file, data] of Object.entries(t.files)) if (!out.has(file)) out.set(file, data);
    }
    return out;
  }

  // Files whose contents differ now from the checkpoint before `turn`.
  async changedSince(turn) {
    const changed = [];
    for (const [file, data] of this.originals(turn)) {
      if (data === undefined) continue;
      if ((await snapshot(file)) !== data) changed.push(file);
    }
    return changed;
  }

  // Which turns have something to restore, for the buttons in the chat.
  summary() {
    this.load();
    return {
      turns: this.turns.filter((t) => Object.keys(t.files).length).map((t) => t.turn),
      redo: this.redo ? this.redo.turn : null,
    };
  }

  async restore(turn) {
    const files = await this.changedSince(turn);
    const originals = this.originals(turn);
    const after = {};
    for (const file of files) {
      after[file] = await snapshot(file);
      await write(file, originals.get(file));
    }
    const removed = this.turns.filter((t) => t.turn >= turn);
    this.turns = this.turns.filter((t) => t.turn < turn);
    this.redo = { turn, turns: removed, after };
    this.save();
    return files;
  }

  async redoRestore() {
    const r = this.redo;
    if (!r) return null;
    for (const [file, data] of Object.entries(r.after)) await write(file, data);
    this.turns.push(...r.turns);
    this.redo = null;
    this.save();
    return { turn: r.turn, files: Object.keys(r.after) };
  }
}

async function snapshot(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_FILE) return undefined; // too big to keep; never restored
    return (await fsp.readFile(file)).toString("base64");
  } catch (err) {
    return err.code === "ENOENT" ? null : undefined;
  }
}

async function write(file, data) {
  if (data === undefined) return;
  if (data === null) { await fsp.rm(file, { force: true }); return; }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.from(data, "base64"));
}

module.exports = { Checkpoints };
