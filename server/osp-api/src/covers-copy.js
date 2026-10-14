// Копирование обложек объектов из хранилища Supabase в cloud.ru (covers/<имя>) со сверкой каждого файла
// обратным скачиванием — src/lib/covers.js. На сервере портала запускает deploy/docker/deploy.sh:
//
//   bash /opt/portals/osp/deploy.sh covers-copy <копия>.covers.csv
//
// внутри — node src/covers-copy.js - в образе osp-api с настройками портала (SUPABASE_URL, S3_*); список
// приходит на стандартный ввод: файл копии на сервере закрыт (600), процессу контейнера его не прочитать.
// Список — из копии прода (migration/backup/backup.sh), журнал — для migration/target/load.sh --covers.
// В stdout — только журнал (JSON, без ключей), итог по-русски — в stderr.
// Выход: 0 — сверены все; 4 — есть несверенные (журнал всё равно выдан); 1 — ошибка запуска.
import fs from 'node:fs'
import { loadConfig } from './config.js'
import { defaultDeps } from './app.js'
import { copyCovers, sourceBaseOf } from './lib/covers.js'

async function main(argv) {
  const [listFile] = argv
  if (!listFile || argv.length !== 1) {
    console.error('Использование: node src/covers-copy.js <копия>.covers.csv | - > журнал.json')
    return 1
  }
  const config = loadConfig()
  const { s3 } = config
  if (!config.supabaseUrl) { console.error('FAIL не задан SUPABASE_URL — откуда копировать'); return 1 }
  if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
    console.error('FAIL не заданы ключи хранилища (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)')
    return 1
  }
  const journal = await copyCovers({
    listBytes: fs.readFileSync(listFile === '-' ? 0 : listFile),
    sourceBase: sourceBaseOf(config.supabaseUrl),
    s3: defaultDeps.createS3(s3),
    bucket: s3.bucket,
  })
  process.stdout.write(JSON.stringify(journal, null, 2) + '\n')
  const ok = journal.files.filter((f) => f.status === 'verified')
  const failed = journal.files.filter((f) => f.status !== 'verified')
  console.error(`Обложек в списке: ${journal.files.length}; сверено ${ok.length} (загружено ${ok.filter((f) => f.uploaded).length}, уже были ${ok.filter((f) => !f.uploaded).length}); не сверено ${failed.length}`)
  for (const f of failed) console.error(`FAIL ${f.name}: ${f.reason}`)
  return failed.length ? 4 : 0
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
  console.error(`FAIL ${err?.message || err}`)
  process.exitCode = 1
})
