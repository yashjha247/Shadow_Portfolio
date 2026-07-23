Here's the index.js file, line by line in plain English:
The Setup (Lines 1–7)
require('dotenv').config();          // Load secrets from .env file
const express = require('express');  // Get the Express library (web framework)
const crypto = require('crypto');    // Get Node's built-in cryptography tools
const supabase = require('./supabaseClient'); // Get our database connection
const app = express();               // Create the web server
const PORT = 3000;                   // We'll run on port 3000
This is just importing tools and setting up. Think of it like unpacking your toolbag before starting work.
The Body Catcher (Lines 9–13)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
When GitHub sends us data, Express normally parses it and throws the raw version away. But we need the raw version to verify the signature. So this little trick says: "Hey, before you throw away the raw bytes, stash them on req.rawBody for me."
Think of it like this: if someone sends you a letter in an envelope, Express normally just reads the letter and throws the envelope away. This code says "keep the envelope too."
The Webhook Handler (Lines 15–52)
app.post('/webhook', async (req, res) => {
When GitHub sends a POST request to http://your-server.com/webhook, this function runs.
Step 1: Grab the Headers (Lines 17–22)
const signature = req.headers['x-hub-signature-256'];
const deliveryId = req.headers['x-github-delivery'];
if (!signature || !deliveryId) {
  return res.status(401).json({ error: 'Missing signature or delivery ID' });
}
GitHub sends two special headers:
x-hub-signature-256 — a secret code that proves the request actually came from GitHub (and not a hacker)
x-github-delivery — a unique ID for this delivery (so we don't process the same thing twice)
If either is missing, we return 401 (which means "you're not allowed here").
Step 2: Recreate the Signature (Lines 24–26)
const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
hmac.update(req.rawBody);
const digest = `sha256=${hmac.digest('hex')}`;
We take our secret password (stored in .env as GITHUB_WEBHOOK_SECRET) and the raw request body, and run them through a math formula (SHA256 HMAC) to produce our own signature.
This is like: GitHub says "here's a secret handshake." We do the same secret handshake on our end. If both handshakes match, we know it's really GitHub.
Step 3: Compare Signatures Safely (Lines 28–33)
const sigBuf = Buffer.from(signature);
const digBuf = Buffer.from(digest);
if (sigBuf.length !== digBuf.length || !crypto.timingSafeEqual(sigBuf, digBuf)) {
  return res.status(401).json({ error: 'Invalid signature' });
}
We compare GitHub's signature with ours. crypto.timingSafeEqual is special — it always takes the same amount of time to run, even if the comparison fails. This prevents a type of hack called a timing attack where hackers guess your secret by measuring how fast you say "no."
If the signatures don't match, we return 401. Door's locked.
Step 4: Save to Database (Lines 35–45)
const { error } = await supabase
  .from('raw_events')
  .upsert(
    { delivery_id: deliveryId, payload: req.body, status: 'pending' },
    { onConflict: 'delivery_id' }
  );
If the signature is valid, we save the data to the raw_events table in Supabase:
delivery_id — the unique ID from GitHub (prevents duplicates)
payload — the entire JSON GitHub sent us (the commit data)
status: 'pending' — marks it as "waiting to be processed"
upsert means "insert this row, but if a row with the same delivery_id already exists, update it instead." This prevents duplicate entries.
If saving fails, we log the error and return 500 (server error).
Step 5: Say "OK" Immediately (Line 47)
return res.status(200).json({ status: 'ok' });
We send back a 200 OK to GitHub right away. This is critical — GitHub will timeout and retry the webhook if we don't respond fast enough. We don't do any heavy processing here. We just save and respond.
The Safety Net (Lines 48–51)
catch (err) {
  console.error('Webhook handler error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}
If anything unexpected crashes (network failure, missing variable, etc.), this catch block grabs it, logs it so we can debug later, and returns a 500 error so GitHub knows something went wrong.
The Starter (Lines 54–56)
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
This is the ignition key. It tells the server: "wake up, listen on port 3000, and wait for incoming webhooks."
The Big Picture Flow
GitHub pushes code
       ↓
GitHub sends POST to /webhook
       ↓
We check the secret handshake (HMAC signature)
       ↓
  ❌ Bad signature → 401 (go away)
  ✅ Good signature → Save to raw_events table → 200 OK
That's it. Phase 1 has only one job: catch the webhook, verify it, dump it in the database, and reply fast. Everything else (analyzing the code, grouping into milestones) comes in later phases.



Phase 1: The Foundation (Gateway & Outbox) - COMPLETE
The Goal
Build an Express server that catches GitHub webhooks, verifies they are actually from GitHub (security), and saves the raw data into a Supabase database instantly so GitHub doesn't time out.

Step 1: The Database Setup (Supabase)
What we did: Created a Supabase project and ran SQL to create a table called raw_events.
The Columns: id (auto-incrementing), event_type (push/ping), delivery_id (unique tracking number), payload (the raw JSON), status (pending/processed/ignored), created_at.
The Security: We enabled Row Level Security (RLS). This means the public internet cannot read or write to this table.
The Keys: We grabbed the SUPABASE_URL and the service_role (Secret) key. We used the Secret key because it acts as an admin pass that bypasses RLS, allowing our trusted backend server to write to the database.


Step 2: The .env File (Secrets Management)
What we did: Created a .env file in VS Code to hold our passwords.
Why: Hardcoding passwords in index.js is a massive security risk. If we push to GitHub, hackers steal our keys. The .env file stays local and is ignored by Git (via .gitignore).
Variables inside:
SUPABASE_URL
SUPABASE_SERVICE_KEY (Admin bypass key)
GITHUB_WEBHOOK_SECRET (A made-up shared password for GitHub to use)

Step 3: The Express Server (index.js)
We wrote the Node.js/Express code. Here is the anatomy of the server:

require('dotenv').config()
What it does: Tells Node.js to read the .env file and load the passwords into memory (process.env).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }))

What it does: Grabs a picture of the unopened envelope (the raw bytes) before Express translates it to JSON. We need these exact, untouched bytes to verify GitHub's security stamp.
The HMAC Security Check (crypto module)

What it does: Takes the req.rawBody, mixes it with our GITHUB_WEBHOOK_SECRET, and creates a SHA256 hash.
The Comparison: We use crypto.timingSafeEqual to compare our hash to GitHub's hash. We use this instead of === so hackers can't guess the password by measuring how fast our server says "Wrong."

Result: If it fails, we return a 401 Unauthorized.
The Smart Mailbox (supabase.upsert())

What it does: Takes the JSON payload and saves it to the raw_events table.

The upsert: We use upsert with onConflict: 'delivery_id'. GitHub is impatient and retries if it thinks you didn't reply fast enough. If GitHub sends the same webhook twice, the upsert looks at the tracking number (delivery_id). If it already exists, it doesn't create a duplicate row. Our database stays clean.
res.status(200).json({ status: 'ok' })

What it does: Instantly tells GitHub "I got the package!" so GitHub doesn't panic and retry.

Step 4: The Public Bridge (Ngrok)

The Problem: GitHub lives on the internet. Our Express server lives on localhost:3000. GitHub cannot reach localhost.

The Solution: We used ngrok http 3000. Ngrok gave us a public URL (https://unwoven-plausible-jinx.ngrok-free.dev) that acts like a bridge. It catches traffic on the internet and funnels it straight into our local laptop's port 3000.

Note: Ngrok URLs change every time you restart it (unless you pay). This is only for local development. Later, we will deploy to a real cloud host for a permanent URL.

Step 5: The GitHub Webhook
What we did: Went to GitHub Repo -> Settings -> Webhooks -> Add webhook.
Payload URL: https://unwoven-plausible-jinx.ngrok-free.dev/webhook (Crucial: we had to add /webhook to the end so it matched our Express route, otherwise we got a 404 Not Found).
Content Type: application/json (If we left this as application/x-www-form-urlencoded, our express.json() parser would refuse to read it, and we would save an empty object to the database).

Secret: my-shadow-secret-123 (Used to generate the HMAC stamp).
Events: Just the push event.
Verification Gate 1: The Result
We made a tiny code change, committed it, and pushed to GitHub.
GitHub sent the webhook -> Ngrok caught it -> Express verified the signature -> Supabase saved the row -> Server returned 200 OK.
We looked at the Supabase Table Editor and saw the row sitting there with status: 'pending'.

PHASE 1 IS OFFICIALLY COMPLETE.