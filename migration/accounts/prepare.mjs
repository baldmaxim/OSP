// Подготовка паролей к записи в базу (accounts-sync.sh, на corp в контейнере инструментов):
//
//   node migration/accounts/prepare.mjs --credentials <файл.sealed> --transfer-key <закрытый ключ переноса.pem>
//        --auth-keys-file <secrets/osp-api.env> --out <пароли.csv> --canary-out <канарейка.txt> [--manifest <опись.json>]
//
// Распечатывает выгрузку и шифрует каждый отпечаток ключом сервера (OSP_AUTH_KEYS, текущий ключ) с привязкой к
// учётке — тем же кодом, что сервер (server/osp-api/src/lib/auth/secretBox.js). На выходе CSV «user_id,secret,
// supabase_sha256» (без почт и без открытых отпечатков) и канарейка ключа. Опись, если дана, сверяется.
// В вывод — только счётчики и отпечаток учёток.
import fs from 'node:fs'
import { createSecretBox, CANARY_AAD, CANARY_TEXT } from '../../server/osp-api/src/lib/auth/secretBox.js'
import { authKeysFromEnvFile, fingerprint, parseCredentialLines, sha256, unseal } from './lib/sealed.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : ''
}

function main() {
  const [sealedFile, keyFile, envFile, out, canaryOut, manifestFile] =
    ['--credentials', '--transfer-key', '--auth-keys-file', '--out', '--canary-out', '--manifest'].map(arg)
  if (!sealedFile || !keyFile || !envFile || !out || !canaryOut) {
    console.error('Использование: node prepare.mjs --credentials <.sealed> --transfer-key <.pem> --auth-keys-file <osp-api.env> --out <.csv> --canary-out <.txt> [--manifest <.json>]')
    return 1
  }
  const keys = authKeysFromEnvFile(fs.readFileSync(envFile, 'utf8'))
  if (!keys) throw new Error('в файле окружения API нет OSP_AUTH_KEYS — сначала deploy-server.sh auth-key-init')
  const box = createSecretBox(keys)
  const plain = unseal(fs.readFileSync(sealedFile, 'utf8'), fs.readFileSync(keyFile, 'utf8'))
  const records = parseCredentialLines(plain)
  if (manifestFile) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (m.sha256 !== sha256(plain) || m.rows !== records.length) throw new Error('опись не совпала с запечатанным файлом')
  }
  const rows = records.map((r) => `${r.id},${box.encrypt(r.hash, r.id)},${sha256(r.hash)}`)
  fs.writeFileSync(out, ['user_id,secret,supabase_sha256', ...rows].join('\n') + '\n', { mode: 0o600 })
  fs.writeFileSync(canaryOut, box.encrypt(CANARY_TEXT, CANARY_AAD), { mode: 0o600 })
  console.log(`OK паролей подготовлено: ${records.length}; ключ сервера ${box.currentKeyId}; отпечаток учёток ${fingerprint(records)}`)
  return 0
}

try {
  process.exit(main())
} catch (err) {
  console.error(`FAIL ${err.message}`)
  process.exit(4)
}
