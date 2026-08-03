-- Phase 3.5: Backend Hardening — run these in the Supabase SQL Editor

-- 1. Add retry_count and last_error columns to raw_events (if missing)
ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 2. Add repository_id column to learning_milestones (if missing)
ALTER TABLE learning_milestones
  ADD COLUMN IF NOT EXISTS repository_id TEXT;

-- 3. Atomic row-locking function: claim a pending event in one transaction.
--    "FOR UPDATE SKIP LOCKED" guarantees only ONE worker instance ever claims
--    a given row, even if many workers poll at the exact same moment.
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
