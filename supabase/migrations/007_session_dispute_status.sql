-- 007_session_dispute_status.sql
-- Expand the sessions.status check constraint to cover the MPP dispute and
-- on-chain refund lifecycle states supported by MppSessionClient.requestRefund.
--
-- Existing rows only ever hold 'open', 'closing' or 'closed', all of which are
-- a subset of the new value set, so the constraint can be swapped in place
-- without invalidating any data or requiring downtime.

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_status_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check
  CHECK (status IN (
    'open',
    'closing',
    'closed',
    'disputed',
    'in-refund-window',
    'refundable',
    'refunded'
  ));
