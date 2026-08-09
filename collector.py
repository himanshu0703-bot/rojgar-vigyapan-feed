import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse
from pathlib import Path

from bs4 import BeautifulSoup

try:
    from curl_cffi import requests
except Exception:
    requests = None

SOURCES = [
    ("https://www.sarkariresult.com/latestjob/", "Latest Jobs"),
    ("https://www.sarkariresult.com/result/", "Result"),
    ("https://www.sarkariresult.com/admitcard/", "Admit Card"),
    ("https://www.sarkariresult.com/answerkey/", "Answer Key"),
    ("https://www.sarkariresult.com/syllabus/", "Syllabus"),
    ("https://www.sarkariresult.com/admission/", "Admission"),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Cache-Control": "no-cache",
}

BLOCKED_SEGMENTS = {
    "latestjob", "result", "admitcard", "answerkey", "syllabus", "admission",
    "contact", "privacy", "disclaimer", "about", "search", "feed", "category", "tag"
}
STATIC_EXT = re.compile(r"\.(?:jpg|jpeg|png|gif|webp|svg|css|js|xml|txt|pdf|zip|rar)$", re.I)


def canonical(url: str) -> str:
    url = (url or "").strip().replace("http://", "https://", 1)
    url = re.sub(r"^https://sarkariresult\.com", "https://www.sarkariresult.com", url, flags=re.I)
    url = re.sub(r"[?#].*$", "", url).rstrip("/")
    return url + "/" if url else ""


def is_article(url: str) -> bool:
    u = canonical(url)
    if not re.match(r"^https://(?:www\.)?sarkariresult\.com/", u, re.I):
        return False
    path = urlparse(u).path.strip("/")
    if not path or STATIC_EXT.search(path):
        return False
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return False
    if any(p.lower() in BLOCKED_SEGMENTS or p.lower().startswith("wp-") for p in parts):
        return False
    return True


def fetch_html(url: str) -> str:
    if requests is None:
        raise RuntimeError("curl_cffi is not installed")
    last = None
    for impersonate in ("chrome", "chrome124", "safari17_0"):
        try:
            r = requests.get(url, headers=HEADERS, impersonate=impersonate, timeout=30, allow_redirects=True)
            if 200 <= r.status_code < 300 and len(r.text) > 500:
                return r.text
            last = RuntimeError(f"HTTP {r.status_code}, bytes={len(r.text)}")
        except Exception as e:
            last = e
        time.sleep(1)
    raise last or RuntimeError("fetch failed")


def parse_category(html: str, base_url: str, label: str):
    soup = BeautifulSoup(html, "lxml")
    out, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a.get("href", ""))
        url = canonical(href)
        if not is_article(url) or url in seen:
            continue
        title = " ".join(a.stripped_strings)
        title = re.sub(r"\s+", " ", title).strip()
        if len(title) < 3:
            continue
        seen.add(url)
        out.append({"url": url, "title": title[:300], "label": label})
    return out


def main():
    all_items, seen = [], set()
    diagnostics = []
    now = datetime.now(timezone.utc).isoformat()

    for source_url, label in SOURCES:
        try:
            html = fetch_html(source_url)
            items = parse_category(html, source_url, label)
            diagnostics.append({"label": label, "ok": True, "count": len(items)})
            for pos, item in enumerate(items):
                if item["url"] in seen:
                    continue
                seen.add(item["url"])
                item["position"] = pos
                item["discovered_at"] = now
                all_items.append(item)
        except Exception as e:
            diagnostics.append({"label": label, "ok": False, "error": str(e)[:300], "count": 0})

    payload = {
        "version": 4,
        "generated_at": now,
        "source": "sarkariresult.com via GitHub Actions collector",
        "items": all_items[:2500],
        "diagnostics": diagnostics,
    }

    Path("feed.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"generated_at": now, "items": len(all_items), "diagnostics": diagnostics}, ensure_ascii=False))

    if not all_items:
        raise SystemExit("No article URLs discovered; feed.json kept for diagnostics but workflow will fail.")


if __name__ == "__main__":
    main()
