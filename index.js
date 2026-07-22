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
        { delivery_id: deliveryId, payload: req.body, status: 'pending' },
        { onConflict: 'delivery_id' }
      );

    if (error) {
      console.error('Supabase upsert error:', error);
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
//testing the github webhook 