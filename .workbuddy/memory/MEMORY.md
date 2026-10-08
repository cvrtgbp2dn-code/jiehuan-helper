# 结账助手 · 项目长期约定

## 项目结构

| 路径 | 说明 |
|---|---|
| `src/index.html` | **界面源码的唯一真源**（改界面改这里） |
| `_build/` | 打包工作区：index.html（由 src 同步）、help.html、main.js、preload.js、package.json、lib/、node_modules/ |
| `_build/help.html` | 帮助中心页面（说明文字的唯一归口） |
| `结账助手-win32-x64/` | 打包产物目录（含 update.bat） |
| `_release/` | 发布工具链：config.json（GitHub 用户名/仓库名）、notes.txt（更新说明）、build-release.js、发布.bat、out/ |
| `结账助手-win32-x64-vX.Y.zip` | 交付给同事的完整包 |

## 界面与文案约定（重要）

1. **说明文字一律放帮助中心**：软件界面（设置面板、弹窗等）只保留**简短操作提示**（一句话以内，告知"怎么做"），**具体规则、原理、注意事项全部写进 `_build/help.html`**。
   - 例：设置面板只写「仅影响此后新记录」，细节写在帮助中心「单价与汇率（设置）」小节
   - 例：表格上方只写「按住行可拖动排序」，细节写在帮助中心「拖动排序」小节
2. **每次新增功能或优化，必须同步做三件事**：
   - 在 `_build/help.html` 增加/更新对应的功能小节（写清"怎么操作、什么效果、注意什么"）
   - 在 `_build/help.html` 版本记录里加一条 `vX.Y` 条目，概述本次改动
   - 在 `_release/notes.txt` 写本次更新要点（每行以 `- ` 开头，其他行自动忽略）
3. 界面文案面向使用者，用词直白，避免技术术语（如不写 "ord 字段"，写 "手动排序"）。

## 打包发布流程

```
1. 改代码（界面改 src/index.html；主进程改 _build/main.js）
2. 同步：脚本会自动把 src/index.html 复制到 _build/index.html
3. 运行：node _release/build-release.js  或双击 _release\发布.bat
   → 产出 _release/out/app.asar（约 110KB 增量包）
   → 产出 version.json（项目根目录 + out/，需提交到 GitHub 仓库根目录）
   → 产出 out/checkout-helper-X.Y.Z-win32-x64.zip（完整包）
   → 同时更新 结账助手-win32-x64/resources/app.asar
4. 复制 zip 为 结账助手-win32-x64-vX.Y.zip 交付
5. 上传 app.asar 到 GitHub Release，更新仓库根目录 version.json
```

## 版本号

`_build/package.json` 的 `version` 字段是唯一版本来源，会写进 asar 并被 `app.getVersion()` 读取。

## 技术注意（踩过的坑）

- **WorkBuddy 沙箱会注入删除/复制拦截器**：脚本里禁用 `fs.rmSync` 递归删大目录、禁用 `fs.cpSync` 递归复制（会静默杀进程）。用自写 `copyDir`（逐文件），删除用 try/catch 包裹的 `tryClean`。
- **PowerShell `Compress-Archive` 生成的 zip 分隔符是反斜杠**，改用 python zipfile + `os.path.relpath(p, base)` 生成标准 zip（保证归档内只有顶层文件夹名）。
- **asar 头部结构**：JSON 从偏移 **16** 开始，长度取 `u32@4`，末尾有 4 字节对齐填充（解析时用 `lastIndexOf('}')` 截断）。
- **asar 在运行时被锁定**，更新必须靠 `update.bat` 在程序退出后替换并重启。
- 更新用的 `update.bat` 必须**纯 ASCII**（避免中文编码问题），延时用 `ping -n`（`timeout` 在无控制台时会报错）。

## 数据与隐私

- 账目数据存 `C:\Users\<用户名>\AppData\Roaming\结账助手`（不在程序目录），更新/覆盖程序不影响数据。
- 更新功能只下载 `version.json`（版本号）和 `app.asar`（程序文件），**从不上传任何本地数据**。
