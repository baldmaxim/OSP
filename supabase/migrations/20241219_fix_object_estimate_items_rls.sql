-- Allow anon access (app uses anon key without Supabase Auth)
DROP POLICY IF EXISTS "Allow all for authenticated users on object_estimate_items" ON object_estimate_items;
CREATE POLICY "Allow all access on object_estimate_items" ON object_estimate_items
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
