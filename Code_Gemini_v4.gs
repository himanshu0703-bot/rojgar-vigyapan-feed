/**
 * Rojgar Vigyapan — Sarkari Result to Blogger Draft Automation
 * Draft-only build. It never publishes a post automatically.
 *
 * Required Script Property:
 *   GEMINI_API_KEY
 *
 * Optional Script Properties:
 *   BLOG_URL          (default: https://rojgarvigyapan.blogspot.com/)
 *   GEMINI_MODEL      (default: gemini-2.5-flash)
 *   MAX_POSTS_PER_RUN (default: 2)
 *   UPDATE_CHECKS_PER_RUN (default: 8)
 *   TEST_SOURCE_URL   (optional exact SarkariResult URL for manual testing)
 *   DISCOVERY_FEED_URL (required for automatic discovery; public JSON feed URL)
 *
 * V4 discovery: Apps Script no longer scrapes SarkariResult/search engines.
 * A free GitHub Actions collector writes feed.json, and Apps Script reads that feed.
 * Individual article pages still use the existing Reader fallback.
 */

const RV = Object.freeze({
  BLOG_URL: 'https://rojgarvigyapan.blogspot.com/',
  MODEL: 'gemini-2.5-flash',
  MAX_POSTS_PER_RUN: 2,
  UPDATE_CHECKS_PER_RUN: 8,
  SEEN_KEY: 'RV_SEEN_SOURCE_URLS',
  SEEN_PREFIX: 'RV_SEEN_CHUNK_',
  REGISTRY_PREFIX: 'RV_REGISTRY_CHUNK_',
  UPDATE_CURSOR_KEY: 'RV_UPDATE_CURSOR',
  BLOG_ID_KEY: 'RV_BLOGGER_BLOG_ID',
  TRIGGER_FUNCTION: 'checkNewSarkariResultPosts',
  REVIEW_PREFIX: 'UPDATE REVIEW – ',
  APPROVED_PREFIX: 'APPROVED UPDATE – ',
  APPLIED_PREFIX: 'APPLIED UPDATE – ',
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

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === RV.TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(RV.TRIGGER_FUNCTION).timeBased().everyHours(1).create();
  Logger.log('Setup complete. %s existing source URLs saved as baseline.', current.length);
  Logger.log('New items will be generated as Blogger drafts only.');
}

/** Creates one test draft from the newest discoverable source post. */
function testAutomationNow() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const exactTestUrl = canonicalSourceUrl_(props.getProperty('TEST_SOURCE_URL') || '');
  const items = exactTestUrl && isSarkariResultArticle_(exactTestUrl)
    ? [{ url: exactTestUrl, title: '', label: inferLabelFromUrlOrTitle_(exactTestUrl, '') }]
    : discoverSourcePosts_();
  if (!items.length) throw new Error('No Sarkari Result post link found in the V4 discovery feed. Check DISCOVERY_FEED_URL or set TEST_SOURCE_URL for manual testing.');

  const newest = items[0];
  const result = processSourcePost_(newest, config);
  const registry = loadRegistry_();
  registry[newest.url] = createRegistryEntry_(newest, result);
  saveRegistry_(registry);
  Logger.log('Test draft created and tracking enabled: %s', result.bloggerPost.url || result.bloggerPost.id);
}

/** Hourly trigger. */
function checkNewSarkariResultPosts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;

  try {
    const config = getConfig_();
    const discovered = discoverSourcePosts_();
    const seen = loadSeen_();
    const seenMap = {};
    seen.forEach(function (url) { seenMap[url] = true; });

    const pending = discovered.filter(function (item) {
      return !seenMap[item.url];
    }).reverse().slice(0, config.maxPostsPerRun);

    const registry = loadRegistry_();
    pending.forEach(function (item) {
      try {
        const created = processSourcePost_(item, config);
        registry[item.url] = createRegistryEntry_(item, created);
        saveRegistry_(registry);
        seen.push(item.url);
        seenMap[item.url] = true;
        saveSeen_(seen);
        Logger.log('Draft created: %s', created.bloggerPost.url || created.bloggerPost.id);
      } catch (error) {
        Logger.log('Skipped %s — %s', item.url, error.message);
      }
    });

    if (!pending.length) Logger.log('No new Sarkari Result post found.');
    applyApprovedUpdates_(registry, config);
    checkTrackedSourceUpdates_(registry, config);
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

/** Clears the baseline. The next run may treat currently listed posts as new. */
function resetSeenPosts() {
  deleteJsonChunks_(RV.SEEN_PREFIX);
  PropertiesService.getScriptProperties().deleteProperty(RV.SEEN_KEY);
  Logger.log('Seen URL baseline cleared. Run setupAutomation() again.');
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
  const source = fetchSourceArticle_(item.url);
  const generated = generatePostWithGemini_(source, item.label, config);
  generated.label = item.label;
  generated.html = sanitizeGeneratedHtml_(generated.html, source.allowedUrls);
  generated.html = addDraftMetadata_(generated, item.url) + generated.html;
  validateGeneratedPost_(generated);
  return {
    bloggerPost: insertBloggerDraft_(generated, config),
    sourceHash: fingerprintSource_(source),
    generated: generated
  };
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = String(props.getProperty('GEMINI_API_KEY') || '').trim();
  if (!apiKey) throw new Error('Script Property GEMINI_API_KEY is missing.');

  return {
    apiKey: apiKey,
    blogUrl: normalizeBlogUrl_(props.getProperty('BLOG_URL') || RV.BLOG_URL),
    model: String(props.getProperty('GEMINI_MODEL') || RV.MODEL).trim(),
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
    results.push({
      url: url,
      title: cleanText_((item && item.title) || ''),
      label: normalizeFeedLabel_((item && item.label) || inferLabelFromUrlOrTitle_(url, (item && item.title) || '')),
      publishedMs: parseFeedDateMs_((item && (item.published_at || item.publishedAt || item.discovered_at || item.discoveredAt)) || '') || (1000000000 - index)
    });
  });

  Logger.log('V4 discovery feed: %s URLs received, %s accepted.', rawItems.length, results.length);
  return results.sort(function (a, b) { return (b.publishedMs || 0) - (a.publishedMs || 0); });
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

function fetchSourceArticle_(url) {
  const html = fetchText_(url);
  const title = extractTitle_(html) || url;
  const anchors = extractAnchors_(html, url);
  const allowedUrls = [url, RV.TELEGRAM, RV.WHATSAPP, RV.TOOLS];
  const linkLines = [];

  anchors.forEach(function (link) {
    if (!/^https?:\/\//i.test(link.url)) return;
    const safeUrl = stripTracking_(link.url);
    if (allowedUrls.indexOf(safeUrl) === -1) allowedUrls.push(safeUrl);
    const text = cleanText_(link.text);
    if (text && safeUrl) linkLines.push(text + ' => ' + safeUrl);
  });

  const text = htmlToText_(html).slice(0, 55000);
  if (text.length < 200) throw new Error('Source article content could not be read.');

  return {
    url: url,
    title: cleanText_(title),
    text: text,
    links: unique_(linkLines).slice(0, 160),
    allowedUrls: unique_(allowedUrls)
  };
}

function generatePostWithGemini_(source, requiredLabel, config, existingPost) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      label: { type: 'string', enum: [requiredLabel] },
      changeSummary: { type: 'string' },
      searchDescription: { type: 'string' },
      searchKeywords: { type: 'array', items: { type: 'string' } },
      html: { type: 'string' }
    },
    required: ['title', 'label', 'changeSummary', 'searchDescription', 'searchKeywords', 'html']
  };

  const systemPrompt = [
    'You create original, accurate, AdSense-friendly Hindi/Hinglish government-job information posts for Rojgar Vigyapan.',
    'Never copy the source wording. Summarize and reorganize facts in original language.',
    'Do not invent dates, vacancies, fees, qualifications, official URLs, or claims.',
    'Use exactly one supplied Blogger label.',
    'Return complete Blogger-compatible HTML only in the html field; do not include html/body/head tags or scripts.',
    'Design: premium clean layout, pink #e60099 accents, readable tables, responsive inline CSS, solid pink action buttons.',
    'Start with 2–4 useful original paragraphs. Include overview, important dates, fee, age, vacancy, eligibility, selection/process and how-to sections only when the source contains those facts.',
    'Create an Important Links section. Use only URLs present in SOURCE LINKS. Close that section fully before FAQ.',
    'Then add original FAQs, a verification disclaimer, Telegram, WhatsApp and Online Tools buttons.',
    'Online Tools button text must be: Signature Resizer, PDF Compress, Age Calculator and More Tools.',
    'If a fact or official link is absent, write “आधिकारिक सूचना में जाँच करें” instead of guessing.',
    'Search description must be natural, post-specific, and about 140–155 characters. Title should be concise and SEO-friendly.'
  ].join('\n');

  const userPrompt = [
    'REQUIRED LABEL: ' + requiredLabel,
    'SOURCE URL: ' + source.url,
    'SOURCE TITLE: ' + source.title,
    '',
    'SOURCE TEXT:',
    source.text,
    '',
    'SOURCE LINKS (the only source URLs allowed in the post):',
    source.links.join('\n'),
    '',
    'FIXED ROJGAR VIGYAPAN LINKS:',
    'Telegram => ' + RV.TELEGRAM,
    'WhatsApp => ' + RV.WHATSAPP,
    'Online Tools => ' + RV.TOOLS,
    '',
    existingPost ? 'EXISTING BLOGGER POST (preserve useful original writing and revise only where the new source supports it):' : 'THIS IS A NEW POST.',
    existingPost ? ('EXISTING TITLE: ' + existingPost.title + '\nEXISTING HTML:\n' + String(existingPost.content || '').slice(0, 45000)) : '',
    '',
    'In changeSummary, briefly state the meaningful source changes in Hindi. For a new post, write “नई पोस्ट”.'
  ].join('\n');

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{
      role: 'user',
      parts: [{ text: userPrompt }]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      maxOutputTokens: 12000,
      temperature: 0.2
    }
  };

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(config.model) + ':generateContent?key=' + encodeURIComponent(config.apiKey);

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Gemini API error ' + code + ': ' + safeApiError_(body));
  }

  const data = JSON.parse(body);
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const outputText = Array.isArray(parts) ? parts.map(function (part) { return part.text || ''; }).join('').trim() : '';
  if (!outputText) {
    const reason = data && data.candidates && data.candidates[0] && data.candidates[0].finishReason;
    throw new Error('Gemini returned no usable text output' + (reason ? ' (' + reason + ')' : '') + '.');
  }

  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw new Error('Gemini returned invalid JSON: ' + outputText.slice(0, 300));
  }
}

function insertBloggerDraft_(post, config) {
  const blogId = getBlogId_(config.blogUrl);
  const endpoint = 'https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(blogId) + '/posts?isDraft=true';
  const resource = {
    kind: 'blogger#post',
    blog: { id: String(blogId) },
    title: post.title,
    content: post.html,
    labels: [post.label]
  };

  const response = googleFetch_(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(resource)
  });
  return JSON.parse(response.getContentText());
}

function checkTrackedSourceUpdates_(registry, config) {
  const urls = Object.keys(registry);
  if (!urls.length) return;

  const props = PropertiesService.getScriptProperties();
  let cursor = Number(props.getProperty(RV.UPDATE_CURSOR_KEY) || 0);
  if (!isFinite(cursor) || cursor < 0 || cursor >= urls.length) cursor = 0;
  const count = Math.min(config.updateChecksPerRun, urls.length);

  for (let offset = 0; offset < count; offset++) {
    const index = (cursor + offset) % urls.length;
    const sourceUrl = urls[index];
    const entry = registry[sourceUrl];

    try {
      const source = fetchSourceArticle_(sourceUrl);
      const currentHash = fingerprintSource_(source);
      entry.lastCheckedAt = new Date().toISOString();
      if (currentHash === entry.sourceHash || currentHash === entry.candidateHash) continue;

      const original = getBloggerPost_(entry.bloggerPostId, config);
      const generated = generatePostWithGemini_(source, entry.label, config, original);
      generated.label = entry.label;
      generated.html = sanitizeGeneratedHtml_(generated.html, source.allowedUrls);
      generated.html = addDraftMetadata_(generated, sourceUrl) + generated.html;
      validateGeneratedPost_(generated);

      const reviewPost = upsertReviewDraft_(entry, generated, currentHash, config);
      entry.reviewDraftId = String(reviewPost.id);
      entry.candidateHash = currentHash;
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
  const reviewHtml = buildReviewNotice_(entry, generated.changeSummary, candidateHash) + generated.html;
  const resource = {
    kind: 'blogger#post',
    blog: { id: String(getBlogId_(config.blogUrl)) },
    title: reviewTitle,
    content: reviewHtml,
    labels: [entry.label]
  };

  if (entry.reviewDraftId) {
    try {
      const existingReview = getBloggerPost_(entry.reviewDraftId, config);
      if (String(existingReview.status || '').toLowerCase() === 'draft' &&
          String(existingReview.title || '').indexOf(RV.APPROVED_PREFIX) !== 0) {
        return updateBloggerPost_(entry.reviewDraftId, resource, config);
      }
    } catch (error) {
      Logger.log('Previous review draft unavailable; creating a new one.');
    }
  }

  return insertBloggerDraft_({
    title: reviewTitle,
    html: reviewHtml,
    label: entry.label
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

      const cleanTitle = title.slice(RV.APPROVED_PREFIX.length).trim();
      const cleanContent = stripReviewNotice_(review.content || '');
      const updatedOriginal = updateBloggerPost_(entry.bloggerPostId, {
        kind: 'blogger#post',
        blog: { id: String(getBlogId_(config.blogUrl)) },
        title: cleanTitle,
        content: cleanContent,
        labels: [entry.label]
      }, config);

      updateBloggerPost_(entry.reviewDraftId, {
        kind: 'blogger#post',
        blog: { id: String(getBlogId_(config.blogUrl)) },
        title: RV.APPLIED_PREFIX + cleanTitle,
        content: review.content,
        labels: [entry.label]
      }, config);

      entry.sourceHash = entry.candidateHash;
      entry.candidateHash = '';
      entry.reviewDraftId = '';
      entry.lastAppliedAt = new Date().toISOString();
      Logger.log('Original Blogger post updated: %s', updatedOriginal.url || updatedOriginal.id);
    } catch (error) {
      Logger.log('Approved update failed for %s — %s', sourceUrl, error.message);
    }
  });
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

function buildReviewNotice_(entry, changeSummary, candidateHash) {
  return '<!-- RV_UPDATE_REVIEW_START -->' +
    '<div style="border:2px solid #e60099;background:#fff4fb;padding:16px;margin:0 0 20px;border-radius:12px;font-family:Arial,sans-serif">' +
    '<h3 style="margin:0 0 8px;color:#e60099">Update Review Required</h3>' +
    '<p style="margin:0 0 8px"><b>Detected changes:</b> ' + escapeHtml_(changeSummary || 'Source page updated') + '</p>' +
    '<p style="margin:0 0 8px"><b>Source:</b> <a href="' + escapeHtml_(entry.sourceUrl) + '">' + escapeHtml_(entry.sourceUrl) + '</a></p>' +
    '<p style="margin:0"><b>Approve:</b> Draft title में <code>UPDATE REVIEW –</code> को <code>APPROVED UPDATE –</code> से replace करके draft save करें। इसे publish न करें।</p>' +
    '<span style="display:none" data-rv-candidate-hash="' + escapeHtml_(candidateHash) + '"></span>' +
    '</div>' +
    '<!-- RV_UPDATE_REVIEW_END -->';
}

function stripReviewNotice_(html) {
  return String(html || '').replace(/<!-- RV_UPDATE_REVIEW_START -->[\s\S]*?<!-- RV_UPDATE_REVIEW_END -->/i, '').trim();
}

function createRegistryEntry_(item, result) {
  return {
    sourceUrl: item.url,
    bloggerPostId: String(result.bloggerPost.id),
    label: item.label,
    sourceHash: result.sourceHash,
    reviewDraftId: '',
    candidateHash: '',
    createdAt: new Date().toISOString(),
    lastCheckedAt: ''
  };
}

function fingerprintSource_(source) {
  const material = cleanText_([
    source.title,
    source.text,
    source.links.join('\n')
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

  // First try the source directly. SarkariResult currently returns HTTP 403 to
  // Apps Script/Google egress IPs, so this normally falls through to Reader.
  try {
    const direct = UrlFetchApp.fetch(url, requestOptions);
    const directCode = direct.getResponseCode();
    if (directCode >= 200 && directCode < 300) return direct.getContentText();
    Logger.log('Direct fetch blocked for %s — HTTP %s; trying Reader fallback.', url, directCode);
  } catch (directError) {
    Logger.log('Direct fetch failed for %s — %s; trying Reader fallback.', url, directError.message);
  }

  // Jina Reader fetches the public URL server-side and returns clean Markdown.
  // No API key is required for basic usage.
  const readerUrl = 'https://r.jina.ai/' + url;
  const reader = UrlFetchApp.fetch(readerUrl, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'Accept': 'text/plain',
      'User-Agent': 'RojgarVigyapanBot/1.0'
    }
  });
  const readerCode = reader.getResponseCode();
  if (readerCode < 200 || readerCode >= 300) {
    throw new Error('Direct source blocked and Reader fallback returned HTTP ' + readerCode);
  }

  const body = reader.getContentText();
  if (!body || body.length < 100) throw new Error('Reader fallback returned empty content.');
  return body;
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
    const cleanUrl = stripTracking_(resolved);
    const key = cleanUrl + '|' + htmlToText_(match[2]);
    if (seen[key]) continue;
    seen[key] = true;
    links.push({ url: cleanUrl, text: htmlToText_(match[2]) });
  }

  // Jina Reader may return absolute OR relative Markdown links.
  const markdownRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  while ((match = markdownRegex.exec(String(html || ''))) !== null) {
    const resolved = resolveUrl_(match[2], baseUrl);
    if (!resolved) continue;
    const cleanUrl = stripTracking_(resolved.replace(/[)>.,;]+$/, ''));
    const text = cleanText_(match[1].replace(/[*_`~]/g, ' '));
    const key = cleanUrl + '|' + text;
    if (seen[key]) continue;
    seen[key] = true;
    links.push({ url: cleanUrl, text: text });
  }

  // Some Reader responses expose URLs as plain text rather than Markdown links.
  // Capture those too so discovery does not depend on Reader's formatting.
  const rawUrlRegex = /https?:\/\/(?:www\.)?sarkariresult\.com\/[^\s<>()\]\["']+/gi;
  while ((match = rawUrlRegex.exec(String(html || ''))) !== null) {
    const cleanUrl = stripTracking_(match[0].replace(/[)>.,;:'"]+$/, ''));
    const key = cleanUrl + '|';
    if (seen[key]) continue;
    seen[key] = true;
    links.push({ url: cleanUrl, text: '' });
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
  const allowed = {};
  allowedUrls.forEach(function (url) { allowed[stripTracking_(url)] = true; });
  output = output.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, function (all, quote, url) {
    const clean = stripTracking_(decodeEntities_(url));
    return allowed[clean] ? 'href=' + quote + clean + quote : 'href=' + quote + '#' + quote + ' data-rv-unverified-link="true"';
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
