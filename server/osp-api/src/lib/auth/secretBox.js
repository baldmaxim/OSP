// Шифрование отпечатков паролей ключом сервера (OSP_AUTH_KEYS). Копия базы, её выгрузка и другие учётки
// кластера отпечатка для перебора не дают: без ключа строка osp_auth.credentials — шум.
//
//   OSP_AUTH_KEYS="k2:<base64 32 байта>,k1:<base64 32 байта>" — первый ключ текущий: им шифруется новое;
//   остальные — только для расшифровки строк, ещё не перешифрованных (auth-key-rotate).
//
// Формат строки: «v1:<id ключа>:<base64(iv 12 байт | шифр | тег 16 байт)>», AES-256-GCM. AAD — к чему строка
// относится (идентификатор пользователя): строку одного пользователя нельзя переставить другому.
// Ни ключи, ни открытый текст не попадают в тексты ошибок.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_ID = /^[a-z0-9]{1,16}$/
const BLOB = /^v1:([a-z0-9]{1,16}):([A-Za-z0-9+/]+={0,2})$/
const IV_BYTES = 12
const TAG_BYTES = 16

// Канарейка: osp_auth.meta('canary') — эта строка, зашифрованная текущим ключом на момент переноса учёток.
// /api/ready её расшифровывает: неверный ключ не выкладывается (иначе не вошёл бы никто).
export const CANARY_TEXT = 'osp-auth-canary'
export const CANARY_AAD = 'osp-auth-canary'

export function parseKeyRing(spec) {
  const keys = new Map()
  let current = null
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf(':')
    const id = at > 0 ? part.slice(0, at) : ''
    if (!KEY_ID.test(id)) throw new Error('OSP_AUTH_KEYS: имя ключа — латиница и цифры, до 16 знаков, затем двоеточие')
    if (keys.has(id)) throw new Error(`OSP_AUTH_KEYS: ключ ${id} указан дважды`)
    const raw = part.slice(at + 1)
    const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, 'base64') : Buffer.alloc(0)
    if (key.length !== 32) throw new Error(`OSP_AUTH_KEYS: ключ ${id} — не 32 байта в base64`)
    keys.set(id, key)
    current ??= id
  }
  if (!current) throw new Error('OSP_AUTH_KEYS: не задан ни один ключ')
  return { current, keys }
}

export function keyIdOf(blob) {
  const m = BLOB.exec(String(blob))
  return m ? m[1] : null
}

export function createSecretBox(spec) {
  const { current, keys } = parseKeyRing(spec)

  function encrypt(plain, aad) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', keys.get(current), iv)
    cipher.setAAD(Buffer.from(String(aad), 'utf8'))
    const data = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()])
    return `v1:${current}:${Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64')}`
  }

  function decrypt(blob, aad) {
    const m = BLOB.exec(String(blob))
    if (!m) throw new Error('secret: неизвестный формат строки')
    const key = keys.get(m[1])
    if (!key) throw Object.assign(new Error(`secret: ключа ${m[1]} нет в OSP_AUTH_KEYS`), { code: 'OSP_AUTH_KEY_UNKNOWN' })
    const raw = Buffer.from(m[2], 'base64')
    if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new Error('secret: строка короче допустимой')
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(String(aad), 'utf8'))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    try {
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch {
      throw Object.assign(new Error('secret: строка не расшифровывается этим ключом'), { code: 'OSP_AUTH_KEY_MISMATCH' })
    }
  }

  return {
    encrypt,
    decrypt,
    currentKeyId: current,
    hasKey: (id) => keys.has(id),
    keyIds: () => [...keys.keys()],
  }
}
