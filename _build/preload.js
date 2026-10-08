const { contextBridge, ipcRenderer } = require('electron');

// 暴露快捷键与关闭询问的最小接口给页面（contextIsolation 下的安全桥）
contextBridge.exposeInMainWorld('bridge', {
  setHotkey: (accel) => ipcRenderer.invoke('set-hotkey', accel),
  getHotkey: () => ipcRenderer.invoke('get-hotkey'),
  onHotkeyError: (cb) => ipcRenderer.on('hotkey-error', (_e, accel) => cb(accel)),
  onCloseAsk: (cb) => ipcRenderer.on('ask-close', () => cb()),
  answerClose: (obj) => ipcRenderer.send('close-answer', obj),
  // 软件更新
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
