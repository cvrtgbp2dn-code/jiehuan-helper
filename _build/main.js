const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_ACCEL = 'Alt+Z';
// 更新源：依次尝试多个地址，第一个成功的就用（国内 jsDelivr 快，国外 raw 直连快）。
// 改成你自己的 GitHub 用户名/仓库名即可；也可以在软件目录放一个 update-config.json
// （{"feed":"https://..."} 或 {"feed":["url1","url2"]}）覆盖，无需重新打包。
const OWNER = 'cvrtgbp2dn-code';
const REPO = 'jiehuan-helper';
const BRANCH = 'main';
const FEED_DEFAULT = [
  'https://cdn.jsdelivr.net/gh/' + OWNER + '/' + REPO + '@' + BRANCH + '/version.json',
  'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + BRANCH + '/version.json',
  'https://github.com/' + OWNER + '/' + REPO + '/raw/' + BRANCH + '/version.json'
];
const userDataDir = app.getPath('userData');
const hotkeyFile = path.join(userDataDir, 'hotkey.json');
const closePrefFile = path.join(userDataDir, 'close-pref.json');
let currentAccel = DEFAULT_ACCEL;
let hotkeyOk = false;
let closePref = 'ask';   // ask=每次询问 | tray=直接收托盘 | quit=直接退出
let forceQuit = false;
let tray = null;

// 读取用户自定义快捷键与关闭偏好（存在 userData，与账本数据分开）
try {
  const cfg = JSON.parse(fs.readFileSync(hotkeyFile, 'utf8'));
  if (cfg && typeof cfg.accel === 'string' && cfg.accel) currentAccel = cfg.accel;
} catch (e) {}
try {
  const cp = JSON.parse(fs.readFileSync(closePrefFile, 'utf8'));
  if (cp && (cp.pref === 'tray' || cp.pref === 'quit')) closePref = cp.pref;
} catch (e) {}

function saveClosePref(p) {
  closePref = p;
  try { fs.writeFileSync(closePrefFile, JSON.stringify({ pref: p })); } catch (e) {}
}

function showWin(w) {
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}
function hideToTray(w) {
  if (!w) return;
  w.hide();   // 从任务栏消失，仅留托盘图标
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('结账助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWin(BrowserWindow.getAllWindows()[0]) },
    { type: 'separator' },
    { label: '退出', click: () => { forceQuit = true; app.quit(); } }
  ]));
  tray.on('click', () => showWin(BrowserWindow.getAllWindows()[0]));
  tray.on('double-click', () => showWin(BrowserWindow.getAllWindows()[0]));
}

function registerHotkey(accel) {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(accel, () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    // 切换语义：已在前台 → 收进托盘；其余（隐藏/最小化/失焦）→ 唤出
    if (w.isVisible() && w.isFocused()) hideToTray(w);
    else showWin(w);
  });
  hotkeyOk = ok;   // 注册失败 = 被其他程序/系统占用
  return ok;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '结账助手',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,   // 允许 file:// 下加载 OCR Worker 和 wasm（本地离线识别需要）
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (!hotkeyOk) win.webContents.send('hotkey-error', currentAccel);
  });

  // 点关闭（X）：按偏好直接收托盘/退出，否则通知页面弹自定义询问框
  win.on('close', (e) => {
    if (forceQuit) return;
    if (closePref === 'tray') { e.preventDefault(); hideToTray(win); return; }
    if (closePref === 'quit') return;
    e.preventDefault();
    win.webContents.send('ask-close');
  });
}

app.whenReady().then(() => {
  hotkeyOk = registerHotkey(currentAccel);
  createTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('set-hotkey', (_e, accel) => {
  const ok = registerHotkey(accel);
  if (ok) {
    currentAccel = accel;
    try { fs.writeFileSync(hotkeyFile, JSON.stringify({ accel })); } catch (e) {}
  } else {
    registerHotkey(currentAccel);   // 新键被占用时回退旧键，避免快捷键完全失效
  }
  return { ok, accel: currentAccel };
});
ipcMain.handle('get-hotkey', () => currentAccel);

// 页面自定义关闭询问框的回传：tray=收托盘 / quit=真退出 / cancel=什么都不做
ipcMain.on('close-answer', (e, payload) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !payload) return;
  if (payload.remember && (payload.choice === 'tray' || payload.choice === 'quit')) saveClosePref(payload.choice);
  if (payload.choice === 'tray') hideToTray(w);
  else if (payload.choice === 'quit') { forceQuit = true; w.close(); }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});

/* ============ 软件更新（只拉版本号，不上传任何账目数据） ============ */
function appDir() { return path.dirname(app.getPath('exe')); }
function feedUrls() {
  try {
    const p = path.join(appDir(), 'update-config.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg && Array.isArray(cfg.feed) && cfg.feed.length) return cfg.feed.filter(u => typeof u === 'string');
      if (cfg && typeof cfg.feed === 'string' && cfg.feed) return [cfg.feed];
    }
  } catch (e) {}
  return FEED_DEFAULT;
}
function curVersion() {
  try { return app.getVersion(); } catch (e) { return '0.0.0'; }
}
function cmpVer(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function parseAsarHeader(buf) {
  if (!buf || buf.length < 4096) return null;
  try {
    const jsonSize = buf.readUInt32LE(4);
    if (!(jsonSize > 16 && jsonSize < 4 * 1024 * 1024)) return null;
    if (16 + jsonSize > buf.length) return null;
    const s = buf.slice(16, 16 + jsonSize).toString('utf8');
    const cut = s.lastIndexOf('}');          // 末尾可能有 4 字节对齐填充
    if (cut < 0) return null;
    const j = JSON.parse(s.slice(0, cut + 1));
    if (!j || !j.files || !j.files['index.html'] || !j.files['main.js']) return null;   // 确认是本软件的包
    return { json: j, jsonSize: jsonSize };
  } catch (e) { return null; }
}
function isValidAsar(buf) {
  const h = parseAsarHeader(buf);
  if (!h) return false;
  // 按头部声明的 offset/size 推算正文长度，校验文件是否完整（防下载被截断）
  let end = 0;
  (function walk(node) {
    if (!node) return;
    if (node.files) {
      const ks = Object.keys(node.files);
      for (let i = 0; i < ks.length; i++) walk(node.files[ks[i]]);
    }
    if (!node.unpacked && typeof node.offset === 'string' && typeof node.size === 'number') {
      const o = (parseInt(node.offset, 10) || 0) + node.size;
      if (o > end) end = o;
    }
  })(h.json);
  if (end <= 0) return false;
  return Math.abs(buf.length - (16 + h.jsonSize + end)) <= 16;
}
async function httpGet(url) {
  const tryFetch = net && net.fetch ? net.fetch.bind(net) : (typeof fetch === 'function' ? fetch : null);
  if (!tryFetch) throw new Error('当前环境不支持网络请求');
  return tryFetch(url, { cache: 'no-store' });
}
ipcMain.handle('app-version', () => curVersion());
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});
ipcMain.handle('check-update', async () => {
  const urls = feedUrls().filter(u => u && !/OWNER\/REPO|OWNER\//.test(u));
  if (!urls.length) return { ok: false, reason: 'unconfigured' };
  let lastStatus = 0, lastErr = '';
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await httpGet(urls[i]);
      if (!res.ok) { lastStatus = res.status; continue; }
      const txt = await res.text();
      let info;
      try { info = JSON.parse(txt); } catch (e) { lastErr = '返回内容不是合法的 JSON'; continue; }
      const latest = String((info && info.version) || '');
      if (!/^\d+(\.\d+)*$/.test(latest)) { lastErr = '版本号格式不正确'; continue; }
      const cur = curVersion();
      return {
        ok: true, current: cur, latest: latest,
        hasUpdate: cmpVer(latest, cur) > 0,
        notes: (info && info.notes) || '',
        asar: (info && info.asar) || '',      // 增量包（约 110KB，推荐）
        full: (info && info.full) || ''       // 完整安装包（备用）
      };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  if (lastStatus) return { ok: false, reason: 'http', status: lastStatus };
  return { ok: false, reason: 'network', message: lastErr };
});
ipcMain.handle('download-update', async (_e, asarUrl) => {
  if (typeof asarUrl !== 'string' || !/^https?:\/\//i.test(asarUrl)) return { ok: false, message: '下载地址无效' };
  try {
    const res = await httpGet(asarUrl);
    if (!res.ok) return { ok: false, message: 'HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isValidAsar(buf)) return { ok: false, message: '下载文件校验未通过（可能不完整）' };
    const dir = path.join(appDir(), 'resources');
    if (!fs.existsSync(dir)) return { ok: false, message: '找不到 resources 目录' };
    const target = path.join(dir, 'app.asar');
    try { fs.accessSync(dir, fs.constants.W_OK); }
    catch (e) { return { ok: false, message: '安装目录不可写，请把软件移到桌面或文档目录后再更新' }; }
    fs.writeFileSync(target + '.new', buf);
    return { ok: true, size: buf.length };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
});
ipcMain.handle('apply-update', () => {
  const dir = appDir();
  const bat = path.join(dir, 'update.bat');
  if (!fs.existsSync(bat)) return { ok: false, message: '缺少 update.bat' };
  try {
    const child = spawn('cmd.exe', ['/c', bat, String(process.pid)], {
      cwd: dir, detached: true, stdio: 'ignore', windowsHide: true
    });
    if (child.unref) child.unref();
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
  forceQuit = true;
  setTimeout(() => app.quit(), 400);
  return { ok: true };
});

app.on('window-all-closed', () => {
  app.quit();
});
