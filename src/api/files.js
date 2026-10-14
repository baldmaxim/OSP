// Обложки объектов. Данные в Supabase — общедоступный бакет object-photos хранилища Supabase; данные в
// базе Яндекса (флаг ospDb) — cloud.ru через свой API, адрес /api/covers/<имя> (src/api/serverPath.js).
// Документы лежат в cloud.ru и идут через services/s3.js.
import { supabase } from './supabaseClient'
import { callOspFunction } from './ospApi'
import { createOspCovers } from './ospCovers'
import { observingFetch } from './clientErrors'
import { ownDbEnabled } from './db'
import { coversPath, coverUrl } from './serverPath'

const OBJECT_PHOTOS = 'object-photos'

const ospToken = async () => (await supabase.auth.getSession()).data?.session?.access_token ?? null
const ospCovers = createOspCovers({
  call: (body) => callOspFunction('cover-upload', { body }, { getToken: ospToken, fetchImpl: observingFetch }),
  fetchImpl: (url, init) => fetch(url, init),
})

// Куда ушла загрузка: адрес обложки — того же хранилища, даже если флаг сменился между загрузкой и
// сохранением формы.
const uploadedTo = new Map()

export const objectPhotos = {
  // Ответ { data, error }, как у storage.upload.
  upload: (path, file, options) => {
    const where = coversPath({ ownDb: ownDbEnabled() })
    uploadedTo.set(path, where)
    return where === 'osp' ? ospCovers.upload(path, file) : supabase.storage.from(OBJECT_PHOTOS).upload(path, file, options)
  },
  // Адрес файла (строка).
  publicUrl: (path) => {
    const where = uploadedTo.get(path) || coversPath({ ownDb: ownDbEnabled() })
    return where === 'osp' ? coverUrl(path) : supabase.storage.from(OBJECT_PHOTOS).getPublicUrl(path).data.publicUrl
  },
}
