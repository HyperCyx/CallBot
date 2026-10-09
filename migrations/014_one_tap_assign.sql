-- 014: the service tap itself is the "Assign number" action.
-- `numbers.require_confirmation = 1` brings the intermediate confirmation
-- screen back; cleared/absent = country -> service -> number assigned.
-- Written inline-idempotent so a fresh install (settings table created in 010)
-- and an existing one run it equally well.

-- On a fresh install arriving at 010's INSERT the default below already
-- applies; this only matters for databases that existed before 014.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'admin_settings') THEN
    DELETE FROM admin_settings WHERE key = 'numbers.require_confirmation';
  END IF;
END $$;
