require('dotenv').config();
const supabase = require('./supabaseClient');

function evaluateDiff(diffText) {
  if (!diffText) return 0;

  const ignoreFiles = ['.md', 'package-lock.json', 'yarn.lock', '.env'];

  const fileSections = diffText.split('diff --git');
  let totalScore = 0;

  for (const section of fileSections) {
    if (!section.trim()) continue;

    const headerLine = section.split('\n')[0];
    const filePath = headerLine.split(' b/')[1] || headerLine;

    if (ignoreFiles.some(ext => filePath.endsWith(ext))) continue;

    const lines = section.split('\n');
    let fileScore = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('+++') || trimmed.startsWith('---')) continue;
      if (trimmed.startsWith('+') || trimmed.startsWith('-')) fileScore++;
    }

    totalScore += fileScore;
  }

  return totalScore;
}

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

  try {
    const { error: updateError } = await supabase
      .from('raw_events')
      .update({ status: 'processing' })
      .eq('id', row.id);

    if (updateError) {
      console.error('Worker status update error:', updateError);
      return;
    }

    const payload = row.payload;
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    const commits = payload?.commits;

    if (!owner || !repo || !commits || commits.length === 0) {
      console.log('Missing owner, repo, or commits in payload');
      await supabase.from('raw_events').update({ status: 'pending' }).eq('id', row.id);
      return;
    }

    let totalScore = 0;

    for (const commit of commits) {
      const commitSha = commit?.id;
      if (!commitSha) continue;

      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`;

      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3.diff',
          Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`,
          'User-Agent': 'Shadow-Portfolio-Worker',
        },
      });

      if (!response.ok) {
        console.error('GitHub diff fetch failed:', response.status, response.statusText);
        await supabase.from('raw_events').update({ status: 'pending' }).eq('id', row.id);
        return;
      }

      const diffText = await response.text();
      totalScore += evaluateDiff(diffText);
    }

    const newStatus = totalScore < 5 ? 'ignored' : 'processed';

    const { error: statusError } = await supabase
      .from('raw_events')
      .update({ status: newStatus, significance_score: totalScore })
      .eq('id', row.id);

    if (statusError) {
      console.error('Worker status update error:', statusError);
      await supabase.from('raw_events').update({ status: 'pending' }).eq('id', row.id);
      return;
    }

    console.log(`Commit ${newStatus} with total score ${totalScore}`);
  } catch (err) {
    console.error('Worker processing error:', err);
    await supabase.from('raw_events').update({ status: 'pending' }).eq('id', row.id);
  }
}

setInterval(processPendingEvents, 10000);

console.log('Worker started — polling every 10s');
