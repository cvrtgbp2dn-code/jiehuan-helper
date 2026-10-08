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

  // 界面里的「复制下载链接」也要用真实用户名/仓库名
  const htmlPath = path.join(BUILD, 'index.html');
  let h = fs.readFileSync(htmlPath, 'utf8');
  const hBefore = h;
  h = h.replace(/'https:\/\/github\.com\/OWNER\/REPO\//, "'https://github.com/" + cfg.owner + "/" + cfg.repo + "/");
  if (h !== hBefore) { fs.writeFileSync(htmlPath, h, 'utf8'); log('· 已写入下载链接：' + cfg.owner + '/' + cfg.repo); }
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
const zipOut = path.join(OUT, zipName);
let zipped = false;
try {
  zipDir(APPDIR, zipOut);
  log('✓ 完整安装包 _release/out/' + zipName + '（' + (fs.statSync(zipOut).size / 1024 / 1024).toFixed(1) + ' MB）');
  zipped = true;
} catch (e) {
  log('! 完整安装包生成失败（可忽略，增量更新不需要它）：' + e.message);
}

// ---------- 5. 自动发布到 GitHub ----------
const tokenFile = path.join(__dirname, '.token');
const canPublish = fs.existsSync(tokenFile) || process.env.GH_TOKEN;
let published = false;
if (canPublish) {
  log('\n────────── 自动发布到 GitHub ──────────');
  try {
    execFileSync('python', [path.join(__dirname, 'publish.py')], { stdio: 'inherit' });
    published = true;
  } catch (e) {
    log('! 自动发布失败，可稍后手动重试：python _release/publish.py');
  }
}

// ---------- 6. 提示 ----------
if (!published) {
  log('\n────────── 下一步：上传到 GitHub ──────────');
  log('1) 打开 https://github.com/' + cfg.owner + '/' + cfg.repo + '/releases/new');
  log('2) Tag 填 ' + tag + '，标题也填 ' + tag);
  log('3) 上传这两个文件（拖拽即可）：');
  log('     _release/out/app.asar');
  if (zipped) log('     _release/out/' + zipName);
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
  // 优先用 python（生成标准 zip，路径用正斜杠，兼容性最好），失败再退回 PowerShell
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
  try {
    execFileSync('python', ['-c', py, dir, outFile], { stdio: 'ignore' });
    if (fs.existsSync(outFile)) return;
  } catch (e) { /* 退回 PowerShell */ }
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path "' + dir + '" -DestinationPath "' + outFile + '" -CompressionLevel Optimal -Force'],
    { stdio: 'ignore' });
  if (!fs.existsSync(outFile)) throw new Error('两种打包方式都失败');
}
