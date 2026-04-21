# Housing Counseling App — Developer Guide

> Written for a first-year developer. Assumes you know what HTML, JavaScript, and a database are, but not necessarily Firebase or this specific app.

---

## What this app is

A case management tool for Housing Opportunities Inc. housing counselors. Counselors log client intake, track counseling sessions, monitor Closing Cost Assistance ("Buyer Ready") and Home Repair Grant ("Repair Ready") waitlists, generate CMC foreclosure outreach letters, log phone call activity, and batch-log court appearances. The Executive Director has extra tools: settings, reporting, data normalization, and duplicate detection.

---

## Tech stack — the short version

| Layer | What it is | Why |
|---|---|---|
| **Firebase Auth** | Handles login / Google sign-in | No password database to manage |
| **Firestore** | NoSQL cloud database | Real-time, no server needed |
| **Firebase Hosting** | Serves the HTML/JS files | Simple, fast, free tier |
| **Plain HTML + JS modules** | The frontend | No React, no bundler, no build step |
| **Google Drive Picker API** | Lets counselors link Drive folders/files | Files stay in their existing Drive |

There is **no backend server**. The browser talks directly to Firebase. Security is enforced through Firestore Rules (see `firestore.rules`).

---

## Project structure

```
housing-counseling-app/
├── public/                     ← everything the browser sees
│   ├── index.html              ← login page
│   ├── clients.html            ← "Counseling Log" — main client list
│   ├── client.html             ← individual client profile + session history
│   ├── new-client.html         ← create a new client + first session
│   ├── cca-list.html           ← "Buyer Ready" — CCA tracking list (PRE clients)
│   ├── hig-waitlist.html       ← "Repair Ready" — home repair grant waitlist (POST clients)
│   ├── outreach.html           ← "Outreach" — CMC batch letters + phone call log
│   ├── court-appearance.html   ← batch-log foreclosure court sessions across clients
│   ├── operations.html         ← static step-by-step guidance for counselors
│   ├── reports.html            ← CDBG reports + court appearance summary
│   ├── settings.html           ← ED-only: counselors, normalization, duplicate scan, import
│   ├── import.html             ← admin-only: bulk CSV import (linked from Settings)
│   ├── cmcletter.html          ← legacy CMC letter page (superseded by outreach.html)
│   ├── cmc-log.html            ← legacy per-client CMC log view
│   ├── css/
│   │   └── app.css             ← all styles; CSS color variables at the top
│   ├── img/
│   │   └── logo.png            ← the nav logo
│   └── js/
│       ├── firebase-config.js  ← Firebase project credentials — DO NOT EDIT
│       ├── auth.js             ← login, roles, and the nav bar
│       ├── data.js             ← all dropdown lists and constants
│       ├── clients.js          ← logic for clients.html
│       ├── client.js           ← logic for client.html (most complex file)
│       ├── new-client.js       ← logic for new-client.html
│       ├── cca-list.js         ← logic for cca-list.html
│       ├── hig-waitlist.js     ← logic for hig-waitlist.html (includes scoring)
│       ├── outreach.js         ← logic for outreach.html (CMC letters + call log)
│       ├── court-appearance.js ← logic for court-appearance.html (batch court sessions)
│       ├── reports.js          ← CDBG reports + court appearance summary
│       ├── settings.js         ← ED settings, normalizers, duplicate scanner
│       ├── picker.js           ← Google Drive file/folder picker
│       ├── cmc-log.js          ← legacy per-client CMC log
│       ├── cmcletter.js        ← legacy CMC letter generator (superseded by outreach.js)
│       ├── log.js              ← legacy counseling log (counselingLog collection)
│       ├── new-entry.js        ← legacy new entry form
│       ├── edit-entry.js       ← legacy edit entry form
│       ├── import.js           ← CSV import logic
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

## Navigation order

The nav bar (defined in `auth.js → setupNav()`) renders links in this order:

| Link | Page | Who sees it |
|---|---|---|
| Counseling Log | `clients.html` | Everyone |
| Buyer Ready | `cca-list.html` | Everyone |
| Repair Ready | `hig-waitlist.html` | Everyone |
| Outreach | `outreach.html` | Everyone |
| Operations | `operations.html` | Everyone |
| Reports | `reports.html` | Everyone |
| Settings | `settings.html` | Admin / ED only |

"Import" is **not** in the nav — it lives as a button inside Settings, accessible to the ED only.

---

## How Firebase works (the mental model)

Think of **Firestore** as a set of folders (called **collections**) that each contain **documents** (like rows in a spreadsheet, but as JSON objects). Each document has a random auto-generated ID.

```
Firestore
├── clients/                ← main client records
│   └── {clientId}/
│       ├── clientName, counselor, amiPercent, ...
│       └── sessions/       ← subcollection: one doc per counseling session
│           └── {sessionId}/
│               ├── date, hours, caseStatus, notes, clientName, ...
├── counselors/             ← dropdown list of active counselors
├── ccaList/                ← "Buyer Ready" — PRE clients in CCA program
├── higWaitlist/            ← "Repair Ready" — POST clients in home repair queue
├── outreachCalls/          ← phone call activity log (clients + prospects)
├── cmcLog/                 ← CMC foreclosure letters sent
├── counselingLog/          ← LEGACY flat records (kept as backup, never deleted)
├── users/                  ← one doc per user, stores role
└── config/
    ├── higWeights          ← Repair Ready priority scoring weights
    └── billing             ← hourly billing rates (not shown to counselors)
```

The browser imports Firebase's JS SDK directly from a CDN — no npm install needed for the frontend. Every `await getDocs(...)` is a network call to Firestore.

---

## Authentication and roles

### How login works

1. User clicks "Sign in with Google" on `index.html`
2. Firebase Auth opens a Google popup — it handles passwords, tokens, everything
3. The app checks that the email ends in `@housingopps.org` — if not, signs them out immediately
4. The app reads the user's doc from the `users` collection to get their **role**
5. If no doc exists yet, the user gets the default role: `counselor`

**To change who can log in:** edit `login.js` — look for the `@housingopps.org` check.

**To change a user's role:** Firebase Console → Firestore → `users` collection → find the user's document → change the `role` field.

### Roles

| Role | What they can do |
|---|---|
| `counselor` | View/add clients, log sessions, close their own files |
| `admin` | Everything a counselor can, plus Import and Settings |
| `executive_director` | Everything, including ED-only Settings tools, can close any file |

### The auth pattern (used on every page)

```js
requireAuth((user, profile) => {
  // Runs only after a verified, signed-in user is confirmed.
  // 'user'    = Firebase Auth object  (user.uid, user.email)
  // 'profile' = Firestore users/{uid} (profile.name, profile.role)
  setupNav(profile, 'page-name'); // builds nav and highlights the active link
});
```

If the user isn't signed in, `requireAuth` redirects to `index.html` automatically.

**To guard a page to admins only:** use `requireAdmin(...)` instead.
**To guard a page to ED only:** use `requireED(...)` instead.

---

## The nav bar

The nav is built in `auth.js → setupNav()`. Every page calls `setupNav(profile, 'page-name')`.

**To add a new nav link:**
1. Add an `<a>` tag inside the `nav.innerHTML` template in `auth.js`
2. Give it `data-page="your-page-name"` and `href="your-page.html"`
3. Call `setupNav(profile, 'your-page-name')` in your page's JS
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
| `homeSearchNotes` | string | PRE clients only — free-text notes on desired home location, type, size, etc. |
| `driveFolderId` | string | Google Drive folder ID |
| `driveFolderName` | string | Display name of the linked folder |
| `driveFolderUrl` | string | Direct URL to open the folder |
| `status` | string | `active` or `closed` |
| `closureDate` | timestamp | When the file was closed |
| `closureOutcome` | string | Notes written at closure |
| `closureOutcomeValue` | number | Final dollar outcome (loan mod amount, grant, etc.) |
| `closureAwardType` | string | Type of outcome (Direct Assistance, Loan Modification, etc.) |
| `totalDownPayment` | number | PRE/CCA: total down payment amount |
| `ccaAmountProvided` | number | PRE/CCA: how much assistance was provided |
| `sessionCount` | number | **Denormalized** — count of sessions (updated on every session change) |
| `totalOutcomeValue` | number | **Denormalized** — sum of `dollarsAwarded` across sessions |
| `firstSessionDate` | timestamp | **Denormalized** — earliest session date |
| `lastSessionDate` | timestamp | **Denormalized** — most recent session date (used for sorting) |
| `createdAt` | timestamp | When this record was created |
| `updatedAt` | timestamp | Last time anything changed |

> **What "denormalized" means:** Instead of counting sessions every time you load the client list, we store the count directly on the client doc and update it whenever sessions change. It's faster but means you have to keep it in sync — see `refreshClientDenormalized()` in `client.js`.

### `clients/{id}/sessions` subcollection

One document per counseling session, including court appearances.

| Field | Type | What it means |
|---|---|---|
| `date` | timestamp | Date of the session |
| `counselor` | string | Who ran the session |
| `rxNumber` | string | Rx/case number for this session |
| `hours` | number | Duration in hours |
| `dollarsFor` | string | What the money was for |
| `caseStatus` | string | Free-text status (court sessions use `"Court — {County}"`) |
| `outcome` | string | Free-text outcome note |
| `notes` | string | General notes |
| `clientName` | string | Copied from the client doc at write time — used by court appearance report queries |
| `dollarsAwarded` | number | Legacy: outcome value per session (from migrated data) |
| `awardType` | string | Legacy: outcome type per session |
| `sourceMonth` | string | Legacy: month string (e.g., "January") |
| `counselingLogId` | string | Legacy: ID of original counselingLog record |
| `createdAt` | timestamp | When this session was logged |
| `updatedAt` | timestamp | Last edit |

> **Court sessions:** The batch Court Appearance tool sets `caseStatus = "Court — {County}"` and stores `clientName` on the session doc so the Reports page can query across all clients' sessions efficiently using a collectionGroup query without loading every client doc.

### `ccaList` collection ("Buyer Ready")

Clients enrolled in the Closing Cost Assistance program. Populated by clicking "+ Add Client" on the Buyer Ready page, or automatically via the legacy edit-entry workflow.

| Field | What it means |
|---|---|
| `clientId` | Foreign key to `clients/{id}` — links this list entry to the full client profile |
| `clientName` | Denormalized copy from the client doc (kept in sync by `syncClientToLists()`) |
| `counselor` | Denormalized copy from the client doc |
| `amiPercent` | Denormalized copy from the client doc |
| `closingDate` | Target closing date (highlighted red if within 14 days) |
| `ccaAmount` | Dollar amount of assistance |
| `status` | eligible → applied → approved → funded → closed |
| `driveFolderId/Name/Url` | Linked Drive folder (synced from client doc) |
| `notes` | Notes specific to this CCA enrollment |
| `enrolledAt` | When they were added to this list |

### `higWaitlist` collection ("Repair Ready")

Clients on the home repair grant waitlist. Sorted by a computed priority score.

| Field | What it means |
|---|---|
| `clientId` | Foreign key to `clients/{id}` |
| `clientName` | Denormalized copy from the client doc |
| `amiPercent` | Denormalized copy — drives the priority score |
| `scopeOfWork` | Description of what repairs are needed |
| `estimatedBudget` | Estimated cost in dollars |
| `estimatedDays` | Estimated completion time in days |
| `driveFileId/Url/Name` | The linked scope-of-work document |
| `driveFolderId/Name/Url` | The linked client Drive folder |
| `status` | waitlisted → under_review → approved → in_progress → complete |
| `enrolledAt` | When added (affects wait-time scoring) |

### `outreachCalls` collection

Phone call activity log — one document per call logged through the Outreach page.

| Field | What it means |
|---|---|
| `date` | Date of the call |
| `counselor` | Who made the call |
| `type` | `"client"` (linked to existing client) or `"prospect"` (not yet intaked) |
| `linkedClientId` | Foreign key to `clients/{id}` — only set when `type === "client"` |
| `contactName` | Name of the person called (client name or prospect name) |
| `phone` | Phone number — typically filled for prospects |
| `outcome` | Short outcome note (e.g., "Left voicemail", "Intake scheduled") |
| `notes` | Longer notes about the call |
| `createdAt` / `updatedAt` | Timestamps |

### `cmcLog` collection

CMC foreclosure outreach letters that have been generated and logged through the Outreach page.

| Field | What it means |
|---|---|
| `recipientName` | Name on the letter |
| `mailingAddress` | Street line of mailing address |
| `mailingAddress2` | City, State ZIP |
| `propertyAddress` | Address of the foreclosed property |
| `lender` | Lender / plaintiff (not used for Lawrence County template) |
| `counselorTemplate` | Which letter template: `"dan"` (Beaver), `"andrusa"` (Lawrence), `"mercer"` (Mercer) |
| `dateSent` | Date on the letter |
| `counselor` | Who generated the letter |
| `linkedClientId` | Set later in Settings when a recipient becomes a client |
| `linkedClientName` | Display name for the linked client |

### `config` collection

Two documents:
- **`higWeights`**: `{ amiWeight, budgetWeight, timeWeight, waitTimeWeight }` — sliders in ED Settings
- **`billing`**: `{ defaultRate, courtRate }` — hourly rates for invoicing, not shown to counselors

### `users` collection

One document per user, keyed by their Firebase Auth UID.

| Field | What it means |
|---|---|
| `name` | Display name (used in nav, pre-fills counselor dropdowns) |
| `email` | Their @housingopps.org email |
| `role` | `counselor`, `admin`, or `executive_director` |

---

## The dropdown lists (data.js)

All dropdown options live in `data.js`. **This is where you go to add a new option to any dropdown.**

```js
export const COUNSELING_TYPES = ['OUTSTANDING', 'PRE', 'POST', 'COURT'];
export const AMI_LEVELS = ['Extremely Low', 'Low', 'Moderate', 'Non Low-Moderate'];
export const AWARD_TYPES = ['Direct Assistance', 'Loan Modification', ...];
```

After changing `data.js`, no build step needed — just redeploy hosting.

---

## Key patterns you'll see everywhere

### The date timezone trick

Dates stored in Firestore as JavaScript `Date` objects are in UTC. `new Date('2024-01-15')` is UTC midnight, which displays as January 14th in Eastern time.

**The fix used throughout this app:**
```js
// Saving — add T12:00:00 to force noon local, so UTC stays on the right calendar day
new Date(dateVal + 'T12:00:00')

// Displaying — force UTC so the calendar day never shifts
date.toLocaleDateString('en-US', { timeZone: 'UTC' })
```

### setSelectValue — injecting unknown dropdown options

When a saved value doesn't exist in the dropdown (e.g., old initials "DRB"), this helper injects it as a custom option rather than silently going blank:

```js
function setSelectValue(id, val) {
  const el = document.getElementById(id);
  el.value = val;
  if (el.value !== String(val)) {        // went blank — value not in list
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = val;
    el.insertBefore(opt, el.options[1]); // inject after the "— Select —" placeholder
    el.value = val;
  }
}
```

### toTitleCase — normalizing client names

Names may be entered in ALL CAPS. Every save normalizes to Title Case:

```js
function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  // "SHARON BIBLE" → "Sharon Bible"
}
```

### Firestore batch writes

Firestore has a 500-operation limit per batch. For bulk updates the code chunks by 499:

```js
for (let i = 0; i < docs.length; i += 499) {
  const batch = writeBatch(db);
  docs.slice(i, i + 499).forEach(d => batch.update(...));
  await batch.commit();
}
```

### Denormalized fields

`clients` documents store `sessionCount`, `totalOutcomeValue`, `firstSessionDate`, and `lastSessionDate` directly rather than re-computing them from all sessions on every read. `refreshClientDenormalized()` in `client.js` keeps these in sync whenever sessions change.

### Cross-collection sync (syncClientToLists)

`ccaList` and `higWaitlist` records store denormalized copies of the client's name, counselor, AMI, and Drive folder. When a counselor saves changes on the client profile page, `syncClientToLists()` in `client.js` queries both collections for any records with that `clientId` and updates them — fire-and-forget (non-blocking):

```js
syncClientToLists(data); // called after updateDoc on the client, without await
```

This means list pages always show up-to-date client info without requiring the counselor to update both places manually.

### Row navigation vs. list edit (Buyer Ready / Repair Ready)

Both list pages use the same click pattern:
- **Clicking anywhere on a row** → navigates to `client.html?id={clientId}` for the full editable profile
- **"Edit Entry" button** in the last column → opens a modal to edit list-specific fields only (status, closing date, budget, etc.) without leaving the page
- If a row has no `clientId` (manually entered or imported without a link), clicking it opens the edit modal as fallback

---

## Page-by-page reference

### `clients.html` / `clients.js` — "Counseling Log"

Main landing page after login. Loads all `clients` collection documents, sorts by `lastSessionDate` descending, runs client-side filters, and renders the table. The "Court Appearance" button in the header links to `court-appearance.html`.

**Stats** at the top are computed from the filtered set client-side.

### `client.html` / `client.js` — Client Profile

The most complex page. Loads one client doc + all sessions subcollection.

**State variables:**
- `_client` — loaded client document (updated in-memory on save)
- `_sessions` — array of session documents
- `_profile` — logged-in user profile (for access control)
- `_driveFolder` — currently linked Drive folder `{ id, name, url }`
- `_editingSessionId` — `null` = new session, session ID = editing existing

**Session flow:** Add/Edit Session → modal → `readSessionForm()` → `saveSession()` → `refreshClientDenormalized()` → `loadSessions()`.

**Close File flow:** Button → modal (with CCA section for PRE clients) → `closeFile()` → `renderHeader()`.

**Program Lists card:** At the bottom of the profile, the "Program Lists" card shows whether the client is on Buyer Ready or Repair Ready. Buttons let counselors add them from the profile page directly.

**PRE clients:** Show a "Home Search Notes" textarea (field: `homeSearchNotes`) for recording desired location, home type, size, etc.

**Access control for closing:**
- ED/admin: can close any file
- Counselor: can only close files where `client.counselor === profile.name`

### `cca-list.html` / `cca-list.js` — "Buyer Ready"

Reads `ccaList` collection. Shows PRE clients enrolled in Closing Cost Assistance. "+ Add Client" button opens a client selector modal filtered to active PRE clients not already on the list. Entries within 14 days of closing are highlighted red. Row click navigates to the full client profile.

### `hig-waitlist.html` / `hig-waitlist.js` — "Repair Ready"

Reads `higWaitlist` collection. Shows POST clients on the home repair grant waitlist. Priority score computed on every render using weights from `config/higWeights`:

```
score = (amiScore * amiWeight + budgetScore * budgetWeight + timeScore * timeWeight + waitScore * waitTimeWeight) / totalWeight
```

Lower AMI = higher `amiScore`. Smaller budget/time = higher score. Longer wait = higher `waitScore`. "+ Add Client" filters to active POST clients.

**To change scoring formula:** edit `calcScore()` in `hig-waitlist.js`.
**To change weights:** Settings → HIG Waitlist Priority Weights.

### `outreach.html` / `outreach.js` — "Outreach"

Two sections on one page:

**CMC Letters:** Batch-generate foreclosure outreach letters. Select county (Beaver/Lawrence/Mercer), enter a date, fill in recipients row by row, then "Generate Letters & Log All" opens a print window with all letters and logs every row to the `cmcLog` collection. Past letters table below lets you re-generate any previous batch.

**Call Log:** "+ Log a Call" opens a modal where counselors choose between:
- **Existing Client** — type-ahead search to link the call to a client record
- **Prospect** — free-text name and phone for people not yet intaked

All calls are stored in the `outreachCalls` collection.

**CMC Letter templates:**
- `dan` → Beaver County (Daniel Bernabie)
- `andrusa` → Lawrence County (Andrusa Lawson) — no lender field
- `mercer` → Mercer County — uses logged-in counselor's name, green letterhead with logo

### `court-appearance.html` / `court-appearance.js` — Batch Court Sessions

A three-step workflow for logging foreclosure court appearances in bulk:

1. **Step 1** — Select county (Beaver/Lawrence/Mercer), court date, hours (default 2), counselor
2. **Step 2** — Search active clients by name/counselor/Rx; click to add each one who appeared
3. **Step 3** — Review selected clients, optionally fill per-client Rx and notes, then submit

On submit the tool writes a session doc to `clients/{id}/sessions` for every selected client simultaneously (`Promise.all`), then runs `refreshClientDenormalized()` sequentially for each one. Sessions are tagged with `caseStatus = "Court — {County}"` and include `clientName` for efficient report queries.

The "Court Appearance" button on `clients.html` links here.

### `reports.html` / `reports.js` — Reports

**CDBG Reports (Reports 1 & 2):** Select a month and year. The app reads the legacy `counselingLog` collection (filtered by `sourceMonth`) and generates `.docx` files for the Income report and the Race & Ethnicity report.

**Court Appearance Summary:** Select a year and click "Load Court Report." Uses a `collectionGroup('sessions')` query filtered by date range to find all sessions across all clients, then filters client-side for `caseStatus` starting with `"Court"`. Groups by date + county and shows a table of: court date, county, number of clients, counselor(s), and client name list.

> **Index note:** The collectionGroup query on `sessions.date` may require a Firestore index the first time it runs. Firebase will log a one-click link in the browser console to create it.

### `settings.html` / `settings.js` — ED Only

Tools:
1. **Active Counselors** — add counselors; inactive ones are hidden in dropdowns but historical records are unchanged
2. **Normalize Counselor Names** — maps old initials/abbreviations in `counselingLog` to canonical names
3. **Link CMC Letters to Clients** — matches unlinked `cmcLog` entries to `clients` records
4. **Possible Duplicate Scanner** — see "How the duplicate scanner works" below
5. **Normalize Client Names — Title Case** — converts ALL CAPS names in `clients`
6. **Remap Client Names** — fixes "Lastname, Firstname" format entries
7. **Billing Rates** — `config/billing`: `defaultRate` and `courtRate`
8. **HIG Waitlist Priority Weights** — `config/higWeights`: sliders for the Repair Ready scoring formula
9. **Import Data** — link to `import.html` for bulk CSV import of historical records

---

## How the duplicate scanner works

`scanDuplicates()` in `settings.js` loads all clients, then compares every possible pair. For each pair it runs three detectors:

**1. Shared Rx number** — if any Rx appears in both clients' `rxNumbers` arrays, it's a strong match.

**2. Name similarity** — two algorithms:
- **Token overlap**: shared word count / longer name's word count
- **Edit distance (Levenshtein)**: character-level string distance on the stripped lowercase name
- Name reversal is also checked: "Akins, Malik" reversed to "Malik Akins" and re-compared

**3. Same zip + type + partial name overlap** — a weaker signal for household members enrolled separately

**Confidence levels:** Strong (>97% / shared Rx), Possible (75–97%), Weak (50–75%)

**Merge operation (`performMerge()`):**
1. Load both client docs
2. Load all sessions from the source (B) client
3. Move each session to the target (A) client's subcollection in batches of 490, then delete from B
4. Re-compute denormalized fields for A
5. Merge `rxNumbers` arrays (union, no duplicates)
6. Copy non-empty fields from B that A is missing
7. Delete B's client document

---

## How to deploy

```bash
firebase deploy --only hosting          # just the HTML/JS/CSS
firebase deploy --only firestore:rules  # just the security rules
firebase deploy                         # everything
```

You must have the Firebase CLI installed and be logged in (`firebase login`). Everything in `public/` is deployed. No build step needed.

---

## How to make common changes

### Add a new option to a dropdown
Edit `data.js`, find the right array, add your string. Redeploy hosting.

### Add a new counselor
App → Settings → Active Counselors → Add Counselor. Or Firestore Console → `counselors` → Add document with `name: "Full Name"` and `active: true`.

### Change a user's role
Firebase Console → Firestore → `users` → find the user's UID → edit the `role` field.

### Add a new field to sessions
1. Add the input to the session modal in `client.html`
2. Add to `readSessionForm()` in `client.js`
3. Add to `renderSessionsTable()` to display it (add a `<th>` in `client.html` too)
4. No migration needed — old sessions just won't have the field

### Add a new page
1. Create `public/yourpage.html` with `<nav class="nav"></nav>` and `<script type="module" src="js/yourpage.js"></script>`
2. Create `public/js/yourpage.js` starting with `requireAuth((user, profile) => { setupNav(profile, 'yourpage'); ... })`
3. Add the nav link in `auth.js → setupNav()` with `data-page="yourpage"`
4. Add a Firestore rule in `firestore.rules` if your page reads/writes a new collection
5. Redeploy

### Change the brand color
Open `public/css/app.css`. At the top you'll see:
```css
--primary: #3333CC;   /* main blue — buttons, active links, badges */
--accent:  #00897B;   /* green — success states */
```

---

## The legacy counselingLog collection

Before the April 2025 migration, all records were flat documents in `counselingLog` — one document per session. The app still reads this for:
- The old log page (`log.html`)
- The Normalize Counselor Names remap tool in Settings
- The CDBG Reports (filtered by `sourceMonth`)

The migration script (`scripts/migrate-clients.js`) created the `clients` + `sessions` structure from this data. The `counselingLog` collection is kept as backup and never deleted. All new records go into the `clients` structure.

---

## Firebase Console — where to look for issues

- **Authentication → Users**: see who has an account, disable if needed
- **Firestore → Data**: browse any collection, edit documents directly
- **Firestore → Indexes**: if you see "requires an index" error in the browser console, create the index here (Firebase usually provides a one-click link in the error message)
- **Firestore → Rules**: see/edit security rules (same as `firestore.rules` in the repo)
- **Hosting → Dashboard**: see deploy history, rollback if needed
- **Usage and billing**: make sure you're on the Blaze plan — the Spark plan has a 50,000 read/day limit

---

## Environment details

- Firebase project ID: `housing-counseling`
- Firebase SDK version: `10.12.0` (pinned in every CDN import URL)
- Google Workspace domain restriction: `@housingopps.org` only
- Deployment command: `firebase deploy --only hosting`
