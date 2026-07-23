require('dotenv').config();
const supabase = require('./supabaseClient');

async function processPendingEvents() {
  const { data: rows, error: fetchError } = await supabase
    .from('raw_events')
    .select('*')
    .eq('status', 'pending')
    .limit(1);

  if (fetchError) {
    console.error('Worker fetch error:', fetchError);
    return;
  }

  if (!rows || rows.length === 0) return;

  const row = rows[0];

  const { error: updateError } = await supabase
    .from('raw_events')
    .update({ status: 'processing' })
    .eq('id', row.id);

  if (updateError) {
    console.error('Worker status update error:', updateError);
    return;
  }

  const compareUrl = row.payload?.compare;
  if (!compareUrl) {
    console.log('No compare URL in payload, skipping');
    return;
  }

  try {
    const response = await fetch(compareUrl, {
      headers: {
        Accept: 'application/vnd.github.v3.diff',
        Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      console.error('GitHub diff fetch failed:', response.status, response.statusText);
      return;
    }

    const diffText = await response.text();
    console.log('--- DIFF START ---');
    console.log(diffText);
    console.log('--- DIFF END ---');
  } catch (err) {
    console.error('Worker fetch error:', err);
  }
}

setInterval(processPendingEvents, 10000);

console.log('Worker started — polling every 10s');
