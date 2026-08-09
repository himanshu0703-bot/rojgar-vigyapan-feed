import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

try:
    from curl_cffi import requests
except Exception:
    requests = None

# V4.2: discovery uses authenticated Jina Search for indexed SarkariResult article URLs, then writes feed.json.
SEARCHES = [
    ("Latest Jobs", "site:sarkariresult.com Sarkari Result latest job online form vacancy 2026"),
    ("Result", "site:sarkariresult.com Sarkari Result result declared merit list score card 2026"),
    ("Admit Card", "site:sarkariresult.com Sarkari Result admit card exam date hall ticket 2026"),
    ("Answer Key", "site:sarkariresult.com Sarkari Result answer key objection 2026"),
    ("Syllabus", "site:sarkariresult.com Sarkari Result syllabus exam pattern 2026"),
    ("Admission", "site:sarkariresult.com Sarkari Result admission online form counselling 2026"),
]

JINA_API_KEY = os.environ.get("JINA_API_KEY", "").strip()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "text/plain,text/markdown,text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

BLOCKED_SEGMENTS = {
    "latestjob", "result", "admitcard", "answerkey", "syllabus", "admission",
    "contact", "privacy", "disclaimer", "about", "search", "feed", "category", "tag"
}
STATIC_EXT = re.compile(r"\.(?:jpg|jpeg|png|gif|webp|svg|css|js|xml|txt|pdf|zip|rar)$", re.I)
URL_RE = re.compile(r"https?://(?:www\.)?sarkariresult\.com/[^\s<>()\]\[\"']+", re.I)
MARKDOWN_RE = re.compile(r"\[([^\]]+)\]\((https?://(?:www\.)?sarkariresult\.com/[^)\s]+)\)", re.I)


def canonical(url: str) -> str:
    url = (url or "").strip()
    url = re.sub(r"[)>.,;:'\"]+$", "", url)
    url = url.replace("http://", "https://", 1)
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


def fetch_text(url: str, extra_headers=None) -> str:
    if requests is None:
        raise RuntimeError("curl_cffi is not installed")
    last = None
    headers = dict(HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    for impersonate in ("chrome", "chrome124", "safari17_0"):
        try:
            r = requests.get(
                url,
                headers=headers,
                impersonate=impersonate,
                timeout=45,
                allow_redirects=True,
            )
            text = r.text or ""
            if 200 <= r.status_code < 300 and len(text) > 100:
                return text
            last = RuntimeError(f"HTTP {r.status_code}, bytes={len(text)}")
        except Exception as e:
            last = e
        time.sleep(1)
    raise last or RuntimeError("search fetch failed")


def search_jina(query: str) -> str:
    # Official Jina Search endpoint: https://s.jina.ai/<query>
    if not JINA_API_KEY:
        raise RuntimeError("JINA_API_KEY environment variable is missing")
    return fetch_text(
        "https://s.jina.ai/" + quote(query, safe=""),
        {"Authorization": "Bearer " + JINA_API_KEY},
    )


def clean_title(text: str) -> str:
    text = re.sub(r"[*_`~#]+", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:300]


def title_near_url(text: str, url: str) -> str:
    # Prefer Markdown link text when the exact URL appears as [title](url).
    for title, found_url in MARKDOWN_RE.findall(text):
        if canonical(found_url) == canonical(url):
            return clean_title(title)

    # Otherwise use the preceding non-metadata line as a lightweight title hint.
    idx = text.find(url)
    if idx >= 0:
        before = text[max(0, idx - 500):idx]
        lines = [clean_title(x) for x in before.splitlines() if clean_title(x)]
        for line in reversed(lines):
            if not re.match(r"^(URL Source|Published Time|Markdown Content|Title):", line, re.I):
                if len(line) >= 5:
                    return line[:300]
    return ""


def extract_items(text: str, label: str):
    out, seen = [], set()

    # Markdown links first, since they carry better titles.
    for title, raw_url in MARKDOWN_RE.findall(text):
        url = canonical(raw_url)
        if not is_article(url) or url in seen:
            continue
        seen.add(url)
        out.append({"url": url, "title": clean_title(title), "label": label})

    # Then any plain SarkariResult URLs exposed in the SERP text.
    for raw_url in URL_RE.findall(text):
        url = canonical(raw_url)
        if not is_article(url) or url in seen:
            continue
        seen.add(url)
        out.append({"url": url, "title": title_near_url(text, raw_url), "label": label})

    return out


def main():
    now = datetime.now(timezone.utc).isoformat()
    all_items, global_seen = [], set()
    diagnostics = []

    for label, query in SEARCHES:
        try:
            text = search_jina(query)
            items = extract_items(text, label)
            accepted = 0
            for pos, item in enumerate(items):
                if item["url"] in global_seen:
                    continue
                global_seen.add(item["url"])
                item["position"] = pos
                item["discovered_at"] = now
                all_items.append(item)
                accepted += 1
            diagnostics.append({
                "label": label,
                "ok": accepted > 0,
                "count": accepted,
                "bytes": len(text),
                "source": "s.jina.ai",
            })
        except Exception as e:
            diagnostics.append({
                "label": label,
                "ok": False,
                "count": 0,
                "error": str(e)[:300],
                "source": "s.jina.ai",
            })
        time.sleep(1)

    payload = {
        "version": "4.2",
        "generated_at": now,
        "source": "sarkariresult.com indexed URLs via Jina Search + GitHub Actions",
        "items": all_items[:500],
        "diagnostics": diagnostics,
    }

    Path("feed.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"generated_at": now, "items": len(all_items), "diagnostics": diagnostics}, ensure_ascii=False))

    if not all_items:
        raise SystemExit("V4.2 discovered 0 article URLs. feed.json contains diagnostics.")


if __name__ == "__main__":
    main()
