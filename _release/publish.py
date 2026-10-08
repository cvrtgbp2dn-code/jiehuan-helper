#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键发布到 GitHub（由 build-release.js 自动调用，也可单独运行）

做四件事：
  1. 创建/复用 Release，上传 app.asar（增量包）和完整 zip
  2. 把 version.json、界面源码、main.js 等更新到仓库
  3. 清除 jsDelivr CDN 缓存
  4. 打印结果
"""
import base64, json, os, sys, urllib.request, urllib.error, urllib.parse, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REL = os.path.join(ROOT, "_release")
OUT = os.path.join(REL, "out")
API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"

# ---------- 读取配置 ----------
cfg = json.load(open(os.path.join(REL, "config.json"), encoding="utf-8"))
OWNER, REPO = cfg["owner"], cfg["repo"]
BRANCH = cfg.get("branch", "main")

# ---------- 读取 token ----------
TOKEN = os.environ.get("GH_TOKEN", "")
if not TOKEN:
    tf = os.path.join(REL, ".token")
    if os.path.exists(tf):
        TOKEN = open(tf, encoding="utf-8").read().strip()
if not TOKEN:
    sys.exit("[错误] 找不到 GitHub 授权信息（_release/.token）")


def build_opener():
    """优先直连，直连失败再走环境代理"""
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        return urllib.request.build_opener(*handlers), "代理 " + proxy
    return urllib.request.build_opener(), "直连"


opener, mode = build_opener()


def call(method, url, data=None, raw=None, ctype="application/json", timeout=1800):
    body = raw if raw is not None else (
        json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None)
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", "token " + TOKEN)
    req.add_header("User-Agent", "checkout-helper")
    req.add_header("Accept", "application/vnd.github+json")
    if body:
        req.add_header("Content-Type", ctype)
    try:
        with opener.open(req, timeout=timeout) as r:
            body = r.read().decode("utf-8")
            if not body.strip():
                return {"ok": True, "status": r.status}   # 204 之类空响应
            return json.loads(body)
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace")
        try:
            return json.loads(t)
        except Exception:
            return {"message": "HTTP %s: %s" % (e.code, t[:300]), "status": e.code}


def purge_jsdelivr(path):
    """清 jsDelivr 缓存（失败不影响主流程）"""
    url = "https://purge.jsdelivr.net/gh/%s/%s@%s/%s" % (OWNER, REPO, BRANCH, path)
    try:
        r = call("GET", url, timeout=60)
        return r.get("status") == "finished"
    except Exception:
        return False


def put_file(rel_path, message):
    p = os.path.join(ROOT, rel_path)
    if not os.path.exists(p):
        print("   ! 跳过（不存在）:", rel_path); return True
    raw = open(p, "rb").read()
    cur = call("GET", "%s/repos/%s/%s/contents/%s?ref=%s" % (API, OWNER, REPO, urllib.parse.quote(rel_path), BRANCH))
    payload = {"message": message, "content": base64.b64encode(raw).decode("ascii"), "branch": BRANCH}
    if isinstance(cur, dict) and cur.get("sha"):
        payload["sha"] = cur["sha"]
    for attempt in range(3):
        r = call("PUT", "%s/repos/%s/%s/contents/%s" % (API, OWNER, REPO, urllib.parse.quote(rel_path)), payload)
        if "content" in r:
            print("   ✓ %-38s %7d B" % (rel_path, len(raw)))
            return True
        time.sleep(2)
    print("   ! 失败 %s: %s" % (rel_path, r))
    return False


def main():
    ver = "0.0.0"
    tag = ""
    notes = ""
    vj = os.path.join(OUT, "version.json")
    if os.path.exists(vj):
        d = json.load(open(vj, encoding="utf-8"))
        ver, notes = d.get("version", "0.0.0"), d.get("notes", "")
    tag = "v" + ver

    print("发布目标：%s/%s  版本 %s  （网络：%s）" % (OWNER, REPO, tag, mode))

    # ---------- 1. Release + 附件 ----------
    print("== 1. 创建 Release %s ==" % tag)
    rel = call("POST", "%s/repos/%s/%s/releases" % (API, OWNER, REPO), {
        "tag_name": tag, "name": tag,
        "body": "## 结账助手 " + tag + "\n\n" + notes +
                "\n\n---\n\n### 怎么更新\n"
                "**已经在用 v5.3 及以后版本**：打开软件 → 设置 → 检查更新 → 立即更新"
                "（只下载约 110KB，自动重启生效）。\n\n"
                "**还在用 v5.2 或更早版本**：请下载下面的完整安装包，解压覆盖即可"
                "（账目数据存在 AppData，不受影响）。",
        "draft": False, "prerelease": False,
    })
    if "id" not in rel:
        rel = call("GET", "%s/repos/%s/%s/releases/tags/%s" % (API, OWNER, REPO, tag))
        if "id" not in rel:
            print("   ! 创建失败:", rel); return False
        print("   · 已存在，复用 Release")
    else:
        print("   ✓ Release 创建成功")
    upload_url = rel["upload_url"].split("{")[0]
    rel_html = rel["html_url"]

    existing = set()
    for a in call("GET", "%s/repos/%s/%s/releases/%s/assets" % (API, OWNER, REPO, rel["id"])) or []:
        if isinstance(a, dict) and a.get("name"):
            existing.add(a["name"])

    assets = [os.path.join(OUT, "app.asar")]
    for f in sorted(os.listdir(OUT)):
        if f.endswith(".zip"):
            assets.append(os.path.join(OUT, f))

    print("== 2. 上传附件 ==")
    for p in assets:
        if not os.path.exists(p):
            print("   ! 跳过（不存在）:", os.path.basename(p)); continue
        name = os.path.basename(p)
        if name in existing:
            print("   · 已存在，先删除旧附件:", name)
            for a in call("GET", "%s/repos/%s/%s/releases/%s/assets" % (API, OWNER, REPO, rel["id"])) or []:
                if isinstance(a, dict) and a.get("name") == name:
                    call("DELETE", "%s/repos/%s/%s/releases/assets/%s" % (API, OWNER, REPO, a["id"]))
        size = os.path.getsize(p)
        print("   ↑ %s（%.1f MB）..." % (name, size / 1024 / 1024), end="", flush=True)
        r = call("POST", "%s?name=%s" % (upload_url, urllib.parse.quote(name)),
                 raw=open(p, "rb").read(), ctype="application/octet-stream")
        if "id" in r:
            print(" ✓")
        else:
            print(" ✗ %s" % r)

    # ---------- 2b. 补一份「固定文件名」的附件 ----------
    # /releases/latest/download/<固定名> 才能成为永久直达链接，所以 zip 要以固定名再传一份
    fixed = "checkout-helper-win32-x64.zip"
    src_zip = None
    for p in assets:
        if p.endswith(".zip") and os.path.exists(p) and os.path.basename(p) != fixed:
            src_zip = p
            break
    if src_zip:
        print("== 2b. 上传固定文件名附件（永久链接用）==")
        for a in call("GET", "%s/repos/%s/%s/releases/%s/assets" % (API, OWNER, REPO, rel["id"])) or []:
            if isinstance(a, dict) and a.get("name") == fixed:
                print("   · 删除旧附件:", fixed)
                call("DELETE", "%s/repos/%s/%s/releases/assets/%s" % (API, OWNER, REPO, a["id"]))
        print("   ↑ %s（%.1f MB）..." % (fixed, os.path.getsize(src_zip) / 1024 / 1024), end="", flush=True)
        r = call("POST", "%s?name=%s" % (upload_url, urllib.parse.quote(fixed)),
                 raw=open(src_zip, "rb").read(), ctype="application/octet-stream")
        print(" ✓" if "id" in r else " ✗ %s" % r)

    # ---------- 3. 更新仓库文件 ----------
    print("== 3. 更新仓库文件 ==")
    ok = True
    ok &= put_file("version.json", "版本更新到 " + tag)
    ok &= put_file("README.md", "同步项目主页说明")
    ok &= put_file("docs/main.png", "同步主界面截图")
    ok &= put_file("_build/main.js", "更新程序代码")
    ok &= put_file("_build/index.html", "同步打包界面")
    ok &= put_file("_build/help.html", "同步帮助文档")
    ok &= put_file("_build/package.json", "更新版本号")
    ok &= put_file("src/index.html", "同步界面源码")
    ok &= put_file("_release/config.json", "更新发布配置")
    ok &= put_file("_release/notes.txt", "更新说明")
    ok &= put_file("_release/更新操作手册.md", "更新操作手册")
    ok &= put_file("_release/build-release.js", "同步发布脚本")
    ok &= put_file("_release/publish.py", "同步发布脚本")
    ok &= put_file(".gitignore", "同步忽略规则")

    # ---------- 4. 清 CDN 缓存 ----------
    print("== 4. 清除 CDN 缓存 ==")
    if purge_jsdelivr("version.json"):
        print("   ✓ jsDelivr 缓存已清除")
    else:
        print("   · jsDelivr 缓存清除未确认（不影响使用：程序优先走 GitHub API，无缓存）")

    print("\n✅ 发布完成")
    print("   下载页: %s" % rel_html)
    print("   永久直达链接: https://github.com/%s/%s/releases/latest/download/checkout-helper-win32-x64.zip" % (OWNER, REPO))
    print("   版本源: https://api.github.com/repos/%s/%s/contents/version.json" % (OWNER, REPO))
    return ok


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
