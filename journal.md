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