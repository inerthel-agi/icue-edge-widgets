"""Builds community/index.json: iCUE widgets other people share on GitHub, and the Elgato Marketplace's.

Found by repository: the topics icue-widget / icuewidget / xeneon-edge-widget, "icuewidget" in the name, or a
search for XENEON EDGE / pump LCD widgets. A widget is either a folder with an iCUE manifest.json (installed by
iCUE Edge Companion from the exact commit listed here, each file checked against its git blob hash) or an
.icuewidget file in a release (checked against its SHA-256). Nothing is reviewed: the index only says where a
widget is and pins what was seen.

Uses the GitHub CLI (`gh api`, logged in or with GH_TOKEN, as in the daily workflow) for the API and plain HTTPS
for raw files. The Marketplace part reads only its public pages (its robots.txt allows them), one request a second:
the widget listing, each maker's page, and the widgets' own pages to find more makers. Nothing is downloaded from
the Marketplace: its widgets come from an Elgato account, so the companion opens their page. Standard library only.

    python scripts/community-index.py [--out community/index.json]
"""
import argparse
import base64
import hashlib
import io
import json
import re
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

OWN = "inerthel-agi/icue-edge-widgets"
QUERIES = [
    "topic:icue-widget", "topic:icuewidget", "topic:xeneon-edge-widget", "icuewidget in:name",
    "icuewidget", "xeneon edge widget", "xeneon edge widgets", "icue widget", "corsair pump lcd widget",
]
MAX_FILES = 300                 # per widget folder
MAX_BYTES = 32 * 1024 * 1024    # per widget, folder or package
MAX_WIDGETS_PER_REPO = 60
OUTSIDE = re.compile(r"""(?:src|href)\s*=\s*["']\.\./""", re.I)   # a folder that needs files next to it


def gh(path):
    """GET on the GitHub API through gh; None on any error (missing repo, rate limit...)."""
    r = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github+json", path], capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        print("  gh:", path, r.stderr.strip()[:120], file=sys.stderr)
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def fetch(url, limit=MAX_BYTES):
    req = urllib.request.Request(url, headers={"User-Agent": "icue-edge-widgets-community-index"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("too large")
    return data


def manifest_ok(m):
    return isinstance(m, dict) and isinstance(m.get("id"), str) and isinstance(m.get("supported_devices"), list)


def summary(m, fallback_name):
    devices = sorted({d.get("type") for d in m.get("supported_devices", []) if isinstance(d, dict) and isinstance(d.get("type"), str)})
    plugins = [p for p in m.get("required_plugins") or [] if isinstance(p, str)]
    return {
        "id": m["id"][:120], "name": str(m.get("name") or fallback_name)[:80], "author": str(m.get("author") or "")[:60],
        "version": str(m.get("version") or "")[:20], "description": str(m.get("description") or "")[:240],
        "devices": devices, "plugins": plugins[:8], "interactive": bool(m.get("interactive")),
    }


def repo_info(it):
    return {
        "repo": it["full_name"], "owner": it["owner"]["login"], "ownerId": it["owner"]["id"],
        "stars": it.get("stargazers_count", 0), "pushed": (it.get("pushed_at") or "")[:10],
        "license": ((it.get("license") or {}).get("spdx_id")) or "none",
        "created": (it.get("created_at") or "")[:10],
    }


def folder_widgets(it, out):
    name, branch = it["full_name"], it.get("default_branch") or "main"
    head = gh(f"repos/{name}/commits/{branch}")
    if not head:
        return
    commit = head["sha"]
    tree = gh(f"repos/{name}/git/trees/{commit}?recursive=1") or {}
    if tree.get("truncated"):
        print(f"  warning: {name} tree truncated, some widgets may be missing", file=sys.stderr)
    blobs = [t for t in tree.get("tree", []) if t.get("type") == "blob"]
    manifests = [t["path"] for t in blobs if t["path"].split("/")[-1] == "manifest.json"
                 and not re.search(r"(^|/)(node_modules|vendor|docs?|\.github|test|tests|examples?)/", t["path"])]
    for path in manifests[:MAX_WIDGETS_PER_REPO]:
        folder = path.rsplit("/", 1)[0] if "/" in path else ""
        prefix = folder + "/" if folder else ""
        try:
            m = json.loads(fetch(f"https://raw.githubusercontent.com/{name}/{commit}/{path}", 256 * 1024).decode("utf-8-sig"))
        except Exception:
            continue
        if not manifest_ok(m):
            continue
        files = [[t["path"][len(prefix):], t.get("size", 0), t["sha"]] for t in blobs if t["path"].startswith(prefix)
                 and not t["path"][len(prefix):].startswith((".git", "node_modules/"))]
        if not any(f[0] == "index.html" for f in files):
            continue
        size = sum(f[1] for f in files)
        if len(files) > MAX_FILES or size > MAX_BYTES:
            continue
        try:
            html = fetch(f"https://raw.githubusercontent.com/{name}/{commit}/{prefix}index.html", 2 * 1024 * 1024).decode("utf-8", "replace")
        except Exception:
            continue
        w = {**repo_info(it), **summary(m, folder.split("/")[-1] or name.split("/")[1])}
        icon = m.get("preview_icon")
        if isinstance(icon, str) and any(f[0] == icon for f in files) and icon.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            w["icon"] = prefix + icon
        w["key"] = f"{name}:{folder or '.'}"
        w["source"] = {"type": "folder", "commit": commit, "folder": folder, "files": files, "size": size,
                       "outside": bool(OUTSIDE.search(html))}
        out.append(w)


def release_widgets(it, out):
    name = it["full_name"]
    releases = gh(f"repos/{name}/releases?per_page=10")
    if not isinstance(releases, list):
        return
    seen = set()
    for rel in releases:
        if rel.get("draft"):
            continue
        for a in rel.get("assets", []):
            if not a["name"].endswith(".icuewidget") or a["name"] in seen or a.get("size", 0) > MAX_BYTES:
                continue
            seen.add(a["name"])  # newest release first: older copies of the same file are skipped
            try:
                data = fetch(a["browser_download_url"])
                z = zipfile.ZipFile(io.BytesIO(data))
                entry = next((n for n in z.namelist() if n.split("/")[-1] == "manifest.json" and n.count("/") <= 1), None)
                m = json.loads(z.read(entry).decode("utf-8-sig")) if entry else None
            except Exception:
                continue
            if not manifest_ok(m):
                continue
            w = {**repo_info(it), **summary(m, a["name"][: -len(".icuewidget")])}
            w["key"] = f"{name}@{a['name']}"
            w["source"] = {"type": "release", "tag": rel["tag_name"], "asset": a["name"], "url": a["browser_download_url"],
                           "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            out.append(w)


MARKET = "https://marketplace.elgato.com"
MARKET_UA = "icue-edge-widgets-community-index (+https://github.com/inerthel-agi/icue-edge-widgets)"
FLIGHT = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
HANDLE = re.compile(r'href="/@([A-Za-z0-9_.-]{1,60})"')
SLUG = re.compile(r"^[a-z0-9-]{1,160}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_MARKET_REQUESTS = 400


def market_page(path, budget):
    if budget[0] <= 0:
        return ""
    budget[0] -= 1
    time.sleep(1)
    req = urllib.request.Request(MARKET + path, headers={"User-Agent": MARKET_UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read(8 * 1024 * 1024).decode("utf-8", "replace")
    except Exception as e:
        print("  marketplace:", path, e, file=sys.stderr)
        return ""


def market_products(html):
    """The product records a public page embeds in its Next.js data, iCUE widgets only."""
    try:
        flight = "".join(json.loads('"' + s + '"') for s in FLIGHT.findall(html))
    except ValueError:
        return {}
    dec, out = json.JSONDecoder(), {}
    for m in re.finditer(r'\{"additional_links":', flight):
        try:
            p, _ = dec.raw_decode(flight, m.start())
        except ValueError:
            continue
        if isinstance(p, dict) and p.get("application") == "icue" and p.get("extension") == "widgets" and SLUG.match(str(p.get("slug", ""))):
            out[p["id"]] = p
    return out


def market_entry(p):
    tags = {t.get("name"): t.get("tags") or [] for t in p.get("tagsets") or [] if isinstance(t, dict)}
    variants = [v for v in p.get("variants") or [] if isinstance(v, dict)]
    v = next((v for v in variants if v.get("is_default")), variants[0] if variants else {})
    price = v.get("price") or {}
    thumb = p.get("thumbnail_cdn") if str(p.get("thumbnail_cdn") or "").startswith("https://mp-cdn.elgato.com/") else None
    return {
        "id": p["id"], "slug": p["slug"], "name": str(p.get("name") or "")[:80], "maker": str(p.get("org_name") or "")[:60],
        "makerSlug": str(p.get("org_slug") or "")[:60], "free": bool(v.get("is_free")),
        "price": None if v.get("is_free") else {"amount": price.get("unit_amount"), "currency": price.get("currency")},
        "devices": [d for d in tags.get("Device", []) if isinstance(d, str)][:4], "type": (tags.get("Type") or [""])[0],
        "interactive": (tags.get("Interactive") or [""])[0] == "Yes", "description": " ".join(str(p.get("seo") or "").split())[:240],
        "image": thumb, "published": str(p.get("last_published") or p.get("created_at") or "")[:10],
    }


def marketplace():
    """iCUE widgets on the Elgato Marketplace, from its public pages: listings, then makers, then the makers named
    on widget pages, until nothing new appears or the request budget is spent."""
    budget = [MAX_MARKET_REQUESTS]
    found, makers, seen_makers, seen_pages = {}, set(), set(), set()
    for path in ["/icue/widgets", "/icue"]:
        html = market_page(path, budget)
        found.update(market_products(html))
        makers |= set(HANDLE.findall(html))
    while True:
        for m in sorted(makers - seen_makers):
            seen_makers.add(m)
            found.update(market_products(market_page("/@" + m, budget)))
        new = set()
        for p in list(found.values()):
            if p["slug"] not in seen_pages and budget[0] > 0:
                seen_pages.add(p["slug"])
                new |= set(HANDLE.findall(market_page("/product/" + p["slug"], budget)))
        makers |= new
        if not (makers - seen_makers) or budget[0] <= 0:
            break
    print(f"marketplace: {len(found)} widgets from {len(seen_makers)} makers, {MAX_MARKET_REQUESTS - budget[0]} requests", file=sys.stderr)
    return sorted((market_entry(p) for p in found.values()), key=lambda e: (not e["free"], e["name"].lower()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "community" / "index.json"))
    ap.add_argument("--marketplace-only", action="store_true", help="refresh only the Marketplace part of an existing index")
    args = ap.parse_args()
    if args.marketplace_only:
        index = json.loads(Path(args.out).read_text(encoding="utf-8"))
        index["marketplace"] = marketplace() or index.get("marketplace", [])
        dump = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        Path(args.out).write_text('{"version":1,\n"generated":' + dump(index["generated"]) + ',\n"repos":' + str(index["repos"]) +
                                  ',\n"widgets":[\n' + ",\n".join(dump(w) for w in index["widgets"]) + '\n],\n"marketplace":[\n' +
                                  ",\n".join(dump(m) for m in index["marketplace"]) + "\n]}\n", encoding="utf-8")
        print(len(index["marketplace"]), "Marketplace widgets ->", args.out)
        return
    repos = {}
    for q in QUERIES:
        d = gh("search/repositories?per_page=100&q=" + urllib.request.quote(q)) or {}
        if d.get("total_count", 0) > len(d.get("items", [])):
            print(f"  warning: {q!r} found {d['total_count']} repositories, read {len(d.get('items', []))}", file=sys.stderr)
        for it in d.get("items", []):
            if it["full_name"] != OWN and not it.get("fork") and not it.get("archived") and not it.get("private"):
                repos[it["full_name"]] = it
        time.sleep(2.5)  # search allows 30 requests a minute
    if not repos:  # every search failed (rate limit, bad token): keep the published index
        sys.exit("no repository search returned a result; index not written")
    widgets = []
    for name in sorted(repos):
        n = len(widgets)
        folder_widgets(repos[name], widgets)
        release_widgets(repos[name], widgets)
        if len(widgets) > n:
            print(f"{name}: {len(widgets) - n}", file=sys.stderr)
    # One entry per widget id. Copies of a widget live in several repositories, a repository can hold it twice
    # (source and build folder) or ship one package per version. Kept, in this order: a published package, the
    # most stars, the oldest repository (the original rather than a copy), then the crawl order (newest
    # release first, shallowest folder).
    for n, w in enumerate(widgets):
        w["_order"] = (w["source"].get("folder") or "").count("/") * 1000 + n
    best = {}
    for w in sorted(widgets, key=lambda w: (w["source"]["type"] != "release", -w["stars"], w.get("created") or "9999", w["_order"])):
        best.setdefault(w["id"], w)
    widgets = list(best.values())
    for w in widgets:
        del w["_order"]
    widgets.sort(key=lambda w: (-w["stars"], w["name"].lower()))
    try:
        before = len(json.loads(Path(args.out).read_text(encoding="utf-8")).get("widgets", []))
    except (OSError, ValueError):
        before = 0  # first run, or an unreadable index
    if len(widgets) * 2 < before:  # a partial failure: keep the published index
        sys.exit(f"only {len(widgets)} widgets found, {before} before; index not written")
    try:
        market = marketplace()
    except Exception as e:  # the Marketplace changed or is down: keep the last list rather than none
        print("marketplace failed:", e, file=sys.stderr)
        market = []
    if not market and Path(args.out).is_file():
        try:
            market = json.loads(Path(args.out).read_text(encoding="utf-8")).get("marketplace", [])
        except ValueError:
            market = []
    # One widget per line, the date on a line of its own: the daily diff stays readable and a date-only change is
    # ignored by the workflow.
    dump = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    text = ('{"version":1,\n"generated":' + dump(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())) + ",\n"
            '"repos":' + str(len(repos)) + ',\n"widgets":[\n' + ",\n".join(dump(w) for w in widgets) + "\n],\n"
            '"marketplace":[\n' + ",\n".join(dump(m) for m in market) + "\n]}\n")
    json.loads(text)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"{len(repos)} repositories, {len(widgets)} widgets, {len(market)} Marketplace widgets -> {args.out}")


if __name__ == "__main__":
    main()
