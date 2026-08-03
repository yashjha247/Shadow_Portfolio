require('dotenv').config();
const supabase = require('./supabaseClient');
const { evaluateDiffWithAI } = require('./aiService');

// --- Global rate limit state ---
// When GitHub returns 429/403, we pause ALL queue processing until this timestamp.
let rateLimitPausedUntil = 0;

async function handleProcessingError(rowId, errorMessage) {
  const { data: currentRow } = await supabase
    .from('raw_events')
    .select('retry_count')
    .eq('id', rowId)
    .single();

  const currentRetryCount = currentRow?.retry_count ?? 0;
  const newRetryCount = currentRetryCount + 1;
  const isExhausted = newRetryCount > 3;

  // Exponential backoff: 30s, 60s, 90s
  const nextRetryAt = new Date(Date.now() + (newRetryCount * 30000)).toISOString();

  const { error } = await supabase
    .from('raw_events')
    .update({
      retry_count: newRetryCount,
      status: isExhausted ? 'failed' : 'pending',
      last_error: errorMessage,
      next_retry_at: isExhausted ? null : nextRetryAt,
    })
    .eq('id', rowId);

  if (error) {
    console.error('handleProcessingError failed:', error);
    return;
  }

  console.log(
    `Row ${rowId} retry ${newRetryCount}/3 → ${isExhausted ? 'failed' : 'pending'}: ${errorMessage}`
  );
}

function evaluateDiff(diffText) {
  if (!diffText) return 0;

  // Truncate at the nearest newline boundary to avoid corrupting
  // a diff header or hunk line mid-character.
  if (diffText.length > 50000) {
    const cutoff = diffText.lastIndexOf('\n', 50000);
    diffText = diffText.slice(0, cutoff > 0 ? cutoff : 50000);
  }

  const ignoreFiles = ['.md', '.css', '.svg', '.min.js', 'package-lock.json', 'yarn.lock', '.env'];

  const allLines = diffText.split('\n');
  let activeFile = null;
  let totalScore = 0;

  for (const line of allLines) {
    // Match diff headers. The regex captures the b/ path, handling
    // filenames with spaces by anchoring on the known ' b/' separator.
    if (line.startsWith('diff --git')) {
      const bMarker = line.lastIndexOf(' b/');
      activeFile = bMarker !== -1 ? line.slice(bMarker + 3) : null;
      continue;
    }

    if (!activeFile) continue;

    const lowerPath = activeFile.toLowerCase();
    if (lowerPath.includes('node_modules/')) continue;
    if (ignoreFiles.some(ext => lowerPath.endsWith(ext))) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('+++') || trimmed.startsWith('---')) continue;
    if (trimmed.startsWith('+') || trimmed.startsWith('-')) totalScore++;
  }

  return totalScore;
}

async function processPendingEvents() {
  // --- Rate limit guard ---
  // If we recently got a 429/403 from GitHub, skip this cycle entirely.
  if (Date.now() < rateLimitPausedUntil) {
    const waitSec = Math.ceil((rateLimitPausedUntil - Date.now()) / 1000);
    console.log(`Rate-limited. Skipping cycle, resuming in ${waitSec}s.`);
    return;
  }

  const { data: rows, error: fetchError } = await supabase.rpc('claim_pending_event');

  if (fetchError) {
    console.error('Worker fetch error:', fetchError);
    return;
  }

  if (!rows || rows.length === 0) return;

  const row = rows[0];

  try {
    const payload = row.payload;
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    const repoId = payload?.repository?.full_name || String(payload?.repository?.id);
    const commits = payload?.commits;

    if (!owner || !repo || !repoId || !commits || commits.length === 0) {
      await handleProcessingError(row.id, 'Missing owner, repo, or commits in payload');
      return;
    }

    let totalScore = 0;
    let totalDiffText = '';
    const commitShas = [];

    for (const commit of commits) {
      const commitSha = commit?.id;
      if (!commitSha) continue;
      commitShas.push(commitSha);

      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitSha)}`;

      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3.diff',
          Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`,
          'User-Agent': 'Shadow-Portfolio-Worker',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 429 || response.status === 403) {
        // Parse GitHub's rate limit reset header to determine exact wait time.
        // Falls back to a 60-second default pause if header is missing.
        const resetHeader = response.headers.get('x-ratelimit-reset');
        const retryAfter = response.headers.get('retry-after');

        let pauseMs = 60000; // default: 60s
        if (resetHeader) {
          pauseMs = Math.max((parseInt(resetHeader, 10) * 1000) - Date.now(), 10000);
        } else if (retryAfter) {
          pauseMs = parseInt(retryAfter, 10) * 1000 || 60000;
        }

        rateLimitPausedUntil = Date.now() + pauseMs;
        console.warn(`GitHub rate limit hit. Pausing worker for ${Math.ceil(pauseMs / 1000)}s.`);

        // Do NOT increment retry_count — this isn't the event's fault.
        // Set status back to pending so it will be re-claimed after the pause.
        await supabase
          .from('raw_events')
          .update({ status: 'pending' })
          .eq('id', row.id);
        return;
      }

      if (!response.ok) {
        await handleProcessingError(row.id, `GitHub diff fetch failed: ${response.status} ${response.statusText}`);
        return;
      }

      const diffText = await response.text();
      totalDiffText += diffText + '\n';
      totalScore += evaluateDiff(diffText);
    }

    if (commitShas.length === 0) {
      await handleProcessingError(row.id, 'No valid commit SHAs found in payload');
      return;
    }

    if (totalScore < 5) {
      const { error: statusError } = await supabase
        .from('raw_events')
        .update({ status: 'ignored', significance_score: totalScore })
        .eq('id', row.id);

      if (statusError) {
        await handleProcessingError(row.id, statusError.message);
        return;
      }

      console.log(`Commit ignored with score ${totalScore}`);
      return;
    }

    const { data: recentMilestones, error: milestonesError } = await supabase
      .from('learning_milestones')
      .select('*')
      .eq('status', 'active')
      .eq('repository_id', repoId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (milestonesError) {
      await handleProcessingError(row.id, `Failed to fetch recent milestones: ${milestonesError.message}`);
      return;
    }

    const aiResponse = await evaluateDiffWithAI(totalDiffText, recentMilestones || []);

    if (!aiResponse) {
      await handleProcessingError(row.id, 'AI returned no valid response');
      return;
    }

    switch (aiResponse.action) {
      case 'create': {
        const { data: createResult, error: createError } = await supabase.rpc(
          'create_milestone_with_details',
          {
            p_title: aiResponse.milestone_title,
            p_complexity: aiResponse.complexity_score,
            p_repository_id: repoId,
            p_commit_hashes: commitShas,
            p_significance_score: totalScore,
            p_skills: aiResponse.extracted_skills || [],
          }
        );

        if (createError || !createResult) {
          await handleProcessingError(row.id, `Failed to create milestone: ${createError?.message || 'no response from RPC'}`);
          return;
        }

        console.log(`Created milestone "${aiResponse.milestone_title}" with score ${totalScore}`);
        break;
      }
      case 'merge': {
        const { data: mergeResult, error: mergeError } = await supabase.rpc(
          'merge_milestone_with_details',
          {
            p_milestone_id: aiResponse.milestone_id,
            p_commit_hashes: commitShas,
            p_significance_score: totalScore,
          }
        );

        if (mergeError || !mergeResult) {
          await handleProcessingError(row.id, `Failed to merge milestone: ${mergeError?.message || 'no response from RPC'}`);
          return;
        }

        console.log(`Merged into milestone ${aiResponse.milestone_id} with score ${totalScore}`);
        break;
      }
      default: {
        await handleProcessingError(row.id, `Unknown AI action: ${aiResponse.action}`);
        return;
      }
    }

    const { error: statusError } = await supabase
      .from('raw_events')
      .update({ status: 'processed', significance_score: totalScore })
      .eq('id', row.id);

    if (statusError) {
      await handleProcessingError(row.id, statusError.message);
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Request timed out (AbortError)');
    }
    await handleProcessingError(row.id, err.message);
  }
}

async function startWorkerLoop() {
  try {
    await processPendingEvents();
  } catch (err) {
    console.error('Worker loop error:', err);
  } finally {
    setTimeout(startWorkerLoop, 10000);
  }
}

startWorkerLoop();

console.log('Worker started — polling every 10s');
