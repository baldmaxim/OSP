// Разбор одного файла ВОР для кабинета подрядчика в отдельном процессе (запускает src/lib/bidPositions.js): свой потолок
// памяти, низкий приоритет, родитель снимает по таймауту. Библиотека Excel читает присланный людьми файл — сбой остаётся
// здесь, а не в API. Разбор — тот же, что был у страницы кабинета (shared/bidVor.js — копия src/utils).
import os from 'node:os'
import { readBidFileBytes } from '../shared/bidVor.js'

try { os.setPriority(19) } catch { /* без права менять приоритет — как есть */ }

process.once('message', (msg) => {
  let out
  try {
    out = readBidFileBytes(msg?.bytes)
  } catch (e) {
    out = { error: 'broken', message: String(e?.message || e) }
  }
  process.send(out, () => process.exit(0))
})
