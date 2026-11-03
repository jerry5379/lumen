// Integrated terminal: one real PTY per terminal tab, rendered by xterm.js in the window.
// A service from the Run & Debug panel is a terminal that runs one command instead of a prompt.
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

  create({ cwd, cols, rows, command, env: extra, onData, onExit }) {
    const id = ++this.seq;
    // Apps opened from Finder get a minimal PATH; a login shell rebuilds the user's own.
    const env = { ...process.env, ...(extra || {}), TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Lumen", LANG: process.env.LANG || "en_US.UTF-8", FORCE_COLOR: process.env.FORCE_COLOR || "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = pty.spawn(SHELL, command ? ["-lc", command] : ["-l"], {
      name: "xterm-256color",
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      cols: Math.max(2, cols | 0 || 80),
      rows: Math.max(1, rows | 0 || 24),
      env,
    });
    p.onData((data) => { this.send("term:data", { id, data }); if (onData) onData(data); });
    p.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.send("term:exit", { id, code: exitCode });
      if (onExit) onExit(exitCode);
    });
    this.sessions.set(id, p);
    return { id, shell: SHELL.split("/").pop(), pid: p.pid };
  }

  write(id, data) { const p = this.sessions.get(id); if (p) p.write(data); }

  resize(id, cols, rows) {
    const p = this.sessions.get(id);
    if (p && cols > 0 && rows > 0) try { p.resize(cols, rows); } catch {}
  }

  alive(id) { return this.sessions.has(id); }

  kill(id) {
    const p = this.sessions.get(id);
    if (!p) return;
    this.sessions.delete(id);
    try { p.kill(); } catch {}
  }

  // Stop a service politely first; a server that ignores SIGTERM is killed a few seconds later.
  stop(id) {
    const p = this.sessions.get(id);
    if (!p) return;
    try { p.kill("SIGTERM"); } catch {}
    setTimeout(() => { if (this.sessions.get(id) === p) { this.sessions.delete(id); try { p.kill("SIGKILL"); } catch {} } }, 4000);
  }

  killAll() { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

module.exports = { Terminals };
