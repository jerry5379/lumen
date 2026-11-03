// Run & Debug: the services a project needs (dev server, API, database, workers) as one list
// in the sidebar, like Cursor's Run and Debug panel. Configurations are detected from the
// project (package.json scripts, docker compose, Makefile, Python, Go, Rust, …) and can be
// written by hand in .lumen/launch.json. Each service runs in its own terminal tab.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const LAUNCH_FILE = path.join(".lumen", "launch.json");
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", "Library"]);
// Sub-folders worth looking in for a second service (monorepos, "backend" + "frontend" layouts).
const NESTED = /^(apps|packages|services|backend|frontend|server|client|api|web|app|ui|worker|workers|functions)$/i;
const SCRIPT_ORDER = ["dev", "start", "serve", "watch", "preview", "start:dev", "dev:server", "dev:client", "server", "backend", "api", "storybook"];

const TEMPLATE = `{
  // Services Lumen can start from the Run & Debug panel. Paths are relative to this folder.
  "configurations": [
    {
      "name": "API server",
      "command": "npm run dev",
      "cwd": ".",
      "env": { "PORT": "4000" }
    }
  ]
}
`;

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(stripComments(fs.readFileSync(p, "utf8"))); } catch { return null; } };
function stripComments(s) {
  // launch.json may have // comments, like VS Code's.
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "").replace(/,(\s*[}\]])/g, "$1");
}
const idOf = (cwd, command) => `${cwd}::${command}`;

function packageManager(dir) {
  if (exists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(path.join(dir, "yarn.lock"))) return "yarn";
  if (exists(path.join(dir, "bun.lockb")) || exists(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}
function python(dir) {
  for (const v of [".venv", "venv", "env"]) {
    const p = path.join(dir, v, "bin", "python");
    if (exists(p)) return p;
  }
  return "python3";
}

// Services detected in one folder.
function detectIn(dir, root) {
  const out = [];
  const rel = path.relative(root, dir);
  const prefix = rel ? rel + " · " : "";
  const add = (name, command, extra = {}) => out.push({ id: idOf(dir, command), name: prefix + name, command, cwd: dir, source: extra.source || "detected", canDebug: !!extra.canDebug });

  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
    const pm = packageManager(dir);
    const scripts = Object.keys(pkg.scripts);
    const picked = [...SCRIPT_ORDER.filter((s) => scripts.includes(s)), ...scripts.filter((s) => !SCRIPT_ORDER.includes(s) && /^(dev|start|serve|watch)[:-]/.test(s))].slice(0, 8);
    for (const s of picked) {
      const run = s === "start" && pm === "npm" ? "npm start" : `${pm} run ${s}`;
      add(`${s} (${pkg.name || path.basename(dir)})`, run, { source: "package.json", canDebug: /\bnode\b|\bts-node\b|\btsx\b|\bnodemon\b|\bnext\b|\bnest\b|\bexpress\b/.test(String(pkg.scripts[s])) || /node/.test(String(pkg.scripts[s])) });
    }
    if (!picked.length && pkg.main) add(`node ${pkg.main}`, `node ${pkg.main}`, { source: "package.json", canDebug: true });
  }
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if (exists(path.join(dir, f))) { add("Docker Compose", `docker compose -f ${f} up`, { source: f }); break; }
  }
  if (exists(path.join(dir, "Makefile"))) {
    const mk = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
    for (const t of ["dev", "run", "serve", "start", "up"]) if (new RegExp(`^${t}\\s*:`, "m").test(mk)) add(`make ${t}`, `make ${t}`, { source: "Makefile" });
  }
  if (exists(path.join(dir, "Procfile"))) {
    for (const line of fs.readFileSync(path.join(dir, "Procfile"), "utf8").split("\n")) {
      const m = /^\s*([\w-]+)\s*:\s*(.+)$/.exec(line);
      if (m) add(`${m[1]} (Procfile)`, m[2].trim(), { source: "Procfile" });
    }
  }
  const py = python(dir);
  if (exists(path.join(dir, "manage.py"))) add("Django server", `${py} manage.py runserver`, { source: "manage.py" });
  else {
    const reqs = ["requirements.txt", "pyproject.toml", "Pipfile"].map((f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } }).join("\n").toLowerCase();
    const entry = ["main.py", "app.py", "server.py", "api.py"].find((f) => exists(path.join(dir, f)));
    if (entry) {
      const mod = entry.replace(/\.py$/, "");
      if (/fastapi|uvicorn/.test(reqs)) add("FastAPI (uvicorn)", `${py} -m uvicorn ${mod}:app --reload`, { source: entry });
      else if (/flask/.test(reqs)) add("Flask", `FLASK_APP=${entry} ${py} -m flask run --debug`, { source: entry });
      else add(`python ${entry}`, `${py} ${entry}`, { source: entry });
    }
  }
  if (exists(path.join(dir, "go.mod"))) add("go run .", "go run .", { source: "go.mod" });
  if (exists(path.join(dir, "Cargo.toml"))) add("cargo run", "cargo run", { source: "Cargo.toml" });
  if (exists(path.join(dir, "bin", "rails"))) add("Rails server", "bin/rails server", { source: "Gemfile" });
  if (exists(path.join(dir, "mix.exs"))) add("Phoenix server", "mix phx.server", { source: "mix.exs" });
  if (exists(path.join(dir, "gradlew"))) add("gradlew bootRun", "./gradlew bootRun", { source: "build.gradle" });
  else if (exists(path.join(dir, "pom.xml"))) add("mvn spring-boot:run", "mvn spring-boot:run", { source: "pom.xml" });
  try { if (fs.readdirSync(dir).some((f) => f.endsWith(".csproj"))) add("dotnet run", "dotnet run", { source: "csproj" }); } catch {}
  return out;
}

async function configs(ws) {
  const out = [];
  const seen = new Set();
  const push = (c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
  // Hand-written configurations come first.
  const file = path.join(ws, LAUNCH_FILE);
  const own = readJson(file);
  const list = own && Array.isArray(own.configurations) ? own.configurations : own && Array.isArray(own) ? own : [];
  for (const c of list) {
    if (!c || typeof c.command !== "string" || !c.command.trim()) continue;
    const cwd = path.resolve(ws, typeof c.cwd === "string" ? c.cwd : ".");
    push({ id: idOf(cwd, c.command), name: String(c.name || c.command), command: c.command, cwd, env: c.env && typeof c.env === "object" ? c.env : undefined, source: "launch.json", canDebug: !!c.debug || /\bnode\b|\bnpm\b|\bpnpm\b|\byarn\b|\bnpx\b|\btsx\b/.test(c.command) });
  }
  for (const c of detectIn(ws, ws)) push(c);
  let kids = [];
  try { kids = (await fsp.readdir(ws, { withFileTypes: true })).filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")); } catch {}
  // One level of nesting: apps/web, packages/api, backend/, frontend/…
  for (const k of kids) {
    const d = path.join(ws, k.name);
    if (NESTED.test(k.name)) {
      let sub = [];
      try { sub = (await fsp.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")); } catch {}
      const here = detectIn(d, ws);
      if (here.length) here.forEach(push);
      else for (const s of sub.slice(0, 20)) detectIn(path.join(d, s.name), ws).forEach(push);
    } else if (exists(path.join(d, "package.json")) || exists(path.join(d, "manage.py")) || exists(path.join(d, "go.mod"))) {
      detectIn(d, ws).forEach(push);
    }
    if (out.length > 40) break;
  }
  return { file, hasFile: !!own, configs: out.slice(0, 40) };
}

// Create .lumen/launch.json with a template so the user can add their own services.
async function ensureFile(ws) {
  const file = path.join(ws, LAUNCH_FILE);
  if (!exists(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, TEMPLATE);
  }
  return file;
}

module.exports = { configs, ensureFile, LAUNCH_FILE };
