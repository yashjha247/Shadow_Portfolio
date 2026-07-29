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
