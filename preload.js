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
  send: (text) => ipcRenderer.invoke("agent:send", text),
  stop: () => ipcRenderer.invoke("agent:stop"),
  reset: () => ipcRenderer.invoke("agent:reset"),
  approve: (id, decision) => ipcRenderer.invoke("agent:approve", { id, decision }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setTheme: (mode) => ipcRenderer.invoke("theme:set", mode),
  inlineEdit: (req) => ipcRenderer.invoke("inline:edit", req),
  onEvent: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on("agent:event", h);
    return () => ipcRenderer.removeListener("agent:event", h);
  },
});
