// Файлы в Supabase Storage. Сейчас там только обложки объектов (публичный бакет
// object-photos); документы лежат в cloud.ru и идут через services/s3.js. Обложки
// переезжают в cloud.ru отдельным релизом (Р5) — тогда меняется этот адаптер.
import { supabase } from './supabaseClient'

const OBJECT_PHOTOS = 'object-photos'

export const objectPhotos = {
  // Ответ { data, error }, как у storage.upload.
  upload: (path, file, options) => supabase.storage.from(OBJECT_PHOTOS).upload(path, file, options),
  // Публичный адрес файла (строка).
  publicUrl: (path) => supabase.storage.from(OBJECT_PHOTOS).getPublicUrl(path).data.publicUrl,
}
