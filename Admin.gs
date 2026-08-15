/**
 * Rojgar Vigyapan — Label History + Admin Panel
 *
 * Script Property required before setup:
 *   RV_ADMIN_PASSWORD = a strong password used only for this admin panel
 *
 * For a new installation only, run createRojgarAdminDatabaseExplicitly_()
 * once, then run setupLabelHistorySystem() and deploy as a Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 * Public requests can only read non-sensitive display data. Every write action
 * requires a short-lived server-side admin session token.
 */

const RVH = Object.freeze({
  DB_KEY: 'RV_LABEL_HISTORY_SHEET_ID',
  ADMIN_PASSWORD_KEY: 'RV_ADMIN_PASSWORD',
  SYNC_TRIGGER: 'syncLabelHistory',
  SESSION_PREFIX: 'RVH_SESSION_',
  SESSION_SECONDS: 21600,
  POSTS: 'Posts',
  HISTORY: 'Label History',
  BOXES: 'Boxes'
});

const RVH_POST_HEADERS = ['postId', 'url', 'currentTitle', 'publishedAt', 'updatedAt', 'currentLabels', 'lastSyncAt'];
const RVH_HISTORY_HEADERS = ['postId', 'label', 'snapshotTitle', 'labelAddedAt', 'originalPublishedAt', 'manualOrder', 'pinned', 'hidden', 'active', 'url'];
const RVH_BOX_HEADERS = ['boxKey', 'heading', 'sourceLabel', 'enabled', 'postLimit', 'sortOrder'];

const RVH_DEFAULT_BOXES = [
  ['latest-jobs', 'Latest Jobs', 'Latest Jobs', true, 15, 10],
  ['result', 'Result', 'Result', true, 15, 20],
  ['admit-card', 'Admit Card', 'Admit Card', true, 15, 30],
  ['answer-key', 'Answer Key', 'Answer Key', true, 15, 40],
  ['syllabus', 'Syllabus', 'Syllabus', true, 15, 50],
  ['admission', 'Admission', 'Admission', true, 15, 60],
  ['certificate', 'Certificate', 'Certificate', true, 15, 70],
  ['important', 'Important', 'Important', true, 15, 80],
  ['other', 'Other Updates', 'Other', true, 15, 90],
  ['up-jobs', 'Uttar Pradesh Jobs', 'UP Jobs', true, 15, 100],
  ['central-govt', 'Central Govt Jobs', 'Central Govt', true, 15, 110],
  ['railway', 'Railway Jobs', 'Railway', true, 15, 120],
  ['featured', 'Trending Jobs', 'Featured', true, 15, 130],
  ['latest-updates', 'Latest Updates', '*', true, 10, 140],
  ['breaking', 'Breaking Updates', 'Breaking', true, 15, 150]
];

/**
 * Developer-only, explicit creation path for a genuinely new installation.
 * The trailing underscore keeps this mutation unavailable to google.script.run.
 * Never replaces an existing configured database, even when that database is
 * currently inaccessible.
 */
function createRojgarAdminDatabaseExplicitly_() {
  const props = PropertiesService.getScriptProperties();
  const saved = String(props.getProperty(RVH.DB_KEY) || '').trim();
  if (saved) {
    throw new Error(
      'Admin database is already configured as ID "' + saved + '". ' +
      'No database was created and the property was not changed. Recover or inspect the configured database first.'
    );
  }

  const ss = SpreadsheetApp.create('Rojgar Vigyapan Admin Database');
  try {
    rvhEnsureSheet_(ss, RVH.POSTS, RVH_POST_HEADERS);
    rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS);
    const boxes = rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS);
    boxes.getRange(2, 1, RVH_DEFAULT_BOXES.length, RVH_BOX_HEADERS.length).setValues(RVH_DEFAULT_BOXES);
  } catch (error) {
    throw new Error(
      'A new spreadsheet was created, but initialization failed. ' +
      'The Script Property was not changed. New spreadsheet ID: "' + ss.getId() + '". ' +
      'Original error: ' + String(error && error.message || error)
    );
  }

  props.setProperty(RVH.DB_KEY, ss.getId());
  const result = {
    created: true,
    databaseId: ss.getId(),
    spreadsheetTitle: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    defaultBoxesRestored: RVH_DEFAULT_BOXES.length
  };
  Logger.log('Explicit Admin database creation result: %s', JSON.stringify(result));
  return result;
}

/**
 * Developer-only recovery action. It restores defaults only when Boxes has no
 * data rows, and never reads or writes Posts or Label History.
 */
function restoreDefaultRojgarBoxesSafely_() {
  const ss = rvhGetDatabase_();
  const existingSheet = ss.getSheetByName(RVH.BOXES);
  // Be conservative: a formula-bearing row can display an empty value but is
  // still occupied and must block restoration.
  const existingRows = existingSheet ? Math.max(0, existingSheet.getLastRow() - 1) : 0;
  if (existingRows > 0) {
    throw new Error(
      'Boxes already contains ' + existingRows + ' data row(s). ' +
      'Default restore refused; no data was changed.'
    );
  }

  const boxes = rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS);
  boxes.getRange(2, 1, RVH_DEFAULT_BOXES.length, RVH_BOX_HEADERS.length).setValues(RVH_DEFAULT_BOXES);
  CacheService.getScriptCache().remove('RVH_PUBLIC_BOOTSTRAP');
  const result = {
    restored: true,
    databaseId: ss.getId(),
    restoredRowCount: RVH_DEFAULT_BOXES.length,
    restoredRows: rvhDefaultBoxObjects_()
  };
  Logger.log('Safe default Boxes restore result: %s', JSON.stringify(result));
  return result;
}

/** Read-only developer inspection. This function never creates sheets. */
function inspectRojgarAdminDatabaseState_() {
  const props = PropertiesService.getScriptProperties();
  const configuredId = String(props.getProperty(RVH.DB_KEY) || '').trim();
  const ss = rvhGetDatabase_();
  const posts = ss.getSheetByName(RVH.POSTS);
  const history = ss.getSheetByName(RVH.HISTORY);
  const boxes = ss.getSheetByName(RVH.BOXES);
  const boxRows = rvhSheetDataRowCount_(boxes);
  const boxesLastRow = boxes ? boxes.getLastRow() : 0;
  const result = {
    configuredDatabaseId: configuredId,
    spreadsheetTitle: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    postsRowCount: rvhSheetDataRowCount_(posts),
    labelHistoryRowCount: rvhSheetDataRowCount_(history),
    boxesRowCount: boxRows,
    boxesSheetExists: !!boxes,
    boxesEmpty: !!boxes && boxesLastRow === 0,
    boxesHeaderOnly: !!boxes && boxesLastRow === 1,
    defaultRestoreSafe: !boxes || boxesLastRow <= 1,
    defaultRowsIfRestored: rvhDefaultBoxObjects_()
  };
  Logger.log('Admin database inspection: %s', JSON.stringify(result));
  return result;
}

function setupLabelHistorySystem() {
  const password = String(PropertiesService.getScriptProperties().getProperty(RVH.ADMIN_PASSWORD_KEY) || '').trim();
  if (password.length < 10) {
    throw new Error('Script Property RV_ADMIN_PASSWORD में कम से कम 10 characters का strong password डालें।');
  }
  const ss = rvhGetDatabase_();
  rvhEnsureSheet_(ss, RVH.POSTS, RVH_POST_HEADERS);
  rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS);
  const boxes = rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS);
  if (boxes.getLastRow() < 2) {
    boxes.getRange(2, 1, RVH_DEFAULT_BOXES.length, RVH_BOX_HEADERS.length).setValues(RVH_DEFAULT_BOXES);
  }
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === RVH.SYNC_TRIGGER) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(RVH.SYNC_TRIGGER).timeBased().everyMinutes(10).create();
  syncLabelHistory();
  Logger.log('Label History system ready. Database: %s', ss.getUrl());
  Logger.log('अब Deploy > New deployment > Web app करें।');
}

function syncLabelHistory() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const ss = rvhGetDatabase_();
    // Sync is deliberately scoped to Posts and Label History. It must never
    // open, initialize, clear or rewrite the Boxes sheet.
    const postSheet = rvhEnsureSheet_(ss, RVH.POSTS, RVH_POST_HEADERS);
    const historySheet = rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS);
    const existingPosts = rvhRowsAsObjects_(postSheet);
    const existingHistory = rvhRowsAsObjects_(historySheet);
    const postMap = {};
    const historyMap = {};
    existingPosts.forEach(function(row) { postMap[String(row.postId)] = row; });
    existingHistory.forEach(function(row) { historyMap[rvhHistoryKey_(row.postId, row.label)] = row; });

    const now = new Date().toISOString();
    const livePosts = rvhFetchAllLivePosts_();
    const livePostIds = {};
    livePosts.forEach(function(post) {
      const postId = String(post.id);
      livePostIds[postId] = true;
      const labels = rvhUniqueLabels_(post.labels || []);
      const priorPost = postMap[postId];
      postMap[postId] = {
        postId: postId,
        url: post.url || '',
        currentTitle: post.title || 'Untitled Post',
        publishedAt: post.published || '',
        updatedAt: post.updated || '',
        currentLabels: JSON.stringify(labels),
        lastSyncAt: now
      };

      const activeLabelMap = {};
      labels.forEach(function(label) {
        const key = rvhHistoryKey_(postId, label);
        activeLabelMap[key] = true;
        const prior = historyMap[key];
        if (!prior) {
          historyMap[key] = {
            postId: postId,
            label: label,
            snapshotTitle: post.title || 'Untitled Post',
            labelAddedAt: priorPost ? now : (post.published || now),
            originalPublishedAt: post.published || now,
            manualOrder: '',
            pinned: false,
            hidden: false,
            active: true,
            url: post.url || ''
          };
        } else if (!rvhBool_(prior.active)) {
          prior.snapshotTitle = post.title || prior.snapshotTitle || 'Untitled Post';
          prior.labelAddedAt = now;
          prior.active = true;
          prior.hidden = false;
          prior.url = post.url || prior.url;
        } else {
          prior.active = true;
          prior.url = post.url || prior.url;
        }
      });

      Object.keys(historyMap).forEach(function(key) {
        const row = historyMap[key];
        if (String(row.postId) === postId && !activeLabelMap[key]) row.active = false;
      });
    });

    Object.keys(historyMap).forEach(function(key) {
      if (!livePostIds[String(historyMap[key].postId)]) historyMap[key].active = false;
    });

    rvhWriteObjects_(postSheet, RVH_POST_HEADERS, Object.keys(postMap).map(function(key) { return postMap[key]; }));
    rvhWriteObjects_(historySheet, RVH_HISTORY_HEADERS, Object.keys(historyMap).map(function(key) { return historyMap[key]; }));
    CacheService.getScriptCache().remove('RVH_PUBLIC_BOOTSTRAP');
    Logger.log('Label history synced: %s live posts, %s label snapshots.', livePosts.length, Object.keys(historyMap).length);
  } finally {
    lock.releaseLock();
  }
}

function syncLabelHistorySafe_() {
  try { syncLabelHistory(); }
  catch (error) { Logger.log('Label history sync skipped: %s', error.message); }
}

function doGet(e) {
  const action = String(e && e.parameter && e.parameter.action || '').toLowerCase();
  if (action === 'approveupdate') {
    return handleRojgarUpdateApprovalRequest_(e);
  }
  if (action === 'feed' || action === 'bootstrap' || action === 'labels') {
    const payload = action === 'feed'
      ? rvhPublicFeed_(e.parameter)
      : (action === 'labels' ? { labels: rvhLabelSummary_() } : rvhPublicBootstrap_());
    return rvhJsonOrJsonp_(payload, e.parameter.callback);
  }
  return HtmlService.createTemplateFromFile('AdminPanel')
    .evaluate()
    .setTitle('Rojgar Vigyapan Admin')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function loginRojgarAdmin(password) {
  const expected = String(PropertiesService.getScriptProperties().getProperty(RVH.ADMIN_PASSWORD_KEY) || '');
  if (!expected || !rvhConstantTimeEqual_(String(password || ''), expected)) {
    Utilities.sleep(500);
    throw new Error('Password गलत है।');
  }
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(RVH.SESSION_PREFIX + rvhHash_(token), '1', RVH.SESSION_SECONDS);
  return { token: token, expiresIn: RVH.SESSION_SECONDS };
}

function getRojgarAdminDashboard(token) {
  rvhRequireAdmin_(token);
  const ss = rvhGetDatabase_();
  const boxes = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS));
  const posts = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.POSTS, RVH_POST_HEADERS));
  const history = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS));
  history.sort(function(a, b) { return Date.parse(b.labelAddedAt || 0) - Date.parse(a.labelAddedAt || 0); });
  return {
    boxes: boxes.sort(function(a, b) { return Number(a.sortOrder || 0) - Number(b.sortOrder || 0); }),
    labels: rvhLabelSummaryFromRows_(history, boxes),
    history: history.slice(0, 1000),
    posts: posts,
    postCount: posts.length,
    spreadsheetUrl: ss.getUrl()
  };
}

function saveRojgarBox(token, box) {
  rvhRequireAdmin_(token);
  const clean = {
    boxKey: rvhKey_(box.boxKey),
    heading: String(box.heading || '').trim(),
    sourceLabel: String(box.sourceLabel || '').trim(),
    enabled: rvhBool_(box.enabled),
    postLimit: Math.max(1, Math.min(100, Number(box.postLimit || 15))),
    sortOrder: Number(box.sortOrder || 0)
  };
  if (!clean.boxKey || !clean.heading || !clean.sourceLabel) throw new Error('Box key, heading और source label जरूरी हैं।');
  const sheet = rvhEnsureSheet_(rvhGetDatabase_(), RVH.BOXES, RVH_BOX_HEADERS);
  rvhUpsertObject_(sheet, RVH_BOX_HEADERS, 'boxKey', clean);
  CacheService.getScriptCache().remove('RVH_PUBLIC_BOOTSTRAP');
  return getRojgarAdminDashboard(token);
}

function saveRojgarHistoryEntry(token, entry) {
  rvhRequireAdmin_(token);
  const postId = String(entry.postId || '').trim();
  const label = String(entry.label || '').trim();
  if (!postId || !label) throw new Error('Post ID और label जरूरी हैं।');
  const sheet = rvhEnsureSheet_(rvhGetDatabase_(), RVH.HISTORY, RVH_HISTORY_HEADERS);
  const rows = rvhRowsAsObjects_(sheet);
  const target = rows.filter(function(row) { return String(row.postId) === postId && String(row.label).toLowerCase() === label.toLowerCase(); })[0];
  if (!target) throw new Error('Label history entry नहीं मिली। पहले Sync चलाएँ।');
  target.snapshotTitle = String(entry.snapshotTitle || target.snapshotTitle).trim();
  target.manualOrder = entry.manualOrder === '' || entry.manualOrder == null ? '' : Number(entry.manualOrder);
  target.pinned = rvhBool_(entry.pinned);
  target.hidden = rvhBool_(entry.hidden);
  rvhWriteObjects_(sheet, RVH_HISTORY_HEADERS, rows);
  CacheService.getScriptCache().remove('RVH_PUBLIC_BOOTSTRAP');
  return getRojgarAdminDashboard(token);
}

function changeRojgarPostLabels(token, postId, labels) {
  rvhRequireAdmin_(token);
  const config = rvhBloggerConfig_();
  const post = getBloggerPost_(String(postId), config);
  const cleanLabels = rvhUniqueLabels_(Array.isArray(labels) ? labels : String(labels || '').split(','));
  if (!cleanLabels.length) throw new Error('कम से कम एक label रखें।');
  updateBloggerPost_(String(postId), {
    kind: 'blogger#post',
    blog: { id: String(getBlogId_(config.blogUrl)) },
    title: post.title,
    content: post.content,
    labels: cleanLabels
  }, config);
  syncLabelHistory();
  return getRojgarAdminDashboard(token);
}

/** Rename one Blogger label everywhere while preserving label history. */
function renameRojgarLabel(token, oldLabel, newLabel) {
  rvhRequireAdmin_(token);
  oldLabel = String(oldLabel || '').trim();
  newLabel = String(newLabel || '').trim();
  if (!oldLabel || !newLabel) throw new Error('पुराना और नया label name जरूरी है।');
  if (oldLabel.toLowerCase() === newLabel.toLowerCase()) throw new Error('नया label पुराने label से अलग होना चाहिए।');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('दूसरा sync चल रहा है। 30 seconds बाद फिर कोशिश करें।');
  let renamedCount = 0;
  try {
    const ss = rvhGetDatabase_();
    const postSheet = rvhEnsureSheet_(ss, RVH.POSTS, RVH_POST_HEADERS);
    const historySheet = rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS);
    const boxSheet = rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS);
    const posts = rvhRowsAsObjects_(postSheet);
    const affected = posts.filter(function(row) {
      let labels = [];
      try { labels = JSON.parse(row.currentLabels || '[]'); } catch (error) {}
      return labels.some(function(label) { return String(label).toLowerCase() === oldLabel.toLowerCase(); });
    });
    if (!affected.length) throw new Error('इस नाम का active Blogger label किसी post में नहीं मिला।');

    const config = rvhBloggerConfig_();
    const updatedPostIds = {};
    const failures = [];
    affected.forEach(function(row) {
      try {
        const post = getBloggerPost_(String(row.postId), config);
        const labels = rvhUniqueLabels_((post.labels || []).map(function(label) {
          return String(label).toLowerCase() === oldLabel.toLowerCase() ? newLabel : label;
        }));
        rvhPatchBloggerLabels_(String(row.postId), labels, config);
        updatedPostIds[String(row.postId)] = true;
        renamedCount++;
      } catch (error) {
        failures.push(String(row.currentTitle || row.postId) + ': ' + error.message);
      }
    });

    const history = rvhRowsAsObjects_(historySheet);
    history.forEach(function(row) {
      const postId = String(row.postId);
      if (!updatedPostIds[postId] || String(row.label).toLowerCase() !== oldLabel.toLowerCase()) return;
      const existingNew = history.some(function(other) {
        return other !== row && String(other.postId) === postId && String(other.label).toLowerCase() === newLabel.toLowerCase();
      });
      if (existingNew) row.active = false;
      else row.label = newLabel;
    });
    rvhWriteObjects_(historySheet, RVH_HISTORY_HEADERS, history);

    if (!failures.length) {
      const boxes = rvhRowsAsObjects_(boxSheet);
      boxes.forEach(function(box) {
        if (String(box.sourceLabel).toLowerCase() === oldLabel.toLowerCase()) box.sourceLabel = newLabel;
      });
      rvhWriteObjects_(boxSheet, RVH_BOX_HEADERS, boxes);
    }
    CacheService.getScriptCache().remove('RVH_PUBLIC_BOOTSTRAP');
    if (failures.length) throw new Error(renamedCount + ' posts update हुए, लेकिन कुछ posts fail हुए: ' + failures.slice(0, 3).join(' | '));
  } finally {
    lock.releaseLock();
  }

  syncLabelHistory();
  const dashboard = getRojgarAdminDashboard(token);
  dashboard.message = oldLabel + ' को ' + newLabel + ' में rename किया गया। ' + renamedCount + ' posts update हुईं।';
  return dashboard;
}

function rvhPatchBloggerLabels_(postId, labels, config) {
  const blogId = getBlogId_(config.blogUrl);
  const endpoint = 'https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(blogId) + '/posts/' + encodeURIComponent(postId);
  const response = googleFetch_(endpoint, {
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify({ labels: labels })
  });
  return JSON.parse(response.getContentText());
}

function runRojgarHistorySync(token) {
  rvhRequireAdmin_(token);
  syncLabelHistory();
  return getRojgarAdminDashboard(token);
}

function rvhPublicBootstrap_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('RVH_PUBLIC_BOOTSTRAP');
  if (cached) return JSON.parse(cached);
  const ss = rvhGetDatabase_();
  const boxes = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS))
    .sort(function(a, b) { return Number(a.sortOrder || 0) - Number(b.sortOrder || 0); });
  const result = { ok: true, boxes: boxes, generatedAt: new Date().toISOString() };
  cache.put('RVH_PUBLIC_BOOTSTRAP', JSON.stringify(result), 300);
  return result;
}

function rvhPublicFeed_(params) {
  const label = String(params && params.label || '').trim();
  const limit = Math.max(1, Math.min(500, Number(params && params.limit || 15)));
  const ss = rvhGetDatabase_();
  const history = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS));
  const posts = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.POSTS, RVH_POST_HEADERS));
  const postMap = {};
  posts.forEach(function(row) { postMap[String(row.postId)] = row; });
  let rows;
  if (label === '*') {
    const latestByPost = {};
    history.forEach(function(row) {
      if (!rvhBool_(row.active) || rvhBool_(row.hidden)) return;
      const id = String(row.postId);
      if (!latestByPost[id] || Date.parse(row.labelAddedAt || 0) > Date.parse(latestByPost[id].labelAddedAt || 0)) latestByPost[id] = row;
    });
    rows = Object.keys(latestByPost).map(function(id) { return latestByPost[id]; });
  } else {
    rows = history.filter(function(row) {
      return String(row.label).toLowerCase() === label.toLowerCase() && rvhBool_(row.active) && !rvhBool_(row.hidden);
    });
  }
  rows.sort(rvhHistorySort_);
  return {
    ok: true,
    label: label,
    total: rows.length,
    entries: rows.slice(0, limit).map(function(row) {
      const post = postMap[String(row.postId)] || {};
      let labels = [];
      try { labels = JSON.parse(post.currentLabels || '[]'); } catch (error) {}
      return {
        id: String(row.postId),
        title: String(row.snapshotTitle || post.currentTitle || 'Untitled Post'),
        url: String(row.url || post.url || '#'),
        published: String(row.labelAddedAt || row.originalPublishedAt || ''),
        originalPublished: String(row.originalPublishedAt || post.publishedAt || ''),
        labels: labels,
        pinned: rvhBool_(row.pinned)
      };
    })
  };
}

function rvhLabelSummary_() {
  const ss = rvhGetDatabase_();
  const history = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.HISTORY, RVH_HISTORY_HEADERS));
  const boxes = rvhRowsAsObjects_(rvhEnsureSheet_(ss, RVH.BOXES, RVH_BOX_HEADERS));
  return rvhLabelSummaryFromRows_(history, boxes);
}

function rvhLabelSummaryFromRows_(history, boxes) {
  const map = {};
  history.forEach(function(row) {
    if (!rvhBool_(row.active)) return;
    const label = String(row.label || '').trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (!map[key]) map[key] = { label: label, postCount: 0, latestAddedAt: '', usedByBoxes: [] };
    map[key].postCount++;
    if (Date.parse(row.labelAddedAt || 0) > Date.parse(map[key].latestAddedAt || 0)) map[key].latestAddedAt = row.labelAddedAt;
  });
  (boxes || []).forEach(function(box) {
    const key = String(box.sourceLabel || '').toLowerCase();
    if (map[key]) map[key].usedByBoxes.push(box.heading || box.boxKey);
  });
  const normalized = {};
  Object.keys(map).forEach(function(key) {
    const compact = key.replace(/[^a-z0-9\u0900-\u097f]+/g, '');
    normalized[compact] = normalized[compact] || [];
    normalized[compact].push(map[key].label);
  });
  return Object.keys(map).map(function(key) {
    const item = map[key];
    const compact = key.replace(/[^a-z0-9\u0900-\u097f]+/g, '');
    item.possibleDuplicates = normalized[compact].filter(function(label) { return label !== item.label; });
    item.unused = item.usedByBoxes.length === 0;
    return item;
  }).sort(function(a, b) { return a.label.localeCompare(b.label); });
}

function rvhFetchAllLivePosts_() {
  const config = rvhBloggerConfig_();
  const blogId = getBlogId_(config.blogUrl);
  const all = [];
  let pageToken = '';
  do {
    let endpoint = 'https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(blogId) +
      '/posts?status=live&view=ADMIN&fetchBodies=false&fetchImages=false&maxResults=100&orderBy=published';
    if (pageToken) endpoint += '&pageToken=' + encodeURIComponent(pageToken);
    const data = JSON.parse(googleFetch_(endpoint, { method: 'get' }).getContentText());
    (data.items || []).forEach(function(post) { all.push(post); });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

function rvhBloggerConfig_() {
  return { blogUrl: normalizeBlogUrl_(PropertiesService.getScriptProperties().getProperty('BLOG_URL') || RV.BLOG_URL) };
}

function rvhGetDatabase_() {
  const props = PropertiesService.getScriptProperties();
  const saved = String(props.getProperty(RVH.DB_KEY) || '').trim();
  if (!saved) {
    throw new Error(
      'Admin database is not configured. Set Script Property ' + RVH.DB_KEY +
      ' to the recovered spreadsheet ID, or run createRojgarAdminDatabaseExplicitly_() only for a genuinely new installation.'
    );
  }
  try {
    return SpreadsheetApp.openById(saved);
  } catch (error) {
    throw new Error(
      'Admin database with saved ID "' + saved + '" could not be opened. ' +
      'No replacement database was created and ' + RVH.DB_KEY + ' was not changed. ' +
      'Restore spreadsheet access or recover the correct database ID. Original error: ' +
      String(error && error.message || error)
    );
  }
}

function rvhSheetDataRowCount_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const rowCount = sheet.getLastRow() - 1;
  const columnCount = Math.max(1, sheet.getLastColumn());
  return sheet.getRange(2, 1, rowCount, columnCount).getValues().filter(function(row) {
    return row.some(function(value) { return value !== ''; });
  }).length;
}

function rvhDefaultBoxObjects_() {
  return RVH_DEFAULT_BOXES.map(function(row) {
    const object = {};
    RVH_BOX_HEADERS.forEach(function(header, index) { object[header] = row[index]; });
    return object;
  });
}

function rvhEnsureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
    headers.forEach(function(header, index) { if (current[index] !== header) sheet.getRange(1, index + 1).setValue(header); });
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function rvhRowsAsObjects_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(String);
  return values.filter(function(row) { return row.some(function(value) { return value !== ''; }); }).map(function(row) {
    const object = {};
    headers.forEach(function(header, index) { object[header] = row[index]; });
    return object;
  });
}

function rvhWriteObjects_(sheet, headers, objects) {
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
  if (!objects.length) return;
  const values = objects.map(function(object) { return headers.map(function(header) { return object[header] == null ? '' : object[header]; }); });
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function rvhUpsertObject_(sheet, headers, keyName, object) {
  const rows = rvhRowsAsObjects_(sheet);
  const key = String(object[keyName]);
  let found = false;
  rows.forEach(function(row, index) { if (String(row[keyName]) === key) { rows[index] = object; found = true; } });
  if (!found) rows.push(object);
  rvhWriteObjects_(sheet, headers, rows);
}

function rvhHistorySort_(a, b) {
  const pin = Number(rvhBool_(b.pinned)) - Number(rvhBool_(a.pinned));
  if (pin) return pin;
  const ao = a.manualOrder === '' || a.manualOrder == null ? null : Number(a.manualOrder);
  const bo = b.manualOrder === '' || b.manualOrder == null ? null : Number(b.manualOrder);
  if (ao != null || bo != null) {
    if (ao == null) return 1;
    if (bo == null) return -1;
    if (ao !== bo) return ao - bo;
  }
  return Date.parse(b.labelAddedAt || 0) - Date.parse(a.labelAddedAt || 0);
}

function rvhHistoryKey_(postId, label) { return String(postId) + '::' + String(label || '').trim().toLowerCase(); }
function rvhKey_(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function rvhBool_(value) { return value === true || String(value).toLowerCase() === 'true' || String(value) === '1'; }
function rvhUniqueLabels_(labels) {
  const result = [], seen = {};
  (labels || []).forEach(function(raw) { const label = String(raw || '').trim(); const key = label.toLowerCase(); if (label && !seen[key]) { seen[key] = true; result.push(label); } });
  return result;
}

function rvhRequireAdmin_(token) {
  const key = RVH.SESSION_PREFIX + rvhHash_(String(token || ''));
  if (!token || CacheService.getScriptCache().get(key) !== '1') throw new Error('Admin session expire हो गई है। दोबारा login करें।');
  CacheService.getScriptCache().put(key, '1', RVH.SESSION_SECONDS);
}

function rvhHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8).map(function(byte) {
    const number = byte < 0 ? byte + 256 : byte;
    return ('0' + number.toString(16)).slice(-2);
  }).join('');
}

function rvhConstantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function rvhJsonOrJsonp_(payload, callback) {
  const json = JSON.stringify(payload);
  const safeCallback = String(callback || '').match(/^[A-Za-z_$][\w$\.]*$/) ? String(callback) : '';
  return ContentService.createTextOutput(safeCallback ? safeCallback + '(' + json + ');' : json)
    .setMimeType(safeCallback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
