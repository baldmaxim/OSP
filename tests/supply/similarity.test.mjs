// Похожесть наименований (миграция 20261025): расчёт портала (src/utils/supplySimilarity.js) — сопоставление строк
// счёта / КП поставщика с позициями ВОР — и расчёт базы (supply_name_stems / supply_name_nums, supply_name_score,
// supply_name_word_share) — «похожие цены» других тендеров — обязаны совпадать: иначе меню похожих и окно
// распознавания называли бы похожим разное. Сравнение — на словаре трудных случаев и на случайных строках, для
// обеих миграций (Supabase и база Яндекса). Плюс сами правила похожести — без базы.
// Нужен PostgreSQL для сравнения (локальный или Docker) — иначе только правила.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TestDatabase, pgAvailable, ROOT } from '../psdc/lib/pg.mjs'
import {
  isSimilar, nameParts, nameScore, normUnit, scoreParts, SIMILAR_MIN, stemWord, STOP_WORDS, unitsCompatible,
} from '../../src/utils/supplySimilarity.js'

const MIGRATIONS = [
  path.join(ROOT, 'supabase', 'migrations', '20261025_supply_docs_similarity.sql'),
  path.join(ROOT, 'migration', 'yandex', '20261025_supply_docs_similarity.sql'),
]
const FUNCTIONS = ['supply_name_prepare', 'supply_name_pieces', 'supply_stem_word', 'supply_name_stems', 'supply_norm_number',
  'supply_name_nums', 'supply_name_heads', 'supply_name_word_share', 'supply_name_score']

// Тексты функций похожести из файла миграции — ровно то, что ляжет в базу.
function similarityFunctions(file) {
  const text = fs.readFileSync(file, 'utf8')
  return FUNCTIONS.map((name) => {
    const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(text)
    assert.ok(m, `в ${path.basename(file)} нет ${name}`)
    return m[0]
  }).join('\n')
}

// Наименования как в ВОР и в счетах поставщиков (копия прода 15.10: клапаны, вентиляторы, радиаторы, трубы, кабели).
const DICTIONARY = [
  'Клапан Сигмавент-90-НО-400x300-SVF(220)-к', 'Сигмавент-90-НО-300 х 400 SVF 220 к', 'Клапан Сигмавент-90-НО-450x350-SVF(220)-к',
  'Клапан противопожарный Сигмавент-120-НЗ(КЛ)-550x550-СН-SVE(220)-к, нормально закрытый',
  'Труба стальная электросварная Ø57х3,5 ГОСТ 10704-91', 'Труба стальная 57*3.5', 'Трубы стальные 57х3,5 мм',
  'Трубопровод из стальных водогазопроводных оцинкованных труб Ø20x2.8', 'Трубопровод из стальных ВГП оц. труб Ø20x2,8',
  'Кабель ВВГнг(А)-LS 3х2,5 мм2', 'Кабель силовой ВВГнг(А)-LS 3x2.5 ок(N)-0,66', 'Кабель ВВГнг-LS 3х1,5',
  'Радиатор стальной панельный EVRA 22C-500-800', 'Радиатор стальной панельный EVRA 22CV-500-800', 'Радиатор стальной панельный 22CV-500-1600',
  'Конвектор внутрипольный Aquilo FMK 42 150 11', 'Конвектор внутрипольный Aquilo FMK 42 250 11',
  'Вентилятор подпора осевой VOC VOC 63-7,5x30 (ND26-013432/1)', 'Осевой вентилятор подпора VOC 63-7,5х30 (ND26-013352/1)',
  'Приточная установка L=795 м3/ч, P=210 Па, Ny= 0,3кВт KVR 315/1', 'Косой сетчатый фильтр 1/2” 74AY103', 'Косой сетчатый фильтр 2 1/2" 74AY009',
  'Кран шаровой Ду15 (PN16)', 'КРАН ШАРОВОЙ ДУ 15 PN16', 'Кран шаровой полнопроходной латунный муфтовый Ду15 PN40',
  'Изоляция K-Flex 13×15', 'Изоляция K‑Flex 13x15', 'Трубка K-FLEX 06x022 ST', 'Трубка K-FLEX 6x22 ST',
  'Цементно-песчаная стяжка армированная М150 – 50 мм', 'Стяжка из цементно-песчаного раствора М150 - 50 мм',
  'Грунтовка глубокого проникновения', 'Грунтовка ГФ-021 20кг', 'Щит ЩР-КНД (шт)', 'Щит ЩР-В (шт)', 'ЁЛКА 0.5x1,25',
  'Огнезащитное покрытие ВЗТМ EI60 толщиной 5мм', 'Лист оцинкованный 0,7 мм ГОСТ Р 52246-2016', '\tКраска\nэмаль ПФ-115',
  'Кабель 1000.28.20 (НФ)', '0,50', '020,0', '1//2', '—', '', '   ', 'İstanbul', 'Straße ẞ', 'Kelvin K', 'ＡＢＣ полноширинные',
  'Σίσυφος', '٣,٥ мм', 'х×*x', 'м2 м3 мм2', 'ГОСТ 10704-91', 'для или при без', 'Ду20х2,8', '4х76х700', 'Регистр 4х76х700',
]

// Детерминированные случайные строки из «опасных» символов: буквы-двойники, размеры, дроби, ГОСТ, единицы.
function fuzz(count) {
  const pieces = ['Труба', 'стальная', 'Ду', 'DN', 'Ø', '57', '3,5', 'х', 'x', '*', '×', ' ', ' ', '-', '/', '.', ',', 'ГОСТ', 'ТУ',
    '10704-91', 'мм2', 'м3/ч', 'НО', 'НЗ', 'SVF', 'к', 'оцинк.', 'оцинкованная', 'трубы', '0', '00', '1/2', '"', '(', ')', 'Ё',
    'ё', '̈', 'İ', 'K', 'Ａ', '٣', 'для', 'шт', 'Клапан', 'Сигмавент', '220', '400', '300', 'а', 'я', 'ый', 'ая', ' ']
  let seed = 20261025
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  return Array.from({ length: count }, () => {
    const len = 1 + Math.floor(next() * 12)
    return Array.from({ length: len }, () => pieces[Math.floor(next() * pieces.length)]).join(next() < 0.5 ? '' : ' ')
  })
}

describe('похожесть: правила', () => {
  it('тот же материал в другой записи — похож; другой размер или длина — нет', () => {
    assert.ok(isSimilar('Клапан Сигмавент-90-НО-400x300-SVF(220)-к', 'Сигмавент-90-НО-300 х 400 SVF 220 к'), 'размер повёрнут, «клапан» не написан')
    assert.ok(!isSimilar('Клапан Сигмавент-90-НО-400x300-SVF(220)-к', 'Клапан Сигмавент-90-НО-450x350-SVF(220)-к'), 'другой размер')
    assert.ok(!isSimilar('Конвектор внутрипольный Aquilo FMK 42 150 11', 'Конвектор внутрипольный Aquilo FMK 42 250 11'), 'другая длина')
    assert.ok(!isSimilar('Кабель ВВГнг(А)-LS 3х2,5 мм2', 'Кабель ВВГнг-LS 3х1,5'), 'другое сечение')
    assert.ok(isSimilar('Кабель ВВГнг(А)-LS 3х2,5 мм2', 'Кабель силовой ВВГнг(А)-LS 3x2.5'), '«силовой» дописан')
    assert.ok(isSimilar('Труба стальная электросварная Ø57х3,5 ГОСТ 10704-91', 'Трубы стальные 57*3.5'), 'ГОСТ не в счёт, окончания — по основе')
    assert.ok(isSimilar('Радиатор стальной панельный EVRA 22C-500-800', 'Радиатор стальной панельный EVRA 22CV-500-800'))
    assert.ok(!isSimilar('Радиатор стальной панельный 22CV-500-1600', 'Радиатор стальной панельный 22CV-500-800'))
    assert.ok(isSimilar('Вентилятор подпора осевой VOC VOC 63-7,5x30 (ND26-013432/1)', 'Осевой вентилятор подпора VOC 63-7,5х30 (ND26-013352/1)'), 'номер заказа в скобках — свой у каждого')
    assert.ok(!isSimilar('Метка адресная АМ-4-RЗ (шт)', 'Метка адресная АМП-4 (шт)'), 'общие слова — меньше 0,6')
    assert.ok(!isSimilar('Краска для бетона', 'Бетон В25'))
  })

  it('слова: основа, сокращение по началу, двухбуквенные обозначения; служебные слова и ГОСТ не в счёт', () => {
    assert.equal(stemWord('трубы'), stemWord('труба'))
    assert.equal(stemWord('стальная'), stemWord('стальной'))
    assert.equal(stemWord('кран'), 'кран')
    assert.deepEqual(nameParts('Трубопровод из стальных ВГП оц. труб').words.includes('oц'), true, 'двухбуквенное — слово')
    assert.ok(nameScore('лист оцинк.', 'Лист оцинкованный') >= SIMILAR_MIN, 'сокращение')
    assert.deepEqual(nameParts('для или при без шт мм').words, [])
    assert.deepEqual(nameParts('Лист 0,7 ГОСТ Р 52246-2016').nums, ['0.7'])
    assert.ok(STOP_WORDS.includes('гост'))
  })

  it('числа: запятая = точка, ведущие и хвостовые нули, размер — одно число по возрастанию, дробь — целиком', () => {
    assert.deepEqual(nameParts('Ду20х2,8').nums, ['2.8×20'])
    assert.deepEqual(nameParts('700 х 700').nums, nameParts('700*700').nums)
    assert.deepEqual(nameParts('400x300').nums, nameParts('300 X 400').nums)
    assert.deepEqual(nameParts('Трубка K-FLEX 06x022').nums, nameParts('Трубка K-FLEX 6x22').nums)
    assert.deepEqual(nameParts('020,0 и 0,50').nums, ['0.5', '20'])
    assert.deepEqual(nameParts('фильтр 2 1/2"').nums, ['1/2', '2'])
    assert.deepEqual(nameParts('Регистр 4х76х700').nums, ['4×76×700'])
    assert.deepEqual(nameParts('L=795 м3/ч, 2,5 мм2').nums, ['2.5', '795'], 'единицы со степенью — не числа')
  })

  it('итог: дробь целых чисел, три знака; у одного нет чисел — слова × 0,8', () => {
    const r = scoreParts('Грунтовка глубокого проникновения', 'Грунтовка глубокого проникновения 10л')
    assert.equal(r.score, 0.8)
    assert.equal(r.words, 1)
    assert.equal(nameScore('', ''), 0)
    assert.equal(scoreParts('Клапан Сигмавент-90-НО-400x300-SVF(220)-к', 'Сигмавент-90-НО-300 х 400 SVF 220 к').sameNums, true)
  })

  it('ед. изм.: как kp_norm_unit; метр = погонный метр; пустая — подходит', () => {
    assert.equal(normUnit('шт.'), 'шт')
    assert.equal(normUnit('Штук'), 'шт')
    assert.equal(normUnit('м.пог.'), 'мп')
    assert.equal(normUnit('кв.м'), 'м2')
    assert.ok(unitsCompatible('м', 'м.п.'))
    assert.ok(unitsCompatible('', 'шт'))
    assert.ok(!unitsCompatible('шт', 'компл'))
  })
})

describe('похожесть в базе = похожесть в портале', { skip: pgAvailable() ? false : 'нет PostgreSQL (initdb/pg_ctl или Docker)', timeout: 600000 }, () => {
  let db
  before(() => {
    db = new TestDatabase()
    db.start()
  })
  after(() => db?.stop())

  const quoted = (value) => {
    const text = JSON.stringify(value)
    let tag = 'n'
    while (text.includes(`$${tag}$`)) tag += 'n'
    return `$${tag}$${text}$${tag}$`
  }

  for (const file of MIGRATIONS) {
    it(`${path.relative(ROOT, file)}: слова и числа — словарь и 3000 случайных строк; итог — 3000 пар`, () => {
      db.exec(similarityFunctions(file))
      const names = [...DICTIONARY, ...fuzz(3000)]
      const parts = JSON.parse(db.exec(`select json_agg(json_build_array(public.supply_name_stems(x), public.supply_name_nums(x)) order by i)
        from json_array_elements_text(${quoted(names)}::json) with ordinality as t(x, i);`).trim())
      const mismatches = names.map((n, i) => [n, nameParts(n), parts[i]])
        .filter(([, js, [w, nu]]) => JSON.stringify(js.words) !== JSON.stringify(w) || JSON.stringify(js.nums) !== JSON.stringify(nu))
      assert.deepEqual(mismatches.slice(0, 5), [], `расхождений: ${mismatches.length}`)

      // Пары: словарь со словарём и случайные — с похожими (одна строка — часть другой), чтобы были и высокие оценки.
      let seed = 7
      const pick = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return names[seed % names.length] }
      const pairs = []
      for (const a of DICTIONARY) for (const b of DICTIONARY) pairs.push([a, b])
      while (pairs.length < 6000) { const a = pick(); pairs.push([a, seed % 3 ? pick() : `${a} ${pick()}`]) }
      const out = JSON.parse(db.exec(`select json_agg(json_build_array(
          public.supply_name_score(public.supply_name_stems(p->>0), public.supply_name_nums(p->>0), public.supply_name_stems(p->>1), public.supply_name_nums(p->>1)),
          public.supply_name_word_share(public.supply_name_stems(p->>0), public.supply_name_stems(p->>1)),
          public.supply_name_score(public.supply_name_stems(p->>0), public.supply_name_nums(p->>0), public.supply_name_stems(p->>1), public.supply_name_nums(p->>1), 0.6)) order by i)
        from json_array_elements(${quoted(pairs)}::json) with ordinality as t(p, i);`).trim())
      const bad = pairs.map(([a, b], i) => {
        const r = scoreParts(a, b)
        const withMin = r.words >= 0.6 ? r.score : 0
        return [a, b, [r.score, r.words, withMin], out[i].map(Number)]
      }).filter(([, , js, pg]) => js.some((v, k) => v !== pg[k]))
      assert.deepEqual(bad.slice(0, 5), [], `расхождений: ${bad.length}`)
      assert.ok(out.some(([s]) => Number(s) >= SIMILAR_MIN), 'есть и похожие пары')
    })
  }

  it('ключи поиска кандидатов: у слова и у его начала (сокращения) — общий ключ', () => {
    const heads = (s) => JSON.parse(db.exec(`select to_json(public.supply_name_heads(public.supply_name_stems(${quoted(s)}::json->>0)))`).trim())
    assert.ok(heads(['Лист оцинк.']).some((h) => heads(['Лист оцинкованный']).includes(h)))
  })
})
