#!/usr/bin/env node
/**
 * 一键打包发布文件（每次优化后运行一次）
 *
 *   node _release/build-release.js
 *
 * 产出（都在 _release/out/ 里）：
 *   1. app.asar                                   ← 增量包（约 100KB），上传到 GitHub Release
 *   2. version.json                               ← 版本号文件，上传到仓库根目录
 *   3. checkout-helper-win32-x64.zip              ← 完整安装包（固定文件名！）
 *
 * 同时会把 resources/app.asar 更新为最新（这样本地 结账助手-win32-x64 目录也是新版）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, '_build');
const OUT = path.join(__dirname, 'out');
const APPDIR = path.join(ROOT, '结账助手-win32-x64');
const ASAR_BIN = path.join(BUILD, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');

function log(msg) { console.log(msg); }
function die(msg) { console.error('\n[错误] ' + msg + '\n'); process.exit(1); }
// 尽力清理（失败也不影响，后面会定向覆盖）
function tryClean(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
// 逐文件递归复制（不用 fs.cpSync，兼容性更好）
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

/* ---------- 找可用的 Python ----------
   注意：不能直接用裸命令 `python`。在 Windows 上，PATH 里第一个 python
   往往是 Microsoft Store 的占位程序（WindowsApps\python.exe），
   双击运行时会弹商店或直接失败，导致 zip 打包和上传都报错。
   这里逐个试，取第一个能真正跑起来的。 */
function findPython() {
  const cands = [
    process.env.PYTHON,                                   // 手动指定优先
    'C:\\Users\\ipai\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe',
    'C:\\Users\\ipai\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe',
    'python',
    'python3',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      // 排除 Store 占位程序：真实 python 能在 stdout 输出以 "Python " 开头的内容
      const out = execFileSync(c, ['-c', 'import sys;print("Python "+sys.version.split()[0])'],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString().trim();
      if (/^Python \d/.test(out)) {
        // 再确认能用标准库 zipfile（打包依赖它）
        execFileSync(c, ['-c', 'import zipfile'], { stdio: 'ignore', timeout: 15000 });
        log('· 使用 Python：' + (c === 'python' || c === 'python3' ? c + '（来自 PATH）' : c));
        return c;
      }
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}
const PYTHON = findPython();
if (!PYTHON) {
  die('找不到可用的 Python。\n' +
      '  打包和上传都需要 Python（用于生成 zip、调用 publish.py）。\n' +
      '  请安装 Python 3（安装时勾选 Add to PATH），或设置环境变量 PYTHON 指向 python.exe。');
}

// ---------- 读取配置 ----------
const cfgPath = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!cfg.owner || !cfg.repo || cfg.owner === 'OWNER' || cfg.repo === 'REPO') {
  die('请先编辑 _release/config.json，把 owner 改成你的 GitHub 用户名、repo 改成仓库名。');
}
const pkg = JSON.parse(fs.readFileSync(path.join(BUILD, 'package.json'), 'utf8'));
const ver = pkg.version;
const tag = 'v' + ver;
const notesFile = path.join(__dirname, 'notes.txt');
// 只取以 - 开头的行作为更新说明，方便在文件里写注释/模板说明
const notes = fs.existsSync(notesFile)
  ? fs.readFileSync(notesFile, 'utf8').split('\n')
      .filter(l => /^\s*-\s*\S/.test(l))
      .map(l => '- ' + l.replace(/^\s*-\s*/, '').trim())
      .join('\n')
  : '';

// ---------- 1. 同步源码 → 打包 --------
// 界面源码以 src/index.html 为准，自动同步到 _build，避免两处不一致
const srcHtml = path.join(ROOT, 'src', 'index.html');
const dstHtml = path.join(BUILD, 'index.html');
if (fs.existsSync(srcHtml)) {
  const a = fs.readFileSync(srcHtml, 'utf8');
  const b = fs.existsSync(dstHtml) ? fs.readFileSync(dstHtml, 'utf8') : null;
  if (a !== b) { fs.copyFileSync(srcHtml, dstHtml); log('· 已同步 src/index.html → _build/index.html'); }
}

// 把 config.json 里的用户名/仓库名自动写进 main.js（更新源地址），避免手动改漏
(function injectUpdateSource() {
  const mainPath = path.join(BUILD, 'main.js');
  let s = fs.readFileSync(mainPath, 'utf8');
  const branch = cfg.branch || 'main';
  const before = s;
  s = s.replace(/const OWNER = '[^']*';/, "const OWNER = '" + cfg.owner + "';");
  s = s.replace(/const REPO = '[^']*';/, "const REPO = '" + cfg.repo + "';");
  s = s.replace(/const BRANCH = '[^']*';/, "const BRANCH = '" + branch + "';");
  if (s !== before) { fs.writeFileSync(mainPath, s, 'utf8'); log('· 已写入更新源：' + cfg.owner + '/' + cfg.repo + '@' + branch); }
})();

// ---------- 保险：把所有 .bat 换成 CRLF 换行 ----------
// cmd.exe 要求 .bat 用 CRLF；若被编辑器改成 LF，双击会报「系统找不到指定的路径」。
// 打包前统一修正，避免把坏掉的 bat 发出去。
(function fixBatLineEndings() {
  const dirs = [APPDIR, ROOT, path.join(ROOT, '_release')];
  let fixed = 0;
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.bat$/i.test(f)) continue;
      const p = path.join(d, f);
      try {
        if (!fs.statSync(p).isFile()) continue;
        const s = fs.readFileSync(p, 'utf8');
        const crlf = s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
        if (crlf !== s) { fs.writeFileSync(p, crlf, 'utf8'); fixed++; }
      } catch (e) { /* 忽略单个文件 */ }
    }
  }
  if (fixed) log('· 已把 ' + fixed + ' 个 .bat 修正为 CRLF 换行');
})();

const STAGE = path.join(BUILD, '_staging');
tryClean(STAGE);
fs.mkdirSync(STAGE, { recursive: true });
for (const f of ['index.html', 'help.html', 'main.js', 'preload.js', 'package.json', 'tray.png']) {
  fs.copyFileSync(path.join(BUILD, f), path.join(STAGE, f));
}
copyDir(path.join(BUILD, 'lib'), path.join(STAGE, 'lib'));

fs.mkdirSync(OUT, { recursive: true });
try {                                   // 清掉上一版遗留的 zip
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.zip')) tryClean(path.join(OUT, f));
} catch (e) { /* 忽略 */ }

const asarTarget = path.join(APPDIR, 'resources', 'app.asar');
try {
  execFileSync(process.execPath, [ASAR_BIN, 'pack', STAGE, asarTarget, '--unpack-dir', 'lib'], { stdio: 'inherit' });
} catch (e) {
  die('打包 app.asar 失败。如果软件正在运行，请先完全退出再重试。');
}
tryClean(STAGE);
log('✓ 已生成 ' + asarTarget);

// ---------- 2. 产出增量包 ----------
const asarOut = path.join(OUT, 'app.asar');
fs.copyFileSync(asarTarget, asarOut);
const asarSize = (fs.statSync(asarOut).size / 1024).toFixed(0);
log('✓ 增量包 _release/out/app.asar（' + asarSize + ' KB）');

// ---------- 3. 产出 version.json ----------
const base = 'https://github.com/' + cfg.owner + '/' + cfg.repo + '/releases/download/' + tag + '/';
// 安装包用固定文件名：这样 /releases/latest/download/<名字> 就成了永久有效的直达链接
const zipName = 'checkout-helper-win32-x64.zip';
const permanentUrl = 'https://github.com/' + cfg.owner + '/' + cfg.repo + '/releases/latest/download/' + zipName;
const versionJson = {
  version: ver,
  date: new Date().toISOString().slice(0, 10),
  notes: notes,
  asar: base + 'app.asar',      // 增量包（带版本号目录，保证与版本严格对应）
  full: base + zipName,         // 本版本的完整包（带版本号目录，精确下载）
  download: permanentUrl        // 永久直达链接（始终指向最新版）
};
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify(versionJson, null, 2) + '\n', 'utf8');
// 同时写一份到项目根目录，这一份就是要提交到 GitHub 仓库根目录的 version.json
fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify(versionJson, null, 2) + '\n', 'utf8');
log('✓ 版本文件 _release/out/version.json（并已同步到项目根目录 version.json）');

// ---------- 4. 产出完整安装包 ----------
// 注意：这一步失败必须**中断整个发布**。否则会静默跳过 zip，导致：
//   ① 新同事下载不到完整包   ② 永久链接指向的附件是旧的
// 之前因为只打一行警告就继续，出现过「看起来发布成功、实际没有 zip」的情况。
const zipOut = path.join(OUT, zipName);
try {
  zipDir(APPDIR, zipOut);
  log('✓ 完整安装包 _release/out/' + zipName + '（' + (fs.statSync(zipOut).size / 1024 / 1024).toFixed(1) + ' MB）');
} catch (e) {
  die('完整安装包生成失败，已停止发布（避免上线一个不完整的版本）。\n' +
      '  原因：' + e.message + '\n' +
      '  处理：完全退出「结账助手」（包括右下角托盘图标）后重新运行 发布.bat。');
}

// ---------- 5. 自动发布到 GitHub ----------
const tokenFile = path.join(__dirname, '.token');
const canPublish = fs.existsSync(tokenFile) || process.env.GH_TOKEN;
let published = false;
if (canPublish) {
  log('\n────────── 自动发布到 GitHub ──────────');
  try {
    execFileSync(PYTHON, [path.join(__dirname, 'publish.py')], { stdio: 'inherit' });
    published = true;
  } catch (e) {
    log('');
    log('! 自动发布失败：' + e.message);
    log('  产物已在 _release/out/，可手动重试：');
    log('    "' + PYTHON + '" "' + path.join(__dirname, 'publish.py') + '"');
  }
}

// ---------- 6. 提示 ----------
if (!published) {
  log('\n────────── 下一步：上传到 GitHub ──────────');
  log('1) 打开 https://github.com/' + cfg.owner + '/' + cfg.repo + '/releases/new');
  log('2) Tag 填 ' + tag + '，标题也填 ' + tag);
  log('3) 上传这两个文件（拖拽即可）：');
  log('     _release/out/app.asar');
  log('     _release/out/' + zipName);
  log('4) 点 Publish release');
  log('5) 把项目根目录的 version.json 覆盖到仓库根目录的 version.json 并提交');
  log('');
  log('提示：把 GitHub 授权保存到 _release/.token 后，这一步会全自动完成。');
}
log('');
log('完整安装包（发给新同事）：_release/out/' + zipName);
log('永久直达下载链接（始终指向最新版）：');
log('  ' + permanentUrl);
log('');

// ---------- 工具：目录打包成 zip ----------
function zipDir(dir, outFile) {
  // 用已找到的 Python 生成标准 zip（路径用正斜杠，兼容性最好）
  const py = `
import zipfile, os, sys
root, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(root))     # 归档内保留顶层文件夹名
if os.path.exists(out): os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            z.write(p, os.path.relpath(p, base))
`;
  let lastErr = null;
  try {
    execFileSync(PYTHON, ['-c', py, dir, outFile], { stdio: 'ignore' });
    if (fs.existsSync(outFile)) return;
  } catch (e) { lastErr = e; }
  // 兜底：PowerShell（生成的 zip 反斜杠路径，兼容性略差，但好过没有）
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -Path "' + dir + '" -DestinationPath "' + outFile + '" -CompressionLevel Optimal -Force'],
      { stdio: 'ignore' });
  } catch (e) { lastErr = e; }
  if (!fs.existsSync(outFile)) {
    throw new Error('打包 zip 失败：' + ((lastErr && lastErr.message) || '未知原因') +
      '（常见原因：软件正在运行，目录被占用；请完全退出结账助手后重试）');
  }
}
