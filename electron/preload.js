// Preload script — runs in the renderer before web content loads.
// contextIsolation is enabled, so this is sandboxed from the page.
// Currently a no-op; will be used in Phase 3+ if we need to expose
// any Electron APIs (e.g. native file dialogs) to the web content.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
});
