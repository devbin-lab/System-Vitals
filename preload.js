// 렌더러(대시보드)에 안전한 패널 제어 API 만 노출 (contextIsolation)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelAPI', {
  getDisplays:   () => ipcRenderer.invoke('panel:getDisplays'),
  selectDisplay: (id) => ipcRenderer.send('panel:selectDisplay', id),
  toggleKiosk:   () => ipcRenderer.send('panel:toggleKiosk'),
  setOpenAtLogin:    (v) => ipcRenderer.send('panel:setOpenAtLogin', v),
  setWaitForDisplay: (v) => ipcRenderer.send('panel:setWaitForDisplay', v),
  reload:        () => ipcRenderer.send('panel:reload'),
  quit:          () => ipcRenderer.send('panel:quit'),
  checkUpdate:   () => ipcRenderer.invoke('panel:checkUpdate'),
  downloadUpdate:() => ipcRenderer.invoke('panel:downloadUpdate'),
  openReleases:  (url) => ipcRenderer.send('panel:openReleases', url),
  onDisplays:    (cb) => ipcRenderer.on('panel:displays', (_e, data) => cb(data)),
  onOpenSettings:(cb) => ipcRenderer.on('panel:openSettings', () => cb()),
  onUpdate:      (cb) => ipcRenderer.on('panel:update', (_e, info) => cb(info)),
  onUpdateProgress:(cb) => ipcRenderer.on('panel:updateProgress', (_e, p) => cb(p)),
});
