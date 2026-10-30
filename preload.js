const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("lumen", {
  info: () => ipcRenderer.invoke("app:info"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  signIn: () => ipcRenderer.invoke("auth:login"),
  signOut: () => ipcRenderer.invoke("auth:logout"),
  claudeSignIn: () => ipcRenderer.invoke("cc:login"),
  claudeSignOut: () => ipcRenderer.invoke("cc:logout"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  list: (dir) => ipcRenderer.invoke("fs:list", dir),
  read: (file) => ipcRenderer.invoke("fs:read", file),
  write: (file, text) => ipcRenderer.invoke("fs:write", { path: file, text }),
  send: (chat, text, display) => ipcRenderer.invoke("agent:send", chat, text, display),
  stop: (chat) => ipcRenderer.invoke("agent:stop", chat),
  chats: {
    list: () => ipcRenderer.invoke("chat:list"),
    create: () => ipcRenderer.invoke("chat:new"),
    history: (id) => ipcRenderer.invoke("chat:history", id),
    close: (id) => ipcRenderer.invoke("chat:close", id),
    reopen: (id) => ipcRenderer.invoke("chat:reopen", id),
    remove: (id) => ipcRenderer.invoke("chat:delete", id),
    onChange: (fn) => ipcRenderer.on("chats:changed", (_e, list) => fn(list)),
  },
  approve: (id, decision) => ipcRenderer.invoke("agent:approve", { id, decision }),
  move: (from, toDir) => ipcRenderer.invoke("fs:move", { from, toDir }),
  copy: (from, toDir) => ipcRenderer.invoke("fs:copy", { from, toDir }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setTheme: (mode) => ipcRenderer.invoke("theme:set", mode),
  inlineEdit: (req) => ipcRenderer.invoke("inline:edit", req),
  term: {
    create: (opts) => ipcRenderer.invoke("term:create", opts),
    write: (id, data) => ipcRenderer.send("term:write", { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send("term:resize", { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke("term:kill", id),
    onData: (fn) => ipcRenderer.on("term:data", (_e, m) => fn(m)),
    onExit: (fn) => ipcRenderer.on("term:exit", (_e, m) => fn(m)),
  },
  git: {
    status: () => ipcRenderer.invoke("git:status"),
    diff: (file, staged) => ipcRenderer.invoke("git:diff", { file, staged }),
    stage: (files) => ipcRenderer.invoke("git:stage", files),
    unstage: (files) => ipcRenderer.invoke("git:unstage", files),
    discard: (tracked, untracked) => ipcRenderer.invoke("git:discard", { tracked, untracked }),
    commit: (message, amend) => ipcRenderer.invoke("git:commit", { message, amend }),
    push: () => ipcRenderer.invoke("git:push"),
    pull: () => ipcRenderer.invoke("git:pull"),
    fetch: () => ipcRenderer.invoke("git:fetch"),
    branches: () => ipcRenderer.invoke("git:branches"),
    checkout: (name, create) => ipcRenderer.invoke("git:checkout", { name, create }),
    init: () => ipcRenderer.invoke("git:init"),
    message: () => ipcRenderer.invoke("git:message"),
  },
  onEvent: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on("agent:event", h);
    return () => ipcRenderer.removeListener("agent:event", h);
  },
});
