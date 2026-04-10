-- Добавление поля для обложки/фото объекта
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'objects' AND column_name = 'cover_image_url'
  ) THEN
    ALTER TABLE objects ADD COLUMN cover_image_url TEXT;
  END IF;
END $$;

-- Публичный bucket для фотографий объектов
INSERT INTO storage.buckets (id, name, public)
VALUES ('object-photos', 'object-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Политики доступа к bucket'у
DROP POLICY IF EXISTS "object_photos_public_read" ON storage.objects;
CREATE POLICY "object_photos_public_read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'object-photos');

DROP POLICY IF EXISTS "object_photos_authenticated_insert" ON storage.objects;
CREATE POLICY "object_photos_authenticated_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'object-photos');

DROP POLICY IF EXISTS "object_photos_authenticated_update" ON storage.objects;
CREATE POLICY "object_photos_authenticated_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'object-photos')
  WITH CHECK (bucket_id = 'object-photos');

DROP POLICY IF EXISTS "object_photos_authenticated_delete" ON storage.objects;
CREATE POLICY "object_photos_authenticated_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'object-photos');
