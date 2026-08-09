ROJGAR VIGYAPAN V4 — FREE DISCOVERY + GEMINI + BLOGGER DRAFT

V4 ka flow:
GitHub Actions (free public repo) -> SarkariResult category pages -> feed.json
Apps Script -> feed.json -> individual source page -> Gemini API -> Blogger Draft

IMPORTANT:
- Automatic publish nahi hota. Draft-only flow same hai.
- Gemini API key chat me share mat karein.
- GitHub repo PUBLIC rakhein, taki raw feed URL Apps Script read kar sake.

STEP 1 — GitHub par naya PUBLIC repository banayein
Suggested name: rojgar-vigyapan-feed

STEP 2 — Is ZIP ke ye files same structure me upload karein:
collector.py
requirements.txt
feed.json
.github/workflows/update-feed.yml

STEP 3 — GitHub Actions open karein
Repo -> Actions -> "Update SarkariResult Feed" -> Run workflow
Run successful hone ke baad repo ke feed.json ko open karein.
Usme items ke andar SarkariResult URLs dikhne chahiye.

STEP 4 — Raw feed URL banayein
Format:
https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME/main/feed.json
Example:
https://raw.githubusercontent.com/abc/rojgar-vigyapan-feed/main/feed.json

STEP 5 — Apps Script Project Settings -> Script Properties
Property add karein:
DISCOVERY_FEED_URL = raw feed URL

Already required:
GEMINI_API_KEY = aapki Gemini API key

STEP 6 — Apps Script me Code.gs replace karein
Code_Gemini_v4.gs ka poora code Code.gs me paste karke Save karein.
appsscript.json ko change na karein.

STEP 7 — TEST
Pehle testAutomationNow run karein.
Expected log:
V4 discovery feed: X URLs received, X accepted.
Uske baad Gemini call aur Blogger draft creation honi chahiye.

STEP 8 — Jab test draft sahi ban jaye
setupAutomation run karein.
Ye current feed ko baseline save karega aur hourly trigger create karega.
Uske baad new source URLs hi Blogger drafts banenge.

SAFETY:
setupAutomation tabhi run karein jab feed.json me proper URLs aa rahe hon.
V4 zero-result condition me purani baseline overwrite nahi karta.
