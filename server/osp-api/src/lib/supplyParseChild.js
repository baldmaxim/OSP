// Разбор одного файла ВОР в отдельном процессе (запускает src/lib/supplyImport.js — parseInChild).
//
// У службы потолок 384 МБ и 0,45 процессора (deploy/docker/compose.yml): большой Excel, разобранный в самом
// процессе API, мог бы уронить его по памяти и тормозить ответы сайту. Этот процесс живёт один файл: низкий
// приоритет, свой потолок памяти (--max-old-space-size от родителя), родитель снимает его по таймауту. Не
// хватило памяти — падает он, а не API. Библиотека Excel читает присланный людьми файл — сбой разбора тоже
// остаётся здесь. Разбор — тот же, что у страницы расценки (shared/vorMaterialsSheet.js — копия src/utils).
import os from 'node:os'
import { parseVorFileBytes } from '../shared/vorMaterialsSheet.js'

try { os.setPriority(19) } catch { /* без права менять приоритет — как есть */ }

process.once('message', (msg) => {
  let out
  try {
    out = parseVorFileBytes(msg?.bytes, msg?.saved || null)
  } catch (e) {
    out = { error: 'broken', message: String(e?.message || e) }
  }
  process.send(out, () => process.exit(0))
})
