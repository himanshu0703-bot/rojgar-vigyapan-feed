const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
const context = {
  console,
  Date,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  isFinite,
  parseInt,
  encodeURIComponent,
  decodeURIComponent,
  Utilities: {
    getUuid: () => 'fixture-attempt-id',
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (algorithm, value) => Array.from(crypto.createHash(algorithm).update(value, 'utf8').digest())
  },
  Logger: { log: () => {} }
};
vm.createContext(context);
vm.runInContext(code, context, { filename: 'Code.gs' });

const passed = [];
function test(name, fn) {
  fn();
  passed.push(name);
}

function item(url, position, title = '', category = 'Latest Jobs', extra = {}) {
  return Object.assign({
    url,
    title,
    label: category,
    category,
    categoryPosition: position,
    categorySnapshotStatus: 'fresh',
    sourcePublishedAt: '2026-08-16T00:00:00+00:00',
    sourceDateStatus: 'jina_published_time',
    sourceExcerpt: 'Verified source article content. '.repeat(20),
    importantLinks: [{ label: 'Official Website', actionText: 'Click Here', url: 'https://example.gov/' }],
    importantLinksCount: 1,
    sourceFetchStatus: 'ok_jina_api_markdown_http_200'
  }, extra);
}

function categorySource(category) {
  return {
    'Latest Jobs': 'https://www.sarkariresult.com/latestjob/',
    Result: 'https://www.sarkariresult.com/result/',
    'Admit Card': 'https://www.sarkariresult.com/admitcard/',
    'Answer Key': 'https://www.sarkariresult.com/answerkey/',
    Syllabus: 'https://www.sarkariresult.com/syllabus/',
    Admission: 'https://www.sarkariresult.com/admission/'
  }[category] || '';
}

function itemList(rows, previousState, options = {}) {
  const list = rows;
  const grouped = {};
  rows.forEach(row => {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push(row);
  });
  list.categorySnapshots = {};
  Object.keys(grouped).forEach(category => {
    const categoryRows = grouped[category].slice().sort((a, b) => a.categoryPosition - b.categoryPosition);
    const urls = categoryRows.map(row => row.url);
    const snapshotHash = context.categorySnapshotHash_(urls);
    const previousEvidence = previousState && previousState.categoryEvidence && previousState.categoryEvidence[category];
    const authoritative = options.authoritative !== false;
    const provenance = authoritative ? 'sarkariresult_visible_category_box_v1' : 'untrusted_feed_order';
    const extractorVersion = authoritative ? 'visible-category-v1' : 'unknown-extractor';
    categoryRows.forEach(row => {
      row.categorySnapshotProvenance = provenance;
      row.categoryExtractorVersion = extractorVersion;
      row.categorySnapshotHash = snapshotHash;
    });
    list.categorySnapshots[category] = {
      label: category,
      status: options.status || 'fresh',
      sourceUrl: categorySource(category),
      itemCount: categoryRows.length,
      provenance,
      extractorVersion,
      snapshotHash,
      previousSnapshotHash: previousEvidence ? previousEvidence.snapshotHash : '',
      ancestorSnapshotHashes: previousEvidence ? [previousEvidence.snapshotHash] : [],
      transitionStatus: previousEvidence ? 'authoritative_transition' : 'baseline',
      trusted: authoritative,
      trustReason: authoritative ? 'validated authoritative category-box snapshot' : 'untrusted fixture ordering'
    };
  });
  return list;
}

const A = 'https://www.sarkariresult.com/2026/a-post/';
const B = 'https://www.sarkariresult.com/2026/b-post/';
const C = 'https://www.sarkariresult.com/2026/c-post/';
const N1 = 'https://www.sarkariresult.com/2026/new-one/';
const N2 = 'https://www.sarkariresult.com/2026/new-two/';
const OLD = 'https://www.sarkariresult.com/2026/up-police-constable-jan26/';

function baseline() {
  const items = itemList([item(A, 0), item(B, 1), item(C, 2)]);
  return context.createDiscoveryState_(items, {}, null, [A, B, C]);
}

function confirmedFrontierCandidate(url = N1, extra = {}) {
  const state = baseline();
  const current = itemList([item(url, 0, '', 'Latest Jobs', extra), item(A, 1), item(B, 2), item(C, 3)], state);
  const decision = context.classifyDiscoveryDelta_(current, [A, B, C], {}, state);
  assert.strictEqual(decision.readyItems.length, 1);
  return { state, current, candidate: decision.readyItems[0], decision };
}

test('first bootstrap baselines all current URLs and replays zero', () => {
  const items = itemList(Array.from({ length: 40 }, (_, index) => item(`https://www.sarkariresult.com/2026/history-${index}/`, index)));
  const state = context.createDiscoveryState_(items, {}, null, items.map(row => row.url));
  const decision = context.classifyDiscoveryDelta_(items, items.map(row => row.url), {}, state);
  assert.strictEqual(decision.readyItems.length, 0);
});

test('legacy discovery state migration is fail-safe and requires a zero-draft rebaseline', () => {
  const legacy = { version: 1, categories: { 'Latest Jobs': [A, B, C] }, pendingUrls: [] };
  assert.strictEqual(context.isDiscoveryStateInitialized_(legacy), false);
  const current = itemList([item(A, 0), item(B, 1), item(C, 2)]);
  const migrated = context.createDiscoveryState_(current, {}, null, [A, B, C]);
  assert.strictEqual(context.isDiscoveryStateInitialized_(migrated), true);
  assert.strictEqual(context.classifyDiscoveryDelta_(current, [A, B, C], {}, migrated).readyItems.length, 0);
});

test('one genuine new head item is the only frontier candidate', () => {
  const state = baseline();
  const current = itemList([
    item(N1, 0, '', 'Latest Jobs', { sourcePublishedAt: '', sourceDateStatus: 'unavailable' }),
    item(A, 1), item(B, 2), item(C, 3)
  ], state);
  const decision = context.classifyDiscoveryDelta_(current, [A, B, C], {}, state);
  assert.deepStrictEqual(Array.from(decision.readyItems, row => row.url), [N1]);
  const evidence = context.newnessEvidence_(decision.readyItems[0], { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  assert.strictEqual(evidence.ok, true);
  assert.strictEqual(evidence.basis, 'NEW_FRONTIER_CONFIRMED');
  assert.strictEqual(context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'compatible new article' } }).decision, 'NEW');
});

test('full verifier permits trusted frontier NEW without publication metadata', () => {
  const fixture = confirmedFrontierCandidate(N1, { sourcePublishedAt: '', sourceDateStatus: 'unavailable' });
  const originals = {
    findTracked: context.findTrackedBloggerPostBySourceUrl_,
    fetchSource: context.fetchSourceArticle_,
    verifyGemini: context.verifyDiscoveryCandidateWithGemini_
  };
  context.findTrackedBloggerPostBySourceUrl_ = () => null;
  context.fetchSourceArticle_ = () => ({
    url: N1,
    title: 'New One',
    text: 'Verified source article body. '.repeat(20),
    links: [{ label: 'Official Website', actionText: 'Click Here', url: 'https://example.gov/' }],
    allowedUrls: [N1, 'https://example.gov/'],
    bodyAvailable: true
  });
  context.verifyDiscoveryCandidateWithGemini_ = () => ({ classification: 'NEW', reason: 'compatible new article' });
  try {
    const result = context.verifyDiscoveryCandidate_(fixture.candidate, {}, fixture.state, { blogUrl: 'https://example.blogspot.com/' }, {});
    assert.strictEqual(result.decision, 'NEW');
    assert.strictEqual(result.evidenceBasis, 'NEW_FRONTIER_CONFIRMED');
  } finally {
    context.findTrackedBloggerPostBySourceUrl_ = originals.findTracked;
    context.fetchSourceArticle_ = originals.fetchSource;
    context.verifyDiscoveryCandidateWithGemini_ = originals.verifyGemini;
  }
});

test('multiple contiguous new head items are independently eligible', () => {
  const state = baseline();
  const current = itemList([
    item(N1, 0, '', 'Latest Jobs', { sourcePublishedAt: '', sourceDateStatus: 'unavailable' }),
    item(N2, 1, '', 'Latest Jobs', { sourcePublishedAt: '', sourceDateStatus: 'unavailable' }),
    item(A, 2), item(B, 3), item(C, 4)
  ], state);
  const decision = context.classifyDiscoveryDelta_(current, [A, B, C], {}, state);
  assert.deepStrictEqual(Array.from(decision.readyItems, row => row.url), [N1, N2]);
  decision.readyItems.forEach(candidate => {
    const evidence = context.newnessEvidence_(candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
    assert.strictEqual(evidence.ok, true);
    assert.strictEqual(context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'compatible new article' } }).decision, 'NEW');
  });
});

test('each category maintains an independent ordered frontier', () => {
  const R1 = 'https://www.sarkariresult.com/2026/result-one/';
  const R2 = 'https://www.sarkariresult.com/2026/result-two/';
  const previous = itemList([item(A, 0), item(B, 1), item(R1, 0, '', 'Result'), item(R2, 1, '', 'Result')]);
  const state = context.createDiscoveryState_(previous, {}, null, [A, B, R1, R2]);
  const current = itemList([item(N1, 0), item(A, 1), item(B, 2), item(R1, 0, '', 'Result'), item(R2, 1, '', 'Result')], state);
  const decision = context.classifyDiscoveryDelta_(current, [A, B, R1, R2], {}, state);
  assert.deepStrictEqual(Array.from(decision.readyItems, row => row.url), [N1]);
});

test('reordering existing items creates zero candidates', () => {
  const state = baseline();
  const decision = context.classifyDiscoveryDelta_(itemList([item(A, 0), item(C, 1), item(B, 2)], state), [A, B, C], {}, state);
  assert.strictEqual(decision.readyItems.length, 0);
});

test('moving a known item to the head is reorder, not NEW', () => {
  const state = baseline();
  const decision = context.classifyDiscoveryDelta_(itemList([item(C, 0), item(A, 1), item(B, 2)], state), [A, B, C], {}, state);
  assert.strictEqual(decision.readyItems.length, 0);
});

test('no surviving anchor is REVIEW_REQUIRED and cannot become NEW', () => {
  const state = baseline();
  const X = 'https://www.sarkariresult.com/2026/x-post/';
  const Y = 'https://www.sarkariresult.com/2026/y-post/';
  const current = itemList([item(X, 0), item(Y, 1)], state);
  current.categorySnapshots['Latest Jobs'].transitionStatus = 'no_surviving_anchor';
  const decision = context.classifyDiscoveryDelta_(current, [A, B, C], {}, state);
  assert.deepStrictEqual(Array.from(decision.readyItems, row => row.url), [X, Y]);
  decision.readyItems.forEach(candidate => {
    const evidence = context.newnessEvidence_(candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
    assert.strictEqual(evidence.ok, false);
    assert.strictEqual(context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'top item' } }).decision, 'UNCERTAIN');
  });
});

test('late discovery below the surviving anchor is historical', () => {
  const state = baseline();
  const decision = context.classifyDiscoveryDelta_(itemList([item(A, 0), item(OLD, 1), item(B, 2), item(C, 3)], state), [A, B, C], {}, state);
  assert.strictEqual(decision.readyItems.length, 0);
  assert.ok(decision.historicalUrls.includes(OLD));
});

test('URL seen in any prior category history cannot become NEW in another category', () => {
  const state = baseline();
  state.historyUrls.push(OLD);
  const decision = context.classifyDiscoveryDelta_(itemList([item(OLD, 0), item(A, 1), item(B, 2)], state), [A, B, C], {}, state);
  assert.strictEqual(decision.readyItems.length, 0);
  assert.ok(decision.historicalUrls.includes(OLD));
});

test('existing Blogger source is never a normal-new candidate', () => {
  const registry = { [OLD]: { sourceUrl: OLD, bloggerPostId: '12345', sourceTitle: 'UP Police Constable' } };
  const state = baseline();
  const decision = context.classifyDiscoveryDelta_(itemList([item(OLD, 0), item(A, 1), item(B, 2)], state), [A, B, C], registry, state);
  assert.strictEqual(decision.readyItems.length, 0);
  assert.strictEqual(context.findRegistryKeyByCanonicalSource_(registry, OLD), OLD);
});

test('exact Blogger RV_SOURCE_URL mapping is recovered as UPDATE with same Post ID', () => {
  const originalFinder = context.findTrackedBloggerPostBySourceUrl_;
  context.findTrackedBloggerPostBySourceUrl_ = () => ({ id: '12345', title: 'UP Police Constable', labels: ['Latest Jobs'] });
  const registry = {};
  try {
    const result = context.verifyDiscoveryCandidate_(item(OLD, 0, 'UP Police Constable Admit Card'), registry, baseline(), { blogUrl: 'https://example.blogspot.com/' });
    assert.strictEqual(result.decision, 'UPDATE');
    assert.strictEqual(result.matchedRegistryKey, OLD);
    assert.strictEqual(registry[OLD].bloggerPostId, '12345');
    assert.deepStrictEqual(Array.from(registry[OLD].labels), ['Latest Jobs', 'Admit Card']);
  } finally {
    context.findTrackedBloggerPostBySourceUrl_ = originalFinder;
  }
});

test('cumulative lifecycle labels remain case-insensitive and duplicate-free', () => {
  assert.deepStrictEqual(Array.from(context.mergeBloggerLabels_(['Latest Jobs'], ['Admit Card'])), ['Latest Jobs', 'Admit Card']);
  assert.deepStrictEqual(Array.from(context.mergeBloggerLabels_(['Latest Jobs', 'Admit Card'], ['Result', 'admit card', 'Answer Key'])), ['Latest Jobs', 'Admit Card', 'Result', 'Answer Key']);
});

test('deterministic recent evidence plus Gemini NEW permits NEW', () => {
  const fixture = confirmedFrontierCandidate();
  const evidence = context.newnessEvidence_(fixture.candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  const result = context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'fresh article' } });
  assert.strictEqual(result.decision, 'NEW');
});

test('actual January UP Police URL cannot draft solely from top position', () => {
  const fixture = confirmedFrontierCandidate(OLD, {
    title: 'UP Police Constable DV / PST Admit Card 2026',
    sourcePublishedAt: '2026-08-16T00:00:00Z'
  });
  fixture.candidate.title = 'UP Police Constable DV / PST Admit Card 2026';
  const evidence = context.newnessEvidence_(fixture.candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  const result = context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'top item' } });
  assert.strictEqual(result.decision, 'UNCERTAIN');
});

test('late untrusted feed insertion cannot use NEW_FRONTIER_CONFIRMED', () => {
  const state = baseline();
  const current = itemList([item(N1, 0, 'MP High Court Assistant Grade III Online Form 2026', 'Latest Jobs', {
    sourcePublishedAt: '', sourceDateStatus: 'unavailable'
  }), item(A, 1), item(B, 2), item(C, 3)], state, { authoritative: false });
  const decision = context.classifyDiscoveryDelta_(current, [A, B, C], {}, state);
  assert.deepStrictEqual(Array.from(decision.readyItems, row => row.url), [N1]);
  const evidence = context.newnessEvidence_(decision.readyItems[0], { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  const result = context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'looks new' } });
  assert.strictEqual(result.decision, 'UNCERTAIN');
});

test('MP High Court-style fresh frontier candidate still requires and passes both gates', () => {
  const fixture = confirmedFrontierCandidate(N1, { title: 'MP High Court Assistant Grade III Online Form 2026' });
  fixture.candidate.title = 'MP High Court Assistant Grade III Online Form 2026';
  const evidence = context.newnessEvidence_(fixture.candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  const result = context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'NEW', reason: 'newly published recruitment article' } });
  assert.strictEqual(result.decision, 'NEW');
});

test('Gemini verifier uses only constrained NEW UPDATE UNCERTAIN JSON', () => {
  const originalFetch = context.fetchGeminiWithRetry_;
  context.fetchGeminiWithRetry_ = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"classification":"UNCERTAIN","reason":"insufficient history"}' }] } }]
    })
  });
  try {
    const result = context.verifyDiscoveryCandidateWithGemini_(
      item(N1, 0, 'MP High Court Assistant Grade III Online Form 2026'),
      { title: 'MP High Court Assistant Grade III', text: 'Verified fixture article text' },
      [],
      { model: 'fixture-model', apiKey: 'fixture-key' }
    );
    assert.strictEqual(result.classification, 'UNCERTAIN');
  } finally {
    context.fetchGeminiWithRetry_ = originalFetch;
  }
});

test('Gemini UPDATE never creates a normal draft', () => {
  const evidence = context.newnessEvidence_(confirmedFrontierCandidate().candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  assert.strictEqual(context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'UPDATE', reason: 'result lifecycle' } }).decision, 'UPDATE');
});

test('Gemini UNCERTAIN never creates a normal draft', () => {
  const evidence = context.newnessEvidence_(confirmedFrontierCandidate().candidate, { bodyAvailable: true }, Date.parse('2026-08-16T03:00:00Z'));
  assert.strictEqual(context.finalizeDiscoveryCandidateDecision_({ evidence, gemini: { classification: 'UNCERTAIN', reason: 'ambiguous' } }).decision, 'UNCERTAIN');
});

test('successful article registration prevents duplicate next run', () => {
  const registry = { [N1]: { sourceUrl: N1, bloggerPostId: '999' } };
  const state = baseline();
  const decision = context.classifyDiscoveryDelta_(itemList([item(N1, 0), item(A, 1), item(B, 2)], state), [A, B, C, N1], registry, state);
  assert.strictEqual(decision.readyItems.length, 0);
});

test('restart with persisted snapshot and pending state does not replay completed items', () => {
  const initial = baseline();
  const firstCurrent = itemList([item(N1, 0), item(A, 1), item(B, 2), item(C, 3)], initial);
  const state = context.createDiscoveryState_(firstCurrent, {}, initial, [N1]);
  const restartedCurrent = itemList([item(N1, 0), item(A, 1), item(B, 2), item(C, 3)], state);
  const decision = context.classifyDiscoveryDelta_(restartedCurrent, [A, B, C, N1], { [N1]: { sourceUrl: N1, bloggerPostId: '999' } }, state);
  assert.strictEqual(decision.readyItems.length, 0);
});

test('failed new-draft attempt keeps candidate retryable', () => {
  const initial = baseline();
  const current = itemList([item(N1, 0), item(A, 1), item(B, 2), item(C, 3)], initial);
  const first = context.classifyDiscoveryDelta_(current, [A, B, C], {}, initial);
  const saved = context.createDiscoveryState_(current, first.pendingCandidates, initial, first.historicalUrls);
  context.recordPendingDiscoveryDecision_(saved, N1, { decision: 'UNCERTAIN', reason: 'draft failed' });
  const retryCurrent = itemList([item(N1, 0), item(A, 1), item(B, 2), item(C, 3)], saved);
  const retry = context.classifyDiscoveryDelta_(retryCurrent, [A, B, C], {}, saved);
  assert.deepStrictEqual(Array.from(retry.readyItems, row => row.url), [N1]);
});

test('ambiguous failed draft attempt recovers exact existing draft before retry', () => {
  const state = { pendingCandidates: { [N1]: { url: N1, categories: ['Latest Jobs'] } }, pendingUrls: [N1] };
  context.recordPendingDiscoveryDecision_(state, N1, {
    decision: 'NEW',
    reason: 'verified fixture',
    source: { title: 'Fixture', text: 'Fixture article body', links: [] }
  });
  context.beginPendingDraftAttempt_(state, N1);
  assert.strictEqual(state.pendingCandidates[N1].draftCreationState, 'started');
  assert.strictEqual(state.pendingCandidates[N1].verifiedDecision, 'NEW');
  assert.ok(state.pendingCandidates[N1].verifiedSourceHash);
  const originalBlogId = context.getBlogId_;
  const originalFetch = context.googleFetch_;
  context.getBlogId_ = () => 'blog-1';
  context.googleFetch_ = () => ({
    getContentText: () => JSON.stringify({
      items: [{ id: 'draft-77', content: `<!-- RV_SOURCE_URL: ${N1} -->`, labels: ['Latest Jobs'] }]
    })
  });
  try {
    const recovered = context.findExistingDraftBySourceUrl_(N1, { blogUrl: 'https://example.blogspot.com/' });
    assert.strictEqual(recovered.id, 'draft-77');
  } finally {
    context.getBlogId_ = originalBlogId;
    context.googleFetch_ = originalFetch;
  }
});

test('stale or legacy category snapshots cannot advance the frontier', () => {
  const current = itemList([item(N1, 0, '', 'Latest Jobs', { categorySnapshotStatus: 'failed' }), item(A, 1, '', 'Latest Jobs', { categorySnapshotStatus: 'failed' })]);
  current.categorySnapshots = { 'Latest Jobs': { status: 'failed' } };
  assert.strictEqual(context.classifyDiscoveryDelta_(current, [A, B, C], {}, baseline()).readyItems.length, 0);
});

test('promotional navigation and video URLs are rejected', () => {
  const rejected = [
    'https://www.sarkariresult.com/',
    'https://www.sarkariresult.com/search/query/',
    'https://www.sarkariresult.com/author/old_sr2026/',
    'https://www.sarkariresult.com/tools/image-resizer/',
    'https://www.sarkariresult.com/android/app/',
    'https://youtube.com/watch?v=1',
    'https://youtu.be/example',
    'https://t.me/example',
    'https://whatsapp.com/channel/example',
    'javascript:void(0)',
    'mailto:test@example.com',
    'tel:+911234567890'
  ];
  rejected.forEach(url => assert.strictEqual(context.isSarkariResultArticle_(url), false));
});

test('valid SarkariResult article namespaces remain accepted', () => {
  ['2026', '2025', 'upsssc', 'ssc', 'railway', 'bihar', 'upsc'].forEach(namespace => {
    assert.strictEqual(context.isSarkariResultArticle_(`https://www.sarkariresult.com/${namespace}/example-post/`), true);
  });
});

test('Important Links exact rows, grouping and fixed destinations remain intact', () => {
  const rows = context.sourceLinkRows_([
    { label: 'Registration', actionText: 'Registration', url: 'https://example.gov/register' },
    { label: 'Registration', actionText: 'Login', url: 'https://example.gov/login' }
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(context.groupConsecutiveSourceLinks_(rows)[0].links.length, 2);
  assert.strictEqual(context.isCollectorApprovedLinkNoise_('Click Here', 'https://youtu.be/test'), true);
  assert.strictEqual(context.isCollectorApprovedLinkNoise_('Download Notification', 'https://example.gov/notice.pdf'), false);
  assert.ok(code.includes("TELEGRAM: 'https://t.me/rojgarvigyapan'"));
  assert.ok(code.includes("WHATSAPP: 'https://whatsapp.com/channel/0029VaAVxN7BA1et899BiK1f'"));
  assert.ok(code.includes("TOOLS: 'https://rojgarvigyapan.blogspot.com/p/online-tools.html'"));
});

test('collector source excerpt safely supplies body when Apps Script refetch is blocked', () => {
  const originalFetchText = context.fetchText_;
  context.fetchText_ = () => ({
    ok: false,
    content: '',
    representation: 'none',
    directStatus: 'HTTP 403',
    readerStatus: 'HTTP 403'
  });
  const excerpt = 'Verified collector source article detail. '.repeat(20);
  const links = [{ label: 'Download Notification', actionText: 'Click Here', url: 'https://example.gov/notice.pdf' }];
  try {
    const source = context.fetchSourceArticle_(
      N1,
      links,
      'ok_jina_api_markdown_http_200',
      1,
      'Fixture Post',
      excerpt
    );
    assert.strictEqual(source.bodyAvailable, true);
    assert.strictEqual(source.text, context.cleanText_(excerpt));
    assert.strictEqual(source.url, N1);
    assert.deepStrictEqual(Array.from(source.links, row => [row.label, row.actionText, row.url]), [
      ['Download Notification', 'Click Here', 'https://example.gov/notice.pdf']
    ]);
  } finally {
    context.fetchText_ = originalFetchText;
  }
});

test('internal update-review draft cannot be recovered as a normal source draft', () => {
  const originalBlogId = context.getBlogId_;
  const originalFetch = context.googleFetch_;
  context.getBlogId_ = () => 'blog-1';
  context.googleFetch_ = () => ({
    getContentText: () => JSON.stringify({
      items: [
        { id: 'review-1', title: 'UPDATE REVIEW – Fixture', content: `<!-- RV_SOURCE_URL: ${N1} -->` },
        { id: 'draft-1', title: 'Fixture', content: `<!-- RV_SOURCE_URL: ${N1} -->` }
      ]
    })
  });
  try {
    const recovered = context.findExistingDraftBySourceUrl_(N1, { blogUrl: 'https://example.blogspot.com/' });
    assert.strictEqual(recovered.id, 'draft-1');
  } finally {
    context.getBlogId_ = originalBlogId;
    context.googleFetch_ = originalFetch;
  }
});

test('same canonical source keeps the original registry key and Post ID', () => {
  const registry = { [A]: { sourceUrl: A, bloggerPostId: '12345' } };
  const key = context.findRegistryKeyByCanonicalSource_(registry, A + '?utm_source=test');
  assert.strictEqual(key, A);
  assert.strictEqual(registry[key].bloggerPostId, '12345');
});

test('V4.5 provenance is validated while legacy feeds remain fail-closed compatible', () => {
  const snapshotHash = context.categorySnapshotHash_([N1]);
  const feed = {
    version: '4.5',
    generated_at: '2026-08-16T00:00:00Z',
    category_snapshots: [{
      label: 'Latest Jobs', status: 'fresh', source_url: 'https://www.sarkariresult.com/latestjob/', item_count: 1,
      provenance: 'sarkariresult_visible_category_box_v1', extractor_version: 'visible-category-v1',
      ordered_urls_sha256: snapshotHash, previous_snapshot_sha256: '', ancestor_snapshot_sha256s: [],
      transition_status: 'baseline'
    }],
    items: [{
      url: N1,
      title: 'New One',
      label: 'Latest Jobs',
      category: 'Latest Jobs',
      position: 0,
      category_position: 0,
      category_snapshot_status: 'fresh',
      category_snapshot_provenance: 'sarkariresult_visible_category_box_v1',
      category_extractor_version: 'visible-category-v1',
      category_snapshot_sha256: snapshotHash,
      source_published_at: '2026-08-16T00:00:00Z',
      source_date_status: 'jina_published_time',
      source_excerpt: 'Verified source article content. '.repeat(20),
      source_fetch_status: 'ok_jina_api_markdown_http_200',
      important_links: [{ label: 'Official Website', text: 'Click Here', url: 'https://example.gov/' }],
      important_links_count: 1
    }]
  };
  const originalProperties = context.PropertiesService;
  const originalFetch = context.UrlFetchApp;
  context.PropertiesService = { getScriptProperties: () => ({ getProperty: key => key === 'DISCOVERY_FEED_URL' ? 'https://fixture.invalid/feed.json' : '' }) };
  context.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(feed) }) };
  try {
    const discovered = context.discoverSourcePosts_();
    assert.strictEqual(discovered.length, 1);
    assert.strictEqual(discovered[0].url, N1);
    assert.strictEqual(discovered[0].categoryPosition, 0);
    assert.strictEqual(discovered[0].categorySnapshotStatus, 'fresh');
    assert.strictEqual(discovered[0].sourceExcerpt, feed.items[0].source_excerpt);
    assert.strictEqual(discovered[0].importantLinks[0].url, 'https://example.gov/');
    assert.strictEqual(discovered.categorySnapshots['Latest Jobs'].trusted, true);
    const v44Feed = JSON.parse(JSON.stringify(feed));
    v44Feed.version = '4.4';
    delete v44Feed.category_snapshots[0].provenance;
    delete v44Feed.category_snapshots[0].extractor_version;
    delete v44Feed.category_snapshots[0].ordered_urls_sha256;
    delete v44Feed.items[0].category_snapshot_provenance;
    delete v44Feed.items[0].category_extractor_version;
    delete v44Feed.items[0].category_snapshot_sha256;
    context.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(v44Feed) }) };
    const v44 = context.discoverSourcePosts_();
    assert.strictEqual(v44.length, 1);
    assert.strictEqual(v44.categorySnapshots['Latest Jobs'].trusted, false);
    const legacyFeed = {
      version: '4.3',
      items: [{
        url: N1,
        title: 'New One',
        label: 'Latest Jobs',
        position: 0,
        source_fetch_status: 'ok_jina_api_markdown_http_200',
        important_links: [{ label: 'Official Website', text: 'Click Here', url: 'https://example.gov/' }],
        important_links_count: 1
      }]
    };
    context.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(legacyFeed) }) };
    const legacy = context.discoverSourcePosts_();
    assert.strictEqual(legacy.length, 1);
    assert.strictEqual(legacy[0].url, N1);
    assert.strictEqual(legacy[0].categorySnapshotStatus, 'legacy_unverified');
  } finally {
    context.PropertiesService = originalProperties;
    context.UrlFetchApp = originalFetch;
  }
});

console.log(`PASS ${passed.length} Code.gs discovery regression tests`);
passed.forEach(name => console.log(`PASS - ${name}`));
