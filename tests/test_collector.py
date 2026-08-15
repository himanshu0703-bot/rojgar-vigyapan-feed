import json
import re
import unittest
from unittest import mock
import sys
import types

try:
    import bs4  # noqa: F401
except ModuleNotFoundError:
    bs4_stub = types.ModuleType("bs4")

    class MissingBeautifulSoup:
        def __init__(self, *args, **kwargs):
            raise AssertionError("This dependency-neutral test unexpectedly required HTML parsing")

    bs4_stub.BeautifulSoup = MissingBeautifulSoup
    sys.modules["bs4"] = bs4_stub

import collector


class CollectorDiscoveryTests(unittest.TestCase):
    def test_category_markdown_order_is_preserved(self):
        markdown = """
## Latest Jobs
[New One](https://www.sarkariresult.com/2026/new-one/)
[New Two](https://www.sarkariresult.com/railway/new-two/)
## Result
[Wrong Section](https://www.sarkariresult.com/2026/wrong-section/)
"""
        items = collector.extract_category_items(markdown, "Latest Jobs")
        self.assertEqual(
            [item["url"] for item in items],
            [
                "https://www.sarkariresult.com/2026/new-one/",
                "https://www.sarkariresult.com/railway/new-two/",
            ],
        )

    def test_each_category_frontier_is_bounded_without_cross_category_truncation(self):
        markdown = "## Latest Jobs\n" + "\n".join(
            f"[Post {index}](https://www.sarkariresult.com/2026/post-{index}/)"
            for index in range(collector.CATEGORY_FRONTIER_LIMIT + 5)
        )
        items = collector.extract_category_items(markdown, "Latest Jobs")
        self.assertEqual(len(items), collector.CATEGORY_FRONTIER_LIMIT)
        self.assertEqual(items[0]["url"], "https://www.sarkariresult.com/2026/post-0/")
        self.assertEqual(
            items[-1]["url"],
            f"https://www.sarkariresult.com/2026/post-{collector.CATEGORY_FRONTIER_LIMIT - 1}/",
        )

    def test_valid_article_namespaces(self):
        for namespace in ("2026", "2025", "upsssc", "ssc", "railway", "bihar", "upsc"):
            self.assertTrue(
                collector.is_article(
                    f"https://www.sarkariresult.com/{namespace}/example-post/"
                )
            )

    def test_navigation_and_promotional_urls_are_rejected(self):
        for url in (
            "https://www.sarkariresult.com/",
            "https://www.sarkariresult.com/search/query/",
            "https://www.sarkariresult.com/tag/jobs/",
            "https://www.sarkariresult.com/author/old_sr2026/",
            "https://www.sarkariresult.com/page/2/",
            "https://www.sarkariresult.com/tools/image-resizer/",
            "https://www.sarkariresult.com/android/app/",
            "https://youtube.com/watch?v=1",
            "https://youtu.be/example",
            "https://t.me/example",
            "https://whatsapp.com/channel/example",
            "mailto:test@example.com",
            "tel:+911234567890",
        ):
            self.assertFalse(collector.is_article(url))

    def test_source_publication_metadata_is_not_inferred(self):
        metadata = collector.extract_source_temporal_metadata(
            "Title: Example\nPublished Time: 2026-08-16T01:02:03Z\nMarkdown Content:",
            "jina_api_markdown",
        )
        self.assertEqual(metadata["source_published_at"], "2026-08-16T01:02:03+00:00")
        self.assertEqual(metadata["source_date_status"], "jina_published_time")
        unavailable = collector.extract_source_temporal_metadata("No date here", "jina_api_markdown")
        self.assertEqual(unavailable["source_published_at"], "")
        self.assertEqual(unavailable["source_date_status"], "unavailable")

    def test_source_excerpt_is_source_derived_and_bounded(self):
        markdown = "Article heading\n" + ("Verified article detail. " * 1200)
        excerpt = collector.source_excerpt_from_content(markdown, "jina_api_markdown")
        self.assertTrue(excerpt.startswith("Article heading"))
        self.assertLessEqual(len(excerpt), collector.SOURCE_EXCERPT_LIMIT)
        self.assertNotIn("SarkariResult homepage", excerpt)

    def test_authenticated_jina_json_preserves_actual_published_time(self):
        content, error = collector.extract_jina_payload_content(
            '{"code":200,"data":{"publishedTime":"2026-08-16T01:02:03Z","content":"## Article body"}}',
            "application/json",
        )
        self.assertEqual(error, "")
        self.assertTrue(content.startswith("Published Time: 2026-08-16T01:02:03Z\n"))

    def test_same_article_can_keep_two_category_positions_with_one_fetch(self):
        url = "https://www.sarkariresult.com/2026/shared-post/"
        rows = [
            {"url": url, "title": "Shared", "label": "Latest Jobs", "category": "Latest Jobs", "category_position": 0},
            {"url": url, "title": "Shared", "label": "Result", "category": "Result", "category_position": 2},
        ]
        enriched = dict(rows[0])
        enriched.update({
            "source_fetch_status": "ok_jina_api_markdown_http_200",
            "source_fetched_at": "2026-08-16T00:00:00+00:00",
            "source_published_at": "2026-08-16T00:00:00+00:00",
            "source_updated_at": "",
            "source_date_status": "jina_published_time",
            "important_links": [{"label": "Official Website", "text": "Click Here", "url": "https://example.gov/"}],
            "important_links_count": 1,
        })
        with mock.patch.object(collector, "enrich_item_with_important_links", return_value=enriched) as fetch:
            result = collector.enrich_items_with_important_links(rows)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(len(result), 2)
        self.assertEqual([row["category"] for row in result], ["Latest Jobs", "Result"])
        self.assertEqual([row["category_position"] for row in result], [0, 2])

    def test_feed_generation_preserves_category_order_and_additive_schema(self):
        captured = {}

        class MemoryPath:
            def __init__(self, name):
                self.name = name

            def write_text(self, value, encoding):
                captured[self.name] = value

        def fake_fetch(url, require_important_links=True):
            label = next(label for label, category_url in collector.CATEGORIES if category_url == url)
            slug = re.sub(r"[^a-z]+", "-", label.lower()).strip("-")
            return {
                "content": f"## {label}\n[{label} Fixture](https://www.sarkariresult.com/2026/{slug}-fixture/)",
                "source_fetch_status": "ok_jina_api_markdown_http_200",
            }

        def fake_enrich(items):
            result = []
            for row in items:
                enriched = dict(row)
                enriched.update({
                    "source_fetch_status": "ok_jina_api_markdown_http_200",
                    "source_fetched_at": "2026-08-16T00:00:00+00:00",
                    "source_published_at": "2026-08-16T00:00:00+00:00",
                    "source_updated_at": "",
                    "source_date_status": "jina_published_time",
                    "source_representation": "jina_api_markdown",
                    "source_excerpt": "Verified fixture article content.",
                    "important_links": [],
                    "important_links_count": 0,
                })
                result.append(enriched)
            return result

        with mock.patch.object(collector, "fetch_source_page", side_effect=fake_fetch), \
                mock.patch.object(collector, "enrich_items_with_important_links", side_effect=fake_enrich), \
                mock.patch.object(collector, "Path", MemoryPath), \
                mock.patch.object(collector.time, "sleep", return_value=None):
            collector.main()

        payload = json.loads(captured["feed.json"])
        expected_categories = [label for label, _ in collector.CATEGORIES]
        self.assertEqual(payload["version"], "4.5")
        self.assertEqual([row["label"] for row in payload["category_snapshots"]], expected_categories)
        self.assertEqual([row["category"] for row in payload["items"]], expected_categories)
        self.assertTrue(all(row["category_position"] == 0 for row in payload["items"]))
        self.assertTrue(all(row["url"].startswith("https://www.sarkariresult.com/2026/") for row in payload["items"]))
        self.assertTrue(all(row["provenance"] == collector.CATEGORY_SNAPSHOT_PROVENANCE for row in payload["category_snapshots"]))
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", row["ordered_urls_sha256"]) for row in payload["category_snapshots"]))

    def test_previous_snapshot_loader_accepts_only_matching_authoritative_provenance(self):
        url = "https://www.sarkariresult.com/2026/fixture-post/"
        snapshot_hash = collector.ordered_url_sha256([url])
        payload = {
            "version": "4.5",
            "category_snapshots": [{
                "label": "Latest Jobs",
                "status": "fresh",
                "item_count": 1,
                "provenance": collector.CATEGORY_SNAPSHOT_PROVENANCE,
                "extractor_version": collector.CATEGORY_EXTRACTOR_VERSION,
                "ordered_urls_sha256": snapshot_hash,
                "ancestor_snapshot_sha256s": [],
            }],
            "items": [{
                "url": url,
                "label": "Latest Jobs",
                "category": "Latest Jobs",
                "position": 0,
                "category_position": 0,
                "category_snapshot_provenance": collector.CATEGORY_SNAPSHOT_PROVENANCE,
                "category_extractor_version": collector.CATEGORY_EXTRACTOR_VERSION,
                "category_snapshot_sha256": snapshot_hash,
            }],
        }

        class FixturePath:
            def __init__(self, value):
                self.value = value

            def read_text(self, encoding):
                return self.value

        accepted = collector.load_previous_category_snapshots(FixturePath(json.dumps(payload)))
        self.assertEqual(accepted["Latest Jobs"]["snapshot_hash"], snapshot_hash)
        payload["items"][0]["url"] = "https://www.sarkariresult.com/2026/arbitrary-insertion/"
        rejected = collector.load_previous_category_snapshots(FixturePath(json.dumps(payload)))
        self.assertEqual(rejected, {})

    def test_important_link_social_filter_does_not_block_official_links(self):
        self.assertIsNotNone(
            collector.important_link_rejection_reason(
                "Video", "Click Here", "https://youtu.be/example"
            )
        )
        self.assertEqual(
            collector.important_link_rejection_reason(
                "Download Notification", "Click Here", "https://example.gov/notice.pdf"
            ),
            "",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
