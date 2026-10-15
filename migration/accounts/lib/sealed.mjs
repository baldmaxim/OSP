// Отпечатки паролей из Supabase по пути «Supabase → машина сборки → corp → база Яндекса» — только запечатанными.
//
// Запечатывание (seal.mjs, на машине сборки, прямо из потока psql — открытого текста на диске нет):
//   случайный ключ AES-256-GCM шифрует данные (gzip), сам ключ шифруется открытым ключом RSA-OAEP-256 corp.
//   Распечатать может только закрытый ключ переноса на corp (secrets/accounts-transfer.key).
// Данные — строки JSON (по одной на учётку): id, email, encrypted_password (только bcrypt), email_confirmed_at,
// banned_until, deleted_at.
//
// Отпечаток учёток — sha256 упорядоченных по id строк «id|почта (нижний регистр, без пробелов по краям)|sha256
// отпечатка пароля|подтверждение|блокировка|удаление». Меняется при смене пароля, почты или статуса; число входов
// на него не влияет. По нему перед переключением видно, что учётки не менялись после выгрузки.
import crypto from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export const SEALED_FORMAT = 'osp-sealed-credentials'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
// Отпечаток открытого ключа (PEM или KeyObject, открытого или закрытого) — им файл помечается при запечатывании.
export function keyFingerprint(key) {
  const pub = key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key)
  return sha256(pub.export({ type: 'spki', format: 'der' }))
}

// Строки JSON → проверенные записи (без лишних полей). Ошибка — без значений (там почты и отпечатки).
export function parseCredentialLines(text) {
  const out = []
  const seen = new Set()
  for (const [n, line] of String(text).split('\n').entries()) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { throw new Error(`строка ${n + 1}: не JSON`) }
    if (!UUID.test(String(r.id))) throw new Error(`строка ${n + 1}: нет идентификатора учётки`)
    if (seen.has(r.id)) throw new Error(`строка ${n + 1}: учётка повторяется`)
    seen.add(r.id)
    if (!BCRYPT.test(String(r.encrypted_password))) throw new Error(`строка ${n + 1}: отпечаток не bcrypt`)
    out.push({
      id: r.id.toLowerCase(), email: typeof r.email === 'string' ? r.email : null, hash: r.encrypted_password,
      email_confirmed_at: r.email_confirmed_at ?? null, banned_until: r.banned_until ?? null, deleted_at: r.deleted_at ?? null,
    })
  }
  return out
}

export function fingerprint(records) {
  const lines = records
    .map((r) => [r.id, String(r.email ?? '').trim().toLowerCase(), sha256(r.hash), r.email_confirmed_at ?? '', r.banned_until ?? '', r.deleted_at ?? ''].join('|'))
    .sort()
  return sha256(lines.join('\n'))
}

export function seal(plain, publicKeyPem) {
  const pub = crypto.createPublicKey(publicKeyPem)
  if (pub.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyDetails.modulusLength < 3072) {
    throw new Error('ключ переноса — RSA не короче 3072 бит')
  }
  const dataKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv)
  const data = Buffer.concat([cipher.update(gzipSync(Buffer.from(plain, 'utf8'))), cipher.final()])
  const wrapped = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey)
  return JSON.stringify({
    format: SEALED_FORMAT, version: 1, alg: 'RSA-OAEP-256+A256GCM', key: keyFingerprint(pub),
    wrappedKey: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  })
}

export function unseal(sealedText, privateKeyPem) {
  let s
  try { s = JSON.parse(sealedText) } catch { throw new Error('запечатанный файл — не JSON') }
  if (s?.format !== SEALED_FORMAT || s.version !== 1) throw new Error('запечатанный файл: неизвестный формат')
  const priv = crypto.createPrivateKey(privateKeyPem)
  if (keyFingerprint(priv) !== s.key) throw new Error('файл запечатан другим ключом переноса')
  const dataKey = crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(s.wrappedKey, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(s.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'))
  try {
    return gunzipSync(Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()])).toString('utf8')
  } catch {
    throw new Error('запечатанный файл повреждён')
  }
}

// OSP_AUTH_KEYS из файла окружения API — строкой, файл не исполняется (как lib/conn.sh читает target.env).
export function authKeysFromEnvFile(text) {
  for (const line of String(text).split('\n')) {
    const m = /^\s*OSP_AUTH_KEYS\s*=\s*(.*)$/.exec(line)
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return ''
}
