/**
 * Rojgar Vigyapan V4.6.2 — Master Template Auto Draft
 * Draft-only build. It never publishes a post automatically.
 *
 * Required Script Property:
 *   GEMINI_API_KEY
 *
 * Optional Script Properties:
 *   BLOG_URL          (default: https://rojgarvigyapan.blogspot.com/)
 *   GEMINI_MODEL      (optional; default: gemini-3.5-flash)
 *   Note: legacy gemini-2.5-flash property is auto-upgraded to gemini-3.5-flash.
 *   MAX_POSTS_PER_RUN (default: 2)
 *   UPDATE_CHECKS_PER_RUN (default: 8)
 *   TEST_SOURCE_URL   (optional exact SarkariResult URL for manual testing)
 *   DISCOVERY_FEED_URL (required for automatic discovery; public JSON feed URL)
 *
 * V4.5.4 discovery: Apps Script no longer scrapes SarkariResult/search engines.
 * A free GitHub Actions collector writes feed.json, and Apps Script reads that feed.
 * Individual article pages still use the existing Reader fallback.
 */

const RV = Object.freeze({
  BLOG_URL: 'https://rojgarvigyapan.blogspot.com/',
  MODEL: 'gemini-3.5-flash',
  MAX_POSTS_PER_RUN: 2,
  UPDATE_CHECKS_PER_RUN: 8,
  SEEN_KEY: 'RV_SEEN_SOURCE_URLS',
  SEEN_PREFIX: 'RV_SEEN_CHUNK_',
  DISCOVERY_STATE_PREFIX: 'RV_DISCOVERY_STATE_CHUNK_',
  DISCOVERY_STATE_VERSION: 1,
  REGISTRY_PREFIX: 'RV_REGISTRY_CHUNK_',
  UPDATE_CURSOR_KEY: 'RV_UPDATE_CURSOR',
  BLOG_ID_KEY: 'RV_BLOGGER_BLOG_ID',
  TEST_CURSOR_KEY: 'RV_TEST_FEED_CURSOR',
  TRIGGER_FUNCTION: 'checkNewSarkariResultPosts',
  REVIEW_PREFIX: 'UPDATE REVIEW – ',
  APPROVED_PREFIX: 'APPROVED UPDATE – ',
  APPLIED_PREFIX: 'APPLIED UPDATE – ',
  UPDATE_APPROVAL_ACTION: 'approveUpdate',
  UPDATE_APPROVAL_SECRET_KEY: 'RV_UPDATE_APPROVAL_SECRET_V1',
  UPDATE_APPROVAL_VERSION: '1',
  TELEGRAM: 'https://t.me/rojgarvigyapan',
  WHATSAPP: 'https://whatsapp.com/channel/0029VaAVxN7BA1et899BiK1f',
  TOOLS: 'https://rojgarvigyapan.blogspot.com/p/online-tools.html',
  SOURCES: [
    { url: 'https://www.sarkariresult.com/latestjob/', label: 'Latest Jobs', query: 'site:sarkariresult.com Sarkari Result latest job online form vacancy' },
    { url: 'https://www.sarkariresult.com/result/', label: 'Result', query: 'site:sarkariresult.com Sarkari Result result declared merit list score card' },
    { url: 'https://www.sarkariresult.com/admitcard/', label: 'Admit Card', query: 'site:sarkariresult.com Sarkari Result admit card exam date hall ticket' },
    { url: 'https://www.sarkariresult.com/answerkey/', label: 'Answer Key', query: 'site:sarkariresult.com Sarkari Result answer key objection' },
    { url: 'https://www.sarkariresult.com/syllabus/', label: 'Syllabus', query: 'site:sarkariresult.com Sarkari Result syllabus exam pattern' },
    { url: 'https://www.sarkariresult.com/admission/', label: 'Admission', query: 'site:sarkariresult.com Sarkari Result admission online form counselling' }
  ]
});

/** Run once after adding GEMINI_API_KEY in Script Properties. */
function setupAutomation() {
  const config = getConfig_();
  const blog = getBlogByUrl_(config.blogUrl);
  PropertiesService.getScriptProperties().setProperty(RV.BLOG_ID_KEY, String(blog.id));

  const current = discoverSourcePosts_();
  if (!current.length) {
    throw new Error('V4 discovery feed returned 0 Sarkari Result URLs. Existing baseline was NOT changed. Check DISCOVERY_FEED_URL or use TEST_SOURCE_URL for a manual test.');
  }
  saveSeen_(current.map(function (item) { return item.url; }));
  saveDiscoveryState_(createDiscoveryState_(current, []));

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === RV.TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(RV.TRIGGER_FUNCTION).timeBased().everyHours(1).create();
  Logger.log('Setup complete. %s existing source URLs saved as baseline.', current.length);
  Logger.log('New items will be generated as Blogger drafts only.');
}

/**
 * Creates one manual TEST draft only.
 * TEST drafts do NOT change the automation baseline or tracking registry.
 * If TEST_SOURCE_URL is set, that exact SarkariResult URL is tested.
 * Otherwise the first feed item is used.
 */
function testAutomationNow() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const exactTestUrl = canonicalSourceUrl_(props.getProperty('TEST_SOURCE_URL') || '');
  const feedItems = discoverSourcePosts_();
  const items = exactTestUrl && isSarkariResultArticle_(exactTestUrl)
    ? feedItems.filter(function (item) { return item.url === exactTestUrl; })
    : feedItems;
  if (!items.length) throw new Error('No Sarkari Result post link found in the V4 discovery feed. Check DISCOVERY_FEED_URL or set TEST_SOURCE_URL for manual testing.');

  const item = items[0];
  const result = processSourcePost_(item, config);
  Logger.log('TEST draft created (not added to automation tracking): %s', result.bloggerPost.url || result.bloggerPost.id);
  Logger.log('TEST source: %s', item.url);
}

/**
 * Tests a DIFFERENT feed post on each run without changing Code.gs.
 * Run this repeatedly to cycle through all currently discovered posts.
 * It does not mark anything as seen and does not add anything to the update registry.
 */
function testNextFeedPost() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const items = discoverSourcePosts_();
  if (!items.length) throw new Error('No Sarkari Result post link found in the V4 discovery feed.');

  let cursor = Number(props.getProperty(RV.TEST_CURSOR_KEY) || 0);
  if (!isFinite(cursor) || cursor < 0 || cursor >= items.length) cursor = 0;

  const item = items[cursor];
  const result = processSourcePost_(item, config);
  const nextCursor = (cursor + 1) % items.length;
  props.setProperty(RV.TEST_CURSOR_KEY, String(nextCursor));

  Logger.log('TEST %s/%s draft created (not tracked): %s', cursor + 1, items.length, result.bloggerPost.url || result.bloggerPost.id);
  Logger.log('TEST source: %s', item.url);
  Logger.log('Next test will use feed item %s/%s.', nextCursor + 1, items.length);
}

/** Starts the feed test cycle again from item 1. */
function resetTestFeedCursor() {
  PropertiesService.getScriptProperties().deleteProperty(RV.TEST_CURSOR_KEY);
  Logger.log('Test feed cursor reset. Next testNextFeedPost() run will use item 1.');
}

/**
 * Prints the HPHC Important Links supplied by feed.json only.
 * It does not call Gemini and never creates or updates a Blogger post.
 */
function debugImportantLinksForUrl() {
  testFeedImportantLinksForHphc();
}

function testFeedImportantLinksForHphc() {
  const url = 'https://www.sarkariresult.com/2026/hphc-various-post-august26/';
  const item = discoverSourcePosts_().filter(function (candidate) {
    return candidate.url === url;
  })[0];
  if (!item) {
    Logger.log('HPHC source is not present in the current feed: %s', url);
    return;
  }

  const rows = sourceLinkRows_(item.importantLinks || []);
  Logger.log('SOURCE FETCH STATUS: %s', item.sourceFetchStatus || 'missing');
  Logger.log('FEED IMPORTANT LINKS COUNT: %s', item.importantLinksCount);
  Logger.log('important_links: %s', JSON.stringify(rows.map(function (row) {
    return { label: row.label, text: row.actionText, url: row.url };
  }), null, 2));
  Logger.log('SOURCE IMPORTANT LINKS: %s', rows.length);
  rows.forEach(function (row, index) {
    Logger.log('%s.\nLabel: %s\nText: %s\nURL: %s', index + 1, row.label, row.actionText, row.url);
  });
}

/** Hourly trigger. */
function checkNewSarkariResultPosts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;

  try {
    const config = getConfig_();
    const discovered = discoverSourcePosts_();
    const seen = loadSeen_();
    const registry = loadRegistry_();
    let discoveryState = loadDiscoveryState_();

    if (!discovered.length) {
      Logger.log('Discovery feed returned 0 usable URLs. Existing baseline was preserved.');
      applyApprovedUpdates_(registry, config);
      checkTrackedSourceUpdates_(registry, config, discovered);
      saveRegistry_(registry);
      return;
    }

    // A missing discovery baseline means bootstrap, not "every URL is new".
    // This state is separate from the tracked-post registry so update checks
    // continue below regardless of the source post's original age.
    if (!isDiscoveryStateInitialized_(discoveryState)) {
      const baselineUrls = discovered.map(function (item) { return item.url; });
      saveSeen_(seen.concat(baselineUrls));
      saveDiscoveryState_(createDiscoveryState_(discovered, []));
      Logger.log('Discovery baseline initialized with %s current feed URLs. No new Blogger drafts were created.', baselineUrls.length);
      applyApprovedUpdates_(registry, config);
      checkTrackedSourceUpdates_(registry, config, discovered);
      saveRegistry_(registry);
      return;
    }

    const decision = classifyDiscoveryDelta_(discovered, seen, registry, discoveryState);
    const updatedSeen = unique_(seen.concat(decision.historicalUrls));
    saveSeen_(updatedSeen);
    discoveryState = createDiscoveryState_(discovered, decision.pendingUrls, discoveryState);
    saveDiscoveryState_(discoveryState);

    if (decision.historicalUrls.length) {
      Logger.log('Baselined %s unseen non-head feed URLs without creating drafts.', decision.historicalUrls.length);
    }

    const pending = decision.readyItems.slice(0, config.maxPostsPerRun);
    pending.forEach(function (item) {
      try {
        const created = processSourcePost_(item, config);
        registry[item.url] = createRegistryEntry_(item, created);
        saveRegistry_(registry);
        updatedSeen.push(item.url);
        saveSeen_(updatedSeen);
        discoveryState.pendingUrls = discoveryState.pendingUrls.filter(function (url) {
          return url !== item.url;
        });
        saveDiscoveryState_(discoveryState);
        Logger.log('Draft created: %s', created.bloggerPost.url || created.bloggerPost.id);
      } catch (error) {
        Logger.log('Skipped %s — %s', item.url, error.message);
      }
    });

    if (!pending.length) Logger.log('No new Sarkari Result post found.');
    applyApprovedUpdates_(registry, config);
    checkTrackedSourceUpdates_(registry, config, discovered);
    saveRegistry_(registry);
  } finally {
    lock.releaseLock();
  }
}

/** Removes the hourly trigger without deleting any drafts or settings. */
function stopAutomation() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === RV.TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  Logger.log('Automation stopped.');
}

/** Clears discovery state. The next automatic run safely baselines the current feed. */
function resetSeenPosts() {
  deleteJsonChunks_(RV.SEEN_PREFIX);
  deleteJsonChunks_(RV.DISCOVERY_STATE_PREFIX);
  PropertiesService.getScriptProperties().deleteProperty(RV.SEEN_KEY);
  Logger.log('Discovery baseline cleared. The next automatic run will baseline the current feed without creating drafts.');
}

/**
 * Run manually after renaming a review draft from UPDATE REVIEW – ...
 * to APPROVED UPDATE – ... . The hourly trigger also calls this automatically.
 */
function applyApprovedUpdatesNow() {
  const config = getConfig_();
  const registry = loadRegistry_();
  applyApprovedUpdates_(registry, config);
  saveRegistry_(registry);
}

function processSourcePost_(item, config) {
  const source = fetchSourceArticle_(item.url, item.importantLinks, item.sourceFetchStatus, item.importantLinksCount, item.title);
  const lifecycleLabel = detectCurrentLifecycleLabel_(source, item.label, item.title);
  const generated = generatePostWithGemini_(source, lifecycleLabel, config);
  generated.label = lifecycleLabel;
  generated.labels = mergeBloggerLabels_([], [lifecycleLabel]);
  generated.html = sanitizeGeneratedHtml_(generated.html, source.allowedUrls);
  generated.html = addDraftMetadata_(generated, item.url) + generated.html;
  validateGeneratedPost_(generated);
  return {
    bloggerPost: insertBloggerDraft_(generated, config),
    sourceHash: fingerprintSource_(source),
    generated: generated
  };
}


function normalizeGeminiModel_(value) {
  const model = String(value || '').trim();
  if (!model || model === 'gemini-2.5-flash') return 'gemini-3.5-flash';
  return model;
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = String(props.getProperty('GEMINI_API_KEY') || '').trim();
  if (!apiKey) throw new Error('Script Property GEMINI_API_KEY is missing.');

  return {
    apiKey: apiKey,
    blogUrl: normalizeBlogUrl_(props.getProperty('BLOG_URL') || RV.BLOG_URL),
    model: normalizeGeminiModel_(props.getProperty('GEMINI_MODEL') || RV.MODEL),
    maxPostsPerRun: clamp_(Number(props.getProperty('MAX_POSTS_PER_RUN') || RV.MAX_POSTS_PER_RUN), 1, 5),
    updateChecksPerRun: clamp_(Number(props.getProperty('UPDATE_CHECKS_PER_RUN') || RV.UPDATE_CHECKS_PER_RUN), 1, 20),
    discoveryFeedUrl: String(props.getProperty('DISCOVERY_FEED_URL') || '').trim()
  };
}

function discoverSourcePosts_() {
  const props = PropertiesService.getScriptProperties();
  const feedUrl = String(props.getProperty('DISCOVERY_FEED_URL') || '').trim();
  if (!feedUrl) {
    Logger.log('DISCOVERY_FEED_URL is not set. Use TEST_SOURCE_URL for manual testing or add the GitHub raw feed URL in Script Properties.');
    return [];
  }

  const response = UrlFetchApp.fetch(feedUrl, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'RojgarVigyapan-AutoDraft/4.0',
      'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache'
    }
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) throw new Error('Discovery feed HTTP ' + code + '.');

  let data;
  try { data = JSON.parse(body); }
  catch (error) { throw new Error('Discovery feed returned invalid JSON.'); }

  const rawItems = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  const results = [];
  const used = {};

  rawItems.forEach(function (item, index) {
    const url = canonicalSourceUrl_(item && item.url);
    if (!isSarkariResultArticle_(url) || used[url]) return;
    used[url] = true;
    const importantLinks = sourceLinkRows_((item && item.important_links) || []);
    const declaredImportantLinksCount = Number(item && item.important_links_count);
    results.push({
      url: url,
      title: cleanText_((item && item.title) || ''),
      label: normalizeFeedLabel_((item && item.label) || inferLabelFromUrlOrTitle_(url, (item && item.title) || '')),
      publishedMs: parseFeedDateMs_((item && (item.published_at || item.publishedAt || item.discovered_at || item.discoveredAt)) || '') || (1000000000 - index),
      importantLinks: importantLinks,
      importantLinksCount: isFinite(declaredImportantLinksCount) ? declaredImportantLinksCount : importantLinks.length,
      sourceFetchStatus: cleanText_((item && item.source_fetch_status) || '')
    });
  });

  Logger.log('V4 discovery feed: %s URLs received, %s accepted.', rawItems.length, results.length);
  // Feed order is authoritative for discovery-frontier comparison. The
  // collector already preserves its category/search result order; discovered_at
  // is a run timestamp, not proof of publication time.
  return results;
}

function normalizeFeedLabel_(label) {
  const value = String(label || '').trim().toLowerCase();
  if (value === 'latest jobs' || value === 'latest job' || value === 'job') return 'Latest Jobs';
  if (value === 'result' || value === 'results') return 'Result';
  if (value === 'admit card' || value === 'admitcard') return 'Admit Card';
  if (value === 'answer key' || value === 'answerkey') return 'Answer Key';
  if (value === 'syllabus') return 'Syllabus';
  if (value === 'admission') return 'Admission';
  return 'Latest Jobs';
}

function parseFeedDateMs_(value) {
  const ms = Date.parse(String(value || ''));
  return isFinite(ms) ? ms : 0;
}

function inferLabelFromUrlOrTitle_(url, title) {
  const text = (String(url || '') + ' ' + String(title || '')).toLowerCase();
  if (/answer[- ]?key|objection/.test(text)) return 'Answer Key';
  if (/admit[- ]?card|hall[- ]?ticket|exam[- ]?date/.test(text)) return 'Admit Card';
  if (/syllabus|exam[- ]?pattern/.test(text)) return 'Syllabus';
  if (/admission|counselling|counseling/.test(text)) return 'Admission';
  if (/result|merit|score[- ]?card/.test(text)) return 'Result';
  return 'Latest Jobs';
}

function detectCurrentLifecycleLabel_(source, fallbackLabel, feedTitle) {
  const titleSignals = [feedTitle, source && source.title, source && source.url];
  let latestJobsFallback = '';
  for (let i = 0; i < titleSignals.length; i++) {
    const titleLabel = lifecycleLabelFromText_(titleSignals[i]);
    if (titleLabel && titleLabel !== 'Latest Jobs') return titleLabel;
    if (titleLabel === 'Latest Jobs') latestJobsFallback = titleLabel;
  }

  const rows = sourceLinkRows_(source && source.links || []);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const rowLabel = lifecycleLabelFromText_([rows[rowIndex].label, rows[rowIndex].actionText].join(' '));
    if (rowLabel && rowLabel !== 'Latest Jobs') return rowLabel;
    if (rowLabel === 'Latest Jobs') latestJobsFallback = rowLabel;
  }

  const contentLabel = lifecycleLabelFromText_(String(source && source.text || '').slice(0, 3500));
  if (contentLabel) return contentLabel;
  return canonicalLifecycleLabel_(fallbackLabel) || latestJobsFallback || 'Latest Jobs';
}

function lifecycleLabelFromText_(value) {
  const text = cleanText_(value || '').toLowerCase().replace(/\bsarkari\s+result(?:\.com)?\b/g, ' ');
  if (!text) return '';
  if (/\banswer[\s_-]*key\b|\bresponse[\s_-]*sheet\b|\bobjection(?:s|[\s_-]*window)?\b/i.test(text)) return 'Answer Key';
  if (/\bfinal[\s_-]*result\b|\bresult\b|\bmerit[\s_-]*list\b|\bselection[\s_-]*list\b|\bscore[\s_-]*card\b/i.test(text)) return 'Result';
  if (/\badmit[\s_-]*card\b|\bhall[\s_-]*ticket\b|\bcall[\s_-]*letter\b|\bexam[\s_-]*city\b|\bcity[\s_-]*intimation\b|\bdv\s*[\/&-]\s*pst\b|\bdocument[\s_-]*verification\b|\bphysical[\s_-]*(?:standard|efficiency)[\s_-]*test\b/i.test(text)) return 'Admit Card';
  if (/\bentrance[\s_-]*admission\b|\badmission\b|\bcounselling\b|\bcounseling\b/i.test(text)) return 'Admission';
  if (/\bsyllabus\b|\bexam[\s_-]*pattern\b/i.test(text)) return 'Syllabus';
  if (/\bexam[\s_-]*calendar\b|\bexam[\s_-]*schedule\b/i.test(text)) return 'Exam Calendar';
  if (/\bnew[\s_-]*recruitment\b|\brecruitment\b|\bvacanc(?:y|ies)\b|\bapply[\s_-]*online\b|\bnotification\b/i.test(text)) return 'Latest Jobs';
  return '';
}

function canonicalLifecycleLabel_(value) {
  const label = cleanText_(value || '').toLowerCase();
  if (label === 'admit card' || label === 'admitcard') return 'Admit Card';
  if (label === 'result' || label === 'results') return 'Result';
  if (label === 'answer key' || label === 'answerkey') return 'Answer Key';
  if (label === 'admission') return 'Admission';
  if (label === 'syllabus') return 'Syllabus';
  if (label === 'exam calendar' || label === 'exam schedule') return 'Exam Calendar';
  if (label === 'latest jobs' || label === 'latest job' || label === 'job') return 'Latest Jobs';
  return '';
}

function mergeBloggerLabels_(existingLabels, addedLabels) {
  const merged = [];
  const seen = {};

  function append(values) {
    const list = Array.isArray(values) ? values : (values ? [values] : []);
    list.forEach(function (rawLabel) {
      const original = String(rawLabel || '');
      const comparison = cleanText_(original);
      if (!comparison) return;
      const key = comparison.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      merged.push(original);
    });
  }

  append(existingLabels);
  append(addedLabels);
  return merged;
}

function bloggerLabelsForPost_(post) {
  const labels = mergeBloggerLabels_(post && post.labels || [], [post && post.label || '']);
  return labels.length ? labels : ['Latest Jobs'];
}

function fetchSourceArticle_(url, feedImportantLinks, sourceFetchStatus, declaredImportantLinksCount, feedTitle) {
  // V4.6.2 LOCKED IMPORTANT-LINK RULE:
  // GitHub Actions/Python verifies source rows and writes them to feed.json.
  // Apps Script never re-extracts links from the live SarkariResult response.
  // Preserve the feed row-label + visible action text + exact href, including:
  // Apply Online | Link will be Activate on 10/08/2026 (clickable).
  const importantRows = sourceLinkRows_(feedImportantLinks || []);
  const allowedUrls = [url, RV.TELEGRAM, RV.WHATSAPP, RV.TOOLS];
  const verifiedRows = [];

  importantRows.forEach(function (row) {
    const safeUrl = String(row && row.url || '');
    const label = String(row && row.label || '');
    const actionText = String(row && row.actionText || '');
    const rejectionReason = importantLinkRejectionReason_({ label: label, actionText: actionText, url: safeUrl });
    if (rejectionReason) {
      Logger.log('Rejected feed Important Link — Label: %s | Text: %s | URL: %s | Reason: %s',
        label || 'EMPTY', actionText || 'EMPTY', safeUrl || 'EMPTY', rejectionReason);
      return;
    }
    if (allowedUrls.indexOf(safeUrl) === -1) allowedUrls.push(safeUrl);
    verifiedRows.push({ label: label, actionText: actionText, url: safeUrl });
  });

  Logger.log('Feed source fetch status: %s. Declared Important Links: %s. Verified feed rows: %s.',
    sourceFetchStatus || 'missing', Number(declaredImportantLinksCount || 0), verifiedRows.length);
  if (!verifiedRows.length) {
    throw new Error('feed.json supplied 0 verified post-specific Important Links. Draft generation stopped. Collector status: ' +
      (sourceFetchStatus || 'missing'));
  }

  const sourceDocument = fetchText_(url);
  let title = extractTitle_(sourceDocument.content) || cleanText_(feedTitle || '') || url;
  let text = sourceDocument.ok ? htmlToText_(sourceDocument.content).slice(0, 55000) : '';
  let representation = sourceDocument.representation;
  let bodyAvailable = sourceDocument.ok && text.length >= 200;

  // Collector-approved feed links must not depend on a second Apps Script fetch.
  // A metadata-only fallback is allowed only when the collector itself recorded
  // a successful source fetch and supplied verified post-specific link rows.
  if (!bodyAvailable) {
    if (!/^ok_/i.test(String(sourceFetchStatus || ''))) {
      throw new Error('Source article fetch was not usable. Direct status: ' + sourceDocument.directStatus +
        '; Reader/Jina status: ' + sourceDocument.readerStatus + '. Collector status: ' + (sourceFetchStatus || 'missing') + '.');
    }
    title = cleanText_(feedTitle || '') || url;
    text = [
      'Verified collector feed metadata for: ' + title,
      'Source URL: ' + url,
      'The article body could not be refetched by Apps Script. Do not infer or invent any missing article facts.',
      'Only the separately supplied verified Important Links rows may be used as read-only link context.'
    ].join('\n');
    representation = 'verified-feed-metadata-fallback';
    bodyAvailable = false;
  }

  Logger.log('Source representation used: %s. Direct status: %s. Reader/Jina status: %s. Article body available: %s.',
    representation, sourceDocument.directStatus, sourceDocument.readerStatus, bodyAvailable ? 'YES' : 'NO');
  Logger.log('Source Important Links: %s verified rows loaded from feed.json. %s', verifiedRows.length,
    verifiedRows.length ? formatSourceLinkRows_(verifiedRows).join(' | ') : 'NONE');

  return {
    url: url,
    title: cleanText_(title),
    text: text,
    links: uniqueSourceLinkRows_(verifiedRows),
    allowedUrls: unique_(allowedUrls),
    bodyAvailable: bodyAvailable
  };
}

function createImportantLinksDiagnostics_(url, sourceDocument) {
  return {
    url: url,
    representation: sourceDocument && sourceDocument.representation || 'none',
    directStatus: sourceDocument && sourceDocument.directStatus || 'not attempted',
    readerStatus: sourceDocument && sourceDocument.readerStatus || 'not attempted',
    sectionFound: false,
    sectionSnippet: '',
    anchorCount: 0,
    candidates: [],
    accepted: [],
    rejected: []
  };
}

function importantLinksDiagnosticSnippet_(content) {
  const raw = String(content || '');
  if (!raw) return 'NONE';
  const marker = /(?:Some\s+Useful\s+)?Important\s+Links/i.exec(raw);
  const from = marker ? Math.max(0, marker.index - 180) : 0;
  return cleanText_(raw.slice(from, from + 3000)).slice(0, 2600) || 'NONE';
}

function logImportantLinksDiagnostics_(diagnostics) {
  const d = diagnostics || {};
  Logger.log('IMPORTANT LINKS DIAGNOSTICS URL: %s', d.url || 'UNKNOWN');
  Logger.log('Source representation used: %s', d.representation || 'none');
  Logger.log('Direct HTML status: %s', d.directStatus || 'not attempted');
  Logger.log('Reader/Jina status: %s', d.readerStatus || 'not attempted');
  Logger.log('Candidate Important Links section found: %s', d.sectionFound ? 'YES' : 'NO');
  Logger.log('Candidate Important Links section snippet: %s', d.sectionSnippet || 'NONE');
  Logger.log('Anchors found in candidate section: %s', Number(d.anchorCount || 0));
  Logger.log('Candidates before filtering: %s', (d.candidates || []).length);
  (d.candidates || []).forEach(function (row, index) {
    Logger.log('Candidate %s — Label: %s | Text: %s | URL: %s', index + 1,
      row.label || 'EMPTY', row.actionText || 'EMPTY', row.url || 'EMPTY');
  });
  (d.rejected || []).forEach(function (row, index) {
    Logger.log('Rejected %s — Label: %s | Text: %s | URL: %s | Reason: %s', index + 1,
      row.label || 'EMPTY', row.actionText || 'EMPTY', row.url || 'EMPTY', row.reason || 'unspecified');
  });
  Logger.log('Verified source rows after filtering: %s', (d.accepted || []).length);
}

function importantLinkRejectionReason_(row) {
  const label = cleanText_(row && row.label || '');
  const actionText = cleanText_(row && row.actionText || '');
  const originalUrl = String(row && row.url || '');
  const url = originalUrl.trim();
  if (!label) return 'empty source row label';
  if (!actionText) return 'empty visible anchor text';
  if (url !== originalUrl) return 'href contains surrounding whitespace';
  if (!/^https?:\/\//i.test(url)) return 'href is missing or is not HTTP(S)';
  if (label.length > 160) return 'source row label is too long';
  if (actionText.length > 240) return 'visible anchor text is too long';
  if (isCollectorApprovedLinkNoise_(label, url)) return 'promotional or navigation source label/URL';
  if (isCollectorApprovedLinkNoise_(actionText, url)) return 'promotional or navigation anchor text/URL';
  return '';
}

function isCollectorApprovedLinkNoise_(label, url) {
  const value = cleanText_(label || '').toLowerCase();
  const href = String(url || '').trim().toLowerCase();

  // This intentionally excludes only known social/app/tools/navigation noise.
  // The GitHub collector is authoritative for post-specific row semantics.
  if (/^(?:home|homepage|about us|contact us|terms(?: and| &) conditions|privacy policy|disclaimer|join us|follow|whatsapp|telegram|instagram|youtube|threads|facebook|category)$/i.test(value)) return true;
  if (/(?:android apps?|apple ios apps?|ios apps?|sarkari result tools?|sarkari tools?|online tools?|sarkari result android|sarkari result apple)/i.test(value)) return true;
  if (/(?:image|signature)\s*resizer|pdf\s*compress|age\s*calculator|typing\s*test|more\s*tools/i.test(value)) return true;
  if (/join\s+sarkari\s+result\s+channel/i.test(value)) return true;
  if (/sarkari\s+result.*(?:telegram|whatsapp|channel|tools?|app)/i.test(value)) return true;
  if (/^sarkari result(?:Â®)?$/i.test(value)) return true;
  if (/(?:^|\.)t\.me\/|whatsapp\.com\/(?:channel|invite)|instagram\.com|facebook\.com|youtube\.com|threads\.net|play\.google\.com|apps\.apple\.com/i.test(href)) return true;
  if (/sarkariresult\.com\/(?:tools?|android|ios|app)(?:\/|$)/i.test(href)) return true;
  if (/^https?:\/\/(?:www\.)?sarkariresult\.com\/?(?:[?#].*)?$/i.test(href)) return true;
  if (/sarkariresult\.com\/(?:latestjob|result|admitcard|answerkey|syllabus|admission)\/?(?:[?#].*)?$/i.test(href)) return true;
  return false;
}

function isImportantLinksHeading_(value) {
  return /^(?:Some\s+Useful\s+)?Important\s+Links\s*:?\s*$/i.test(cleanText_(value || ''));
}

function extractImportantSourceRows_(content, baseUrl, diagnostics) {
  const raw = String(content || '');
  const section = isolateImportantLinksSection_(raw);
  const candidates = [];

  if (diagnostics) {
    diagnostics.sectionFound = Boolean(section);
    diagnostics.sectionSnippet = importantLinksDiagnosticSnippet_(section || raw);
    diagnostics.anchorCount = section ? extractAnchors_(section, baseUrl).length : 0;
  }
  if (!section) return [];

  function addRow(label, actionText, url) {
    const cleanLabel = cleanText_(label || '');
    const cleanAction = cleanText_(actionText || '');
    const cleanUrl = resolveUrl_(url, baseUrl) || String(url || '').trim();
    candidates.push({ label: cleanLabel, actionText: cleanAction, url: cleanUrl });
  }

  // 1) Native HTML table rows: first cell = row label, second cell = action link.
  const htmlScope = section;
  let tr;
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((tr = trRe.exec(htmlScope)) !== null) {
    const cells = [];
    let cell;
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    while ((cell = tdRe.exec(tr[1])) !== null) cells.push(cell[1]);
    if (cells.length < 2) continue;
    const label = htmlToText_(cells[0]);
    const anchors = extractAnchors_(cells.slice(1).join(' '), baseUrl);
    if (!anchors.length) continue;
    anchors.forEach(function (a) { addRow(label, a.text, a.url); });
  }

  // 2) Jina/Markdown TABLE rows. Jina commonly converts SarkariResult
  // Important Links tables to Markdown pipe rows, for example:
  // | Apply Online | [Link will be Activate on 10/08/2026](EXACT_URL) |
  // Preserve the left-cell label, the visible linked action text and exact href.
  const tableScope = section;
  tableScope.split(/\r?\n/).forEach(function (line) {
    const trimmed = String(line || '').trim();
    if (trimmed.indexOf('|') === -1) return;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return String(cell || '').trim(); });
    if (cells.length < 2) return;

    const labelText = cleanText_(cells[0]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, ' '));
    if (!labelText || isImportantLinksHeading_(labelText)) return;

    const actionCell = cells.slice(1).join(' | ');
    const actionAnchors = extractAnchors_(actionCell, baseUrl);
    if (!actionAnchors.length) return;
    actionAnchors.forEach(function (a) { addRow(labelText, a.text, a.url); });
  });

  // 3) Jina/Markdown heading structure. SarkariResult is commonly rendered as:
  // ## Apply Online
  // |
  // ## [Link will be Activate on 10/08/2026](EXACT_URL)
  // Pair each useful row heading with the next clickable heading/link.
  const mdScope = section;
  const lines = mdScope.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const hm = /^\s*#{1,6}\s+(.+?)\s*$/.exec(lines[i]);
    if (!hm) continue;
    const headingRaw = hm[1];
    const headingText = cleanText_(headingRaw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, ' '));
    if (!headingText || isImportantLinksHeading_(headingText)) continue;
    if (extractAnchors_(headingRaw, baseUrl).length) continue;
    if (isSourceFooterNoise_(headingText, '')) continue;

    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      const candidate = lines[j];
      // Stop if another unlinked heading starts before an action link.
      const nextH = /^\s*#{1,6}\s+(.+?)\s*$/.exec(candidate);
      if (nextH) {
        const nextText = cleanText_(nextH[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, ' '));
        const md = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(candidate);
        if (md) {
          addRow(headingText, md[1], md[2]);
          break;
        }
        if (nextText && !/^\|$/.test(nextText)) break;
      }
      const md = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(candidate);
      if (md) {
        addRow(headingText, md[1], md[2]);
        break;
      }
      // Some Reader variants expose an HTML anchor inline.
      const aa = extractAnchors_(candidate, baseUrl);
      if (aa.length) {
        addRow(headingText, aa[0].text, aa[0].url);
        break;
      }
    }
  }

  // 4) Reader-specific fallbacks. Support reference-style Markdown,
  // and flattened row/action pairs. These run before the
  // broad proximity fallback and still pass through the locked noise filters.
  if (candidates.length < 2) extractReaderReferenceImportantRows_(section, baseUrl, addRow);
  if (candidates.length < 2) extractReaderPairImportantRows_(section, baseUrl, addRow);

  // 5) Final proximity fallback stays inside the isolated source section.
  if (candidates.length < 2) extractProximityImportantRows_(section, baseUrl, addRow);

  const seen = {};
  const accepted = candidates.filter(function (row) {
    const rejectionReason = importantLinkRejectionReason_(row);
    if (diagnostics) {
      diagnostics.candidates.push({ label: row.label, actionText: row.actionText, url: row.url });
      if (rejectionReason) {
        diagnostics.rejected.push({ label: row.label, actionText: row.actionText, url: row.url, reason: rejectionReason });
      }
    }
    if (rejectionReason) return false;
    const key = row.label.toLowerCase() + '|' + row.url;
    if (seen[key]) {
      if (diagnostics) diagnostics.rejected.push({ label: row.label, actionText: row.actionText, url: row.url, reason: 'duplicate label and URL' });
      return false;
    }
    seen[key] = true;
    return true;
  });
  if (diagnostics) diagnostics.accepted = accepted.slice();
  return accepted;
}

function isolateImportantLinksSection_(raw) {
  const text = String(raw || '');
  if (!text) return '';

  // V4.6.2: Reader output can contain "Important Links" in the Table of
  // Contents before the real link table. Do NOT blindly use the first match.
  // Build multiple candidate windows and select the one that looks most like
  // the real link table structurally. Row names are intentionally not used as
  // a whitelist because genuine action labels vary between posts.
  const candidates = [];
  const patterns = [
    /(?:Some\s+Useful\s+)?Important\s+Links/ig,
    /(?:महत्वपूर्ण|उपयोगी)\s+लिंक(?:्स)?/ig
  ];

  patterns.forEach(function (re) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const from = Math.max(0, m.index - 250);
      let to = Math.min(text.length, m.index + 18000);
      const htmlTableEnd = text.indexOf('</table>', m.index);
      if (htmlTableEnd >= 0 && htmlTableEnd + 8 < to) to = htmlTableEnd + 8;
      const tail = text.slice(from, to);
      let stop = tail.length;
      const stopPatterns = [
        /\n\s*#{1,6}\s*(?:Frequently\s+Asked\s+Questions|FAQs?|Disclaimer|Related\s+Posts?|Latest\s+Posts?)\b/i,
        /\n\s*(?:Frequently\s+Asked\s+Questions|FAQs?|Disclaimer|अक्सर\s+पूछे\s+जाने\s+वाले\s+प्रश्न)\b/i
      ];
      stopPatterns.forEach(function (sr) {
        const sm = sr.exec(tail.slice(Math.max(1, m.index - from + m[0].length)));
        if (sm) {
          const abs = Math.max(1, m.index - from + m[0].length) + sm.index;
          if (abs < stop) stop = abs;
        }
      });
      const windowText = tail.slice(0, stop);
      const linkMatches = (windowText.match(/https?:\/\/[^\s<>()\]"']+|\[[^\]]+\]\([^)]+\)|<a\b/ig) || []).length;
      const htmlRowMatches = (windowText.match(/<tr\b[^>]*>[\s\S]*?<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>[\s\S]*?<a\b/ig) || []).length;
      const markdownRowMatches = windowText.split(/\r?\n/).filter(function (line) {
        return line.indexOf('|') !== -1 && /\[[^\]]+\]\([^)]+\)/.test(line);
      }).length;
      const headingPairMatches = (windowText.match(/#{1,6}\s+[^\r\n\[]+\s*(?:\r?\n\s*\|?\s*){1,5}#{0,6}\s*\[[^\]]+\]\([^)]+\)/g) || []).length;
      const prefix = text.slice(Math.max(0, m.index - 80), m.index);
      const headingBonus = /#{1,6}\s*$/.test(prefix) || /<t[dh]\b[^>]*>\s*$/i.test(prefix) ? 35 : 0;
      const exactBonus = /Some\s+Useful\s+Important\s+Links/i.test(m[0]) ? 20 : 0;
      candidates.push({
        text: windowText,
        score: headingBonus + exactBonus + htmlRowMatches * 15 + markdownRowMatches * 15 + headingPairMatches * 15 + linkMatches
      });
    }
  });

  if (!candidates.length) return '';
  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates[0].text;
}

function extractReaderReferenceImportantRows_(raw, baseUrl, addRow) {
  const text = String(raw || '');
  if (!text) return;

  // Reader/Jina can emit reference-style Markdown instead of inline links:
  // Apply Online | [Link will be Activate on 10/08/2026][12]
  // ...
  // [12]: https://official.example/apply
  const refs = {};
  text.split(/\r?\n/).forEach(function (line) {
    const m = /^\s*\[([^\]]+)\]:\s*(https?:\/\/\S+)/i.exec(line);
    if (m) refs[String(m[1]).trim()] = String(m[2]).replace(/[)>.,;]+$/, '');
  });

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const sourceLine = String(lines[i] || '');
    if (/\[[^\]]+\]\s*\[[^\]]+\]/.test(sourceLine)) continue;
    const label = cleanText_(sourceLine
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*[|>*+-]+\s*/, '')
      .replace(/[*_`~]/g, ' '));
    if (!label || label.length > 160 || isImportantLinksHeading_(label) || isSourceFooterNoise_(label, '')) continue;

    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const refLink = /\[([^\]]+)\]\s*\[([^\]]+)\]/.exec(lines[j]);
      if (refLink && refs[String(refLink[2]).trim()]) {
        addRow(label, refLink[1], refs[String(refLink[2]).trim()]);
        break;
      }
      const nextLabel = cleanText_(String(lines[j] || '').replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[|>*+-]+\s*/, '').replace(/[*_`~]/g, ' '));
      if (nextLabel && nextLabel !== '|' && !/^[-:| ]+$/.test(nextLabel)) break;
    }
  }
}

function extractReaderPairImportantRows_(raw, baseUrl, addRow) {
  const text = String(raw || '');
  if (!text) return;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const sourceLine = String(lines[i] || '');
    if (extractAnchors_(sourceLine, baseUrl).length) continue;
    const label = cleanText_(sourceLine
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*[|>*+-]+\s*/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, ' '));
    if (!label || label.length > 160 || isImportantLinksHeading_(label) || isSourceFooterNoise_(label, '')) continue;

    // Look only a short distance ahead. This catches flattened two-column
    // tables without drifting into the next Important Links row.
    for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
      const line = String(lines[j] || '');
      const candidateText = cleanText_(line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[|>*+-]+\s*/, '').replace(/[*_`~]/g, ' '));

      const anchors = extractAnchors_(line, baseUrl);
      if (anchors.length) {
        for (let k = 0; k < anchors.length; k++) {
          if (!isSourceFooterNoise_(anchors[k].text, anchors[k].url)) {
            addRow(label, anchors[k].text, anchors[k].url);
            break;
          }
        }
        break;
      }
      if (candidateText && candidateText !== '|' && !/^[-:| ]+$/.test(candidateText)) break;
    }
  }
}

function extractProximityImportantRows_(raw, baseUrl, addRow) {
  extractReaderPairImportantRows_(raw, baseUrl, addRow);
}

// Backward-compatible wrapper used nowhere else in V4.5.8, retained safely.
function extractImportantSourceLinks_(content, baseUrl) {
  return extractImportantSourceRows_(content, baseUrl).map(function (row) {
    return { url: row.url, text: row.actionText, label: row.label };
  });
}

function isFallbackOfficialActionLabel_(label) {
  const value = cleanText_(label || '');
  if (!value) return false;
  return /(apply\s*online|online\s*form|download\s*(?:notification|admit|result|answer|syllabus)|notification|advertisement|official\s*(?:website|notification|notice)|admit\s*card|result|answer\s*key|response\s*sheet|exam\s*date|exam\s*city|registration|candidate\s*login|join\s+indian\s+army\s+website|recruitment\s+portal|counsell?ing|allotment|merit\s*list|score\s*card|correction|link\s+will\s+be\s+(?:activate|activated|active)(?:\s+on)?)/i.test(value);
}

function isSourceFooterNoise_(label, url) {
  const value = cleanText_(label || '').toLowerCase();
  const href = String(url || '').toLowerCase();

  // LOCKED RULE: Sarkari Result promotional/navigation rows must NEVER be
  // copied into Rojgar Vigyapan Important Links. Only post-specific action /
  // official links are allowed from the source Important Links block.
  if (/^(home|homepage|about us|contact us|terms(?: and| &) conditions|privacy policy|disclaimer|join us|follow|whatsapp|telegram|instagram|youtube|threads|facebook|category|find more latest updates)$/i.test(value)) return true;
  if (/^(up scholarship|up-scholarship|bpsc|upsssc|ibps|upsc|air force|navy|rpsc|delhi dssb|delhi dsssb|hssc|police|railways?|latest jobs?)$/i.test(value)) return true;
  if (/(android apps?|apple ios apps?|ios apps?|sarkari result tools?|sarkari tools?|sarkari result android|sarkari result apple)/i.test(value)) return true;
  if (/(?:image|signature)\s*resizer|pdf\s*compress|age\s*calculator|typing\s*test|more\s*tools/i.test(value)) return true;
  if (/join\s+sarkari\s+result\s+channel/i.test(value)) return true;
  if (/sarkari\s+result.*(?:telegram|whatsapp|channel|tools?|app)/i.test(value)) return true;
  if (/^sarkari result(?:®)?$/i.test(value)) return true;

  // Source-owned social/app/channel destinations are promotional even when
  // their anchor text is generic (e.g. Telegram | WhatsApp / Click Here).
  if (/(?:^|\.)t\.me\/|whatsapp\.com\/(?:channel|invite)|instagram\.com|facebook\.com|youtube\.com|threads\.net|play\.google\.com|apps\.apple\.com/i.test(href)) return true;

  // Known generic SarkariResult tool/app pages are promotional.
  if (/sarkariresult\.com\/(?:tools?|android|ios|app)(?:\/|$)/i.test(href)) return true;
  if (/^https?:\/\/(?:www\.)?sarkariresult\.com\/?(?:[?#].*)?$/i.test(href)) return true;
  if (/sarkariresult\.com\/(?:latestjob|result|admitcard|answerkey|syllabus|admission)\/?(?:[?#].*)?$/i.test(href)) return true;

  return false;
}

function generatePostWithGemini_(source, requiredLabel, config, existingPost) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      heroSubtitle: { type: 'string' },
      label: { type: 'string', enum: [requiredLabel] },
      changeSummary: { type: 'string' },
      searchDescription: { type: 'string' },
      searchKeywords: { type: 'array', items: { type: 'string' } },
      introParagraphs: { type: 'array', items: { type: 'string' } },
      latestUpdate: { type: 'string' },
      importantAlert: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string' },
            kind: { type: 'string', enum: ['table', 'list', 'ordered_list', 'paragraphs', 'mixed'] },
            columns: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            items: { type: 'array', items: { type: 'string' } },
            paragraphs: { type: 'array', items: { type: 'string' } },
            noteType: { type: 'string', enum: ['none', 'note', 'success', 'alert', 'update'] },
            noteText: { type: 'string' },
            subSections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  heading: { type: 'string' },
                  paragraphs: { type: 'array', items: { type: 'string' } },
                  items: { type: 'array', items: { type: 'string' } }
                },
                required: ['heading', 'paragraphs', 'items']
              }
            }
          },
          required: ['heading', 'kind', 'columns', 'rows', 'items', 'paragraphs', 'noteType', 'noteText', 'subSections']
        }
      },
      faqs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { question: { type: 'string' }, answer: { type: 'string' } },
          required: ['question', 'answer']
        }
      },
      disclaimer: { type: 'string' }
    },
    required: ['title','heroSubtitle','label','changeSummary','searchDescription','searchKeywords','introParagraphs','latestUpdate','importantAlert','sections','faqs','disclaimer']
  };

  const systemPrompt = [
    'You are the CONTENT ENGINE for Rojgar Vigyapan. Apps Script controls all HTML/CSS and you must return JSON only.',
    'Match the CONTENT DEPTH of the supplied Rojgar Vigyapan master style: detailed, useful, source-grounded and not a short summary.',
    'Write original Hindi/Hinglish. Never copy source sentences verbatim and never invent facts.',
    'Do not invent dates, vacancies, fee, age, eligibility, selection stages, physical standards, documents, URLs or official claims.',
    'Use exactly the supplied Blogger label.',
    'heroSubtitle: a compact one-line post-specific summary such as post names / total posts / current stage, only from supported facts.',
    'introParagraphs: normally 4 substantial original paragraphs. Explain what the update is, who it affects, key numbers/dates, current stage and practical context.',
    'latestUpdate: one concise source-supported update. importantAlert: one concise caution/verification point. If not supported, return an empty string.',
    'sections: build a COMPLETE article. Use every useful source-supported topic, not only basic dates/fee/age.',
    'For recruitment posts consider Overview, Important Dates, Post Wise Vacancy, Eligibility, Fee, Age, Selection Process, How to Apply, Documents, useful explanations, troubleshooting, candidate checklist and Quick Summary whenever the source supports them.',
    'For Admit Card posts consider Overview, Important Dates, Post/Vacancy coverage, what the test/stage means, what to check on admit card, download steps, download problems, documents to carry, centre-day checklist, next stage and Quick Summary whenever supported.',
    'For Result/Answer Key/Admission/Syllabus adapt sections naturally to that post type. Do not force irrelevant sections.',
    'Return at least 8 meaningful H2 sections for a new post and normally 10 to 18 when the source supports it. If exact recruitment details are awaited, do NOT shrink the article to 2-4 sections: use source-grounded sections such as Overview, Current Status, What Is Announced, What Is Still Awaited, Official Website/Update Checking Steps, Application Guidance based only on confirmed facts, Candidate Checklist, and Quick Summary. Never invent missing dates/fees/vacancies.',
    'Use kind=table for structured facts, kind=list for bullets, ordered_list for step-by-step instructions, paragraphs for prose, mixed when a section needs paragraphs plus bullets/subsections.',
    'subSections are for H3-level groups such as Constable Posts / Head Constable Posts. Use only when useful.',
    'noteType/noteText may add one post-specific note, success, alert or update after a section. Do not add generic filler.',
    'IMPORTANT LINKS LOCKED RULE: do not return an importantLinks field. SOURCE LINKS are read-only factual context. Apps Script alone renders the verified label, visible action text and exact href, so do not reproduce, rename, add or remove link rows anywhere in sections.',
    'Do NOT include an Important Links section, Telegram, WhatsApp or Online Tools; the script adds the one locked section and fixed Rojgar Vigyapan rows.',
    'FAQs: generate 6 to 12 genuinely useful FAQs. Prefer 8 to 12 when the source is detailed. For limited/awaited-detail posts, questions may clarify current status, what is announced, what is not yet announced, where to verify, and how to follow the official update, without inventing facts.',
    'Disclaimer: concise but specific verification disclaimer based on this post type.',
    'Search description: natural, post-specific and about 140-155 characters. Title: SEO-friendly and concise.',
    'If a detail is absent, omit it instead of writing vague placeholders.'
  ].join('\n');

  const userPrompt = [
    'REQUIRED LABEL: ' + requiredLabel,
    'SOURCE URL: ' + source.url,
    'SOURCE TITLE: ' + source.title,
    'SOURCE ARTICLE BODY AVAILABLE: ' + (source.bodyAvailable === false ? 'NO' : 'YES'),
    '',
    'SOURCE TEXT:', source.text,
    '',
    'SOURCE LINKS (read-only row label || visible action text => exact URL):', formatSourceLinkRows_(source.links).join('\n'),
    '',
    existingPost ? 'THIS IS AN UPDATE. Preserve still-correct facts and explain meaningful changes in changeSummary.' : 'THIS IS A NEW POST. changeSummary should be “नई पोस्ट”.',
    existingPost ? ('EXISTING TITLE: ' + existingPost.title + '\nEXISTING CONTENT FOR CONTEXT:\n' + htmlToText_(String(existingPost.content || '')).slice(0, 30000)) : ''
  ].join('\n');

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      maxOutputTokens: 30000,
      temperature: 0.12
    }
  };

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(config.model) + ':generateContent?key=' + encodeURIComponent(config.apiKey);

  const response = fetchGeminiWithRetry_(endpoint, payload);
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) throw new Error('Gemini API error ' + code + ': ' + safeApiError_(body));

  const data = JSON.parse(body);
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const outputText = Array.isArray(parts) ? parts.map(function (part) { return part.text || ''; }).join('').trim() : '';
  if (!outputText) {
    const reason = data && data.candidates && data.candidates[0] && data.candidates[0].finishReason;
    throw new Error('Gemini returned no usable text output' + (reason ? ' (' + reason + ')' : '') + '.');
  }

  let generated = parseGeminiJson_(outputText);
  if (!generated) {
    Logger.log('Gemini JSON parse failed on first response; retrying generation once with stricter JSON settings.');
    const retryPayload = JSON.parse(JSON.stringify(payload));
    retryPayload.generationConfig.temperature = 0;
    const retryResponse = fetchGeminiWithRetry_(endpoint, retryPayload);
    const retryCode = retryResponse.getResponseCode();
    const retryBody = retryResponse.getContentText();
    if (retryCode < 200 || retryCode >= 300) throw new Error('Gemini retry API error ' + retryCode + ': ' + safeApiError_(retryBody));
    const retryData = JSON.parse(retryBody);
    const retryParts = retryData && retryData.candidates && retryData.candidates[0] && retryData.candidates[0].content && retryData.candidates[0].content.parts;
    const retryText = Array.isArray(retryParts) ? retryParts.map(function (part) { return part.text || ''; }).join('').trim() : '';
    generated = parseGeminiJson_(retryText);
    if (!generated) throw new Error('Gemini returned invalid JSON twice. First response starts: ' + outputText.slice(0, 220));
  }

  // Defense in depth for an unexpected/non-schema model response. The locked
  // renderer never accepts Gemini-authored Important Links.
  generated.importantLinks = [];

  const sectionCount = Array.isArray(generated.sections) ? generated.sections.filter(function (x) {
    const heading = cleanText_(x && x.heading || '');
    return heading && !isGeneratedImportantLinksHeading_(heading);
  }).length : 0;
  const faqCount = Array.isArray(generated.faqs) ? generated.faqs.filter(function (x) { return cleanText_(x && x.question || '') && cleanText_(x && x.answer || ''); }).length : 0;
  Logger.log('Generated content depth: %s sections, %s FAQs.', sectionCount, faqCount);
  if (sectionCount < 8) throw new Error('Generated article depth too low (' + sectionCount + ' sections). Re-run test; V4.6.2 requires at least 8 source-grounded sections.');
  if (faqCount < 6) throw new Error('Generated FAQ depth too low (' + faqCount + ' FAQs). Re-run test; V4.6.2 requires at least 6 source-grounded FAQs.');

  generated.html = buildLockedRojgarHtml_(generated, source);
  return generated;
}


function parseGeminiJson_(rawText) {
  let text = String(rawText || '').trim();
  if (!text) return null;
  text = text.replace(/^\uFEFF/, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);

  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'),
    text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const parsed = JSON.parse(attempts[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {}
  }
  return null;
}

function fetchGeminiWithRetry_(endpoint, payload) {
  const waits = [0, 2500, 6000, 12000];
  let lastResponse = null;
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt] > 0) Utilities.sleep(waits[attempt]);
    lastResponse = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = lastResponse.getResponseCode();
    if (code >= 200 && code < 300) return lastResponse;
    if ([429, 500, 502, 503, 504].indexOf(code) === -1) return lastResponse;
    Logger.log('Gemini temporary HTTP %s on attempt %s/%s; retrying.', code, attempt + 1, waits.length);
  }
  return lastResponse;
}

function buildLockedRojgarHtml_(post, source) {
  // V4.6.2: Important Links are fully source-driven and code-locked.
  // Gemini is NOT allowed to omit, rename or invent source rows.
  // Every verified post-specific source row is preserved in original order,
  // including its visible action text (e.g. "Link will be Activate on ...").
  const selectedLinks = sourceLinkRows_(source.links || []).filter(function (row) {
    return !importantLinkRejectionReason_(row);
  });
  const groupedLinks = groupConsecutiveSourceLinks_(selectedLinks);

  const css = '<style>' +
    '.rv-admit-card-post{color:#222222;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.7;max-width:920px;margin:0 auto}.rv-admit-card-post *{box-sizing:border-box}.rv-admit-card-post a{text-decoration:none}' +
    '.rv-admit-card-post .rv-head{background:linear-gradient(135deg,#ec008c,#171717);border-radius:14px;color:#fff;margin:0 0 20px;padding:23px 18px;text-align:center}.rv-admit-card-post .rv-head h1{color:#fff;font-size:28px;line-height:1.35;margin:6px 0 8px}.rv-admit-card-post .rv-head p{color:#fff;margin:0}' +
    '.rv-admit-card-post h2{background:#ec008c;border-radius:7px;color:#fff;font-size:20px;line-height:1.4;margin:24px 0 14px;padding:9px 13px}.rv-admit-card-post h3{color:#c60078;font-size:17px;line-height:1.5;margin:18px 0 6px}' +
    '.rv-admit-card-post .rv-update{background:#fff1fa;border-left:5px solid #ec008c;border-radius:8px;margin:17px 0;padding:13px 15px}.rv-admit-card-post .rv-note{background:#fff8dc;border-left:5px solid #dfa900;border-radius:8px;margin:17px 0;padding:13px 15px}.rv-admit-card-post .rv-success{background:#effff4;border-left:5px solid #1a9b50;border-radius:8px;margin:17px 0;padding:13px 15px}.rv-admit-card-post .rv-alert{background:#fff0f0;border-left:5px solid #d93025;border-radius:8px;margin:17px 0;padding:13px 15px}' +
    '.rv-admit-card-post .rv-table-wrap{overflow-x:auto;width:100%}.rv-admit-card-post table{border-collapse:collapse;margin:12px 0;min-width:640px;width:100%}.rv-admit-card-post th,.rv-admit-card-post td{border:1px solid #d5d5d5;padding:10px;text-align:left;vertical-align:middle}.rv-admit-card-post th{background:#fff1fa;font-weight:700}.rv-admit-card-post thead th{background:#ec008c;color:#fff;text-align:center}.rv-admit-card-post tbody tr:nth-child(even) td{background:#fafafa}.rv-admit-card-post ul,.rv-admit-card-post ol{padding-left:24px}.rv-admit-card-post li{margin:7px 0}' +
    '.rv-admit-card-post .rv-links-list{border:1px solid #d5d5d5;border-bottom:none;margin:12px 0 22px;width:100%}.rv-admit-card-post .rv-link-row{border-bottom:1px solid #d5d5d5;display:grid;grid-template-columns:minmax(0,1fr) minmax(190px,42%);width:100%}.rv-admit-card-post .rv-link-row:nth-child(even){background:#fafafa}.rv-admit-card-post .rv-link-label{align-items:center;background:#fff1fa;display:flex;font-weight:700;min-width:0;overflow-wrap:anywhere;padding:10px}.rv-admit-card-post .rv-link-action{align-items:center;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;min-width:0;padding:10px;text-align:center}' +
    '.rv-admit-card-post .rv-pink-btn{background:#ec008c!important;border:1px solid #ec008c!important;border-radius:7px;color:#fff!important;display:inline-block;font-size:14px;font-weight:700;line-height:1.4;min-width:135px;padding:8px 12px;text-align:center;text-decoration:none!important}.rv-admit-card-post .rv-pink-btn:hover{background:#c60078!important;border-color:#c60078!important;color:#fff!important}.rv-admit-card-post .rv-tools-btn{max-width:330px;min-width:200px;white-space:normal}.rv-admit-card-post .rv-disclaimer{background:#f4f4f4;border-radius:9px;font-size:14px;margin-top:22px;padding:14px 16px}.rv-admit-card-post .rv-footer{border-top:1px solid #ddd;margin-top:24px;padding-top:14px;text-align:center}' +
    '@media(max-width:640px){.rv-admit-card-post{font-size:15px}.rv-admit-card-post .rv-head h1{font-size:23px}.rv-admit-card-post h2{font-size:18px}.rv-admit-card-post th,.rv-admit-card-post td{font-size:14px;padding:8px}.rv-admit-card-post .rv-link-row{grid-template-columns:minmax(0,58%) minmax(120px,42%)}.rv-admit-card-post .rv-link-label,.rv-admit-card-post .rv-link-action{font-size:13px;padding:8px}.rv-admit-card-post .rv-pink-btn{font-size:12px;min-width:100px;padding:7px 8px}.rv-admit-card-post .rv-tools-btn{min-width:100px}}' +
    '</style>';

  let html = css + '<article class="rv-admit-card-post">';
  html += '<header class="rv-head"><div style="font-size:13px;font-weight:700;letter-spacing:1px;">ROJGAR VIGYAPAN</div><h1>' + escapeHtml_(cleanText_(post.title)) + '</h1>';
  if (cleanText_(post.heroSubtitle)) html += '<p>' + escapeHtml_(cleanText_(post.heroSubtitle)) + '</p>';
  html += '</header>';

  (post.introParagraphs || []).filter(function(p){return cleanText_(p);}).slice(0,4).forEach(function(para){ html += '<p>' + nl2brEscaped_(para) + '</p>'; });
  if (cleanText_(post.latestUpdate)) html += '<div class="rv-update"><strong>Latest Update:</strong> ' + nl2brEscaped_(post.latestUpdate) + '</div>';
  if (cleanText_(post.importantAlert)) html += '<div class="rv-alert"><strong>Important:</strong> ' + nl2brEscaped_(post.importantAlert) + '</div>';

  (post.sections || []).forEach(function(section){
    const heading=cleanText_(section && section.heading || ''); if(!heading) return;
    if (isGeneratedImportantLinksHeading_(heading)) return;
    html += '<h2>' + escapeHtml_(heading) + '</h2>';
    if ((section.kind === 'table' || section.kind === 'mixed') && Array.isArray(section.rows) && section.rows.length) {
      html += '<div class="rv-table-wrap"><table>';
      const cols=Array.isArray(section.columns)?section.columns:[];
      if(cols.length) html += '<thead><tr>' + cols.map(function(c){return '<th>'+escapeHtml_(cleanText_(c))+'</th>';}).join('') + '</tr></thead>';
      html += '<tbody>';
      section.rows.forEach(function(row){ if(!Array.isArray(row)) return; html += '<tr>' + row.map(function(cell,idx){ return (cols.length ? '<td>' : (idx===0?'<th>':'<td>')) + nl2brEscaped_(cell) + (cols.length?'</td>':(idx===0?'</th>':'</td>')); }).join('') + '</tr>'; });
      html += '</tbody></table></div>';
    }
    (section.paragraphs || []).forEach(function(para){ if(cleanText_(para)) html += '<p>'+nl2brEscaped_(para)+'</p>'; });
    if ((section.kind === 'list' || section.kind === 'mixed') && Array.isArray(section.items) && section.items.length) {
      html += '<ul>'; section.items.forEach(function(item){if(cleanText_(item)) html += '<li>'+nl2brEscaped_(item)+'</li>';}); html += '</ul>';
    }
    if (section.kind === 'ordered_list' && Array.isArray(section.items) && section.items.length) {
      html += '<ol>'; section.items.forEach(function(item){if(cleanText_(item)) html += '<li>'+nl2brEscaped_(item)+'</li>';}); html += '</ol>';
    }
    (section.subSections || []).forEach(function(sub){
      const sh=cleanText_(sub && sub.heading || ''); if(!sh || isGeneratedImportantLinksHeading_(sh)) return; html += '<h3>'+escapeHtml_(sh)+'</h3>';
      (sub.paragraphs||[]).forEach(function(para){if(cleanText_(para)) html += '<p>'+nl2brEscaped_(para)+'</p>';});
      if(Array.isArray(sub.items)&&sub.items.length){html += '<ul>';sub.items.forEach(function(item){if(cleanText_(item))html += '<li>'+nl2brEscaped_(item)+'</li>';});html += '</ul>';}
    });
    const nt=String(section.noteType||'none'); const nx=cleanText_(section.noteText||'');
    if(nx && /^(note|success|alert|update)$/.test(nt)) html += '<div class="rv-'+nt+'">'+nl2brEscaped_(nx)+'</div>';
  });

  html += '<!-- RV_IMPORTANT_LINKS_START --><h2>Important Links</h2><div class="rv-links-list">';
  groupedLinks.forEach(function(group){
    html += '<div class="rv-link-row"><div class="rv-link-label">'+escapeHtml_(sanitizeImportantLinkDisplayLabel_(group.label))+'</div><div class="rv-link-action">';
    group.links.forEach(function(link){
      html += '<a class="rv-pink-btn" href="'+escapeHtml_(link.url)+'" rel="nofollow noopener" target="_blank">'+escapeHtml_(link.actionText)+'</a>';
    });
    html += '</div></div>';
  });
  html += '<div class="rv-link-row"><div class="rv-link-label">Online Tools</div><div class="rv-link-action"><a class="rv-pink-btn rv-tools-btn" href="'+escapeHtml_(RV.TOOLS)+'" target="_blank">Online Tools</a></div></div>' +
    '<div class="rv-link-row"><div class="rv-link-label">Join Rojgar Vigyapan Telegram Channel</div><div class="rv-link-action"><a class="rv-pink-btn" href="'+escapeHtml_(RV.TELEGRAM)+'" rel="nofollow noopener" target="_blank">Join Telegram</a></div></div>' +
    '<div class="rv-link-row"><div class="rv-link-label">Join Rojgar Vigyapan WhatsApp Channel</div><div class="rv-link-action"><a class="rv-pink-btn" href="'+escapeHtml_(RV.WHATSAPP)+'" rel="nofollow noopener" target="_blank">Join WhatsApp</a></div></div></div><!-- RV_IMPORTANT_LINKS_END -->';

  const faqs=(post.faqs||[]).slice(0,12);
  if(faqs.length){ html += '<h2>Frequently Asked Questions</h2>'; faqs.forEach(function(faq){const q=cleanText_(faq&&faq.question||''),a=cleanText_(faq&&faq.answer||'');if(!q||!a)return;html += '<h3>'+escapeHtml_(q)+'</h3><p>'+nl2brEscaped_(a)+'</p>';}); }

  const disclaimer=cleanText_(post.disclaimer||'आवेदन या किसी भी कार्रवाई से पहले आधिकारिक सूचना/वेबसाइट पर सभी महत्वपूर्ण विवरण सत्यापित करें।');
  html += '<div class="rv-disclaimer"><strong>Disclaimer:</strong> '+escapeHtml_(disclaimer)+'</div>';
  html += '<div class="rv-footer"><strong>Rojgar Vigyapan</strong> — Government Jobs, Result, Admit Card, Admission और Exam Updates</div>';
  html += '</article>';
  assertLockedImportantLinksSection_(html);
  return html;
}

function groupConsecutiveSourceLinks_(linkRows) {
  const groups = [];
  (linkRows || []).forEach(function (row) {
    const previous = groups.length ? groups[groups.length - 1] : null;
    if (previous && previous.label === row.label) {
      previous.links.push(row);
      return;
    }
    groups.push({ label: row.label, links: [row] });
  });
  return groups;
}

function sanitizeImportantLinkDisplayLabel_(value) {
  return String(value || '')
    .replace(/^[ \t]*#+[ \t]*/, '')
    .replace(/[ \t]*#+[ \t]*$/, '');
}

function isGeneratedImportantLinksHeading_(value) {
  const heading = cleanText_(value || '').replace(/[\s:|]+$/g, '');
  if (!heading) return false;
  if (/^(?:some\s+useful\s+)?(?:official\s+)?important\s+links?(?:\s+(?:section|table|for\s+this\s+post))?$/i.test(heading)) return true;
  if (/^(?:useful|official|direct|source)\s+links?(?:\s+(?:section|table|for\s+this\s+post))?$/i.test(heading)) return true;
  if (/^important\s+links?\s*(?:&|and|\/|-)\s*(?:apply\s+online|online\s+application|official\s+website|downloads?|notification|registration|login|results?)$/i.test(heading)) return true;
  if (/^(?:apply\s+online|online\s+application|official\s+website|downloads?|notification|registration|login|results?)\s*(?:&|and|\/|-)\s*important\s+links?$/i.test(heading)) return true;
  return false;
}

function assertLockedImportantLinksSection_(html) {
  const value = String(html || '');
  const headingCount = (value.match(/<h2>Important Links<\/h2>/g) || []).length;
  const startCount = (value.match(/<!-- RV_IMPORTANT_LINKS_START -->/g) || []).length;
  const endCount = (value.match(/<!-- RV_IMPORTANT_LINKS_END -->/g) || []).length;
  const start = value.indexOf('<!-- RV_IMPORTANT_LINKS_START -->');
  const end = value.indexOf('<!-- RV_IMPORTANT_LINKS_END -->');
  const faq = value.indexOf('<h2>Frequently Asked Questions</h2>');
  const disclaimer = value.indexOf('<div class="rv-disclaimer">');
  const footer = value.indexOf('<div class="rv-footer">');
  if (headingCount !== 1 || startCount !== 1 || endCount !== 1 || start < 0 || end <= start) {
    throw new Error('Locked Important Links renderer must produce exactly one complete section.');
  }
  if (faq < end || disclaimer < end || footer < end || !(faq < disclaimer && disclaimer < footer)) {
    throw new Error('Locked post order is invalid: Important Links must close before FAQ, disclaimer and footer.');
  }
}

function isGenericActionLabel_(label) {
  const value = cleanText_(label || '');
  return /^(click here|open|view|download|link|go|visit)$/i.test(value);
}

function isSarkariResultPromotionalLabel_(label) {
  const value = cleanText_(label || '');
  if (!value) return true;

  // Remove ONLY Sarkari Result's generic/promotional rows. Do not reject a
  // recruitment-specific link merely because it points to sarkariresult.com.
  if (/^sarkari result(?:®)?$/i.test(value)) return true;
  if (/^sarkari result android app$/i.test(value)) return true;
  if (/^sarkari result apple ios app$/i.test(value)) return true;
  if (/^sarkari result ios app$/i.test(value)) return true;
  if (/^sarkari result tools?$/i.test(value)) return true;

  return false;
}

function isUsefulImportantLinkLabel_(label) {
  const value = cleanText_(label || '');
  if (!value || value.length > 160) return false;
  if (isSarkariResultPromotionalLabel_(value)) return false;
  return !isSourceFooterNoise_(value, '');
}

function sourceLinkRows_(linkLines) {
  const rows = [];
  const seen = {};
  (linkLines || []).forEach(function (line) {
    let label = '';
    let actionText = '';
    let url = '';

    if (line && typeof line === 'object' && !Array.isArray(line)) {
      label = String(line.label || '');
      actionText = String(line.actionText !== undefined ? line.actionText : (line.text || ''));
      url = String(line.url || '');
    } else {
      // Backward compatibility for registry/source objects created before V4.6.2.
      const value = String(line || '');
      const idx = value.lastIndexOf(' => ');
      if (idx <= 0) return;
      const left = value.slice(0, idx);
      url = value.slice(idx + 4).trim();
      const sep = left.indexOf(' || ');
      label = String(sep >= 0 ? left.slice(0, sep) : left);
      actionText = String(sep >= 0 ? left.slice(sep + 4) : 'Click Here');
    }

    const normalizedLabel = cleanText_(label);
    const normalizedActionText = cleanText_(actionText);
    const normalizedUrl = String(url).trim();
    if (url !== normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) return;
    if (!normalizedLabel || !normalizedActionText) return;
    const key = normalizedLabel.toLowerCase() + '|' + normalizedActionText.toLowerCase() + '|' + url;
    if (seen[key]) return;
    seen[key] = true;
    rows.push({ label: label, actionText: actionText, url: url });
  });
  return rows;
}

function formatSourceLinkRows_(linkRows) {
  return sourceLinkRows_(linkRows).map(function (row) {
    return row.label + ' || ' + row.actionText + ' => ' + row.url;
  });
}

function uniqueSourceLinkRows_(linkRows) {
  return sourceLinkRows_(linkRows);
}

function sourceLinkMap_(linkLines) {
  const map = {};
  sourceLinkRows_(linkLines).forEach(function (row) {
    if (!map[row.url]) map[row.url] = row.label;
  });
  return map;
}

function nl2brEscaped_(value) {
  return escapeHtml_(cleanText_(value)).replace(/\n/g, '<br>');
}

function insertBloggerDraft_(post, config) {
  const blogId = getBlogId_(config.blogUrl);
  const endpoint = 'https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(blogId) + '/posts?isDraft=true';
  const resource = {
    kind: 'blogger#post',
    blog: { id: String(blogId) },
    title: post.title,
    content: post.html,
    labels: bloggerLabelsForPost_(post)
  };

  const response = googleFetch_(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(resource)
  });
  return JSON.parse(response.getContentText());
}

function checkTrackedSourceUpdates_(registry, config, discoveredItems) {
  const urls = Object.keys(registry);
  if (!urls.length) return;

  const currentFeedItems = {};
  (discoveredItems || []).forEach(function (item) {
    if (item && item.url) currentFeedItems[item.url] = item;
  });

  const props = PropertiesService.getScriptProperties();
  let cursor = Number(props.getProperty(RV.UPDATE_CURSOR_KEY) || 0);
  if (!isFinite(cursor) || cursor < 0 || cursor >= urls.length) cursor = 0;
  const count = Math.min(config.updateChecksPerRun, urls.length);

  for (let offset = 0; offset < count; offset++) {
    const index = (cursor + offset) % urls.length;
    const sourceUrl = urls[index];
    const entry = registry[sourceUrl];

    try {
      const currentFeedItem = currentFeedItems[sourceUrl];
      if (currentFeedItem) {
        entry.importantLinks = sourceLinkRows_(currentFeedItem.importantLinks || []);
        entry.importantLinksCount = currentFeedItem.importantLinksCount;
        entry.sourceFetchStatus = currentFeedItem.sourceFetchStatus;
        entry.sourceTitle = currentFeedItem.title || entry.sourceTitle || '';
      }
      const source = fetchSourceArticle_(
        sourceUrl,
        entry.importantLinks || [],
        entry.sourceFetchStatus || '',
        entry.importantLinksCount || 0,
        entry.sourceTitle || ''
      );
      const currentHash = fingerprintSource_(source);
      entry.lastCheckedAt = new Date().toISOString();
      if (currentHash === entry.sourceHash) continue;
      if (currentHash === entry.candidateHash) {
        ensurePendingReviewApprovalAction_(entry, config);
        continue;
      }

      const original = getBloggerPost_(entry.bloggerPostId, config);
      const updateLabel = detectCurrentLifecycleLabel_(source, entry.label, entry.sourceTitle || '');
      const preservedLabels = mergeBloggerLabels_(
        original.labels || [],
        entry.labels || [entry.label]
      );
      const pendingLabels = mergeBloggerLabels_(preservedLabels, entry.pendingLabels || []);
      const mergedLabels = mergeBloggerLabels_(pendingLabels, [updateLabel]);
      const generated = generatePostWithGemini_(source, updateLabel, config, original);
      generated.label = updateLabel;
      generated.labels = mergedLabels;
      generated.html = sanitizeGeneratedHtml_(generated.html, source.allowedUrls);
      generated.html = addDraftMetadata_(generated, sourceUrl) + generated.html;
      validateGeneratedPost_(generated);

      const reviewPost = upsertReviewDraft_(entry, generated, currentHash, config);
      entry.reviewDraftId = String(reviewPost.id);
      entry.candidateHash = currentHash;
      entry.pendingLabels = mergedLabels;
      entry.lastChangeDetectedAt = new Date().toISOString();
      Logger.log('Update review draft ready: %s', reviewPost.url || reviewPost.id);
    } catch (error) {
      Logger.log('Update check failed for %s — %s', sourceUrl, error.message);
    }
  }

  props.setProperty(RV.UPDATE_CURSOR_KEY, String((cursor + count) % urls.length));
}

function upsertReviewDraft_(entry, generated, candidateHash, config) {
  const reviewTitle = RV.REVIEW_PREFIX + generated.title;
  if (entry.reviewDraftId) {
    try {
      const existingReview = getBloggerPost_(entry.reviewDraftId, config);
      if (String(existingReview.status || '').toLowerCase() === 'draft' &&
          String(existingReview.title || '').indexOf(RV.APPROVED_PREFIX) !== 0 &&
          String(existingReview.title || '').indexOf(RV.APPLIED_PREFIX) !== 0) {
        return writePendingReviewWithApproval_(
          entry,
          generated,
          candidateHash,
          String(existingReview.id),
          config
        );
      }
    } catch (error) {
      Logger.log('Previous review draft unavailable; creating a new one.');
    }
  }

  const provisional = insertBloggerDraft_({
    title: reviewTitle,
    html: buildReviewNotice_(entry, generated, candidateHash, '', '') + generated.html,
    label: generated.label,
    labels: generated.labels
  }, config);
  entry.reviewDraftId = String(provisional.id);

  try {
    return writePendingReviewWithApproval_(
      entry,
      generated,
      candidateHash,
      entry.reviewDraftId,
      config
    );
  } catch (error) {
    // Keep the draft reference, but do not mark this source hash pending until
    // the review has a usable signed approval action. A later run can retry.
    entry.candidateHash = '';
    throw error;
  }
}

function writePendingReviewWithApproval_(entry, generated, candidateHash, reviewDraftId, config) {
  const approvalUrl = buildUpdateApprovalUrl_(entry, reviewDraftId, candidateHash);
  return updateBloggerPost_(reviewDraftId, {
    kind: 'blogger#post',
    blog: { id: String(getBlogId_(config.blogUrl)) },
    title: RV.REVIEW_PREFIX + generated.title,
    content: buildReviewNotice_(entry, generated, candidateHash, reviewDraftId, approvalUrl) + generated.html,
    labels: bloggerLabelsForPost_(generated)
  }, config);
}

function ensurePendingReviewApprovalAction_(entry, config) {
  if (!entry || !entry.reviewDraftId || !entry.candidateHash) return;
  const review = getBloggerPost_(entry.reviewDraftId, config);
  if (String(review.status || '').toLowerCase() !== 'draft') return;
  if (String(review.title || '').indexOf(RV.APPLIED_PREFIX) === 0) return;

  const metadata = extractReviewMetadata_(review.content || '');
  if (metadata && metadata.approvalAction === RV.UPDATE_APPROVAL_ACTION &&
      String(metadata.reviewDraftId || '') === String(entry.reviewDraftId)) {
    return;
  }

  const targetError = reviewTargetRejectionReason_(review, entry, entry.sourceUrl);
  if (targetError) {
    Logger.log('Pending review approval action rejected for safety: %s (%s)', review.id, targetError);
    return;
  }

  const approvalUrl = buildUpdateApprovalUrl_(entry, entry.reviewDraftId, entry.candidateHash);
  const updatedContent = injectApprovalActionIntoReviewNotice_(review.content || '', approvalUrl, entry.reviewDraftId);
  updateBloggerPost_(entry.reviewDraftId, {
    kind: 'blogger#post',
    blog: { id: String(getBlogId_(config.blogUrl)) },
    title: review.title,
    content: updatedContent,
    labels: review.labels || []
  }, config);
}

function applyApprovedUpdates_(registry, config) {
  Object.keys(registry).forEach(function (sourceUrl) {
    const entry = registry[sourceUrl];
    if (!entry.reviewDraftId || !entry.candidateHash) return;

    try {
      const review = getBloggerPost_(entry.reviewDraftId, config);
      const title = String(review.title || '');
      if (title.indexOf(RV.APPROVED_PREFIX) !== 0) return;
      if (String(review.status || '').toLowerCase() !== 'draft') {
        Logger.log('Approved review must remain a draft: %s', review.id);
        return;
      }

      const targetError = reviewTargetRejectionReason_(review, entry, sourceUrl);
      if (targetError) {
        Logger.log('Approved review rejected for safety: %s (%s)', review.id, targetError);
        return;
      }
      applyPendingReviewUpdate_(registry, sourceUrl, entry, review, config);
    } catch (error) {
      Logger.log('Approved update failed for %s — %s', sourceUrl, error.message);
    }
  });
}

function applyPendingReviewUpdate_(registry, sourceUrl, entry, review, config) {
  const cleanTitle = proposedReviewTitle_(review.title || '');
  const cleanContent = stripReviewNotice_(review.content || '');
  const candidateHash = String(entry.candidateHash || '');
  const reviewDraftId = String(entry.reviewDraftId || '');
  let appliedLabels;
  let updatedOriginal = null;

  if (!candidateHash || !reviewDraftId) {
    throw approvalRequestError_('security', 'Review is no longer pending.');
  }

  if (entry.appliedCandidateHash === candidateHash) {
    // The original update already succeeded. Retry only review finalization.
    appliedLabels = mergeBloggerLabels_(entry.labels || [entry.label], review.labels || []);
  } else {
    const original = getBloggerPost_(entry.bloggerPostId, config);
    if (!original || String(original.id || '') !== String(entry.bloggerPostId || '')) {
      throw approvalRequestError_('security', 'Original Blogger Post ID verification failed.');
    }
    const existingLabels = mergeBloggerLabels_(original.labels || [], entry.labels || [entry.label]);
    const pendingLabels = mergeBloggerLabels_(existingLabels, entry.pendingLabels || []);
    appliedLabels = mergeBloggerLabels_(pendingLabels, review.labels || []);

    try {
      updatedOriginal = updateBloggerPost_(entry.bloggerPostId, {
        kind: 'blogger#post',
        blog: { id: String(getBlogId_(config.blogUrl)) },
        title: cleanTitle,
        content: cleanContent,
        labels: appliedLabels
      }, config);
    } catch (error) {
      throw approvalRequestError_('original-update', 'The original Blogger post could not be updated.');
    }

    // This checkpoint makes review finalization independently retryable and
    // guarantees that a later click does not PUT the original post twice.
    entry.appliedCandidateHash = candidateHash;
    entry.sourceHash = candidateHash;
    entry.labels = appliedLabels;
    entry.pendingLabels = [];
    entry.lastAppliedAt = new Date().toISOString();
    saveRegistry_(registry);
  }

  try {
    updateBloggerPost_(reviewDraftId, {
      kind: 'blogger#post',
      blog: { id: String(getBlogId_(config.blogUrl)) },
      title: RV.APPLIED_PREFIX + cleanTitle,
      content: markReviewNoticeApplied_(review.content, entry.bloggerPostId),
      labels: mergeBloggerLabels_(review.labels || [], appliedLabels)
    }, config);
  } catch (error) {
    throw approvalRequestError_('finalization', 'The original post was updated, but the review could not be finalized.');
  }

  entry.sourceHash = candidateHash;
  entry.lastAppliedReviewDraftId = reviewDraftId;
  entry.lastAppliedCandidateHash = candidateHash;
  entry.candidateHash = '';
  entry.reviewDraftId = '';
  entry.appliedCandidateHash = '';
  entry.labels = appliedLabels;
  entry.pendingLabels = [];
  entry.lastAppliedAt = new Date().toISOString();
  saveRegistry_(registry);
  Logger.log('Original Blogger post updated: %s', updatedOriginal ? (updatedOriginal.url || updatedOriginal.id) : entry.bloggerPostId);
  return { status: 'applied', bloggerPostId: String(entry.bloggerPostId) };
}

function handleRojgarUpdateApprovalRequest_(e) {
  try {
    const result = approveRojgarUpdateRequest_(e && e.parameter || {});
    if (result.status === 'already-applied') {
      return buildUpdateApprovalResponse_(true, 'This update was already applied to the original post. No duplicate update was made.');
    }
    return buildUpdateApprovalResponse_(true, 'Update applied successfully to the original post.');
  } catch (error) {
    Logger.log('One-click update approval failed: %s', error.message);
    if (error && error.rvApprovalKind === 'finalization') {
      return buildUpdateApprovalResponse_(false, 'The original post was updated, but the review still needs finalization. Click the same approval button again; the original post will not be updated twice.');
    }
    if (error && error.rvApprovalKind === 'original-update') {
      return buildUpdateApprovalResponse_(false, 'The original post could not be updated. The review is still pending and this approval can be retried safely.');
    }
    return buildUpdateApprovalResponse_(false, 'This approval link is invalid, altered, expired, or no longer pending. No Blogger post was changed.');
  }
}

function approveRojgarUpdateRequest_(params) {
  const reviewDraftId = String(params && params.review || '').trim();
  const token = String(params && params.token || '').trim().toLowerCase();
  if (!/^\d+$/.test(reviewDraftId) || !/^[a-f0-9]{64}$/.test(token)) {
    throw approvalRequestError_('security', 'Malformed approval request.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw approvalRequestError_('busy', 'Another automation operation is running.');
  }

  try {
    const registry = loadRegistry_();
    const match = findRegistryReviewEntry_(registry, reviewDraftId);
    if (!match) throw approvalRequestError_('security', 'Review draft is not registered.');

    const entry = match.entry;
    if (match.alreadyApplied) {
      const priorHash = String(entry.lastAppliedCandidateHash || '');
      if (!priorHash || !isValidUpdateApprovalToken_(token, entry, reviewDraftId, priorHash)) {
        throw approvalRequestError_('security', 'Approval token does not match the applied review.');
      }
      return { status: 'already-applied', bloggerPostId: String(entry.bloggerPostId || '') };
    }

    if (!entry.candidateHash || String(entry.reviewDraftId || '') !== reviewDraftId) {
      throw approvalRequestError_('security', 'Review is not pending.');
    }
    if (!isValidUpdateApprovalToken_(token, entry, reviewDraftId, entry.candidateHash)) {
      throw approvalRequestError_('security', 'Approval token is invalid.');
    }

    const config = getApprovalBloggerConfig_();
    const review = getBloggerPost_(reviewDraftId, config);
    if (String(review.status || '').toLowerCase() !== 'draft') {
      throw approvalRequestError_('security', 'Review must remain a draft.');
    }
    if (String(review.title || '').indexOf(RV.APPLIED_PREFIX) === 0) {
      throw approvalRequestError_('security', 'Review is already applied.');
    }

    const targetError = approvalReviewRejectionReason_(review, entry, match.sourceUrl);
    if (targetError) throw approvalRequestError_('security', targetError);
    return applyPendingReviewUpdate_(registry, match.sourceUrl, entry, review, config);
  } finally {
    lock.releaseLock();
  }
}

function findRegistryReviewEntry_(registry, reviewDraftId) {
  const urls = Object.keys(registry || {});
  for (let index = 0; index < urls.length; index++) {
    const entry = registry[urls[index]] || {};
    if (String(entry.reviewDraftId || '') === reviewDraftId) {
      return { sourceUrl: urls[index], entry: entry, alreadyApplied: false };
    }
    if (String(entry.lastAppliedReviewDraftId || '') === reviewDraftId) {
      return { sourceUrl: urls[index], entry: entry, alreadyApplied: true };
    }
  }
  return null;
}

function getApprovalBloggerConfig_() {
  const blogUrl = PropertiesService.getScriptProperties().getProperty('BLOG_URL') || RV.BLOG_URL;
  return { blogUrl: normalizeBlogUrl_(blogUrl) };
}

function approvalRequestError_(kind, message) {
  const error = new Error(message);
  error.rvApprovalKind = kind;
  return error;
}

function proposedReviewTitle_(title) {
  const value = String(title || '');
  if (value.indexOf(RV.APPROVED_PREFIX) === 0) return value.slice(RV.APPROVED_PREFIX.length).trim();
  if (value.indexOf(RV.REVIEW_PREFIX) === 0) return value.slice(RV.REVIEW_PREFIX.length).trim();
  throw approvalRequestError_('security', 'Review title marker is invalid.');
}

function getBloggerPost_(postId, config) {
  const blogId = getBlogId_(config.blogUrl);
  const endpoint = 'https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(blogId) +
    '/posts/' + encodeURIComponent(postId) + '?view=ADMIN';
  return JSON.parse(googleFetch_(endpoint, { method: 'get' }).getContentText());
}

function updateBloggerPost_(postId, resource, config) {
  const blogId = getBlogId_(config.blogUrl);
  const endpoint = 'https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(blogId) +
    '/posts/' + encodeURIComponent(postId);
  const response = googleFetch_(endpoint, {
    method: 'put',
    contentType: 'application/json',
    payload: JSON.stringify(resource)
  });
  return JSON.parse(response.getContentText());
}

function buildUpdateApprovalUrl_(entry, reviewDraftId, candidateHash) {
  const serviceUrl = String(ScriptApp.getService().getUrl() || '').trim();
  if (!/^https:\/\//i.test(serviceUrl)) {
    throw new Error('Apps Script web app is not deployed; approval button URL cannot be created.');
  }
  const token = buildUpdateApprovalToken_(entry, reviewDraftId, candidateHash);
  return serviceUrl + (serviceUrl.indexOf('?') === -1 ? '?' : '&') +
    'action=' + encodeURIComponent(RV.UPDATE_APPROVAL_ACTION) +
    '&review=' + encodeURIComponent(String(reviewDraftId || '')) +
    '&token=' + encodeURIComponent(token);
}

function buildUpdateApprovalToken_(entry, reviewDraftId, candidateHash) {
  const secret = getOrCreateUpdateApprovalSecret_();
  const payload = updateApprovalTokenPayload_(entry, reviewDraftId, candidateHash);
  const signature = Utilities.computeHmacSha256Signature(
    payload,
    secret,
    Utilities.Charset.UTF_8
  );
  return bytesToHex_(signature);
}

function isValidUpdateApprovalToken_(token, entry, reviewDraftId, candidateHash) {
  const expected = buildUpdateApprovalToken_(entry, reviewDraftId, candidateHash);
  return constantTimeTextEqual_(String(token || '').toLowerCase(), expected);
}

function updateApprovalTokenPayload_(entry, reviewDraftId, candidateHash) {
  return [
    RV.UPDATE_APPROVAL_VERSION,
    String(reviewDraftId || ''),
    String(entry && entry.bloggerPostId || ''),
    canonicalSourceUrl_(entry && entry.sourceUrl || ''),
    String(candidateHash || '')
  ].join('\n');
}

function getOrCreateUpdateApprovalSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = String(props.getProperty(RV.UPDATE_APPROVAL_SECRET_KEY) || '').trim();
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty(RV.UPDATE_APPROVAL_SECRET_KEY, secret);
  }
  return secret;
}

function bytesToHex_(bytes) {
  return (bytes || []).map(function (byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function constantTimeTextEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

function buildApprovalActionMarkup_(approvalUrl, reviewDraftId) {
  if (!approvalUrl || !reviewDraftId) {
    return '<p style="margin:0" data-rv-approval-button-wrapper="1"><b>Approval:</b> Secure approval link is being prepared. Keep this review as a draft.</p>';
  }
  return '<p style="margin:14px 0 0" data-rv-approval-button-wrapper="1">' +
    '<a href="' + escapeHtml_(approvalUrl) + '" target="_blank" rel="noopener noreferrer" ' +
    'style="display:inline-block;background:#e60099;color:#fff;text-decoration:none;font-weight:800;padding:12px 20px;border-radius:8px">Approve Update</a>' +
    '</p>' +
    '<span style="display:none" data-rv-approval-action="' + escapeHtml_(RV.UPDATE_APPROVAL_ACTION) +
    '" data-rv-review-draft-id="' + escapeHtml_(reviewDraftId) + '"></span>';
}

function injectApprovalActionIntoReviewNotice_(html, approvalUrl, reviewDraftId) {
  const value = String(html || '');
  const action = buildApprovalActionMarkup_(approvalUrl, reviewDraftId);
  if (!/<!-- RV_UPDATE_REVIEW_START -->[\s\S]*?<!-- RV_UPDATE_REVIEW_END -->/i.test(value)) {
    throw approvalRequestError_('security', 'Review notice is missing.');
  }
  if (/<p\b[^>]*data-rv-approval-button-wrapper="1"[^>]*>[\s\S]*?<\/p>/i.test(value)) {
    return value
      .replace(/<p\b[^>]*data-rv-approval-button-wrapper="1"[^>]*>[\s\S]*?<\/p>(?:\s*<span\b[^>]*data-rv-approval-action=[\s\S]*?<\/span>)?/i, action);
  }
  if (/<p style="margin:0"><b>Approve with one action:<\/b>[\s\S]*?<\/p>/i.test(value)) {
    return value.replace(/<p style="margin:0"><b>Approve with one action:<\/b>[\s\S]*?<\/p>/i, action);
  }
  return value.replace(/<\/div>\s*<!-- RV_UPDATE_REVIEW_END -->/i, action + '</div><!-- RV_UPDATE_REVIEW_END -->');
}

function buildUpdateApprovalResponse_(success, message) {
  const color = success ? '#168c4d' : '#b42318';
  const title = success ? 'Update approval complete' : 'Update approval not completed';
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title></head><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif">' +
    '<main style="max-width:620px;margin:60px auto;background:#fff;border:1px solid #e2e4ec;border-radius:14px;padding:24px">' +
    '<h2 style="margin:0 0 12px;color:' + color + '">' + escapeHtml_(title) + '</h2>' +
    '<p style="margin:0;line-height:1.6">' + escapeHtml_(message) + '</p>' +
    '</main></body></html>'
  ).setTitle(title);
}

function buildReviewNotice_(entry, generated, candidateHash, reviewDraftId, approvalUrl) {
  const existingLabels = mergeBloggerLabels_(entry.labels || [], [entry.label]);
  const existingMap = {};
  existingLabels.forEach(function (label) { existingMap[cleanText_(label).toLowerCase()] = true; });
  const addedLabels = [generated.label].filter(function (label) {
    return !existingMap[cleanText_(label).toLowerCase()];
  });
  const labelsText = addedLabels.length ? addedLabels.join(', ') : 'No new label';
  return '<!-- RV_UPDATE_REVIEW_START -->' +
    '<div style="border:2px solid #e60099;background:#fff4fb;padding:16px;margin:0 0 20px;border-radius:12px;font-family:Arial,sans-serif">' +
    '<h3 style="margin:0 0 8px;color:#e60099">Update Review Required</h3>' +
    '<p style="margin:0 0 8px"><b>Original Blogger Post ID:</b> ' + escapeHtml_(entry.bloggerPostId || '') + '</p>' +
    '<p style="margin:0 0 8px"><b>Update type:</b> ' + escapeHtml_(generated.label || '') + '</p>' +
    '<p style="margin:0 0 8px"><b>Labels to add:</b> ' + escapeHtml_(labelsText) + '</p>' +
    '<p style="margin:0 0 8px"><b>Proposed title:</b> ' + escapeHtml_(generated.title || '') + '</p>' +
    '<p style="margin:0 0 8px"><b>Detected changes:</b> ' + escapeHtml_(generated.changeSummary || 'Source page updated') + '</p>' +
    '<p style="margin:0 0 8px"><b>Source:</b> <a href="' + escapeHtml_(entry.sourceUrl) + '">' + escapeHtml_(entry.sourceUrl) + '</a></p>' +
    '<p style="margin:0 0 8px"><b>Proposed content:</b> The complete updated article appears below this notice.</p>' +
    '<p style="margin:0 0 8px"><b>Approval status:</b> Pending approval</p>' +
    buildApprovalActionMarkup_(approvalUrl, reviewDraftId) +
    '<span style="display:none" data-rv-candidate-hash="' + escapeHtml_(candidateHash) +
    '" data-rv-original-post-id="' + escapeHtml_(entry.bloggerPostId || '') +
    '" data-rv-source-url="' + escapeHtml_(entry.sourceUrl || '') + '"></span>' +
    '</div>' +
    '<!-- RV_UPDATE_REVIEW_END -->';
}

function extractReviewMetadata_(html) {
  const value = String(html || '');
  const notice = value.match(/<!-- RV_UPDATE_REVIEW_START -->([\s\S]*?)<!-- RV_UPDATE_REVIEW_END -->/i);
  if (!notice) return null;

  function attribute(name) {
    const match = notice[1].match(new RegExp("\\b" + name + "\\s*=\\s*([\"'])((?:.|\\n|\\r)*?)\\1", 'i'));
    return match ? decodeEntities_(match[2]) : '';
  }

  const legacySource = value.match(/<!--\s*RV_SOURCE_URL:\s*([\s\S]*?)\s*-->/i);
  return {
    candidateHash: attribute('data-rv-candidate-hash'),
    originalPostId: attribute('data-rv-original-post-id'),
    sourceUrl: attribute('data-rv-source-url') || (legacySource ? cleanText_(legacySource[1]) : ''),
    approvalAction: attribute('data-rv-approval-action'),
    reviewDraftId: attribute('data-rv-review-draft-id')
  };
}

function reviewTargetRejectionReason_(review, entry, sourceUrl) {
  if (String(review && review.id || '') !== String(entry && entry.reviewDraftId || '')) {
    return 'review draft ID does not match registry';
  }
  const metadata = extractReviewMetadata_(review && review.content || '');
  if (!metadata) return 'review metadata block is missing';
  if (!metadata.candidateHash || metadata.candidateHash !== String(entry.candidateHash || '')) {
    return 'candidate hash does not match registry';
  }
  if (!metadata.originalPostId || metadata.originalPostId !== String(entry.bloggerPostId || '')) {
    return 'original Blogger Post ID does not match registry';
  }
  if (canonicalSourceUrl_(metadata.sourceUrl) !== canonicalSourceUrl_(sourceUrl)) {
    return 'source URL does not match registry';
  }
  return '';
}

function approvalReviewRejectionReason_(review, entry, sourceUrl) {
  const targetError = reviewTargetRejectionReason_(review, entry, sourceUrl);
  if (targetError) return targetError;
  const metadata = extractReviewMetadata_(review && review.content || '');
  if (!metadata || metadata.approvalAction !== RV.UPDATE_APPROVAL_ACTION) {
    return 'review approval action marker is missing';
  }
  if (String(metadata.reviewDraftId || '') !== String(entry.reviewDraftId || '')) {
    return 'approval review draft ID does not match registry';
  }
  return '';
}

function markReviewNoticeApplied_(html, bloggerPostId) {
  return String(html || '')
    .replace('<b>Approval status:</b> Pending approval',
      '<b>Approval status:</b> Applied to original Blogger Post ID ' + escapeHtml_(bloggerPostId || ''))
    .replace(/<p\b[^>]*data-rv-approval-button-wrapper="1"[^>]*>[\s\S]*?<\/p>/i,
      '<p style="margin:0"><b>Applied:</b> The approved content was automatically sent to the original Blogger post. This review draft was not published.</p>')
    .replace(/<p style="margin:0"><b>Approve with one action:<\/b>[\s\S]*?<\/p>/i,
      '<p style="margin:0"><b>Applied:</b> The approved content was automatically sent to the original Blogger post. This review draft was not published.</p>');
}

function stripReviewNotice_(html) {
  return String(html || '').replace(/<!-- RV_UPDATE_REVIEW_START -->[\s\S]*?<!-- RV_UPDATE_REVIEW_END -->/i, '').trim();
}

function createRegistryEntry_(item, result) {
  const generatedLabel = result.generated && result.generated.label || item.label;
  const generatedLabels = mergeBloggerLabels_(result.generated && result.generated.labels || [], [generatedLabel]);
  return {
    sourceUrl: item.url,
    bloggerPostId: String(result.bloggerPost.id),
    label: generatedLabel,
    labels: generatedLabels,
    sourceTitle: item.title || '',
    importantLinks: sourceLinkRows_(item.importantLinks || []),
    importantLinksCount: Number(item.importantLinksCount || 0),
    sourceFetchStatus: item.sourceFetchStatus || '',
    sourceHash: result.sourceHash,
    reviewDraftId: '',
    candidateHash: '',
    appliedCandidateHash: '',
    lastAppliedReviewDraftId: '',
    lastAppliedCandidateHash: '',
    createdAt: new Date().toISOString(),
    lastCheckedAt: ''
  };
}

function fingerprintSource_(source) {
  const material = cleanText_([
    source.title,
    source.text,
    formatSourceLinkRows_(source.links).join('\n')
  ].join('\n')).toLowerCase();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, material, Utilities.Charset.UTF_8);
  return digest.map(function (byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function getBlogId_(blogUrl) {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty(RV.BLOG_ID_KEY);
  if (saved) return saved;
  const blog = getBlogByUrl_(blogUrl);
  props.setProperty(RV.BLOG_ID_KEY, String(blog.id));
  return String(blog.id);
}

function getBlogByUrl_(blogUrl) {
  const url = 'https://www.googleapis.com/blogger/v3/blogs/byurl?url=' + encodeURIComponent(blogUrl);
  return JSON.parse(googleFetch_(url, { method: 'get' }).getContentText());
}

function googleFetch_(url, options) {
  const request = options || {};
  request.headers = request.headers || {};
  request.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  request.muteHttpExceptions = true;
  const response = UrlFetchApp.fetch(url, request);
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Blogger API error ' + code + ': ' + safeApiError_(response.getContentText()));
  }
  return response;
}

function fetchText_(url) {
  const requestOptions = {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8'
    }
  };

  let directStatus = 'not attempted';
  let directBody = '';

  // First try the source directly. SarkariResult currently returns HTTP 403 to
  // Apps Script/Google egress IPs, so this normally falls through to Reader.
  try {
    const direct = UrlFetchApp.fetch(url, requestOptions);
    const directCode = direct.getResponseCode();
    directBody = direct.getContentText();
    directStatus = 'HTTP ' + directCode;
    if (directCode >= 200 && directCode < 300 && directBody && directBody.length >= 100 && !isBlockedSourceRepresentation_(directBody)) {
      return {
        ok: true,
        content: directBody,
        representation: 'direct-html',
        directStatus: directStatus,
        readerStatus: 'not attempted'
      };
    }
    if (directCode >= 200 && directCode < 300) directStatus += ' with blocked/error body';
    Logger.log('Direct fetch blocked for %s — HTTP %s; trying Reader fallback.', url, directCode);
  } catch (directError) {
    directStatus = 'exception: ' + String(directError && directError.message || directError).slice(0, 220);
    Logger.log('Direct fetch failed for %s — %s; trying Reader fallback.', url, directError.message);
  }

  // Jina Reader fetches the public URL server-side and returns clean Markdown.
  // No API key is required for basic usage.
  const readerUrl = 'https://r.jina.ai/' + url;
  let reader;
  try {
    reader = UrlFetchApp.fetch(readerUrl, {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'RojgarVigyapanBot/1.0'
      }
    });
  } catch (readerError) {
    return {
      ok: false,
      content: directBody,
      representation: directBody ? 'direct-error' : 'none',
      directStatus: directStatus,
      readerStatus: 'exception: ' + String(readerError && readerError.message || readerError).slice(0, 220)
    };
  }

  const readerCode = reader.getResponseCode();
  const body = reader.getContentText();
  const targetError = extractReaderTargetError_(body);
  let readerStatus = 'HTTP ' + readerCode;
  if (targetError) readerStatus += ' wrapper; target ' + targetError;

  if (readerCode < 200 || readerCode >= 300 || !body || body.length < 100 || isBlockedSourceRepresentation_(body)) {
    return {
      ok: false,
      content: body || directBody,
      representation: body ? 'jina-reader-error' : (directBody ? 'direct-error' : 'none'),
      directStatus: directStatus,
      readerStatus: !body || body.length < 100 ? readerStatus + ' with empty/short body' : readerStatus
    };
  }

  return {
    ok: true,
    content: body,
    representation: 'jina-reader-markdown',
    directStatus: directStatus,
    readerStatus: readerStatus
  };
}

function extractReaderTargetError_(body) {
  const match = String(body || '').match(/^Warning:\s*Target URL returned error\s+(\d{3})(?::\s*([^\r\n]+))?/mi);
  return match ? ('HTTP ' + match[1] + (match[2] ? ': ' + cleanText_(match[2]) : '')) : '';
}

function isBlockedSourceRepresentation_(body) {
  const value = String(body || '');
  if (extractReaderTargetError_(value)) return true;
  if (/Title:\s*The request could not be satisfied/i.test(value) && /Generated by cloudfront/i.test(value)) return true;
  if (/\b(?:403|429)\s+ERROR\b/i.test(value) && /(?:request blocked|access denied|cloudfront)/i.test(value)) return true;
  return false;
}

function extractAnchors_(html, baseUrl) {
  const links = [];
  const seen = {};
  let match;

  // Normal HTML anchors.
  const htmlRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = htmlRegex.exec(html)) !== null) {
    const resolved = resolveUrl_(match[1], baseUrl);
    if (!resolved) continue;
    const exactUrl = resolved;
    const key = exactUrl + '|' + htmlToText_(match[2]);
    if (seen[key]) continue;
    seen[key] = true;
    links.push({ url: exactUrl, text: htmlToText_(match[2]) });
  }

  // Jina Reader may return absolute OR relative Markdown links.
  const markdownRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  while ((match = markdownRegex.exec(String(html || ''))) !== null) {
    const resolved = resolveUrl_(match[2], baseUrl);
    if (!resolved) continue;
    const exactUrl = resolved.replace(/[)>.,;]+$/, '');
    const text = cleanText_(match[1].replace(/[*_`~]/g, ' '));
    const key = exactUrl + '|' + text;
    if (seen[key]) continue;
    seen[key] = true;
    links.push({ url: exactUrl, text: text });
  }

  // Some Reader responses expose URLs as plain text rather than Markdown links.
  // Capture those too so discovery does not depend on Reader's formatting.
  const rawUrlRegex = /https?:\/\/(?:www\.)?sarkariresult\.com\/[^\s<>()\]\["']+/gi;
  while ((match = rawUrlRegex.exec(String(html || ''))) !== null) {
    const exactUrl = match[0].replace(/[)>.,;:'"]+$/, '');
    const key = exactUrl + '|';
    if (seen[key]) continue;
    seen[key] = true;
    links.push({ url: exactUrl, text: '' });
  }

  return links;
}

function extractTitle_(html) {
  const og = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (og) return decodeEntities_(og[1]);

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return htmlToText_(title[1]);

  // Jina Reader commonly starts with "Title: ..." and may also expose an H1.
  const readerTitle = String(html || '').match(/^Title:\s*(.+)$/mi);
  if (readerTitle) return cleanText_(readerTitle[1]);
  const heading = String(html || '').match(/^#\s+(.+)$/m);
  return heading ? cleanText_(heading[1]) : '';
}

function htmlToText_(html) {
  let value = String(html || '');

  // Remove Reader metadata lines while retaining the article body and link URLs.
  value = value
    .replace(/^URL Source:\s*.+$/gmi, ' ')
    .replace(/^Published Time:\s*.+$/gmi, ' ')
    .replace(/^Markdown Content:\s*$/gmi, ' ');

  // HTML cleanup.
  value = value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  // Light Markdown cleanup. Keep link destinations visible to the model.
  value = value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 => $2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>*+-]\s+/gm, '')
    .replace(/[*_`~]{1,3}/g, ' ');

  return cleanText_(value);
}

function decodeEntities_(value) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&([a-z]+);/gi, function (all, name) { return map[name.toLowerCase()] || all; });
}

function cleanText_(value) {
  return decodeEntities_(value).replace(/[\t\r ]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function resolveUrl_(href, baseUrl) {
  href = decodeEntities_(String(href || '')).trim();
  if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) return '';
  if (/^https?:\/\//i.test(href)) return href;
  const origin = String(baseUrl).match(/^(https?:\/\/[^/]+)/i);
  if (!origin) return '';
  if (href.indexOf('//') === 0) return 'https:' + href;
  if (href.charAt(0) === '/') return origin[1] + href;
  const folder = String(baseUrl).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return folder + href;
}

function isSarkariResultArticle_(url) {
  const value = canonicalSourceUrl_(url);
  if (!/^https:\/\/(?:www\.)?sarkariresult\.com\//i.test(value)) return false;

  // Ignore category/navigation/system/static URLs.
  if (/\/(latestjob|result|admitcard|answerkey|syllabus|admission|contact|privacy|disclaimer|about|search|feed|wp-|category|tag)(?:\/|$)/i.test(value)) return false;
  if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|xml|txt|pdf|zip|rar)(?:\/)?$/i.test(value)) return false;

  // Real Sarkari Result article URLs have at least two path segments, e.g.
  // /2026/uppsc-a3-e1-2026-august/ or /railway/rrb-isolated-cen-08-2025/.
  const path = value.replace(/^https:\/\/(?:www\.)?sarkariresult\.com/i, '').replace(/^\/+|\/+$/g, '');
  const parts = path.split('/').filter(Boolean);
  return parts.length >= 2;
}

function canonicalSourceUrl_(url) {
  let value = decodeEntities_(String(url || '')).trim();
  value = value.replace(/^http:\/\//i, 'https://');
  value = value.replace(/^https:\/\/sarkariresult\.com/i, 'https://www.sarkariresult.com');
  // Category pages/Reader sometimes append query strings or fragments. They are
  // not part of the canonical article URL and made the old strict parser reject links.
  value = value.replace(/[?#].*$/, '');
  value = value.replace(/\/+$/, '');
  return value ? value + '/' : '';
}

function stripTracking_(url) {
  return String(url || '').replace(/([?&])(utm_[^=]+|fbclid|gclid)=[^&#]*/gi, '$1').replace(/[?&]$/, '');
}

function sanitizeGeneratedHtml_(html, allowedUrls) {
  let output = String(html || '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const allowedExact = {};
  const allowedNormalized = {};
  allowedUrls.forEach(function (url) {
    const exact = String(url || '').trim();
    if (!exact) return;
    allowedExact[exact] = exact;
    const normalized = stripTracking_(exact);
    if (!allowedNormalized[normalized]) allowedNormalized[normalized] = exact;
  });
  output = output.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, function (all, quote, url) {
    const exact = decodeEntities_(url);
    const selected = allowedExact[exact] || allowedNormalized[stripTracking_(exact)];
    return selected ? 'href=' + quote + escapeHtml_(selected) + quote : 'href=' + quote + '#' + quote + ' data-rv-unverified-link="true"';
  });
  return output;
}

function addDraftMetadata_(post, sourceUrl) {
  const description = String(post.searchDescription || '').replace(/-->/g, '');
  const keywords = (post.searchKeywords || []).join(', ').replace(/-->/g, '');
  return '<!-- RV_SEARCH_DESCRIPTION: ' + description + ' -->\n' +
    '<!-- RV_SEARCH_KEYWORDS: ' + keywords + ' -->\n' +
    '<!-- RV_SOURCE_URL: ' + sourceUrl + ' -->\n';
}

function validateGeneratedPost_(post) {
  if (!post.title || post.title.length < 15) throw new Error('Generated title is invalid.');
  if (!post.label) throw new Error('Generated label is missing.');
  if (!post.html || post.html.length < 800) throw new Error('Generated HTML is too short.');
  if (!post.searchDescription) throw new Error('Search description is missing.');
  assertLockedImportantLinksSection_(post.html);
}

function extractOpenAIOutputText_(data) {
  if (data.output_text) return data.output_text;
  const output = data.output || [];
  for (let i = 0; i < output.length; i++) {
    const content = output[i].content || [];
    for (let j = 0; j < content.length; j++) {
      if (content[j].type === 'output_text' && content[j].text) return content[j].text;
    }
  }
  return '';
}

function discoverySnapshotByLabel_(items) {
  const categories = {};
  const used = {};
  (items || []).forEach(function (item) {
    const url = canonicalSourceUrl_(item && item.url);
    if (!url || used[url]) return;
    used[url] = true;
    const label = cleanText_(item && item.label) || 'Latest Jobs';
    if (!categories[label]) categories[label] = [];
    categories[label].push(url);
  });
  return categories;
}

function isDiscoveryStateInitialized_(state) {
  return !!(state && Number(state.version) === RV.DISCOVERY_STATE_VERSION &&
    state.categories && typeof state.categories === 'object' && !Array.isArray(state.categories));
}

function createDiscoveryState_(items, pendingUrls, previousState) {
  const previous = isDiscoveryStateInitialized_(previousState) ? previousState : {};
  const now = new Date().toISOString();
  return {
    version: RV.DISCOVERY_STATE_VERSION,
    initializedAt: previous.initializedAt || now,
    updatedAt: now,
    categories: discoverySnapshotByLabel_(items),
    pendingUrls: unique_((pendingUrls || []).map(canonicalSourceUrl_).filter(Boolean)).slice(0, 1000)
  };
}

/**
 * Compares ordered category snapshots. Only an unseen contiguous prefix before
 * the first surviving prior-feed anchor is eligible as genuinely new. Unseen
 * URLs below that anchor (or in a category with no anchor) are historical
 * recovery/backfill and are silently baselined.
 */
function classifyDiscoveryDelta_(items, seenUrls, registry, state) {
  const currentCategories = discoverySnapshotByLabel_(items);
  const previousCategories = (state && state.categories) || {};
  const itemByUrl = {};
  (items || []).forEach(function (item) {
    const url = canonicalSourceUrl_(item && item.url);
    if (url && !itemByUrl[url]) itemByUrl[url] = item;
  });

  const completed = {};
  (seenUrls || []).forEach(function (url) {
    const canonicalUrl = canonicalSourceUrl_(url);
    if (canonicalUrl) completed[canonicalUrl] = true;
  });
  Object.keys(registry || {}).forEach(function (url) {
    const canonicalUrl = canonicalSourceUrl_(url);
    if (canonicalUrl) completed[canonicalUrl] = true;
  });

  const pendingUrls = [];
  const pendingMap = {};
  unique_((state && state.pendingUrls) || []).forEach(function (url) {
    const canonicalUrl = canonicalSourceUrl_(url);
    if (!canonicalUrl || completed[canonicalUrl] || pendingMap[canonicalUrl]) return;
    pendingMap[canonicalUrl] = true;
    pendingUrls.push(canonicalUrl);
  });

  const historicalUrls = [];
  Object.keys(currentCategories).forEach(function (label) {
    const currentUrls = currentCategories[label];
    const previousSet = {};
    (previousCategories[label] || []).forEach(function (url) {
      const canonicalUrl = canonicalSourceUrl_(url);
      if (canonicalUrl) previousSet[canonicalUrl] = true;
    });

    let anchorIndex = -1;
    for (let i = 0; i < currentUrls.length; i++) {
      if (previousSet[currentUrls[i]] && !pendingMap[currentUrls[i]]) {
        anchorIndex = i;
        break;
      }
    }

    const newlyDetected = [];
    currentUrls.forEach(function (url, index) {
      if (completed[url] || pendingMap[url]) return;
      if (anchorIndex >= 0 && index < anchorIndex) newlyDetected.push(url);
      else historicalUrls.push(url);
    });

    // Feed order is latest-first; queue a same-run prefix oldest-first so a
    // multi-item burst is drafted chronologically without reading from the tail.
    newlyDetected.reverse().forEach(function (url) {
      if (pendingMap[url]) return;
      pendingMap[url] = true;
      pendingUrls.push(url);
    });
  });

  return {
    pendingUrls: pendingUrls,
    historicalUrls: unique_(historicalUrls),
    readyItems: pendingUrls.map(function (url) { return itemByUrl[url]; }).filter(Boolean)
  };
}

function loadDiscoveryState_() {
  return loadJsonChunks_(RV.DISCOVERY_STATE_PREFIX, null);
}

function saveDiscoveryState_(state) {
  saveJsonChunks_(RV.DISCOVERY_STATE_PREFIX, state || {});
}

function loadSeen_() {
  const chunked = loadJsonChunks_(RV.SEEN_PREFIX, null);
  if (chunked) return chunked;
  const raw = PropertiesService.getScriptProperties().getProperty(RV.SEEN_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (error) { return []; }
}

function saveSeen_(urls) {
  saveJsonChunks_(RV.SEEN_PREFIX, unique_(urls).slice(0, 1000));
  PropertiesService.getScriptProperties().deleteProperty(RV.SEEN_KEY);
}

function loadRegistry_() {
  return loadJsonChunks_(RV.REGISTRY_PREFIX, {}) || {};
}

function saveRegistry_(registry) {
  saveJsonChunks_(RV.REGISTRY_PREFIX, registry || {});
}

function loadJsonChunks_(prefix, fallback) {
  const props = PropertiesService.getScriptProperties().getProperties();
  const keys = Object.keys(props).filter(function (key) {
    return key.indexOf(prefix) === 0 && /^\d+$/.test(key.slice(prefix.length));
  }).sort(function (a, b) {
    return Number(a.slice(prefix.length)) - Number(b.slice(prefix.length));
  });
  if (!keys.length) return fallback;
  try {
    return JSON.parse(keys.map(function (key) { return props[key]; }).join(''));
  } catch (error) {
    Logger.log('Stored data could not be decoded for %s', prefix);
    return fallback;
  }
}

function saveJsonChunks_(prefix, value) {
  const text = JSON.stringify(value);
  const size = 7500;
  const newValues = {};
  for (let i = 0, part = 0; i < text.length; i += size, part++) {
    newValues[prefix + part] = text.slice(i, i + size);
  }
  deleteJsonChunks_(prefix);
  PropertiesService.getScriptProperties().setProperties(newValues, false);
}

function deleteJsonChunks_(prefix) {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(prefix) === 0) props.deleteProperty(key);
  });
}

function unique_(items) {
  const used = {};
  return items.filter(function (item) {
    if (!item || used[item]) return false;
    used[item] = true;
    return true;
  });
}

function safeApiError_(body) {
  try {
    const parsed = JSON.parse(body);
    return String((parsed.error && parsed.error.message) || parsed.message || 'Unknown API error').slice(0, 500);
  } catch (error) {
    return String(body || 'Unknown API error').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 500);
  }
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeBlogUrl_(url) {
  return String(url || '').trim().replace(/\/+$/, '') + '/';
}

function clamp_(value, min, max) {
  if (!isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
