-- Second stamp for the Sleep Score Review notifier. 9 Oct 2026.
--
-- WHY. A customer can submit their answers first and upload the tracker export
-- later through their return link. The first email to Rachel then says "No
-- export yet" and notified_at is stamped, so when uploaded_at is set later
-- nobody is told the file arrived. Rachel approved a second email for that
-- case (9 Oct 2026). scripts/sleep-form-notify.py in the hex workspace sends it
-- and needs its own durable dedupe, which is this column.
--
-- upload_notified_at means "Rachel has been told about this row's upload".
--   * stamped together with notified_at when the FIRST email already said
--     "Export uploaded" (submitted and uploaded before the first notify run)
--   * stamped on its own after the second email is accepted by Gmail
--   * null with uploaded_at set and notified_at set = a second email is owed
--
-- Additive and nullable. The Edge Function names its columns on every insert
-- and select, and the purge job selects a fixed list, so neither sees it.
-- Idempotent, safe to run twice.

alter table public.sleep_submissions
  add column if not exists upload_notified_at timestamptz;

-- ============================================================
-- Backfill, so the first run after this does not email old rows
-- ============================================================
-- 1. The first email already carried the upload. Nothing is owed.
--    (notified_at >= uploaded_at is the test. A file landing in the few seconds
--    between the notifier's read and its stamp would be misread as covered,
--    which is acceptable for a one-off backfill.)
update public.sleep_submissions
   set upload_notified_at = notified_at
 where upload_notified_at is null
   and uploaded_at is not null
   and notified_at is not null
   and notified_at >= uploaded_at;

-- 2. Uploaded after the first email, more than 7 days ago. Too old to be news,
--    so it is marked as told and no email goes out.
update public.sleep_submissions
   set upload_notified_at = now()
 where upload_notified_at is null
   and uploaded_at is not null
   and notified_at is not null
   and notified_at < uploaded_at
   and uploaded_at < now() - interval '7 days';

-- 3. Uploaded after the first email within the last 7 days: deliberately NOT
--    stamped here. Those are a human decision. When this was applied on
--    9 Oct 2026 the table held no rows at all, so all three sets were empty.

notify pgrst, 'reload schema';
