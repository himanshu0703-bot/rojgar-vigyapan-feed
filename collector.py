import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

from bs4 import BeautifulSoup

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

IMPORTANT_LINKS_HEADING_RE = re.compile(r"^(?:some\s+useful\s+)?important\s+links\s*:?\s*$", re.I)
SECTION_STOP_RE = re.compile(
    r"^(?:frequently\s+asked\s+questions|faqs?|disclaimer|related\s+posts?|latest\s+posts?|"
    r"find\s+more\s+latest\s+updates|welcome\s+to\s+this\s+official\s+website)",
    re.I,
)
PROMOTIONAL_TEXT_RE = re.compile(
    r"(?:android\s+apps?|apple\s+ios\s+apps?|ios\s+apps?|sarkari\s+(?:result\s+)?tools?|"
    r"sarkari\s+result\s+(?:android|apple)|join\s+sarkari\s+result\s+channel|"
    r"sarkari\s+result.*(?:telegram|whatsapp|channel|tools?|app)|"
    r"(?:image|signature)\s*resizer|pdf\s*compress|age\s*calculator|typing\s*test|more\s*tools)",
    re.I,
)
NAVIGATION_LABELS = {
    "home", "homepage", "about us", "contact us", "terms and conditions",
    "terms & conditions", "privacy policy", "disclaimer", "join us", "follow",
    "whatsapp", "telegram", "instagram", "youtube", "threads", "facebook",
    "category", "find more latest updates", "up scholarship", "up-scholarship",
    "bpsc", "upsssc", "ibps", "upsc", "air force", "navy", "rpsc",
    "delhi dssb", "delhi dsssb", "hssc", "police", "railway", "railways",
    "latest job", "latest jobs",
}
SOCIAL_HOSTS = {
    "t.me", "telegram.me", "whatsapp.com", "www.whatsapp.com", "instagram.com",
    "www.instagram.com", "facebook.com", "www.facebook.com", "youtube.com",
    "www.youtube.com", "threads.net", "www.threads.net", "play.google.com",
    "apps.apple.com",
}
SARKARIRESULT_NAV_PATHS = {
    "", "latestjob", "result", "admitcard", "answerkey", "syllabus", "admission",
    "contact", "privacy", "disclaimer", "about", "search", "category", "tag",
    "tools", "tool", "android", "ios", "app",
}


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


def clean_visible_text(value) -> str:
    if hasattr(value, "stripped_strings"):
        value = " ".join(value.stripped_strings)
    return re.sub(r"\s+", " ", str(value or "")).strip()


def source_body_is_blocked(text: str) -> bool:
    value = text or ""
    if re.search(r"warning:\s*target url returned error\s+\d{3}", value, re.I):
        return True
    if re.search(r"the request could not be satisfied", value, re.I) and re.search(r"cloudfront", value, re.I):
        return True
    if re.search(r"\b(?:403|429)\s+error\b", value, re.I) and re.search(r"request blocked|access denied|cloudfront", value, re.I):
        return True
    return False


def content_representation(text: str) -> str:
    """Identify the representation returned by the source or Jina Reader."""
    if re.search(r"<(?:!doctype|html|body|table|tr|td)\b", text or "", re.I):
        return "html"
    return "markdown"


def fetch_source_page(url: str):
    """Fetch an article directly, then use authenticated Jina Reader on failure."""
    result = {
        "content": None,
        "direct_status": "not_attempted",
        "jina_attempted": False,
        "jina_http_status": None,
        "jina_status": "not_attempted",
        "representation": "none",
        "source_fetch_status": "failed_unknown",
    }
    if requests is None:
        result["direct_status"] = "failed_curl_cffi_not_installed"
        result["source_fetch_status"] = "failed_curl_cffi_not_installed"
        return result

    direct_attempts = []
    for impersonate in ("chrome", "chrome124", "safari17_0"):
        try:
            response = requests.get(
                url,
                headers=HEADERS,
                impersonate=impersonate,
                timeout=30,
                allow_redirects=True,
            )
            text = response.text or ""
            status = int(response.status_code)
            blocked = source_body_is_blocked(text)
            if 200 <= status < 300 and len(text) > 100 and not blocked:
                attempt_status = f"ok_http_{status}_{impersonate}_bytes_{len(text)}"
                direct_attempts.append(attempt_status)
                result.update({
                    "content": text,
                    "direct_status": ";".join(direct_attempts),
                    "representation": "direct_html",
                    "source_fetch_status": f"ok_http_{status}_{impersonate}",
                })
                return result
            suffix = "_blocked_body" if blocked else ""
            direct_attempts.append(
                f"failed_http_{status}_{impersonate}{suffix}_bytes_{len(text)}"
            )
        except Exception as error:
            direct_attempts.append(f"failed_{impersonate}_{type(error).__name__.lower()}")
        time.sleep(0.5)

    result["direct_status"] = ";".join(direct_attempts)
    if not JINA_API_KEY:
        result["jina_status"] = "not_attempted_missing_jina_api_key"
        result["source_fetch_status"] = "failed_direct_and_missing_jina_api_key"
        return result

    result["jina_attempted"] = True
    # Use authenticated Reader for a fresh browser-backed fetch after direct attempts fail.
    # Markdown preserves visible anchor text and href without depending on source table HTML.
    jina_url = "https://r.jina.ai/" + url
    jina_headers = {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Accept": "text/plain",
        "X-Engine": "browser",
        "X-No-Cache": "true",
        "X-Return-Format": "markdown",
        "X-Timeout": "60",
    }
    try:
        response = requests.get(
            jina_url,
            headers=jina_headers,
            impersonate="chrome",
            timeout=75,
            allow_redirects=True,
        )
        text = response.text or ""
        status = int(response.status_code)
        blocked = source_body_is_blocked(text)
        result["jina_http_status"] = status
        if 200 <= status < 300 and len(text) > 100 and not blocked:
            representation = content_representation(text)
            result.update({
                "content": text,
                "jina_status": f"ok_http_{status}_bytes_{len(text)}",
                "representation": f"jina_{representation}",
                "source_fetch_status": f"ok_jina_{representation}_http_{status}",
            })
            return result
        suffix = "_blocked_body" if blocked else ""
        result["jina_status"] = f"failed_http_{status}{suffix}_bytes_{len(text)}"
        result["source_fetch_status"] = (
            f"failed_direct_and_jina_http_{status}{suffix}_bytes_{len(text)}"
        )
    except Exception as error:
        error_name = type(error).__name__.lower()
        result["jina_status"] = f"failed_{error_name}"
        result["source_fetch_status"] = f"failed_direct_and_jina_{error_name}"
    return result


def exact_href(anchor, article_url: str) -> str:
    href = str(anchor.get("href") or "").strip()
    if not href or re.match(r"^(?:javascript:|mailto:|tel:|#)", href, re.I):
        return ""
    return href if re.match(r"^https?://", href, re.I) else urljoin(article_url, href)


def important_link_rejection_reason(label: str, text: str, url: str) -> str:
    label = clean_visible_text(label)
    text = clean_visible_text(text)
    url = str(url or "").strip()
    if not label:
        return "empty source row label"
    if not text:
        return "empty visible anchor text"
    if not re.match(r"^https?://", url, re.I):
        return "href is missing or is not HTTP(S)"
    if len(label) > 160:
        return "source row label is too long"
    if len(text) > 240:
        return "visible anchor text is too long"

    label_key = label.casefold()
    text_key = text.casefold()
    if label_key in NAVIGATION_LABELS or text_key in NAVIGATION_LABELS:
        return "promotional or navigation label/text"
    if PROMOTIONAL_TEXT_RE.search(label) or PROMOTIONAL_TEXT_RE.search(text):
        return "SarkariResult promotional tools/app/channel row"
    if re.fullmatch(r"sarkari\s+result(?:®)?", label, re.I):
        return "SarkariResult branding/navigation row"

    parsed = urlparse(url)
    host = (parsed.hostname or "").casefold()
    if any(host == social or host.endswith("." + social) for social in SOCIAL_HOSTS):
        return "social/app/channel destination"

    if host == "sarkariresult.com" or host.endswith(".sarkariresult.com"):
        parts = [part.casefold() for part in parsed.path.strip("/").split("/") if part]
        if not parts or (len(parts) == 1 and parts[0] in SARKARIRESULT_NAV_PATHS):
            return "SarkariResult homepage/category/navigation destination"

    return ""


def row_cells(row):
    return [
        cell for cell in row.find_all(["td", "th"])
        if cell.find_parent("tr") is row
    ]


def candidate_rows_after_marker(marker):
    marker_row = marker.find_parent("tr")
    if marker_row is not None:
        table = marker_row.find_parent("table")
        if table is not None:
            rows = [row for row in table.find_all("tr") if row.find_parent("table") is table]
            for index, row in enumerate(rows):
                if row is marker_row:
                    return rows[index + 1:], ("table", id(table), index)

    next_table = marker.find_next("table")
    if next_table is not None:
        rows = [row for row in next_table.find_all("tr") if row.find_parent("table") is next_table]
        return rows, ("next_table", id(next_table), 0)
    return [], ("none", id(marker), 0)


def raw_important_link_candidates(rows, article_url: str):
    candidates = []
    anchors_found = 0
    accepted_shape_seen = False

    for row in rows:
        cells = row_cells(row)
        row_text = clean_visible_text(row)
        if accepted_shape_seen and len(cells) < 2 and SECTION_STOP_RE.match(row_text):
            break
        if len(cells) < 2:
            continue

        label = clean_visible_text(cells[0])
        if not label or IMPORTANT_LINKS_HEADING_RE.fullmatch(label):
            continue

        anchors = []
        for cell in cells[1:]:
            anchors.extend(cell.find_all("a", href=True))
        anchors_found += len(anchors)
        if not anchors:
            continue

        accepted_shape_seen = True
        for anchor in anchors:
            candidates.append({
                "label": label,
                "text": clean_visible_text(anchor),
                "url": exact_href(anchor, article_url),
            })

    return candidates, anchors_found


def evaluate_important_link_candidates(raw_candidates):
    accepted = []
    rejected = []
    seen = set()
    for candidate in raw_candidates:
        candidate = {
            "label": clean_visible_text(candidate.get("label")),
            "text": clean_visible_text(candidate.get("text")),
            "url": str(candidate.get("url") or "").strip(),
        }
        reason = important_link_rejection_reason(
            candidate["label"], candidate["text"], candidate["url"]
        )
        if reason:
            rejected.append({**candidate, "reason": reason})
            continue
        key = (
            candidate["label"].casefold(),
            candidate["text"].casefold(),
            candidate["url"],
        )
        if key in seen:
            rejected.append({**candidate, "reason": "duplicate label/text/URL"})
            continue
        seen.add(key)
        accepted.append(candidate)
    return accepted, rejected


def extract_important_links(html: str, article_url: str):
    soup = BeautifulSoup(html or "", "lxml")
    markers = []
    for node in soup.find_all(string=True):
        if IMPORTANT_LINKS_HEADING_RE.fullmatch(clean_visible_text(node)):
            markers.append(node.parent)

    section_options = []
    used_scopes = set()
    for marker in markers:
        rows, scope_key = candidate_rows_after_marker(marker)
        if scope_key in used_scopes:
            continue
        used_scopes.add(scope_key)
        raw_candidates, anchors_found = raw_important_link_candidates(rows, article_url)
        accepted, rejected = evaluate_important_link_candidates(raw_candidates)

        section_options.append({
            "accepted": accepted,
            "rejected": rejected,
            "candidates": raw_candidates,
            "anchors_found": anchors_found,
        })

    if not section_options:
        return [], {
            "section_found": False,
            "anchors_found": 0,
            "candidates": [],
            "rejected": [],
        }

    best = max(
        section_options,
        key=lambda option: (len(option["accepted"]), len(option["candidates"]), option["anchors_found"]),
    )
    return best["accepted"], {
        "section_found": True,
        "anchors_found": best["anchors_found"],
        "candidates": best["candidates"],
        "rejected": best["rejected"],
    }


MARKDOWN_INLINE_LINK_RE = re.compile(
    r"\[([^\]]+)\]\(\s*<?(https?://[^\s)>]+)>?(?:\s+['\"][^)]*['\"])?\s*\)",
    re.I,
)
MARKDOWN_REFERENCE_LINK_RE = re.compile(r"\[([^\]]+)\]\[([^\]]+)\]")
MARKDOWN_REFERENCE_DEF_RE = re.compile(r"^\s*\[([^\]]+)\]:\s*<?(https?://\S+?)>?\s*$", re.I)


def clean_markdown_text(value: str) -> str:
    value = unescape(str(value or ""))
    value = re.sub(r"^\s{0,3}#{1,6}\s*", "", value)
    value = re.sub(r"\s+#+\s*$", "", value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"[*_`~]", "", value)
    value = re.sub(r"\\([\\`*{}\[\]()#+.!_|>-])", r"\1", value)
    return clean_visible_text(value.strip(" |:-"))


def markdown_links_in_line(line: str, references):
    links = []
    occupied = []
    for match in MARKDOWN_INLINE_LINK_RE.finditer(line):
        links.append({
            "text": clean_markdown_text(match.group(1)),
            "url": unescape(match.group(2).replace("\\)", ")")),
            "start": match.start(),
        })
        occupied.append(match.span())

    for match in MARKDOWN_REFERENCE_LINK_RE.finditer(line):
        if any(start <= match.start() < end for start, end in occupied):
            continue
        url = references.get(match.group(2).casefold())
        if url:
            links.append({
                "text": clean_markdown_text(match.group(1)),
                "url": url,
                "start": match.start(),
            })
    return sorted(links, key=lambda link: link["start"])


def markdown_label_before(lines, line_index: int, first_link_start: int) -> str:
    prefix = clean_markdown_text(lines[line_index][:first_link_start])
    if prefix:
        return prefix

    labels = []
    separator_since_last_label = False
    for previous_index in range(line_index - 1, max(-1, line_index - 24), -1):
        previous = lines[previous_index].strip()
        if not previous:
            continue
        cleaned = clean_markdown_text(previous)
        if re.fullmatch(r"[|:\-–—\s]+", previous):
            separator_since_last_label = True
            continue
        if IMPORTANT_LINKS_HEADING_RE.fullmatch(cleaned):
            break
        if MARKDOWN_INLINE_LINK_RE.search(previous) or MARKDOWN_REFERENCE_LINK_RE.search(previous):
            break
        if not cleaned or re.match(
            r"^(?:title|url source|published time|markdown content)\s*:", cleaned, re.I
        ):
            continue
        # Jina represents table cells with standalone pipes. Two adjacent text
        # blocks without a pipe identify the end of the preceding table row.
        if labels and not separator_since_last_label:
            break
        labels.append(cleaned)
        separator_since_last_label = False
    return labels[-1] if labels else ""


def raw_markdown_important_link_candidates(lines, article_url: str, references):
    candidates = []
    anchors_found = 0
    for line_index, line in enumerate(lines):
        links = markdown_links_in_line(line, references)
        if not links:
            continue
        anchors_found += len(links)

        table_cells = [cell for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        first_cell_has_link = bool(markdown_links_in_line(table_cells[0], references))
        if (
            len(table_cells) >= 2
            and not first_cell_has_link
            and markdown_links_in_line("|".join(table_cells[1:]), references)
        ):
            label = clean_markdown_text(table_cells[0])
        else:
            label = markdown_label_before(lines, line_index, links[0]["start"])

        for link in links:
            href = link["url"].strip()
            if href and not re.match(r"^https?://", href, re.I):
                href = urljoin(article_url, href)
            candidates.append({"label": label, "text": link["text"], "url": href})
    return candidates, anchors_found


def extract_important_links_markdown(markdown: str, article_url: str):
    lines = (markdown or "").splitlines()
    references = {}
    for line in lines:
        match = MARKDOWN_REFERENCE_DEF_RE.match(line)
        if match:
            references[match.group(1).casefold()] = unescape(match.group(2))

    marker_indexes = [
        index for index, line in enumerate(lines)
        if IMPORTANT_LINKS_HEADING_RE.fullmatch(clean_markdown_text(line))
    ]
    section_options = []
    for marker_index in marker_indexes:
        end_index = len(lines)
        for index in range(marker_index + 1, end_index):
            if SECTION_STOP_RE.match(clean_markdown_text(lines[index])):
                end_index = index
                break
        section_lines = lines[marker_index + 1:end_index]
        raw_candidates, anchors_found = raw_markdown_important_link_candidates(
            section_lines, article_url, references
        )
        accepted, rejected = evaluate_important_link_candidates(raw_candidates)
        section_options.append({
            "accepted": accepted,
            "rejected": rejected,
            "candidates": raw_candidates,
            "anchors_found": anchors_found,
        })

    if not section_options:
        return [], {
            "section_found": False,
            "anchors_found": 0,
            "candidates": [],
            "rejected": [],
        }

    best = max(
        section_options,
        key=lambda option: (len(option["accepted"]), len(option["candidates"]), option["anchors_found"]),
    )
    return best["accepted"], {
        "section_found": True,
        "anchors_found": best["anchors_found"],
        "candidates": best["candidates"],
        "rejected": best["rejected"],
    }


def enrich_item_with_important_links(item):
    enriched = dict(item)
    url = enriched["url"]
    fetch_result = fetch_source_page(url)
    fetch_status = fetch_result["source_fetch_status"]
    enriched["source_fetch_status"] = fetch_status
    enriched["important_links"] = []
    enriched["important_links_count"] = 0

    print(
        f"[source-fetch] url={url} direct_status={fetch_result['direct_status']!r} "
        f"jina_attempted={fetch_result['jina_attempted']} "
        f"jina_http_status={fetch_result['jina_http_status']} "
        f"jina_status={fetch_result['jina_status']!r} "
        f"representation={fetch_result['representation']} final_status={fetch_status}"
    )

    content = fetch_result["content"]
    if content is None:
        print(
            f"[important-links] url={url} section_found=False anchors=0 "
            "candidates=0 accepted=0 rejected=0"
        )
        return enriched

    try:
        if fetch_result["representation"].endswith("markdown"):
            rows, diagnostics = extract_important_links_markdown(content, url)
        else:
            rows, diagnostics = extract_important_links(content, url)
    except Exception as error:
        enriched["source_fetch_status"] = f"{fetch_status}_parse_failed_{type(error).__name__.lower()}"
        print(
            f"[important-links] url={url} section_found=unknown anchors=unknown "
            f"candidates=unknown accepted=0 rejected=unknown "
            f"parse_error={type(error).__name__}"
        )
        return enriched

    enriched["important_links"] = rows
    enriched["important_links_count"] = len(rows)
    print(
        f"[important-links] url={url} representation={fetch_result['representation']} "
        f"section_found={diagnostics['section_found']} anchors={diagnostics['anchors_found']} "
        f"candidates={len(diagnostics['candidates'])} accepted={len(rows)} "
        f"rejected={len(diagnostics['rejected'])}"
    )
    for accepted in rows:
        print(
            "[important-links][accepted] "
            f"label={accepted['label']!r} text={accepted['text']!r} "
            f"url={accepted['url']!r}"
        )
    for rejected in diagnostics["rejected"]:
        print(
            "[important-links][rejected] "
            f"label={rejected['label']!r} text={rejected['text']!r} "
            f"url={rejected['url']!r} reason={rejected['reason']}"
        )
    return enriched


def enrich_items_with_important_links(items):
    if not items:
        return []
    worker_count = min(4, len(items))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        return list(executor.map(enrich_item_with_important_links, items))


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

    feed_items = enrich_items_with_important_links(all_items[:500])

    payload = {
        "version": "4.3",
        "generated_at": now,
        "source": "sarkariresult.com indexed URLs via Jina Search + GitHub Actions; source Important Links extracted by collector.py",
        "items": feed_items,
        "diagnostics": diagnostics,
    }

    Path("feed.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "generated_at": now,
        "items": len(all_items),
        "items_written": len(feed_items),
        "important_links": sum(item["important_links_count"] for item in feed_items),
        "diagnostics": diagnostics,
    }, ensure_ascii=False))

    if not all_items:
        raise SystemExit("V4.3 discovered 0 article URLs. feed.json contains diagnostics.")


if __name__ == "__main__":
    main()
