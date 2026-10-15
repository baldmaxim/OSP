// Учётные записи и обложки при загрузке в базу Яндекса (load.sh --auth / --covers) и при сверке
// (verify.sh): из выгрузок копии и журнала копирования обложек — SQL с проверенными значениями.
//
//   node extras.mjs auth-copy  <копия>.auth-users.csv <копия>.auth-identities.csv   → \copy в osp_vault
//   node extras.mjs covers-sql <журнал.json> <копия>.covers.csv <итог.json>         → osp_meta.cover_moves
//
// Колонки учёток — только из закрытого списка (тот же, что в migration/backup/extras.sql; совпадение
// проверяет тест): незнакомая колонка в заголовке выгрузки — отказ, а не «загрузим как есть». Паролей в
// списке нет: для своего входа нового портала они переносятся отдельно, запечатанными (migration/accounts).
// Журнал обложек принимается, только если снят по списку обложек этой же копии (SHA-256 списка).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const USER_COLUMNS = [
  'id', 'aud', 'role', 'email', 'email_confirmed_at', 'invited_at',
  'confirmation_sent_at', 'recovery_sent_at', 'email_change', 'email_change_sent_at', 'last_sign_in_at',
  'raw_app_meta_data', 'raw_user_meta_data', 'is_super_admin', 'created_at', 'updated_at', 'phone',
  'phone_confirmed_at', 'phone_change', 'phone_change_sent_at', 'email_change_confirm_status',
  'banned_until', 'reauthentication_sent_at', 'is_sso_user', 'deleted_at', 'is_anonymous',
]
export const USER_REQUIRED = ['id', 'email', 'created_at', 'updated_at']
export const IDENTITY_COLUMNS = ['id', 'user_id', 'provider', 'provider_id', 'identity_data', 'last_sign_in_at', 'created_at', 'updated_at']
export const IDENTITY_REQUIRED = ['id', 'user_id', 'provider', 'identity_data']
// Порядок строк выгрузки (extras.sql) — им же выгружает сверка, чтобы сравнить файлы побайтно.
export const USER_ORDER = 'id'
export const IDENTITY_ORDER = 'user_id, provider, id'

// Имя обложки — как его даёт страница объектов: UUID и расширение исходного файла. Тот же шаблон — у
// маршрута /api/covers в osp-api (совпадение проверяет тест).
export const COVER_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{1,10}$/
export const COVER_SOURCE_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/storage\/v1\/object\/public\/object-photos\/$/
export const COVER_URL_PREFIX = '/api/covers/'

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const literal = (s) => `'${String(s).replaceAll("'", "''")}'`

export function csvHeader(text) {
  const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  return first.split(',').map((c) => c.replace(/^"|"$/g, ''))
}

export function checkColumns(header, allowed, required, title) {
  const unknown = header.filter((c) => !allowed.includes(c))
  if (unknown.length) throw new Error(`${title}: незнакомые колонки в выгрузке — ${unknown.join(', ')}`)
  const missing = required.filter((c) => !header.includes(c))
  if (missing.length) throw new Error(`${title}: нет обязательных колонок — ${missing.join(', ')}`)
  if (new Set(header).size !== header.length) throw new Error(`${title}: колонка повторяется`)
  return header
}

function safePath(file) {
  const abs = path.resolve(file)
  if (/['\s\\]/.test(abs)) throw new Error(`путь выгрузки не должен содержать кавычек, пробелов и обратной косой черты: ${abs}`)
  return abs
}

// \copy каждой выгрузки в свою таблицу osp_vault — с колонками из её заголовка.
export function authCopySql(usersFile, identitiesFile) {
  const users = checkColumns(csvHeader(fs.readFileSync(usersFile, 'utf8')), USER_COLUMNS, USER_REQUIRED, 'учётные записи')
  const identities = checkColumns(csvHeader(fs.readFileSync(identitiesFile, 'utf8')), IDENTITY_COLUMNS, IDENTITY_REQUIRED, 'способы входа')
  return [
    `\\copy osp_vault.users (${users.join(', ')}) FROM '${safePath(usersFile)}' WITH (FORMAT csv, HEADER true)`,
    `\\copy osp_vault.identities (${identities.join(', ')}) FROM '${safePath(identitiesFile)}' WITH (FORMAT csv, HEADER true)`,
    '',
  ].join('\n')
}

export function parseJournal(text) {
  let j
  try { j = JSON.parse(text) } catch { throw new Error('журнал обложек — не JSON') }
  if (j?.tool !== 'covers-copy' || j.version !== 1) throw new Error('журнал обложек: не от covers-copy (tool/version)')
  if (!/^[0-9a-f]{64}$/.test(j.list_sha256 || '')) throw new Error('журнал обложек: нет SHA-256 списка')
  if (!COVER_SOURCE_RE.test(j.source_base || '')) throw new Error('журнал обложек: адрес хранилища Supabase не похож на …/storage/v1/object/public/object-photos/')
  if (!Array.isArray(j.files)) throw new Error('журнал обложек: нет списка файлов')
  const seen = new Set()
  for (const f of j.files) {
    if (typeof f?.name !== 'string' || !f.name) throw new Error('журнал обложек: файл без имени')
    if (seen.has(f.name)) throw new Error('журнал обложек: файл указан дважды')
    seen.add(f.name)
    if (!['verified', 'failed'].includes(f.status)) throw new Error('журнал обложек: неизвестный итог файла')
    if (f.status !== 'verified') continue
    // Сверенный файл попадает в SQL и в адрес: только имя по шаблону.
    if (!COVER_NAME_RE.test(f.name)) throw new Error('журнал обложек: сверенный файл с именем не по шаблону')
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || '') || !Number.isSafeInteger(f.size) || f.size < 0) {
      throw new Error(`журнал обложек: ${f.name} сверен, но нет SHA-256 или размера`)
    }
  }
  return j
}

// Имена файлов списка обложек копии (первая колонка .covers.csv).
export function coverNames(csvText) {
  const lines = csvText.split('\n').filter(Boolean)
  if (lines[0] !== 'name,size,mimetype,created_at,updated_at') throw new Error('список обложек: заголовок не тот')
  return lines.slice(1).map((l) => l.split(',')[0])
}

export function coverMovesSql(journalText, coversCsvText) {
  const j = parseJournal(journalText)
  if (j.list_sha256 !== sha256(coversCsvText)) {
    throw new Error('журнал обложек снят по другому списку: сначала covers-copy со списком этой копии')
  }
  const listed = coverNames(coversCsvText)
  const inJournal = new Set(j.files.map((f) => f.name))
  const absent = listed.filter((n) => !inJournal.has(n))
  if (absent.length) throw new Error(`журнал обложек неполный: нет ${absent.length} файлов списка`)
  const verified = j.files.filter((f) => f.status === 'verified')
  const rows = verified.map((f) => `(${literal(f.name)}, ${f.size}, ${literal(f.sha256)}, ${literal(j.source_base + f.name)}, ${literal(COVER_URL_PREFIX + f.name)})`)
  const sql = [
    '-- Обложки, скопированные в cloud.ru и сверенные (журнал covers-copy). Создаёт load.sh / verify.sh.',
    'CREATE TABLE osp_meta.cover_moves (',
    '  name text PRIMARY KEY, size bigint NOT NULL, sha256 text NOT NULL,',
    '  old_url text NOT NULL UNIQUE, new_url text NOT NULL UNIQUE, objects_updated integer NOT NULL DEFAULT 0',
    ');',
    rows.length ? `INSERT INTO osp_meta.cover_moves (name, size, sha256, old_url, new_url) VALUES\n  ${rows.join(',\n  ')};` : '',
    '',
  ].join('\n')
  return { sql, summary: { listed: listed.length, verified: verified.length, failed: j.files.length - verified.length } }
}

function main(argv) {
  const [cmd, ...args] = argv
  try {
    if (cmd === 'auth-copy' && args.length === 2) {
      process.stdout.write(authCopySql(args[0], args[1]))
      return 0
    }
    if (cmd === 'covers-sql' && args.length === 3) {
      const { sql, summary } = coverMovesSql(fs.readFileSync(args[0], 'utf8'), fs.readFileSync(args[1], 'utf8'))
      fs.writeFileSync(args[2], JSON.stringify(summary))
      process.stdout.write(sql)
      return 0
    }
  } catch (err) {
    console.error(`error: ${err.message}`)
    return 4
  }
  console.error('Использование: node extras.mjs auth-copy <users.csv> <identities.csv> | covers-sql <журнал.json> <covers.csv> <итог.json>')
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
