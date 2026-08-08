-- TS-294 — reviewer-required grant flow: decider's free-text note.
--
-- Expand-only: one nullable column on `role_assignment_approvals`.
-- `decision_note` records the second admin's optional note on approve
-- OR reject (the requester's own justification already lives in
-- `reason`); preserved for the audit trail alongside
-- `approved_by_user_id` / `decided_at`. Existing rows read as
-- note-less, which is accurate.
--
-- Reversal plan:
--   ALTER TABLE "identity"."role_assignment_approvals" DROP COLUMN "decision_note";
-- Safe in isolation — nullable, no index, no FK.

ALTER TABLE "identity"."role_assignment_approvals"
    ADD COLUMN "decision_note" TEXT;
