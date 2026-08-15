const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const currentCode = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
const headCode = childProcess.execFileSync('git', ['show', 'HEAD:Code.gs'], {
  cwd: root,
  encoding: 'utf8'
}).replace(/\r\n/g, '\n');

function topLevelFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

[
  'detectCurrentLifecycleLabel_',
  'lifecycleLabelFromText_',
  'canonicalLifecycleLabel_',
  'mergeBloggerLabels_',
  'importantLinkRejectionReason_',
  'isCollectorApprovedLinkNoise_',
  'generatePostWithGemini_',
  'buildLockedRojgarHtml_',
  'groupConsecutiveSourceLinks_',
  'sanitizeImportantLinkDisplayLabel_',
  'sourceLinkRows_',
  'insertBloggerDraft_',
  'applyApprovedUpdates_',
  'applyPendingReviewUpdate_',
  'handleRojgarUpdateApprovalRequest_',
  'approveRojgarUpdateRequest_',
  'buildUpdateApprovalToken_',
  'isValidUpdateApprovalToken_'
].forEach(name => {
  assert.strictEqual(topLevelFunction(currentCode, name), topLevelFunction(headCode, name), `${name} changed unexpectedly`);
});

[
  'Admin.gs',
  'AdminPanel.html',
  'appsscript.json',
  'feed.json',
  'Code_Gemini_v4.gs',
  '.github/workflows/update-feed.yml'
].forEach(file => {
  const current = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const committed = childProcess.execFileSync('git', ['show', `HEAD:${file}`], {
    cwd: root,
    encoding: 'utf8'
  }).replace(/\r\n/g, '\n');
  assert.strictEqual(current, committed, `${file} changed unexpectedly`);
});

console.log('PASS protected Admin, workflow, renderer, Important Links, lifecycle, draft-only, and approval code is unchanged');
