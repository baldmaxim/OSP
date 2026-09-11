// Замер времени функций ПСДЦ на больших ведомостях (не входит в обычный прогон):
//   node tests/psdc/perf.bench.mjs 6000 20000
// Важно для Supabase: у роли authenticated по умолчанию statement_timeout = 8 с.
import { setupDatabase, sqlJson } from './lib/pg.mjs'
import { createUser, createDocument, section, process as processRow, HEADER } from './lib/fixtures.mjs'

const sizes = process.argv.slice(2).map(Number).filter(Boolean)
const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
const db = setupDatabase()
try {
  const lawyer = createUser(db, { role: 'lawyer', canEdit: true })
  const measure = (size, label, sql) => {
    const out = db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${lawyer}', false) \\g ${devNull}\n\\timing on\n${sql}`)
    console.log(`${size} строк — ${label}: ${(/Time: ([\d.,]+) ms/.exec(out) || [])[1]} мс`)
  }
  for (const size of sizes.length ? sizes : [6000, 20000]) {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work', vat_rate: 22 })
    const rows = []
    let r = 2
    for (let s = 1; rows.length < size; s++) {
      rows.push(section(r++, String(s), `Секция ${s}`))
      for (let k = 1; k < 100 && rows.length < size; k++) {
        rows.push(processRow(r++, `${s}.${k}`, `Работа ${s}.${k}`, { volume: k + 0.12345, materialPrice: '1 234,56', workPrice: 12.34, dm: k % 10 === 0 }))
      }
    }
    const meta = { source_filename: 'big.xlsx', header: HEADER, totals: {}, fatal: [] }
    const id = db.asUser(lawyer, `SELECT psdc_create('${doc.id}', NULL, ${sqlJson(meta)});`)
    for (let i = 0; i < rows.length; i += 1000) {
      db.asUser(lawyer, `SELECT psdc_add_rows('${id}', ${sqlJson(rows.slice(i, i + 1000))});`)
    }
    measure(size, 'проверка', `SELECT psdc_validate('${id}') IS NOT NULL;`)
    measure(size, 'применение', `SELECT psdc_apply('${id}') IS NOT NULL;`)
    measure(size, 'чтение строк', `SELECT length(psdc_get_rows('${id}')::text);`)
  }
} finally {
  db.stop()
}
