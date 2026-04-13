# Housing Counseling App — Developer Guide

> Written for a first-year developer. Assumes you know what HTML, JavaScript, and a database are, but not necessarily Firebase or this specific app.

---

## What this app is

A case management tool for Housing Opportunities Inc. housing counselors. Counselors log client intake, track counseling sessions, monitor Closing Cost Assistance (CCA / "Buyer Ready") and Home Improvement Grant (HIG) waitlists, and close files with outcome data. The Executive Director has extra tools: settings, reporting, data normalization, and duplicate detection.

---

## Tech stack — the short version

| Layer | What it is | Why |
|---|---|---|
| **Firebase Auth** | Handles login / Google sign-in | No password database to manage |
| **Firestore** | NoSQL cloud database | Real-time, no server needed |
| **Firebase Hosting** | Serves the HTML/JS files | Simple, fast, free tier |
| **Plain HTML + JS modules** | The frontend | No React, no bundler, no build step |
| **Google Drive Picker API** | Lets counselors link Drive folders | Files stay in their existing Drive |

There is **no backend server**. The browser talks directly to Firebase. Security is enforced through Firestore Rules (see `firestore.rules`).

---

## Project structure

```
housing-counseling-app/
├── public/                   ← everything the browser sees
│   ├── index.html            ← login page
│   ├── clients.html          ← "Counseling Log" — main client list
│   ├── client.html           ← individual client profile
│   ├── new-client.html       ← create a new client + first session
│   ├── cca-list.html         ← "Buyer Ready" — CCA tracking list
│   ├── hig-waitlist.html     ← HIG grant waitlist with priority scoring
│   ├── operations.html       ← static step-by-step guidance for counselors
│   ├── reports.html          ← summary reports
│   ├── settings.html         ← ED-only: counselors, normalization, duplicate scan
│   ├── import.html           ← admin-only: bulk CSV import
│   ├── css/
│   │   └── app.css           ← all styles; color variables are at the top
│   ├── img/
│   │   └── logo.png          ← the nav logo
│   └── js/
│       ├── firebase-config.js  ← Firebase project credentials — DO NOT EDIT
│       ├── auth.js             ← login, roles, and the nav bar
│       ├── data.js             ← all dropdown lists and constants
│       ├── clients.js          ← logic for clients.html
│       ├── client.js           ← logic for client.html (most complex file)
│       ├── new-client.js       ← logic for new-client.html
│       ├── cca-list.js         ← logic for cca-list.html
│       ├── hig-waitlist.js     ← logic for hig-waitlist.html (includes scoring)
│       ├── settings.js         ← ED settings, normalizers, duplicate scanner
│       ├── reports.js          ← reports page
│       ├── log.js              ← legacy counseling log (counselingLog collection)
│       ├── new-entry.js        ← legacy new entry form
│       ├── edit-entry.js       ← legacy edit entry form
│       ├── import.js           ← CSV import logic
│       ├── picker.js           ← Google Drive file/folder picker
│       ├── login.js            ← login page logic
│       └── dashboard.js        ← dashboard (if used)
├── firestore.rules             ← who can read/write what in the database
├── firebase.json               ← Firebase Hosting config
├── .firebaserc                 ← which Firebase project to deploy to
└── scripts/
    ├── migrate-clients.js      ← one-time: grouped counselingLog → clients
    └── fix-dates.js            ← one-time: corrected wrong UTC dates
```

---

## How Firebase works (the mental model)

Think of **Firestore** as a set of folders (called **collections**) that each contain **documents** (like rows in a spreadsheet, but as JSON objects). Each document has a random auto-generated ID.

```
Firestore
├── clients/              ← collection (like a table)
│   ├── abc123/           ← document (one client)
│   │   ├── clientName: "Sharon Bible"
│   │   ├── counselingType: "PRE"
│   │   └── sessions/     ← subcollection (belongs to this client)
│   │       ├── xyz789/   ← document (one session)
│   │       │   ├── date: ...
│   │       │   └── hours: 4
│   │       └── ...
│   └── ...
├── counselors/           ← collection
├── ccaList/              ← collection
├── higWaitlist/          ← collection
├── counselingLog/        ← LEGACY collection (old flat records, kept as backup)
├── users/                ← collection (one doc per user, stores role)
└── config/
    ├── higWeights        ← HIG priority scoring weights
    └── billing           ← default and court billing rates
```

The browser imports Firebase's JS SDK directly from a CDN (no npm install needed). Every `await getDocs(...)` is a network call to Firestore.

---

## Authentication and roles

### How login works

1. User clicks "Sign in with Google" on `index.html`
2. Firebase Auth opens a Google popup — it handles passwords, tokens, everything
3. The app checks that the email ends in `@housingopps.org` — if not, signs them out immediately
4. The app reads the user's doc from the `users` collection to get their **role**
5. If no doc exists yet, the user gets the default role: `counselor`

**To change who can log in:** edit `login.js` — look for the `@housingopps.org` check.

**To change a user's role:** go to the Firebase Console → Firestore → `users` collection → find the user's document → change the `role` field.

### Roles

| Role | What they can do |
|---|---|
| `counselor` | View/add clients assigned to them, close their own files |
| `admin` | Everything a counselor can, plus Import and Settings |
| `executive_director` | Everything, including Settings (ED-only tools), can close any file |

### The auth pattern (used on every page)

```js
// In every page's JS file at the top:
requireAuth((user, profile) => {
  // This runs only after a verified, signed-in user is confirmed.
  // 'user' is the Firebase Auth user object (has user.uid, user.email).
  // 'profile' is the Firestore users/{uid} document (has profile.name, profile.role).
  setupNav(profile, 'page-name'); // builds the nav bar and highlights the active link
});
```

If the user isn't signed in, `requireAuth` redirects to `index.html` automatically.

**To guard a page to admins only:** use `requireAdmin(...)` instead.
**To guard a page to ED only:** use `requireED(...)` instead.

---

## The nav bar

The nav is built entirely in `auth.js → setupNav()`. Every page calls `setupNav(profile, 'page-name')` and the function injects the nav HTML into the `<nav class="nav">` element.

**To add a new nav link:**
1. Add an `<a>` tag inside the `nav.innerHTML` template in `auth.js`
2. Give it `data-page="your-page-name"` and `href="your-page.html"`
3. Call `setupNav(profile, 'your-page-name')` in your page's JS — this makes the link highlight as active
4. If the link should only show for admins, add `class="admin-only hidden"` — the code will un-hide it for admins

---

## Data model — field-by-field

### `clients` collection

The main client record. One document per unique client.

| Field | Type | What it means |
|---|---|---|
| `clientName` | string | Full name, always stored Title Case |
| `counselingType` | string | One of: `PRE`, `POST`, `OUTSTANDING`, `COURT` |
| `counselor` | string | Counselor's full name (from the `counselors` collection) |
| `guarantor` | string | Funding guarantor (e.g., HEMAP, PHFA) |
| `zipCode` | string | Client's zip code |
| `rxNumbers` | array of strings | All Rx/case numbers for this client |
| `amiPercent` | string | Income level: Extremely Low / Low / Moderate / Non Low-Moderate |
| `reCode` | string | Race & ethnicity code (see `data.js → RE_CODES`) |
| `hispanic` | boolean | Hispanic/Latino flag |
| `femaleHeaded` | boolean | Female-headed household flag |
| `areasOfInterest` | array of strings | PRE only — counties/areas the client is looking in |
| `driveFolderId` | string | Google Drive folder ID |
| `driveFolderName` | string | Display name of the linked folder |
| `driveFolderUrl` | string | Direct URL to open the folder |
| `status` | string | `active` or `closed` |
| `closureDate` | timestamp | When the file was closed |
| `closureOutcome` | string | Notes written at closure |
| `closureOutcomeValue` | number | Final dollar outcome at closure (loan mod amount, grant, etc.) |
| `closureAwardType` | string | Type of outcome (Direct Assistance, Loan Modification, etc.) |
| `totalDownPayment` | number | PRE/CCA: total down payment amount |
| `ccaAmountProvided` | number | PRE/CCA: how much assistance was provided |
| `sessionCount` | number | **Denormalized** — auto-updated count of sessions (avoids extra DB reads) |
| `totalOutcomeValue` | number | **Denormalized** — sum of session-level dollarsAwarded (legacy, from migration) |
| `firstSessionDate` | timestamp | **Denormalized** — earliest session date |
| `lastSessionDate` | timestamp | **Denormalized** — most recent session date (used for sorting) |
| `createdAt` | timestamp | When this record was created |
| `updatedAt` | timestamp | Last time anything changed |

> **What "denormalized" means:** Instead of counting sessions every time you load the list, we store the count directly on the client doc and update it whenever sessions change. It's faster but means you have to keep it in sync — see `refreshClientDenormalized()` in `client.js`.

### `clients/{id}/sessions` subcollection

One document per counseling session.

| Field | Type | What it means |
|---|---|---|
| `date` | timestamp | Date of the session |
| `counselor` | string | Who ran the session |
| `rxNumber` | string | Rx/case number for this specific session |
| `hours` | number | Duration of the session |
| `dollarsAwarded` | number | Legacy: outcome value per session (kept for migrated data) |
| `awardType` | string | Legacy: outcome type per session |
| `dollarsFor` | string | What the money was for |
| `caseStatus` | string | Free text status note |
| `outcome` | string | Free text outcome note |
| `notes` | string | General notes |
| `sourceMonth` | string | Legacy: month string (e.g., "January") |
| `counselingLogId` | string | Legacy: ID of the original counselingLog record this came from |
| `createdAt` | timestamp | When this session was logged |
| `updatedAt` | timestamp | Last edit |

### `counselors` collection

Simple list of counselors for the dropdown menus.

| Field | What it means |
|---|---|
| `name` | Full name (what appears in dropdowns) |
| `active` | `true` = shows in dropdowns; `false` = hidden (fired/left) |
| `createdAt` | When they were added |

### `ccaList` collection

Clients enrolled in Closing Cost Assistance ("Buyer Ready").

| Field | What it means |
|---|---|
| `counselingLogId` | Links back to the original counselingLog entry that triggered enrollment |
| `clientName` | Copied from the source record at enrollment time |
| `counselor` | Copied at enrollment time |
| `amiPercent` | Income level |
| `closingDate` | Target closing date |
| `ccaAmount` | Dollar amount of assistance |
| `status` | eligible → applied → approved → funded → closed |
| `driveFolderId/Name/Url` | Linked Drive folder |
| `enrolledAt` | When they were added to this list |

### `higWaitlist` collection

Clients on the Home Improvement Grant waitlist.

| Field | What it means |
|---|---|
| `clientName`, `counselor`, `amiPercent` | Copied at enrollment |
| `scopeOfWork` | What repairs are needed |
| `estimatedBudget` | Estimated cost |
| `estimatedDays` | Estimated completion time in days |
| `driveFileId/Url/Name` | The scope-of-work document |
| `priorityScore` | Computed ranking score (see `hig-waitlist.js → calcScore()`) |
| `status` | waitlisted → under_review → approved → in_progress → complete |
| `enrolledAt` | When added (affects wait-time scoring) |

### `config` collection

Two documents:
- **`higWeights`**: `{ amiWeight, budgetWeight, timeWeight, waitTimeWeight }` — sliders in ED Settings
- **`billing`**: `{ defaultRate, courtRate }` — hourly rates for invoicing, not shown to counselors

### `users` collection

One document per user, keyed by their Firebase Auth UID.

| Field | What it means |
|---|---|
| `name` | Display name (used in nav, pre-fills counselor dropdown) |
| `email` | Their @housingopps.org email |
| `role` | `counselor`, `admin`, or `executive_director` |

---

## The dropdown lists (data.js)

All dropdown options live in `data.js`. **This is where you go to add a new option to any dropdown.**

```js
// To add a new counseling type — add to this array:
export const COUNSELING_TYPES = ['OUTSTANDING', 'PRE', 'POST', 'COURT'];

// To add a new AMI level:
export const AMI_LEVELS = ['Extremely Low', 'Low', 'Moderate', 'Non Low-Moderate'];

// To add a new outcome type:
export const AWARD_TYPES = [
  'Direct Assistance',
  'Loan Modification',
  'Debt Forgiveness',
  'Deferred Payment',
  'Other',
];
```

After changing `data.js`, no deploy is needed for the logic — just re-deploy hosting.

---

## Key patterns you'll see everywhere

### The date timezone trick

Dates stored in Firestore as JavaScript `Date` objects are in UTC. If you just do `new Date('2024-01-15')`, JavaScript treats the string as UTC midnight, which displays as January 14th in Eastern time.

**The fix used throughout this app:**
```js
// Saving a date — add T12:00:00 to make it noon local time, so UTC is the same calendar day
new Date(dateVal + 'T12:00:00')

// Displaying a date — force UTC timezone so the calendar day doesn't shift
date.toLocaleDateString('en-US', { timeZone: 'UTC' })
```

### setSelectValue — injecting unknown dropdown options

When you load a saved record and the stored value doesn't match any option in the dropdown (e.g., the old counselor initials "DRB" that no longer exists), the select would silently go blank. This helper injects the stored value as a custom option so it stays visible:

```js
function setSelectValue(id, val) {
  const el = document.getElementById(id);
  el.value = val;
  if (el.value !== String(val)) {        // if it went blank...
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = val;
    el.insertBefore(opt, el.options[1]); // inject it right after the blank "— Select —"
    el.value = val;
  }
}
```

### toTitleCase — normalizing client names

Dan enters names in ALL CAPS. This converts them to Title Case on every save:

```js
function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  // "SHARON BIBLE" → "Sharon Bible"
}
```

### Firestore batch writes

Firestore has a hard limit of 500 operations per batch write. For bulk updates (like normalizing names), the code breaks work into chunks of 499:

```js
for (let i = 0; i < docs.length; i += 499) {
  const batch = writeBatch(db);
  docs.slice(i, i + 499).forEach(d => {
    batch.update(doc(db, 'clients', d.id), { clientName: newName });
  });
  await batch.commit(); // sends this batch to Firestore
}
```

### Denormalized fields

`clients` documents store `sessionCount`, `totalOutcomeValue`, `firstSessionDate`, and `lastSessionDate` directly — even though this data could be computed by reading all sessions. This is a speed trade-off: loading 958 clients is one read; loading all their sessions would be thousands of reads.

Whenever sessions are added, edited, or deleted, `refreshClientDenormalized()` in `client.js` re-reads all sessions for that client and updates these fields. If they ever get out of sync, the fix is to re-run that function for the affected client.

---

## Page-by-page reference

### `clients.html` / `clients.js` — "Counseling Log"

The main landing page after login. Loads all documents from the `clients` collection, sorts by `lastSessionDate` descending (most recently active clients first), runs client-side filters, and renders a table.

**Stats** at the top are computed from the filtered set:
- Active Clients: count where `status === 'active'`
- Total Sessions: sum of `sessionCount`
- Outcome Value: sum of `closureOutcomeValue` (for closed files) or `totalOutcomeValue` (for active files)

**Breakdowns** at the bottom are also computed client-side from the filtered rows.

**To add a new filter:** add a form field to `clients.html`, read its value in `applyFilters()` in `clients.js`, and add a `.filter()` call.

### `client.html` / `client.js` — Client Profile

The most complex page. Loads one client doc + all its sessions subcollection.

**State variables at the top of `client.js`:**
- `_client` — the loaded client document (updated in-memory when you save)
- `_sessions` — array of session documents
- `_profile` — the logged-in user's profile (used for access control)
- `_driveFolder` — currently linked Drive folder `{ id, name, url }`
- `_editingSessionId` — `null` when adding a new session, session ID when editing

**Session flow:** Add/Edit Session → modal opens → `readSessionForm()` reads the form → `saveSession()` writes to Firestore → `refreshClientDenormalized()` updates the client doc totals → `loadSessions()` re-renders the table.

**Close File flow:** "Close File" button → modal opens with Outcome Value, Outcome Type, CCA fields (PRE only), and Notes → `closeFile()` writes all closure fields to the client doc → `renderHeader()` updates the banner.

**Access control for closing:**
- ED/admin: can close any file
- Counselor: can only close files where `client.counselor === profile.name`

### `new-client.html` / `new-client.js`

Simple form that creates two Firestore documents atomically:
1. A new doc in `clients/`
2. A new doc in `clients/{id}/sessions/`

Then redirects to `client.html?id=newId`.

### `cca-list.html` / `cca-list.js` — "Buyer Ready"

Reads from the `ccaList` collection. Clients appear here after being enrolled from the legacy edit-entry page. Sorted by closing date. Entries within 14 days of closing are highlighted red.

### `hig-waitlist.html` / `hig-waitlist.js`

Reads from `higWaitlist`. Priority score is computed on every render using weights from `config/higWeights`. The formula:

```
score = (
  amiScore    * amiWeight +
  budgetScore * budgetWeight +
  timeScore   * timeWeight +
  waitScore   * waitTimeWeight
) / totalWeight
```

Where lower AMI = higher `amiScore`, smaller budget/time = higher score, longer wait = higher `waitScore`.

**To change the scoring formula:** edit `calcScore()` in `hig-waitlist.js`. **To change the weights:** ED → Settings → HIG Waitlist Priority Weights.

### `settings.html` / `settings.js` — ED Only

Five tools:

1. **Active Counselors** — add/remove/toggle counselors. Active counselors appear in dropdowns; inactive ones are hidden but their historical records are unchanged.

2. **Normalize Counselor Names** — scans `counselingLog` (legacy) for counselor values that don't match a canonical name (old initials, abbreviations). Lets ED map them. Batch-updates matching records.

3. **Normalize Client Names — Title Case** — scans `clients` for all-caps names and converts them.

4. **Remap Client Names** — scans `clients` for comma-format names like "Lastname, Firstname" and auto-suggests the reversal. Also has "Show All Clients" mode for any correction needed.

5. **Possible Duplicate Scanner** — see "How the duplicate scanner works" below.

6. **Billing Rates** — stores `defaultRate` and `courtRate` in `config/billing`. Not shown to counselors.

7. **HIG Waitlist Priority Weights** — sliders saved to `config/higWeights`.

---

## How the duplicate scanner works

`scanDuplicates()` in `settings.js` loads all clients, then compares every possible pair (n × n/2 comparisons). For each pair it runs three detectors:

**1. Shared Rx number**
Both clients' `rxNumbers` arrays are compared. If any Rx appears in both and is non-empty, it's flagged as a strong match. (Example: two records both have Rx 12345 — probably the same person entered twice.)

**2. Name similarity**
Two algorithms run in parallel:
- **Token overlap**: split name into words, count how many words are shared, divide by the longer name's word count. "John Smith" vs "Johnny Smith" shares "smith" → 50% overlap.
- **Edit distance (Levenshtein)**: counts how many single-character changes turn one name into the other. Used on the full stripped-lowercase string.

Name reversal is also checked: "Akins, Malik" is reversed to "Malik Akins" and re-compared.

**3. Same zip + type + partial name overlap**
A weaker signal used to catch household members enrolled separately (same address and program type with some name similarity).

**Confidence levels:**
- **Strong**: shared Rx, or >97% name similarity, or clear name reversal
- **Possible**: 75–97% similarity
- **Weak**: 50–75% similarity, or zip+type+partial

**Merge operation (`performMerge()`):**
1. Load both client docs
2. Load all sessions from the "drop" (B) client
3. In batches of 490: move each session to the "keep" (A) client's subcollection, delete it from B
4. Re-compute `sessionCount`, `totalOutcomeValue`, `firstSessionDate`, `lastSessionDate` for A
5. Merge `rxNumbers` and `areasOfInterest` arrays (union, no duplicates)
6. Copy any non-empty fields from B that A is missing (guarantor, zip, counselor)
7. Delete B's client document
8. **Note:** Orphaned session documents under B are deleted as part of step 3. The client document itself is deleted in step 7.

---

## How to deploy

```bash
# From the project root directory:
firebase deploy --only hosting          # just the HTML/JS/CSS
firebase deploy --only firestore:rules  # just the security rules
firebase deploy                         # everything
```

You must have the Firebase CLI installed and be logged in (`firebase login`).

**What gets deployed:** everything in the `public/` folder. Changes to JS files in `public/js/` are live immediately after deploy — no build step needed.

---

## How to make common changes

### Add a new option to a dropdown

Edit `data.js`. Find the right array and add your string. Redeploy hosting.

### Add a new counselor

Go to the app → Settings → Active Counselors → Add Counselor. Or directly in Firestore Console → `counselors` collection → Add document with `name` and `active: true`.

### Change a user's role

Firebase Console → Firestore → `users` collection → find the user's UID → edit the `role` field.

### Add a new field to sessions

1. Add the HTML input to the session modal in `client.html`
2. Add to `readSessionForm()` in `client.js` to read its value
3. Add to the table render in `renderSessionsTable()` to display it (add a `<th>` to the header in `client.html` too)
4. No migration needed — old sessions just won't have the field

### Add a new page

1. Create `public/yourpage.html` with `<nav class="nav"></nav>` and `<script type="module" src="js/yourpage.js"></script>`
2. Create `public/js/yourpage.js` starting with `requireAuth((user, profile) => { setupNav(profile, 'yourpage'); ... })`
3. Add the nav link in `auth.js → setupNav()` with `data-page="yourpage"`
4. Add a Firestore rule in `firestore.rules` if your page reads/writes a new collection
5. Redeploy

### Change the brand color

Open `public/css/app.css`. At the very top you'll see CSS variables:
```css
--primary: #3333CC;   /* the main blue — buttons, active links, badges */
--accent:  #00897B;   /* green — used for success states */
```
Change `--primary` to change the entire color scheme.

---

## The legacy counselingLog collection

Before the architectural migration (April 2025), all records were stored as flat documents in `counselingLog` — one document per session, no parent-child relationship. The app still reads this collection for:
- The old log page (`log.html` / `log.js`)
- The edit-entry page (`edit-entry.html`)
- The Normalize Counselor Names remap tool in Settings

The migration script (`scripts/migrate-clients.js`) created the new `clients` + `sessions` structure from this data. The `counselingLog` collection was kept as a backup and is never deleted. New clients are created only in the new `clients` structure.

---

## Firebase Console — where to look for issues

- **Authentication** → Users: see who has an account, disable if needed
- **Firestore** → Data: browse any collection, edit documents directly
- **Firestore** → Indexes: if you see "requires an index" error in console, create it here
- **Firestore** → Rules: see/edit who can read/write (same as `firestore.rules` in the repo)
- **Hosting** → Dashboard: see deploy history, rollback if needed
- **Usage and billing**: make sure you're on the Blaze plan (pay-as-you-go) — the Spark plan has a 50,000 read/day limit that was hit during early development

---

## Environment details

- Firebase project ID: `housing-counseling`
- Firebase SDK version: `10.12.0` (pinned in every CDN import URL)
- Google Workspace domain restriction: `@housingopps.org` only
- Deployment command: `firebase deploy --only hosting`
