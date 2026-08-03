-- Production Hardening — run these in the Supabase SQL Editor

-- 0. Exponential backoff support: when to allow the next retry of a row
ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- 1. Updated claim_pending_event: respects next_retry_at for exponential backoff.
--    Rows with a future next_retry_at are skipped until their backoff window expires.
CREATE OR REPLACE FUNCTION claim_pending_event()
RETURNS SETOF raw_events
LANGUAGE plpgsql
AS $$
DECLARE
  claimed_row raw_events;
BEGIN
  SELECT * INTO claimed_row
  FROM raw_events
  WHERE status = 'pending'
    AND (next_retry_at IS NULL OR next_retry_at <= NOW())
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF claimed_row.id IS NOT NULL THEN
    UPDATE raw_events
    SET status = 'processing'
    WHERE id = claimed_row.id
    RETURNING * INTO claimed_row;

    RETURN NEXT claimed_row;
  END IF;

  RETURN;
END;
$$;

-- 2. Updated create_milestone_with_details: accepts an ARRAY of commit hashes
--    so all commits in a push event are linked atomically.
CREATE OR REPLACE FUNCTION create_milestone_with_details(
  p_title TEXT,
  p_complexity INTEGER,
  p_repository_id TEXT,
  p_commit_hashes TEXT[],
  p_significance_score INTEGER,
  p_skills TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  new_milestone_id UUID;
BEGIN
  INSERT INTO learning_milestones (title, status, complexity_score, repository_id)
  VALUES (p_title, 'active', p_complexity, p_repository_id)
  RETURNING id INTO new_milestone_id;

  INSERT INTO engineering_commits (commit_hash, milestone_id, significance_score)
  SELECT unnest(p_commit_hashes), new_milestone_id, p_significance_score;

  IF p_skills IS NOT NULL AND array_length(p_skills, 1) > 0 THEN
    INSERT INTO extracted_skills (milestone_id, skill_name)
    SELECT new_milestone_id, unnest(p_skills);
  END IF;

  RETURN jsonb_build_object('milestone_id', new_milestone_id);
END;
$$;

-- 3. New merge_milestone_with_details: atomically validates that the target
--    milestone exists & is active, then inserts all commit hashes.
--    Raises an exception (rolling back the transaction) if the milestone
--    is missing or inactive — preventing hallucinated IDs from corrupting data.
CREATE OR REPLACE FUNCTION merge_milestone_with_details(
  p_milestone_id UUID,
  p_commit_hashes TEXT[],
  p_significance_score INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  target_status TEXT;
BEGIN
  SELECT status INTO target_status
  FROM learning_milestones
  WHERE id = p_milestone_id
  FOR UPDATE;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'Milestone % does not exist', p_milestone_id;
  END IF;

  IF target_status != 'active' THEN
    RAISE EXCEPTION 'Milestone % is not active (status: %)', p_milestone_id, target_status;
  END IF;

  INSERT INTO engineering_commits (commit_hash, milestone_id, significance_score)
  SELECT unnest(p_commit_hashes), p_milestone_id, p_significance_score;

  RETURN jsonb_build_object('milestone_id', p_milestone_id, 'commits_linked', array_length(p_commit_hashes, 1));
END;
$$;
