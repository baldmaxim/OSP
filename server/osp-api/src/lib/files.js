// Имена файлов для ключей S3 — как в Edge Function s3-presign (supabase/functions/s3-presign).
// Ключ должен быть ASCII: кириллица в presigned URL ломает подпись у части прокси.
// Исходное имя для показа хранится отдельно в s3_documents.file_name.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function transliterate(s) {
  let out = ''
  for (const ch of s) {
    const lower = ch.toLowerCase()
    const mapped = TRANSLIT[lower]
    if (mapped === undefined) { out += ch; continue }
    out += ch === lower ? mapped : (mapped ? mapped.charAt(0).toUpperCase() + mapped.slice(1) : '')
  }
  return out
}

// Только [a-zA-Z0-9._-], без ведущей точки и пустого имени, длина ≤ 200.
export function sanitizeFileName(name) {
  const cleaned = transliterate(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200)
  const noLeadingDot = cleaned.replace(/^\.+/, '')
  return noLeadingDot || 'file'
}
