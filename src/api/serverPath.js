// Куда идут серверные функции — файлы (s3-presign) и ИИ (ai-assist): свой API osp-api или Edge
// Functions Supabase. Модуль чистый (tests/osp-api/client.test.mjs).
//
// Данные в базе Яндекса (флаг ospDb) — файлы только через свой API, каким бы ни был их флаг: функция
// файлов Supabase работает с базой Supabase. Удаление документа через неё убрало бы из хранилища файл,
// на который ссылается другая база, а проверка прав шла бы по устаревшим строкам.
// ИИ к данным не привязан (функция проверяет только вход) — он идёт по своему флагу: если с сервера
// портала Anthropic недоступен, ИИ остаётся на функции Supabase и после переноса данных.

// ИИ — тот же запрос и ответ, что у функции. Файлы идут не через invokeFunction, а потоком с ключом
// операции (ospFiles.js, флаг OSP_FILES_FLAG).
export const OSP_API_FLAG = {
  'ai-assist': 'ospApiAi',
}

// Файлы через osp-api. Прежний флаг ospApiFiles (сборки до захода Б, без ключа операции) не включать:
// новый сервер прежний протокол загрузки не принимает.
export const OSP_FILES_FLAG = 'ospApiFilesV2'

// Функции Supabase, которые читают базу Supabase и меняют общее хранилище файлов. С данными в базе
// Яндекса их вызывать нельзя; у своего API для файлов другой протокол (ospFiles.js).
export const DATA_BOUND_FUNCTIONS = ['s3-presign']

// Вызов функции по имени: 'osp' — свой API, 'supabase' — функция Supabase, 'refuse' — не вызывать.
export function functionPath(name, { ownDb, enabled }) {
  if (ownDb && DATA_BOUND_FUNCTIONS.includes(name)) return 'refuse'
  const flag = Object.hasOwn(OSP_API_FLAG, name) ? OSP_API_FLAG[name] : null
  return flag && enabled(flag) ? 'osp' : 'supabase'
}

// Файлы документов. Без SubtleCrypto (не HTTPS) прежний путь остаётся только при данных в Supabase:
// свой API принимает файл и без отпечатка.
export function filesPath({ ownDb, enabled, hasDigest }) {
  if (ownDb) return 'osp'
  return enabled(OSP_FILES_FLAG) && hasDigest ? 'osp' : 'supabase'
}

// Обложки объектов. Данные в базе Яндекса — обложки в cloud.ru через свой API (адрес /api/covers/<имя>,
// server/osp-api/src/routes/covers.js): перенос данных переписывает адреса прежних обложек туда же
// (migration/target/sql/load-covers.sql). Данные в Supabase — прежний бакет object-photos.
export const COVER_URL_PREFIX = '/api/covers/'

export function coversPath({ ownDb }) {
  return ownDb ? 'osp' : 'supabase'
}

export const coverUrl = (name) => COVER_URL_PREFIX + encodeURIComponent(name)
