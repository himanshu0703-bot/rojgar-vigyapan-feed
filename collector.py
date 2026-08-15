import json
import hashlib
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

try:
    from curl_cffi import requests
except Exception:
    requests = None

# V4.5: visible SarkariResult category order is the primary discovery frontier.
# Search-engine ranking is deliberately not used for NEW-post detection because
# an old indexed URL can move upward without being newly published.
CATEGORIES = [
    ("Latest Jobs", "https://www.sarkariresult.com/latestjob/"),
    ("Result", "https://www.sarkariresult.com/result/"),
    ("Admit Card", "https://www.sarkariresult.com/admitcard/"),
    ("Answer Key", "https://www.sarkariresult.com/answerkey/"),
    ("Syllabus", "https://www.sarkariresult.com/syllabus/"),
    ("Admission", "https://www.sarkariresult.com/admission/"),
]
CATEGORY_FRONTIER_LIMIT = 20
SOURCE_EXCERPT_LIMIT = 12000
CATEGORY_SNAPSHOT_PROVENANCE = "sarkariresult_visible_category_box_v1"
CATEGORY_EXTRACTOR_VERSION = "visible-category-v1"
CATEGORY_SNAPSHOT_LINEAGE_LIMIT = 48

JINA_API_KEY = os.environ.get("JINA_API_KEY", "").strip()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "text/plain,text/markdown,text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

BLOCKED_SEGMENTS = {
    "latestjob", "result", "admitcard", "answerkey", "syllabus", "admission",
    "contact", "privacy", "disclaimer", "about", "search", "feed", "category", "tag",
    "author", "page", "paged", "archive", "archives", "comments", "trackback",
    "sitemap", "robots", "cdn-cgi", "tools", "tool", "android", "ios", "app",
    "whatsapp", "telegram", "youtube", "social"
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
    "twitter", "x", "linkedin",
    "category", "find more latest updates", "up scholarship", "up-scholarship",
    "bpsc", "upsssc", "ibps", "upsc", "air force", "navy", "rpsc",
    "delhi dssb", "delhi dsssb", "hssc", "police", "railway", "railways",
    "latest job", "latest jobs",
}
SOCIAL_HOSTS = {
    "t.me", "telegram.me", "whatsapp.com", "www.whatsapp.com", "instagram.com",
    "www.instagram.com", "facebook.com", "www.facebook.com", "youtube.com",
    "www.youtube.com", "youtu.be", "www.youtu.be", "threads.net", "www.threads.net",
    "twitter.com", "www.twitter.com", "x.com", "www.x.com", "linkedin.com",
    "www.linkedin.com", "wa.me", "telegram.org", "www.telegram.org",
    "play.google.com", "apps.apple.com",
}
SARKARIRESULT_NAV_PATHS = {
    "", "latestjob", "result", "admitcard", "answerkey", "syllabus", "admission",
    "contact", "privacy", "disclaimer", "about", "search", "category", "tag",
    "author", "page", "paged", "archive", "archives", "comments", "trackback",
    "sitemap", "robots", "cdn-cgi", "tools", "tool", "android", "ios", "app",
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
            if not re.match(
                r"^(?:\[?\d+\]?\s*)?(?:URL Source|Published Time|Markdown Content|Title):",
                line,
                re.I,
            ):
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


def _category_heading_aliases(label: str):
    aliases = {clean_title(label).casefold()}
    if label == "Latest Jobs":
        aliases.update({"latest job", "latest jobs"})
    elif label == "Admit Card":
        aliases.update({"admit card", "admit cards"})
    elif label == "Answer Key":
        aliases.update({"answer key", "answer keys"})
    return aliases


def isolate_category_scope(text: str, label: str) -> str:
    """Return the visible category box/list when it can be isolated safely."""
    value = text or ""
    if not value:
        return ""
    aliases = _category_heading_aliases(label)

    if re.search(r"<(?:html|table|div|section)\b", value, re.I):
        soup = BeautifulSoup(value, "html.parser")
        for node in soup.find_all(["h1", "h2", "h3", "h4", "th", "td", "div"]):
            heading = clean_visible_text(node).casefold().rstrip(":")
            if heading not in aliases:
                continue
            table = node.find_parent("table")
            if table is not None:
                return str(table)
            container = node.find_parent(["section", "article"])
            if container is not None:
                return str(container)

    lines = value.splitlines()
    start = -1
    start_level = 7
    for index, line in enumerate(lines):
        match = re.match(r"^\s*(#{1,6})\s*(.*?)\s*$", line)
        if not match:
            continue
        heading = clean_title(match.group(2)).casefold().rstrip(":")
        if heading in aliases:
            start = index + 1
            start_level = len(match.group(1))
            break
    if start < 0:
        return value

    stop = len(lines)
    for index in range(start, len(lines)):
        match = re.match(r"^\s*(#{1,6})\s*(.*?)\s*$", lines[index])
        if not match or len(match.group(1)) > start_level:
            continue
        heading = clean_title(match.group(2)).casefold().rstrip(":")
        if heading and heading not in aliases:
            stop = index
            break
    return "\n".join(lines[start:stop])


def extract_category_items(text: str, label: str):
    """Extract individual articles in the visible order of one category."""
    scope = isolate_category_scope(text, label)
    items = extract_items(scope, label)
    if not items and scope != (text or ""):
        items = extract_items(text, label)
    return items[:CATEGORY_FRONTIER_LIMIT]


def ordered_url_sha256(urls) -> str:
    normalized = [canonical(url) for url in urls if canonical(url)]
    return hashlib.sha256("\n".join(normalized).encode("utf-8")).hexdigest()


def load_previous_category_snapshots(path=Path("feed.json")):
    """Load only internally consistent snapshots made by this exact extractor."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    items_by_category = {}
    for item in payload.get("items") or []:
        category = clean_title(item.get("category") or item.get("label") or "")
        url = canonical(item.get("url") or "")
        if not category or not is_article(url):
            continue
        try:
            position = int(item.get("category_position", item.get("position", 10**9)))
        except Exception:
            position = 10**9
        items_by_category.setdefault(category, []).append((position, url, item))

    valid = {}
    for snapshot in payload.get("category_snapshots") or []:
        if not isinstance(snapshot, dict):
            continue
        label = clean_title(snapshot.get("label") or snapshot.get("category") or "")
        if not label or snapshot.get("status") != "fresh":
            continue
        if snapshot.get("provenance") != CATEGORY_SNAPSHOT_PROVENANCE:
            continue
        if snapshot.get("extractor_version") != CATEGORY_EXTRACTOR_VERSION:
            continue
        ordered_rows = sorted(items_by_category.get(label, []), key=lambda row: row[0])
        urls = []
        positions = []
        item_metadata_valid = True
        for position, url, item in ordered_rows:
            positions.append(position)
            urls.append(url)
            if (
                item.get("category_snapshot_provenance") != CATEGORY_SNAPSHOT_PROVENANCE
                or item.get("category_extractor_version") != CATEGORY_EXTRACTOR_VERSION
                or item.get("category_snapshot_sha256") != snapshot.get("ordered_urls_sha256")
            ):
                item_metadata_valid = False
        expected_hash = ordered_url_sha256(urls)
        if not urls or positions != list(range(len(urls))):
            continue
        try:
            item_count = int(snapshot.get("item_count") or 0)
        except (TypeError, ValueError):
            continue
        if item_count != len(urls):
            continue
        if snapshot.get("ordered_urls_sha256") != expected_hash or not item_metadata_valid:
            continue
        ancestors = [
            str(value)
            for value in snapshot.get("ancestor_snapshot_sha256s") or []
            if re.fullmatch(r"[0-9a-f]{64}", str(value))
        ]
        valid[label] = {
            "urls": urls,
            "snapshot_hash": expected_hash,
            "ancestor_snapshot_sha256s": ancestors[:CATEGORY_SNAPSHOT_LINEAGE_LIMIT],
        }
    return valid


def _parse_source_datetime(value: str) -> str:
    raw = clean_visible_text(value)
    if not raw:
        return ""
    parsed = None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        try:
            parsed = parsedate_to_datetime(raw)
        except Exception:
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def extract_source_temporal_metadata(content: str, representation: str):
    """Return only dates exposed by article/Jina metadata; never infer one."""
    text = content or ""
    published = ""
    updated = ""
    status = "unavailable"

    published_match = re.search(r"^Published Time:\s*(.+?)\s*$", text, re.I | re.M)
    if published_match:
        published = _parse_source_datetime(published_match.group(1))
        if published:
            status = "jina_published_time"

    if not published and representation.endswith("html"):
        soup = BeautifulSoup(text, "html.parser")
        for attribute, key in (("property", "article:published_time"), ("itemprop", "datePublished")):
            node = soup.find(attrs={attribute: key})
            if node is not None:
                published = _parse_source_datetime(node.get("content") or node.get_text(" ", strip=True))
                if published:
                    status = "html_article_published_time"
                    break

    if representation.endswith("html"):
        soup = BeautifulSoup(text, "html.parser")
        for attribute, key in (("property", "article:modified_time"), ("itemprop", "dateModified")):
            node = soup.find(attrs={attribute: key})
            if node is not None:
                updated = _parse_source_datetime(node.get("content") or node.get_text(" ", strip=True))
                if updated:
                    break

    return {
        "source_published_at": published,
        "source_updated_at": updated,
        "source_date_status": status,
    }


def source_excerpt_from_content(content: str, representation: str, limit: int = SOURCE_EXCERPT_LIMIT) -> str:
    """Create a bounded excerpt from the actual fetched article representation."""
    value = content or ""
    if not value:
        return ""
    if representation.endswith("html"):
        soup = BeautifulSoup(value, "html.parser")
        for node in soup(["script", "style", "noscript"]):
            node.decompose()
        value = soup.get_text("\n", strip=True)
    value = re.sub(r"[\t\r ]+", " ", value)
    value = re.sub(r"\n\s+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value).strip()
    return value[:limit]


def clean_visible_text(value) -> str:
    if hasattr(value, "stripped_strings"):
        value = " ".join(value.stripped_strings)
    return re.sub(r"\s+", " ", str(value or "")).strip()


def source_body_block_reason(text: str) -> str:
    value = text or ""
    if re.search(r"warning:\s*target url returned error\s+\d{3}", value, re.I):
        return "jina_target_url_error_warning"
    if re.search(r"the request could not be satisfied", value, re.I) and re.search(r"cloudfront", value, re.I):
        return "cloudfront_request_not_satisfied"
    if re.search(r"\b(?:403|429)\s+error\b", value, re.I) and re.search(r"request blocked|access denied|cloudfront", value, re.I):
        return "http_403_or_429_blocking_text"
    return ""


def source_body_is_blocked(text: str) -> bool:
    return bool(source_body_block_reason(text))


def important_links_heading_present(text: str) -> bool:
    return bool(re.search(r"(?:some\s+useful\s+)?important\s+links", text or "", re.I))


def href_like_link_count(text: str) -> int:
    value = text or ""
    html_hrefs = len(re.findall(r"\bhref\s*=\s*['\"]?https?://", value, re.I))
    markdown_links = len(re.findall(r"\[[^\]]+\]\(\s*<?https?://", value, re.I))
    reference_links = len(re.findall(r"^\s*\[[^\]]+\]:\s*<?https?://", value, re.I | re.M))
    return html_hrefs + markdown_links + reference_links


def sanitize_diagnostic_text(value: str, limit: int = 500) -> str:
    preview = str(value or "")[:4000]
    preview = re.sub(r"(?i)\bbearer\s+[A-Za-z0-9._~+\-/=]+", "Bearer [REDACTED]", preview)
    preview = re.sub(r"\bjina_[A-Za-z0-9_-]+", "[REDACTED_JINA_KEY]", preview)
    preview = re.sub(
        r"(?i)(['\"]?(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|"
        r"secret|password|passwd|cookie|set-cookie|session(?:id)?)['\"]?\s*[:=]\s*)"
        r"['\"]?[^'\"\s,;}&]+",
        r"\1[REDACTED]",
        preview,
    )
    preview = re.sub(
        r"(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)"
        r"[^&#\s]+",
        r"\1[REDACTED]",
        preview,
    )
    preview = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[REDACTED_JWT]", preview)
    preview = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", preview)
    return preview[:limit]


def response_content_type(response) -> str:
    headers = getattr(response, "headers", {}) or {}
    try:
        return str(headers.get("content-type") or headers.get("Content-Type") or "unknown")
    except Exception:
        return "unknown"


def response_body_byte_count(response, text: str) -> int:
    content = getattr(response, "content", None)
    if isinstance(content, (bytes, bytearray)):
        return len(content)
    return len((text or "").encode("utf-8", errors="replace"))


def jina_body_characteristics(text: str, content_type: str):
    value = text or ""
    lower = value.casefold()
    kinds = []
    block_reason = source_body_block_reason(value)
    if block_reason:
        kinds.append("cloudflare_or_403_wrapper")
    if "json" in (content_type or "").casefold() or value.lstrip().startswith(("{", "[")):
        kinds.append("json")
    if re.search(r"<(?:!doctype|html|head|body|table|title)\b", value, re.I):
        kinds.append("html")
    if important_links_heading_present(value) or re.search(r"^\s{0,3}#{1,6}\s+", value, re.M) or re.search(r"\[[^\]]+\]\(https?://", value, re.I):
        kinds.append("markdown")
    if re.search(
        r"\b(?:sign in to continue|please sign in|please log in|login required|"
        r"enter your (?:username|email|password)|authentication required)\b",
        lower,
    ) or re.search(r"\btype\s*=\s*['\"]password['\"]", value, re.I):
        kinds.append("login_page")
    if not block_reason and re.search(
        r"(?:^|\n)\s*(?:title:\s*)?(?:access denied|forbidden|unauthorized|"
        r"internal server error|bad gateway|service unavailable)\s*(?:\n|$)",
        value,
        re.I,
    ):
        kinds.append("other_error_format")
    return kinds or ["plain_text"], block_reason


def log_jina_response_diagnostics(endpoint_name: str, request_url: str, target_url: str, response):
    text = response.text or ""
    content_type = response_content_type(response)
    kinds, block_reason = jina_body_characteristics(text, content_type)
    status = int(response.status_code)
    byte_count = response_body_byte_count(response, text)
    heading_found = important_links_heading_present(text)
    link_count = href_like_link_count(text)
    print(
        f"[jina-response] endpoint={endpoint_name} "
        f"request_url={sanitize_diagnostic_text(request_url, 700)!r} "
        f"target_url={sanitize_diagnostic_text(target_url, 700)!r} "
        f"http_status={status} content_type={content_type!r} "
        f"response_bytes={byte_count} response_chars={len(text)} "
        f"body_kinds={','.join(kinds)} block_reason={block_reason or 'none'} "
        f"important_links_heading={heading_found} href_like_links={link_count}"
    )
    print(
        f"[jina-response][preview] endpoint={endpoint_name} "
        f"preview={sanitize_diagnostic_text(text)!r}"
    )
    return {
        "text": text,
        "content_type": content_type,
        "status": status,
        "byte_count": byte_count,
        "body_kinds": kinds,
        "block_reason": block_reason,
        "heading_found": heading_found,
        "link_count": link_count,
    }


def content_representation(text: str) -> str:
    """Identify the representation returned by the source or Jina Reader."""
    if re.search(r"<(?:!doctype|html|body|table|tr|td)\b", text or "", re.I):
        return "html"
    return "markdown"


def extract_jina_payload_content(text: str, content_type: str):
    looks_json = "json" in (content_type or "").casefold() or (text or "").lstrip().startswith("{")
    if not looks_json:
        return text or "", ""
    try:
        payload = json.loads(text or "")
    except Exception:
        return "", "invalid_json_response"
    if not isinstance(payload, dict):
        return "", "json_response_is_not_an_object"

    code = payload.get("code")
    if isinstance(code, int) and not 200 <= code < 300:
        return "", f"jina_json_code_{code}"
    internal_status = payload.get("status")
    if isinstance(internal_status, int) and internal_status >= 40000:
        return "", f"jina_json_status_{internal_status}"

    data = payload.get("data")
    if isinstance(data, dict):
        content = data.get("content")
    elif isinstance(data, str):
        content = data
    else:
        content = payload.get("content")
    if not isinstance(content, str) or not content.strip():
        return "", "jina_json_content_missing"
    if isinstance(data, dict):
        published_time = data.get("publishedTime") or data.get("published_time")
        if published_time and not re.search(r"^Published Time:\s*", content, re.I | re.M):
            content = f"Published Time: {published_time}\n{content}"
    return content, ""


def jina_content_rejection_reason(
    content: str, content_type: str, require_important_links: bool = True
) -> str:
    if len(content or "") <= 100:
        return "content_too_short"
    block_reason = source_body_block_reason(content)
    if block_reason:
        return block_reason
    kinds, _ = jina_body_characteristics(content, content_type)
    if "login_page" in kinds:
        return "login_page"
    if "other_error_format" in kinds:
        return "other_error_format"
    if require_important_links and not important_links_heading_present(content):
        return "important_links_heading_not_found"
    return ""


def evaluate_jina_response(
    endpoint_name: str,
    request_url: str,
    target_url: str,
    response,
    require_important_links: bool = True,
):
    diagnostics = log_jina_response_diagnostics(endpoint_name, request_url, target_url, response)
    if not 200 <= diagnostics["status"] < 300:
        rejection_reason = f"http_{diagnostics['status']}"
        print(
            f"[jina-response][decision] endpoint={endpoint_name} "
            f"accepted=False rejection_reason={rejection_reason}"
        )
        return None, rejection_reason

    content, payload_error = extract_jina_payload_content(
        diagnostics["text"], diagnostics["content_type"]
    )
    if payload_error:
        print(
            f"[jina-response][decision] endpoint={endpoint_name} "
            f"accepted=False rejection_reason={payload_error}"
        )
        return None, payload_error

    content_type = diagnostics["content_type"]
    response_was_json = (
        "json" in content_type.casefold()
        or diagnostics["text"].lstrip().startswith("{")
    )
    if response_was_json:
        kinds, block_reason = jina_body_characteristics(content, "text/markdown")
        print(
            f"[jina-response][extracted-content] endpoint={endpoint_name} "
            f"content_chars={len(content)} body_kinds={','.join(kinds)} "
            f"block_reason={block_reason or 'none'} "
            f"important_links_heading={important_links_heading_present(content)} "
            f"href_like_links={href_like_link_count(content)} "
            f"preview={sanitize_diagnostic_text(content)!r}"
        )
        content_type = "text/markdown"

    rejection_reason = jina_content_rejection_reason(
        content, content_type, require_important_links=require_important_links
    )
    if rejection_reason:
        print(
            f"[jina-response][decision] endpoint={endpoint_name} "
            f"accepted=False rejection_reason={rejection_reason}"
        )
        return None, rejection_reason
    print(
        f"[jina-response][decision] endpoint={endpoint_name} "
        "accepted=True rejection_reason=none"
    )
    return content, ""


def fetch_source_page(url: str, require_important_links: bool = True):
    """Fetch a source URL directly, then use authenticated Jina Reader."""
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
    # First retain the documented Reader URL form so its exact response is visible
    # in diagnostics. If it is unusable, try the authenticated JSON API form.
    jina_url = "https://r.jina.ai/" + url
    jina_url_headers = {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Accept": "text/plain",
        "X-Engine": "browser",
        "X-No-Cache": "true",
        "X-Return-Format": "markdown",
        "X-Timeout": "60",
    }
    jina_attempts = []
    try:
        response = requests.get(
            jina_url,
            headers=jina_url_headers,
            impersonate="chrome",
            timeout=75,
            allow_redirects=True,
        )
        result["jina_http_status"] = int(response.status_code)
        content, rejection_reason = evaluate_jina_response(
            "reader_url_get",
            jina_url,
            url,
            response,
            require_important_links=require_important_links,
        )
        if content is not None:
            representation = content_representation(content)
            result.update({
                "content": content,
                "jina_status": f"reader_url_get=ok_http_{response.status_code}",
                "representation": f"jina_url_{representation}",
                "source_fetch_status": f"ok_jina_url_{representation}_http_{response.status_code}",
            })
            return result
        jina_attempts.append(
            f"reader_url_get=failed_http_{response.status_code}_{rejection_reason}_"
            f"bytes_{response_body_byte_count(response, response.text or '')}"
        )
    except Exception as error:
        jina_attempts.append(f"reader_url_get=failed_{type(error).__name__.lower()}")

    jina_api_url = "https://r.jina.ai/"
    jina_api_headers = {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Engine": "cf-browser-rendering",
        "X-No-Cache": "true",
        "X-Return-Format": "markdown",
        "X-Timeout": "60",
    }
    try:
        response = requests.post(
            jina_api_url,
            headers=jina_api_headers,
            json={"url": url},
            timeout=75,
            allow_redirects=True,
        )
        result["jina_http_status"] = int(response.status_code)
        content, rejection_reason = evaluate_jina_response(
            "authenticated_api_post",
            jina_api_url,
            url,
            response,
            require_important_links=require_important_links,
        )
        if content is not None:
            representation = content_representation(content)
            jina_attempts.append(f"authenticated_api_post=ok_http_{response.status_code}")
            result.update({
                "content": content,
                "jina_status": ";".join(jina_attempts),
                "representation": f"jina_api_{representation}",
                "source_fetch_status": f"ok_jina_api_{representation}_http_{response.status_code}",
            })
            return result
        final_attempt = (
            f"authenticated_api_post=failed_http_{response.status_code}_{rejection_reason}_"
            f"bytes_{response_body_byte_count(response, response.text or '')}"
        )
        jina_attempts.append(final_attempt)
        result["jina_status"] = ";".join(jina_attempts)
        result["source_fetch_status"] = (
            f"failed_direct_and_jina_api_http_{response.status_code}_{rejection_reason}_"
            f"bytes_{response_body_byte_count(response, response.text or '')}"
        )
    except Exception as error:
        error_name = type(error).__name__.lower()
        jina_attempts.append(f"authenticated_api_post=failed_{error_name}")
        result["jina_status"] = ";".join(jina_attempts)
        result["source_fetch_status"] = f"failed_direct_and_jina_api_{error_name}"
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
    enriched["source_fetched_at"] = datetime.now(timezone.utc).isoformat()
    enriched["source_representation"] = fetch_result.get("representation") or "none"
    enriched["source_excerpt"] = source_excerpt_from_content(
        fetch_result.get("content") or "", fetch_result.get("representation") or "none"
    )
    enriched.update(
        extract_source_temporal_metadata(
            fetch_result.get("content") or "", fetch_result.get("representation") or "none"
        )
    )

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
    # The same article may legitimately appear in more than one category.
    # Fetch it once, then retain every category-specific position in feed.json.
    unique_items = {}
    for item in items:
        unique_items.setdefault(item["url"], item)
    worker_count = min(4, len(unique_items))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        enriched_unique = list(executor.map(enrich_item_with_important_links, unique_items.values()))
    enriched_by_url = {item["url"]: item for item in enriched_unique}
    result = []
    for item in items:
        merged = dict(item)
        source = enriched_by_url[item["url"]]
        for key in (
            "source_fetch_status", "source_fetched_at", "source_published_at",
            "source_updated_at", "source_date_status", "source_representation",
            "source_excerpt", "important_links",
            "important_links_count",
        ):
            merged[key] = source.get(key)
        result.append(merged)
    return result


def main():
    now = datetime.now(timezone.utc).isoformat()
    previous_snapshots = load_previous_category_snapshots()
    all_items = []
    diagnostics = []
    category_snapshots = []

    for label, category_url in CATEGORIES:
        try:
            fetch_result = fetch_source_page(category_url, require_important_links=False)
            text = fetch_result.get("content") or ""
            items = extract_category_items(text, label) if text else []
            if not items:
                raise RuntimeError(
                    "category page returned no valid ordered article URLs "
                    f"({fetch_result.get('source_fetch_status', 'unknown')})"
                )
            current_urls = [item["url"] for item in items]
            current_snapshot_hash = ordered_url_sha256(current_urls)
            previous_snapshot = previous_snapshots.get(label)
            previous_hash = previous_snapshot["snapshot_hash"] if previous_snapshot else ""
            lineage = []
            if previous_snapshot:
                lineage = [previous_hash] + previous_snapshot.get("ancestor_snapshot_sha256s", [])
            lineage = list(dict.fromkeys(lineage))[:CATEGORY_SNAPSHOT_LINEAGE_LIMIT]
            previous_set = set(previous_snapshot["urls"]) if previous_snapshot else set()
            surviving_anchor = next((url for url in current_urls if url in previous_set), "")
            transition_status = (
                "baseline"
                if not previous_snapshot
                else ("authoritative_transition" if surviving_anchor else "no_surviving_anchor")
            )

            for pos, item in enumerate(items):
                item["position"] = pos
                item["category"] = label
                item["category_position"] = pos
                item["category_source_url"] = category_url
                item["category_snapshot_status"] = "fresh"
                item["category_fetched_at"] = now
                item["category_snapshot_provenance"] = CATEGORY_SNAPSHOT_PROVENANCE
                item["category_extractor_version"] = CATEGORY_EXTRACTOR_VERSION
                item["category_snapshot_sha256"] = current_snapshot_hash
                item["discovered_at"] = now
                item["collected_at"] = now
                all_items.append(item)
            diagnostics.append({
                "label": label,
                "ok": True,
                "count": len(items),
                "bytes": len(text),
                "source": category_url,
                "fetch_status": fetch_result.get("source_fetch_status"),
            })
            category_snapshots.append({
                "label": label,
                "source_url": category_url,
                "status": "fresh",
                "item_count": len(items),
                "fetched_at": now,
                "provenance": CATEGORY_SNAPSHOT_PROVENANCE,
                "extractor_version": CATEGORY_EXTRACTOR_VERSION,
                "ordered_urls_sha256": current_snapshot_hash,
                "previous_snapshot_sha256": previous_hash,
                "ancestor_snapshot_sha256s": lineage,
                "transition_status": transition_status,
            })
        except Exception as e:
            diagnostics.append({
                "label": label,
                "ok": False,
                "count": 0,
                "error": str(e)[:300],
                "source": category_url,
            })
            category_snapshots.append({
                "label": label,
                "source_url": category_url,
                "status": "failed",
                "item_count": 0,
                "fetched_at": now,
                "error": str(e)[:300],
            })
        time.sleep(1)

    if not all_items:
        print(json.dumps({
            "generated_at": now,
            "items": 0,
            "diagnostics": diagnostics,
        }, ensure_ascii=False))
        raise SystemExit("V4.5 discovered 0 category article URLs; existing feed.json was preserved.")

    feed_items = enrich_items_with_important_links(all_items)

    payload = {
        "version": "4.5",
        "generated_at": now,
        "source": "sarkariresult.com visible category order via authenticated Jina Reader + GitHub Actions; source Important Links extracted by collector.py",
        "category_snapshots": category_snapshots,
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

if __name__ == "__main__":
    main()
