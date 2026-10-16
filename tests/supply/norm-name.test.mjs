// Ключ наименования в базе (supply_norm_name, миграция 20261020) обязан совпадать с normName портала
// (src/utils/supplyRateHelpers.js): по нему страница расценки и прогресс «N из M» сопоставляют позиции ВОР
// с ценами, а карточка тендера — те же цены со строками своего ВОР. Сравнение на словаре трудных случаев
// (Ø и его двойники, запятая/точка, кириллица/латиница, неразрывные пробелы, разложенные буквы) и на
// случайных строках из тех же символов. Нужен PostgreSQL (локальный или Docker), иначе — пропуск.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TestDatabase, pgAvailable, ROOT } from '../psdc/lib/pg.mjs'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const MIGRATIONS = [
  path.join(ROOT, 'supabase', 'migrations', '20261020_supply_pricing.sql'),
  path.join(ROOT, 'migration', 'yandex', '20261020_supply_pricing.sql'),
]

// Текст функции supply_norm_name из файла миграции — ровно то, что ляжет в базу.
function normNameFunction(file) {
  const text = fs.readFileSync(file, 'utf8')
  const m = /CREATE OR REPLACE FUNCTION public\.supply_norm_name\(p_name text\)[\s\S]*?\n\$\$;/.exec(text)
  assert.ok(m, `в ${path.basename(file)} нет supply_norm_name`)
  return m[0]
}

const DICTIONARY = [
  'Труба МЕДНАЯ Ø12,7', 'труба медная ø12.7', 'Труба медная ∅12,7', 'Труба медная ⌀12,7', 'Труба медная Ө12,7',
  'Кран шаровой Ду15 (PN16)', 'КРАН ШАРОВОЙ ДУ15 PN16', 'Kpah шapoвoй Дy15', '1,2,3 мм', '0,5', '12.70', 'Ø1,27',
  'ЁЛКА 0.5x1,25', 'ёлка', 'ёлка', 'йод', 'Изоляция K‑Flex 13×15  мм', 'Кабель ВВГнг(А)-LS 3×2,5',
  'Лист оцинкованный  0,7 мм', '\tКраска\nэмаль ПФ-115', 'İstanbul', 'Straße ẞ', 'Kelvin K', 'ＡＢＣ полноширинные',
  'Ѐ ѐ Ѝ ѝ', 'Σίσυφος', '٣,٥ мм', '', '   ', '—', 'Хомут 1/2"', 'Отвод 90° Ду 50×3,5', 'Шуруп 4,2х19',
]

// Детерминированные случайные строки из «опасных» символов.
function fuzz(count) {
  const alphabet = [...'АаВвЕеЁёКкМмНнОоРрСсТтУуХхБбДдЙйЯяЮюЖжabcdefkmxyzABCKMXYZ0123456789.,;:-_/()×ØøΘθӨө∅⌀ΩİẞßЀ°"'
    , ' ', ' ', ' ', '\t', ' ', ' ', '̈', '̆', 'K', 'Ａ', '٣']
  let seed = 20261020
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  return Array.from({ length: count }, () => {
    const len = 1 + Math.floor(next() * 24)
    return Array.from({ length: len }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')
  })
}

describe('supply_norm_name в базе = normName в портале', { skip: pgAvailable() ? false : 'нет PostgreSQL (initdb/pg_ctl или Docker)', timeout: 300000 }, () => {
  let db
  before(() => {
    db = new TestDatabase()
    db.start()
  })
  after(() => db?.stop())

  for (const file of MIGRATIONS) {
    it(`${path.relative(ROOT, file)}: словарь и 3000 случайных строк`, () => {
      db.exec(normNameFunction(file))
      const input = [...DICTIONARY, ...fuzz(3000)]
      const text = JSON.stringify(input)
      let tag = 'n'
      while (text.includes(`$${tag}$`)) tag += 'n'
      const out = JSON.parse(db.exec(`select json_agg(public.supply_norm_name(x) order by i)
        from json_array_elements_text($${tag}$${text}$${tag}$::json) with ordinality as t(x, i);`).trim())
      const mismatches = input.map((s, i) => [s, normName(s), out[i]]).filter(([, js, pg]) => js !== pg)
      assert.deepEqual(mismatches.slice(0, 10), [], `расхождений: ${mismatches.length}`)
      assert.equal(out[0], 'tpyбameдhaя12.7')
    })
  }
})
