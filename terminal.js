// Integrated terminal: one real PTY per terminal tab, rendered by xterm.js in the window.
const os = require("os");
const fs = require("fs");
const pty = require("node-pty");

const SHELL = [process.env.SHELL, "/bin/zsh", "/bin/bash"].find((s) => s && fs.existsSync(s));

class Terminals {
  constructor(send) {
    this.send = send;
    this.sessions = new Map();
    this.seq = 0;
  }

  create({ cwd, cols, rows }) {
    const id = ++this.seq;
    // Apps opened from Finder get a minimal PATH; a login shell rebuilds the user's own.
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Lumen", LANG: process.env.LANG || "en_US.UTF-8" };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = pty.spawn(SHELL, ["-l"], {
      name: "xterm-256color",
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      cols: Math.max(2, cols | 0 || 80),
      rows: Math.max(1, rows | 0 || 24),
      env,
    });
    p.onData((data) => this.send("term:data", { id, data }));
    p.onExit(({ exitCode }) => { this.sessions.delete(id); this.send("term:exit", { id, code: exitCode }); });
    this.sessions.set(id, p);
    return { id, shell: SHELL.split("/").pop() };
  }

  write(id, data) { const p = this.sessions.get(id); if (p) p.write(data); }

  resize(id, cols, rows) {
    const p = this.sessions.get(id);
    if (p && cols > 0 && rows > 0) try { p.resize(cols, rows); } catch {}
  }

  kill(id) {
    const p = this.sessions.get(id);
    if (!p) return;
    this.sessions.delete(id);
    try { p.kill(); } catch {}
  }

  killAll() { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

module.exports = { Terminals };
