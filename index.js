require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const supabase = require('./supabaseClient');

const app = express();
const PORT = 3000;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-hub-signature-256'];
    const deliveryId = req.headers['x-github-delivery'];
    const eventType = req.headers['x-github-event'];

    if (!signature || !deliveryId) {
      return res.status(401).json({ error: 'Missing signature or delivery ID' });
    }

    const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
    hmac.update(req.rawBody);
    const digest = `sha256=${hmac.digest('hex')}`;

    const sigBuf = Buffer.from(signature);
    const digBuf = Buffer.from(digest);

    if (sigBuf.length !== digBuf.length || !crypto.timingSafeEqual(sigBuf, digBuf)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { error } = await supabase
      .from('raw_events')
      .upsert(
        { delivery_id: deliveryId, event_type: eventType, payload: req.body, status: 'pending' },
        { onConflict: 'delivery_id' }
      );

    if (error) {
      console.error('Supabase upsert error:', error);
      require('fs').appendFileSync('error-debug.log', JSON.stringify(error) + '\n');
      return res.status(500).json({ error: 'Database error' });
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Triggering webhook again
// Testing hardening step 2
// Triggering AI test now
// Final AI trigger test
// Webhook retry test
function calculateUserStats(userData) {
  const totalLogins = userData.logins.length;
  const lastLogin = userData.logins[totalLogins - 1];
  const isActive = totalLogins > 0;
  const accountAge = new Date().getFullYear() - userData.createdAt;
  return { totalLogins, lastLogin, isActive, accountAge };
}

function testRealPipeline() {
  const score = 7;
  console.log("Testing real pipeline score:", score);
}

function handleDatabaseRetry(dbClient, query) {
  let attempts = 0;
  let maxRetries = 3;
  let success = false;
  while (attempts < maxRetries && !success) {
    try {
      const result = dbClient.execute(query);
      success = true;
      return result;
    } catch (err) {
      attempts++;
      console.log(`Retry attempt ${attempts} failed.`);
    }
  }
  throw new Error("Max retries reached");
}

function calculateAnalyticsMetrics(data) {
  const totalUsers = data.users.length;
  const activeUsers = data.users.filter(u => u.isActive).length;
  const churnRate = (totalUsers - activeUsers) / totalUsers;
  const revenue = data.payments.reduce((acc, p) => acc + p.amount, 0);
  return { totalUsers, activeUsers, churnRate, revenue };
}