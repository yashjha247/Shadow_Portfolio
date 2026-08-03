# The Shadow Portfolio — Development Journal

An automated Learning Milestone Detection System. An event-driven backend pipeline that watches GitHub activity, filters noise, and uses AI to extract meaningful engineering progress.

---

## Phase 1: The Foundation (Gateway & Outbox)

### Goal
Build an Express server that catches GitHub webhooks, verifies they are actually from GitHub (HMAC security), and saves the raw data into Supabase instantly so GitHub doesn't time out.

### How It Was Implemented

#### Step 1: Supabase Database Setup
Created a Supabase project with a `raw_events` table to store incoming webhook payloads.

**Table columns:**
- `id` — auto-incrementing primary key
- `event_type` — identifies the event (push, ping, etc.)
- `delivery_id` — unique tracking number from GitHub (prevents duplicate processing)
- `payload` — the raw JSON payload from GitHub
- `status` — tracks pipeline progress (pending → processing → processed/ignored)
- `created_at` — timestamp of when the event was received

**Security:** Row Level Security (RLS) was enabled to block public access. The `service_role` (Secret) key is used in the backend to bypass RLS, allowing only the trusted server to write to the database.

#### Step 2: Environment Variables (.env)
A `.env` file was created to hold secrets locally (never committed to Git). Variables:
- `SUPABASE_URL` — the Supabase project URL
- `SUPABASE_SERVICE_KEY` — admin bypass key for database writes
- `GITHUB_WEBHOOK_SECRET` — shared secret for HMAC signature verification

#### Step 3: The Express Server (index.js)
The server uses `require('dotenv').config()` at the top to load environment variables into memory.

**Capturing the Raw Body:**
```js
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
```
When GitHub sends data, Express normally parses JSON and discards the raw bytes. This `verify` callback intercepts the raw buffer before parsing and stores it on `req.rawBody`. This is essential for HMAC verification because the hash must be computed against the exact raw bytes — not the parsed JSON object (which may differ in formatting).

Think of it like this: if someone sends you a letter in an envelope, Express normally reads the letter and throws the envelope away. This code says "keep the envelope too."

**The Webhook Route — `POST /webhook`:**

1. **Grab the headers** — `x-hub-signature-256` (the HMAC signature) and `x-github-delivery` (unique delivery ID). If either is missing, return `401`.

2. **Recreate the signature** — Take the raw body and the shared secret, run them through SHA256 HMAC to produce our own signature. This is like doing the same secret handshake GitHub did — if both match, it's really GitHub.

3. **Compare using `crypto.timingSafeEqual`** — Unlike a normal `===` comparison, `timingSafeEqual` always takes the same amount of time to run regardless of whether the match succeeds or fails. This prevents timing attacks where hackers guess the secret by measuring how fast the server says "no."

4. **Save to Supabase** — Use `supabase.upsert()` with `onConflict: 'delivery_id'`. The upsert ensures that if GitHub retries the same webhook (which it does when it suspects a timeout), the duplicate delivery is silently ignored rather than creating a duplicate row.

5. **Return 200 OK immediately** — GitHub will timeout if we don't respond fast enough. Heavy processing (diff fetching, analysis) happens later in the worker.

#### Step 4: Ngrok (Public Tunnel)
GitHub lives on the internet. Our Express server runs on `localhost:3000`. Ngrok bridges the gap:
```
ngrok http 3000
```
This generates a public URL (e.g., `https://xxxx.ngrok-free.dev`) that forwards all traffic to our local port 3000. The GitHub webhook is configured to send payloads to `https://xxxx.ngrok-free.dev/webhook`.

#### Step 5: GitHub Webhook Configuration
- **Payload URL:** `https://xxxx.ngrok-free.dev/webhook` (the `/webhook` suffix must match the Express route)
- **Content Type:** `application/json` (if left as `x-www-form-urlencoded`, `express.json()` would refuse to parse it)
- **Secret:** `my-shadow-secret-123` (used to generate the HMAC signature)
- **Events:** Just the push event

### Verification Gate 1 — Result
A tiny code change was committed and pushed to GitHub. The full flow executed:
```
GitHub push → Webhook → Ngrok → Express (HMAC verified) → Supabase (row saved) → 200 OK
```
The Supabase Table Editor showed a new row with `status: 'pending'`.

**Phase 1 is officially complete.**

---

## Phase 2: The Logic (Diff Fetcher & Decision Engine)

### Goal
The `raw_events` table was hoarding raw JSON. We needed a Background Worker to wake up, fetch the actual code from GitHub, filter out junk (typos, lockfiles), and score the commit to determine if it was worth sending to the AI.

### How It Was Implemented

#### Step 1: The Background Worker (worker.js)
A separate file (`worker.js`) was created and required at the bottom of `index.js` so it runs alongside the Express server.

**The Alarm Clock — `setInterval`:**
```js
setInterval(processPendingEvents, 10000);
```
Every 10 seconds, the worker queries Supabase for rows where `status = 'pending'`.

**The Lock — Marking as 'processing':**
When a pending row is found, the worker immediately updates its status to `'processing'`. This prevents the same row from being picked up again on the next poll interval.

**The Outbox Pattern:** This proves the Outbox Pattern in action. The Express server's only job is to catch the webhook and drop it in the outbox (`raw_events`). The worker takes its time opening the package and processing it. If the worker takes 30 seconds, GitHub never times out — because GitHub already received its `200 OK` and moved on.

#### Step 2: Fetching the Diff from GitHub API
The worker extracts `owner`, `repo`, and `commit.id` from the payload stored in Supabase and constructs a strict GitHub API URL:
```
https://api.github.com/repos/{owner}/{repo}/commits/{sha}
```

**The HTML Bug:** Initially, the worker printed HTML instead of raw diff text. This happened because GitHub redirects requests without proper headers to the web UI.

**The Fix — Three Required Headers:**
- `Accept: application/vnd.github.v3.diff` — tells GitHub to return raw diff text instead of JSON or HTML
- `User-Agent: Shadow-Portfolio-Worker` — GitHub's API rejects requests without a `User-Agent` header (it's how they identify legitimate programs vs spam bots)
- `Authorization: Bearer {GITHUB_ACCESS_TOKEN}` — a Personal Access Token that authenticates the request and increases API rate limits

**Why `head_commit.id` instead of `payload.compare`:** The `compare` URL gives the cumulative diff of the entire push (potentially many commits). `head_commit.id` targets exactly the one commit the developer just pushed, giving us a precise score for each individual change.

#### Step 3: The Decision Engine (evaluateDiff)
A function that takes the raw diff text and calculates a `significance_score`:

1. **Split by file** — The raw diff is split using `diff --git` as a delimiter, separating it into chunks, one per file.

2. **Filter junk files** — Files ending in `.md`, `package-lock.json`, `yarn.lock`, or `.env` are ignored. README edits, dependency bumps, and environment file changes don't represent real engineering work.

3. **Count real changes** — For remaining files, lines starting with `+` (added) or `-` (removed) are counted. Lines starting with `+++` or `---` are excluded — these are Git file headers (e.g., `+++ b/index.js`), not actual code. Counting them would inflate the score with metadata.

4. **Score threshold** — If the total score is less than 5, the row is marked `ignored`. If 5 or higher, it's marked `processed` and ready for AI analysis (Phase 3).

#### Step 4: Code Review — Edge Cases Fixed

The `/review` tool found several critical issues that were fixed:

**Unhandled Promise Rejections:**
If a Supabase update call failed outside a `try/catch`, the entire Node.js process would crash. Fixed by wrapping the entire worker logic in a `try/catch` block, ensuring any rejected promise resets the row to `pending` for retry.

**Multi-Commit Pushes:**
A push can contain multiple commits. The original code only evaluated the HEAD commit. Fixed by iterating over `payload.commits[]`, fetching each commit's diff, and summing all scores.

**Partial Score Bug:**
If a push has 3 commits and the 2nd commit's fetch fails, the code previously used `continue` — saving a partial score and losing data. Fixed by using `return` with a `pending` reset, so the entire batch is retried from the beginning on the next poll.

**Misleading Log Messages:**
The catch block logged "Worker fetch error" even when the actual failure was a database write error. Changed to "Worker processing error" for accuracy.

### Verification Gate 2 — Result
A 1-line comment was added to `index.js`, committed, and pushed to GitHub. The full pipeline executed:
```
GitHub push → Webhook → Express → Supabase (pending) → Worker (processing) → GitHub API (diff fetched) → Decision Engine (scored) → Supabase (processed)
```
The Supabase Table Editor showed `status: 'processed'` and `significance_score: 1` for the trivial change.

**Phase 2 is officially complete.**

---

## Phase 3: The Intelligence (AI Semantic Grouper)

### Goal
The database knew how much code we wrote, but not what the code did. We needed an AI to read the meaningful commits, understand the semantic meaning, and group them into "Learning Milestones" — telling a cohesive story of our engineering progress.

### How It Was Implemented

#### Step 1: The Relational Schema (PostgreSQL/Supabase)
Ran SQL to create three new tables: `learning_milestones`, `engineering_commits`, and `extracted_skills`.

**Referential Integrity (`REFERENCES`):**
The `engineering_commits` and `extracted_skills` tables use `milestone_id UUID REFERENCES learning_milestones(id)`. This enforces a strict database rule: you cannot save a commit or skill that points to a milestone that doesn't exist. It prevents orphaned data.

**Cascade Delete (`ON DELETE CASCADE`):**
If a milestone is deleted, the database automatically deletes all commits and skills linked to it. No manual cleanup required.

#### Step 2: The AI Service Layer (aiService.js)
Built an abstraction layer that talks to OpenRouter (using an OpenAI-compatible API structure, so the model can be swapped effortlessly).

**Context-Windowed Prompting:**
Instead of building an expensive vector database, we query Supabase for the 5 most recently active milestones and pass them into the AI's prompt alongside the code diff. The AI uses its context window to do semantic matching — a smart trade-off for a portfolio project's scale.

**Strict JSON Contract (`response_format: { type: "json_object" }`):**
We forced the AI to return a Discriminated Union. It must return exactly one of two shapes:
```
{ "action": "merge", "milestone_id": "<uuid>" }
{ "action": "create", "milestone_title": "...", "complexity_score": N, "extracted_skills": ["..."] }
```

**Safe Parsing:**
The entire fetch and `JSON.parse()` call is wrapped in a `try/catch`. If the AI hallucinates and returns bad text, the function returns `null` instead of crashing the Node.js process.

#### Step 3: Worker Integration & The `switch` Statement
Upgraded `worker.js`. If the deterministic score is >= 5, the worker pauses, fetches the 5 active milestones, and calls `evaluateDiffWithAI`.

**The `switch` Statement:**
We use `switch(aiResponse.action)` to handle the union. This is the ultimate safety net — if the AI returns a merge shape, we never look for `milestone_title`, preventing undefined errors and database crashes.

**Returning the Inserted ID (`.select().single()`):**
When the AI says `create`, we insert the new milestone into Supabase. But we need the new `milestone_id` back to link the subsequent commits and skills. We chain `.select().single()` to the insert command so Supabase instantly returns the newly created row object.

#### Step 4: The Self-Healing Outbox (Retry Logic)
During testing, the worker crashed because the new tables didn't exist yet. Because of the `try/catch` block built in Phase 2, the worker caught the error, reset the `raw_events` row back to `pending`, and stopped. When we fixed the database and restarted the server, the worker's 10-second alarm rang, found the pending row, and successfully processed the exact same commit.

**The system healed itself. No data was lost.**

### Verification Gate 3 — Result
The complete pipeline now executes end-to-end:
```
GitHub push → Webhook → Express → Supabase (pending) → Worker (processing) → GitHub API (diff fetched) → Decision Engine (scored) → AI (semantic grouping) → Supabase (milestones/commits/skills written)
```
Commits are now grouped into learning milestones with extracted skills, ready for display in Phase 4.

**Phase 3 is officially complete.**

---

## Phase 3.5: Backend Hardening (Production Readiness)

### Goal
Phase 3 made the pipeline work. Phase 3.5 makes it safe to leave running unattended — fixing crash bugs, race conditions, cross-repo contamination, infinite retry loops, and hallucinating AI responses. This is the difference between a "demo" and a "real system."

### Step 1: Isolating the Worker + The Dead-Letter Queue

**The Problem:**
The worker was embedded inside `index.js` via `require('./worker')`. This meant the Express server and worker were one process — if one crashed, both crashed. Worse, there was no limit on retries: any failure reset a row to `pending` forever, causing infinite, expensive retry loops (every retry calls the GitHub API and the paid AI API).

**What We Did:**

1. **Isolated the worker:** Removed `require('./worker')` from `index.js`. Added `"start:worker": "node worker.js"` to `package.json`. Now Express and the worker are separate processes — you can run them independently (`npm start` and `npm run start:worker`).

2. **Built the Dead-Letter Queue (DLQ):** Created a `handleProcessingError(rowId, errorMessage)` helper. Every time processing fails, it increments `retry_count` by 1:
   - If `retry_count` ≤ 3 → row goes back to `pending` for another try, error saved to `last_error`
   - If `retry_count` > 3 → row is marked `failed` (sent to the "dead letter pile") and never touched again

   This is a **counting switch**: after 3 strikes, the worker gives up on the broken event so it can't drain the API budget forever.

3. **Replaced all 9 manual `status: 'pending'` resets** in `worker.js` with calls to `handleProcessingError`.

**Database migration needed:** `raw_events` gained `retry_count` (integer, default 0) and `last_error` (text) columns.

### Step 2: Atomic Row Locking + Multi-Repo Scoping

**The Race Condition Problem:**
The worker used a two-step process: SELECT a pending row, then UPDATE it to `processing`. If two worker instances ran at the same moment, both could SELECT the *same* pending row and process it twice — double AI calls, duplicate milestones, chaos.

**The Fix — Atomic Row Locking (RPC):**
Replaced the two-step SELECT/UPDATE with a single atomic Postgres function called via `supabase.rpc('claim_pending_event')`. The SQL uses `FOR UPDATE SKIP LOCKED`:
```sql
SELECT * FROM raw_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
```
The database itself guarantees only ONE worker ever claims a row. Even if 10 workers poll at the exact same millisecond, only one succeeds; the rest are told "row taken, pick another." Duplicate processing became physically impossible.

**The Cross-Repo Contamination Problem:**
Every commit was grouped against milestones from *all* repositories. One repo's "JWT Auth" milestone could absorb commits from another repo.

**The Fix — Multi-Repo Scoping:**
- Extracted `repoId` from `payload.repository.full_name` (fallback: `.id`)
- Milestone queries now filter `.eq('repository_id', repoId)`
- New milestones (`create` action) now store `repository_id` on insert

**Database migration needed:** `learning_milestones` gained a `repository_id` column.

**SQL file:** All Phase 3.5 migrations live in `sql/phase-3.5-hardening.sql`.

### Step 3: Smarter Filtering + AI Response Validation

**Smarter Decision Engine Filtering:**
Expanded `evaluateDiff` to ignore more junk:
- Added `.css`, `.svg`, `.min.js` to the ignore list (plus existing `.md`, lockfiles, `.env`)
- Any file path containing `node_modules/` is skipped (dependencies, not your code)
- Added a safety limit: any diff longer than 50,000 characters is truncated before scoring to prevent RAM blowups

**AI Merge Validation:**
The AI is a probability engine — it can hallucinate a `milestone_id` that doesn't exist. Before inserting into `engineering_commits`, the worker now:
1. SELECTs the milestone by `aiResponse.milestone_id`
2. If it's missing OR not `active`, calls `handleProcessingError('AI hallucinated invalid milestone_id')` and skips the insert

Without this check, a fake ID would violate the Foreign Key constraint (`REFERENCES learning_milestones(id)`) and crash the insert — triggering another expensive retry loop.

### The CSS Bug: A Real Lesson in Stale Processes

**What happened:** Pushed `styles.css` (20 lines of `body { color: red; }`) as a test of the new `.css` filter. But the worker logged `Created milestone "Add basic red body color stylesheet" with score 20`.

**Why:** The running worker process was started **before** we added `.css` to the ignore list. Node.js does **not** hot-reload — the process kept executing the old code in memory. The `.css` filter wasn't in that process, so all 20 lines scored.

**The fix:** Restart the worker (`npm run start:worker`) so it loads the new code.

**The cleanup:** Deleted the junk milestone from Supabase and reset raw_events row 29 back to `pending` so the fresh worker could re-test the exact same commit.

### Verification Tests After Hardening

**Test 1 — CSS filter (noise should be ignored):**
Pushed CSS changes (9+ lines). The fresh worker scored the diff **0** → marked `ignored`. No AI call. ✅ Noise correctly filtered.

**Test 2 — Real JS code (signal should reach the AI):**
Pushed `calculateAnalyticsMetrics` (8 lines of real JS in `index.js`). Worker scored it **8** ≥ 5 → AI evaluated it → created a milestone. ✅ Real engineering reaches the AI.

**Phase 3.5 is officially complete.** The pipeline is now crash-resistant, race-free, repo-scoped, cost-capped, and immune to AI hallucinations.

---

## Production Hardening: The Attack-Surface Pass

### Goal
Phase 3.5 made the pipeline safe from *internal* failure (crashes, races, costs). This pass makes it safe from *external* attackers — real hackers who can hit the webhook endpoint or feed malicious content into the AI — as well as from GitHub API abuse. The focus: security and graceful degradation under adversarial input.

### Step 1: Constant-Time HMAC (index.js)
The old comparison checked `sigBuf.length !== digBuf.length` then called `timingSafeEqual`. That length-branch leaked information and could throw `TypeError` on mismatch lengths.

**The fix — hash both sides to a fixed length:**
```js
const h1 = crypto.createHash('sha256').update(signature).digest();
const h2 = crypto.createHash('sha256').update(digest).digest();
const signaturesMatch = crypto.timingSafeEqual(h1, h2);
```
Both the incoming `x-hub-signature-256` and our computed digest are re-hashed through SHA-256 to fixed 32-byte digests *before* comparison. `timingSafeEqual` now always compares equal-length buffers, eliminating the length branch and making it impossible to throw `TypeError` — so a forged short signature can't be used to fingerprint the secret via timing.

### Step 2: Prompt Injection Quarantine + Response Schema
**Injection defense (`sanitizeDiffForPrompt`):** The diff is untrusted raw data wrapped in `<diff>...</diff>` tags in the prompt. An attacker could embed a literal `</diff>` in their code to break out of the boundary and inject instructions. The sanitizer escapes every literal `</diff>` → `<\/diff>` before the diff enters the prompt, closing that escape.

**Runtime schema validation (`validateAIResponse`):** The AI is probabilistic — it can return malformed or hallucinated JSON. Before trusting the response, the worker now validates it struct-fittingly:
- `action` must be `create` or `merge`
- `create` requires a string `milestone_title` (capped at 200 chars), enforces `complexity_score` in 1–10 (fallback 5), filters `extracted_skills` to a max of 20 string entries
- `merge` requires a string `milestone_id`
- Unknown action or missing fields → returns `null` → the worker treats it as a retryable failure (event's fault), not a crash

**Configurable headers:** `HTTP-Referer` and `X-Title` now read from env (`APP_REFERER_URL`, `APP_TITLE`) with sensible defaults, so the OpenRouter identity isn't hard-coded.

### Step 3: GitHub Rate-Limit Backoff
A queue-wide retry storm isn't the events' fault — it's GitHub throttling our token. The worker now:
- On HTTP 429/403 reads `x-ratelimit-reset` (fallback `retry-after`, then 60s default) to compute the exact paused duration
- Sets a **global `rateLimitPausedUntil`** gate. Every later poll cycle checks it and skips work until the window expires — the whole queue breathes instead of hammering GitHub
- Resets the affected row to `pending` **without** incrementing `retry_count` (the event is fine; the API is throttled — no point exhausting its retries)

### Step 4: Fully Atomic Database Transactions (RPCs)
Previously `create` + `merge` did multi-step client-side inserts (partial-write risk on failure mid-way):
- **`create_milestone_with_details`** now accepts `p_commit_hashes TEXT[]` and inserts all commits atomically via `unnest()` plus skills — no commit dropped, no partial state.
- **`merge_milestone_with_details`** (new) `SELECT ... FOR UPDATE`-locks the target milestone, validates it exists and is `'active'`, then inserts all commit hashes in one transaction. If the milestone is missing/inactive it `RAISE EXCEPTION`s, rolling back the whole transaction — so an AI-hallucinated ID can never corrupt linked commits.

### Step 5: Robust Diff Parsing & URL Safety
- File-path extraction uses `line.lastIndexOf(' b/')` instead of a greedy regex, so filenames containing the letter `b` or spaces parse correctly.
- The 50,000-char truncation now cuts at the nearest preceding `\n` (`lastIndexOf('\n')`), so a diff header/hunk line is never chopped mid-line.
- GitHub API URL segments (`owner`, `repo`, `commitSha`) are `encodeURIComponent()`-wrapped to survive special characters.
- Added an explicit empty-commit guard: if the push's commit list yields no valid SHAs, the row is routed to error handling instead of silently proceeding.

### Verification
All four source files pass `node -c` (syntax-valid): `index.js`, `worker.js`, `aiService.js`, `supabaseClient.js`.

> **Deploy note:** `sql/production-hardening.sql` must be run in the Supabase SQL Editor so the worker's updated RPC calls (array args + `merge_milestone_with_details`) resolve.

**Production Hardening complete.** The gateway verifies signatures in constant time, the AI is hardened against injection and malformed output, GitHub throttling is handled gracefully, and all milestone writes are atomic database transactions.

---

## Backend Fundamentals Learned

This project was designed not just to work, but to teach real-world backend engineering. Each topic below maps to concrete code in this repo — the depth behind the app.

### 1. Event-Driven Architecture & Asynchronous Processing
Systems that react to events (webhooks) instead of constantly asking for updates (polling).

**Done here:** GitHub sends the webhook → Express gateway replies `200 OK` instantly → the Background Worker wakes up on a timer. Ingestion and processing are fully decoupled.

**Theory: The Outbox Pattern.** Decoupling ingestion from processing so the caller (GitHub) never times out, even if the heavy work takes 30 seconds.

> Where: `index.js` webhook route (instant 200), `worker.js` timer loop.

### 2. Distributed Systems & Concurrency Control
When multiple machines or processes try to access the same database at the same time.

- **Done here:** `FORE UPDATE SKIP LOCKED` atomic locking, the Dead-Letter Queue (`retry_count`), and recursive `setTimeout` to prevent overlapping runs.

**Theory:** Race conditions, Atomicity, Idempotency, and Poison Pill prevention. This is the hardest part of backend engineering — and why PostgreSQL is so powerful.

> Where: `sql/phase-3.5-hardening.sql` (`claim_pending_event`), `worker.js` (`handleProcessingError`).

### 3. Database Management & Relational Modeling
How to structure data so it is clean, linked, and cannot be corrupted.

- **Done here:** The `learning_milestones`, `engineering_commits`, and `extracted_skills` relational tables.

**Theory:** Foreign Keys, Referential Integrity (`REFERENCES`), Row Level Security (RLS), and Normalization.

> Where: the four relational tables in Supabase.

### 4. Application Security & Cryptography
Proving identity and protecting data from malicious actors.

- **Done here:** HMAC-SHA256 signature verification, `crypto.timingSafeEqual` (prevents timing attacks), and Prompt Injection defense (`<diff>` untrusted-tag quarantine).

**Theory:** Shared secrets, constant-time comparison algorithms, and untrusted-input handling.

> Where: `index.js` (HMAC check), `aiService.js` (injection defense).

### 5. System Reliability & Fault Tolerance
Assuming everything will break (networks, APIs, databases) and designing the system to survive.

- **Done here:** `try/catch` blocks, `AbortSignal.timeout(15000/45000)` fetch timeouts, resetting rows to `pending` on failure, and validating the AI's JSON before saving it.

**Theory:** Graceful degradation, retries, Dead-Letter Queues, and defensive programming.

> Where: `worker.js` (error handling), `aiService.js` (fetch timeout + safe parsing).

### 6. API Integration & LLM Engineering
Making third-party services talk to each other safely.

- **Done here:** GitHub API diff fetching, OpenRouter integration, strict JSON contracts (`response_format`), and Discriminated Unions (`switch` on `action`).

**Theory:** REST API standards, rate limiting, context-window management, and structured data extraction.

> Where: `worker.js` (GitHub fetch), `aiService.js` (OpenRouter call), the `switch(aiResponse.action)` handler.

---

**Why this matters:** Building an app proves you can write code. Building *this* app proves you understand the engineering fundamentals behind it — the problems that only show up when real traffic, real concurrency, and real APIs are involved. That's what separates "Tutorial Hell" from "Proof of Competence." This was the entire purpose of the project.