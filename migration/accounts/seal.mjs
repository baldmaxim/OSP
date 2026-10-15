// Запечатать отпечатки паролей прямо из потока psql (migration/backup/backup.sh --credentials):
//
//   psql … | node migration/accounts/seal.mjs --pub <открытый ключ переноса.pem> --out <файл.sealed> --manifest <опись.json>
//
// Открытого текста на диске нет. Опись (права 600) — число строк, sha256 открытого текста и отпечаток учёток;
// почт и отпечатков в ней нет. В вывод — только счётчики.
import fs from 'node:fs'
import { fingerprint, keyFingerprint, parseCredentialLines, seal, sha256 } from './lib/sealed.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : ''
}

async function main() {
  const [pub, out, manifest] = [arg('--pub'), arg('--out'), arg('--manifest')]
  if (!pub || !out || !manifest) {
    console.error('Использование: … | node seal.mjs --pub <ключ.pem> --out <файл.sealed> --manifest <опись.json>')
    return 1
  }
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const plain = Buffer.concat(chunks).toString('utf8')
  const records = parseCredentialLines(plain)
  const publicKey = fs.readFileSync(pub, 'utf8')
  fs.writeFileSync(out, seal(plain, publicKey), { mode: 0o600 })
  const m = { rows: records.length, sha256: sha256(plain), fingerprint: fingerprint(records), key: keyFingerprint(publicKey) }
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
  console.log(`OK отпечатков паролей запечатано: ${m.rows}; отпечаток учёток ${m.fingerprint.slice(0, 16)}…`)
  return 0
}

main().then((code) => process.exit(code), (err) => { console.error(`FAIL ${err.message}`); process.exit(4) })
