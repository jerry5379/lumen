// Source control: thin wrappers over the git CLI for the Source Control panel.
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
  // Never wait on a password prompt nobody can see.
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  LC_ALL: "C",
};

function git(args, cwd, { input, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: ENV });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); err += "\ngit took too long and was stopped."; }, timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.code === "ENOENT" ? "git isn't installed. Run: xcode-select --install" : e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err: err.trim() }); });
    if (input != null) child.stdin.end(input);
  });
}
async function ok(args, cwd, opts) {
  const r = await git(args, cwd, opts);
  if (r.code !== 0) throw new Error(r.err || r.out.trim() || `git ${args[0]} failed`);
  return r.out;
}
async function root(ws) {
  const r = await git(["rev-parse", "--show-toplevel"], ws);
  return r.code === 0 ? r.out.trim() : null;
}
async function repo(ws) {
  const r = await root(ws);
  if (!r) throw new Error("This folder isn't a git repository.");
  return r;
}

function parseBranch(line) {
  const b = { branch: null, upstream: null, ahead: 0, behind: 0 };
  const s = line.replace(/^## /, "");
  let m;
  if ((m = /^No commits yet on (.+)$/.exec(s)) || (m = /^Initial commit on (.+)$/.exec(s))) { b.branch = m[1]; return b; }
  if (s.startsWith("HEAD (no branch)")) { b.branch = "(detached)"; return b; }
  m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(s);
  if (!m) return b;
  b.branch = m[1]; b.upstream = m[2] || null;
  const track = m[3] || "";
  b.ahead = +((/ahead (\d+)/.exec(track) || [])[1] || 0);
  b.behind = +((/behind (\d+)/.exec(track) || [])[1] || 0);
  return b;
}

async function status(ws) {
  const r = await root(ws);
  if (!r) return { repo: null };
  const out = await ok(["status", "--porcelain=v1", "-b", "-z", "-uall"], r);
  const parts = out.split("\0");
  const info = parseBranch(parts.shift() || "");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const f = { x: e[0], y: e[1], path: e.slice(3) };
    if (f.x === "R" || f.x === "C") f.orig = parts[++i];
    files.push(f);
    if (files.length >= 3000) break;
  }
  const log = await git(["log", "-n", "40", "--format=%h%x1f%s%x1f%an%x1f%ar%x1f%H"], r);
  const commits = log.code === 0 ? log.out.split("\n").filter(Boolean).map((l) => { const [short, subject, author, when, hash] = l.split("\x1f"); return { short, subject, author, when, hash }; }) : [];
  const remotes = (await git(["remote"], r)).out.split("\n").filter(Boolean);
  return { repo: r, ...info, files, commits, remotes };
}

// Text of a file on both sides of a change, for the diff view.
async function show(r, spec) { const x = await git(["show", spec], r, { timeout: 15000 }); return x.code === 0 ? x.out : ""; }
async function diff(ws, file, staged) {
  const r = await repo(ws);
  let before, after;
  if (staged) {
    before = await show(r, `HEAD:${file}`);
    after = await show(r, `:${file}`);
  } else {
    before = await show(r, `:${file}`);
    try { after = await fsp.readFile(path.join(r, file), "utf8"); } catch { after = ""; }
  }
  if (before.includes("\0") || after.includes("\0")) return { path: path.join(r, file), binary: true };
  return { path: path.join(r, file), before, after };
}

async function stage(ws, files) { const r = await repo(ws); await ok(["add", "-A", "--", ...files], r); }
async function unstage(ws, files) {
  const r = await repo(ws);
  const x = await git(["restore", "--staged", "--", ...files], r);
  // A repository with no commits yet has nothing to restore from.
  if (x.code !== 0) await ok(["rm", "--cached", "-r", "-q", "--", ...files], r);
}
async function discard(ws, tracked, untracked) {
  const r = await repo(ws);
  if (tracked.length) await ok(["restore", "--worktree", "--", ...tracked], r);
  if (untracked.length) await ok(["clean", "-f", "-q", "--", ...untracked], r);
}
async function commit(ws, message, { all = false, amend = false } = {}) {
  const r = await repo(ws);
  if (all) await ok(["add", "-A"], r);
  const args = ["commit", "-F", "-"];
  if (amend) args.push("--amend");
  return ok(args, r, { input: message });
}
async function hasStaged(ws) {
  const r = await repo(ws);
  return (await git(["diff", "--cached", "--quiet"], r)).code === 1;
}

async function push(ws) {
  const r = await repo(ws);
  const s = await status(r);
  if (!s.remotes.length) throw new Error("This repository has no remote. Add one with: git remote add origin <url>");
  if (s.upstream) return ok(["push"], r, { timeout: 120000 });
  return ok(["push", "-u", s.remotes.includes("origin") ? "origin" : s.remotes[0], "HEAD"], r, { timeout: 120000 });
}
async function pull(ws) { return ok(["pull"], await repo(ws), { timeout: 120000 }); }
async function fetch(ws) { return ok(["fetch", "--all", "--prune"], await repo(ws), { timeout: 120000 }); }

async function branches(ws) {
  const r = await repo(ws);
  const out = await ok(["branch", "--all", "--format=%(HEAD)%(refname:short)"], r);
  return out.split("\n").filter(Boolean).filter((l) => !/\/HEAD$/.test(l)).map((l) => ({ current: l[0] === "*", name: l.slice(1) }));
}
async function checkout(ws, name, create) {
  const r = await repo(ws);
  const remote = !create && /^[^/]+\/.+/.test(name) && (await git(["show-ref", "--verify", "--quiet", `refs/remotes/${name}`], r)).code === 0;
  // Checking out origin/foo makes a local foo that tracks it.
  if (remote) return ok(["switch", "--track", name], r);
  return ok(create ? ["switch", "-c", name] : ["switch", name], r);
}
async function init(ws) { await ok(["init"], ws); }

// What a commit message should describe: the staged diff, or everything if nothing is staged.
async function changesForMessage(ws) {
  const r = await repo(ws);
  const staged = await hasStaged(r);
  const args = staged ? ["diff", "--cached"] : ["diff", "HEAD"];
  let d = (await git([...args, "--stat"], r)).out + "\n" + (await git(args, r)).out;
  if (!staged) {
    const untracked = (await git(["ls-files", "--others", "--exclude-standard"], r)).out.trim();
    if (untracked) d += "\nNew files:\n" + untracked;
  }
  return d.length > 40000 ? d.slice(0, 40000) + "\n… (diff truncated)" : d;
}

module.exports = { status, diff, stage, unstage, discard, commit, hasStaged, push, pull, fetch, branches, checkout, init, changesForMessage };
