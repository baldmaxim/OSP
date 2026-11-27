// Книги «КП до перекидок» и «Смета» в раскладке файлов ЖК Примавера К14 (лист «Комм. затраты»; листы «Паспорт», «Смета»,
// «Освоение», «Коэффициенты»), но с вымышленными позициями и ценами: настоящие файлы в репозиторий не кладём (он открытый).
// Есть всё, что встречается в настоящих: заголовок «Корпус 1», разделы и группы с SUBTOTAL, позиции с J = G×O, K = G×P,
// L = J+K, нулевая строка «Учтено» (в смету ПЗ не попадает), укрупнённая позиция с подробными позициями (их коды — от
// другой группы, как у К14), вставленная строка без кода (№ 9.1), техническая строка «Округление» в смете.
// XLSX передаётся снаружи: в node — пакет xlsx, на стенде — тот же модуль из браузера.

const POS = [
  // [код, №, название, ед., кол-во ГП, кол-во заказчика, за ед. материалов, за ед. работ, примечание ГП, прямые: осн., вспом., работы]
  ['1.1.1', 4, 'Разработка грунта с вывозом', 'м3', 1000, 980, 0, 2000, 'Учтена механизированная разработка', 0, 0, 1795000],
  ['1.1.2', 5, 'Шпунтовое ограждение из труб 530х8', 'тн', 50, 50, 75000, 54000, '', 3750000, 0, 2400000],
  ['1.1.3', 6, 'Армирование ростверка', 'кг', 0, 9100, 0, 0, 'Учтено', 0, 0, 0],
]
const AGG_CHILDREN = [
  ['1.1.9.1', 9, 'Покрытие по типу «Мастертоп» 5 мм', 'м2', 500, 0, 255, 581, '', 127500, 0, 160000],
  ['1.1.9.2', 10, 'Бетонное основание В25 по сетке', 'м2', 500, 0, 1726, 2990, '', 863000, 40000, 900000],
  ['1.1.9.3', 11, 'Обмазочная гидроизоляция 2 мм', 'м2', 500, 0, 556, 922, '', 278000, 0, 300000],
]
const LUK = ['', 11.1, 'Люк потолочный под отделку 300×300', 'шт.', 10, 0, 2369, 5589, '', 23690, 5000, 20000]
const SEC2 = [
  ['2.1.1', 14, 'Стена железобетонная монолитная B30', 'м3', 200, 205, 19416, 48718, 'В том числе герметизация', 3883200, 400000, 8000000],
  ['2.1.2', 15, 'Плита перекрытия монолитная B30', 'м3', 300, 300, 18532, 46611, '', 5559600, 500000, 11000000],
]

const commercial = (p) => ({ j: p[4] * p[6], k: p[4] * p[7] })

// inlinePz — один файл «КП + план затрат» (13.11.2026): справа от столбцов КП — прямые затраты строки.
export function sampleKpWorkbook(XLSX, { inlinePz = false } = {}) {
  const rows = []
  const header = ['Номер раздела', 'Номер позиции', 'Название', 'Примечание Заказчика', 'Примечание ГП', 'Единица', 'Количество (ГП)',
    'Кол-во Заказчика', 'Базовая стоимость', 'Итого материалов (КП), руб', 'Итого работ (КП), руб', 'Коммерческая стоимость',
    'За единицу (база)', 'За единицу (коммерч.)', 'За единицу материалов', 'За единицу работ']
  if (inlinePz) header.push('Прямые затраты', 'Прямые: основные материалы', 'Прямые: вспом. материалы', 'Прямые: работы')
  rows.push({ cells: header })
  const pos = (p) => {
    const R = rows.length + 1
    const { j, k } = commercial(p)
    const direct = p[9] + p[10] + p[11]
    return {
      cells: [p[0], p[1], p[2], '', p[8], p[3], p[4], p[5], direct, { v: j, f: `G${R}*O${R}` }, { v: k, f: `G${R}*P${R}` }, { v: j + k, f: `J${R}+K${R}` },
        p[4] ? Math.round((direct / p[4]) * 100) / 100 : 0, p[4] ? Math.round(((j + k) / p[4]) * 100) / 100 : 0, p[6], p[7],
        ...(inlinePz ? [direct, p[9], p[10], p[11]] : [])],
    }
  }
  const zero = (p) => {
    const R = rows.length + 1
    return { cells: [p[0], p[1], p[2], '', p[8], p[3], 0, p[5], 0, 0, 0, { v: 0, f: `J${R}+K${R}` }, 0, 0, 0, 0] }
  }
  const group = (code, n, name, unit = '', qty = 0, qtyCustomer = 0) => ({ cells: [code, n, name, '', '', unit, qty, qtyCustomer, 0, null, null, null, 0, 0, 0, 0], group: true })
  rows.push({ cells: ['', 1, 'Корпус 1', '', '', '', 0, 0, 0, 0, 0, { v: 0, f: 'J2+K2' }, 0, 0, 0, 0] })
  const sec1 = rows.push(group('1', 2, 'Раздел 1. Подземная часть')) - 1
  const g11 = rows.push(group('1.1', 3, 'Нулевой цикл. Котлован')) - 1
  rows.push(pos(POS[0]), pos(POS[1]), zero(POS[2]))
  const agg = rows.push(group('1.1.4', 8, 'Отделка пола автостоянки, тип П1 (покрытие, основание, гидроизоляция)', 'м2', 500, 480)) - 1
  for (const c of AGG_CHILDREN) rows.push(pos(c))
  const aggEnd = rows.length - 1
  rows.push(pos(LUK))
  const g11End = rows.length - 1
  const sec1End = rows.length - 1
  const sec2 = rows.push(group('2', 12, 'Раздел 2. Надземная часть')) - 1
  const g21 = rows.push(group('2.1', 13, 'Конструкции железобетонные')) - 1
  for (const p of SEC2) rows.push(pos(p))
  const sec2End = rows.length - 1
  const g21End = sec2End
  // SUBTOTAL групп: диапазон — строки Excel (индекс + 1).
  const sub = (i, end) => {
    const R1 = i + 2
    const R2 = end + 1
    const sum = (col) => rows.slice(i + 1, end + 1).filter((r) => !r.group).reduce((s, r) => s + (typeof r.cells[col] === 'object' && r.cells[col] ? r.cells[col].v : (Number(r.cells[col]) || 0)), 0)
    rows[i].cells[9] = { v: sum(9), f: `SUBTOTAL(9,J${R1}:J${R2})` }
    rows[i].cells[10] = { v: sum(10), f: `SUBTOTAL(9,K${R1}:K${R2})` }
    rows[i].cells[11] = { v: sum(11), f: `SUBTOTAL(9,L${R1}:L${R2})` }
  }
  for (const [i, end] of [[agg, aggEnd], [g11, g11End], [sec1, sec1End], [g21, g21End], [sec2, sec2End]]) sub(i, end)
  const last = rows.length
  const totals = (col) => rows.slice(1).filter((r) => !r.group).reduce((s, r) => s + (typeof r.cells[col] === 'object' && r.cells[col] ? r.cells[col].v : (Number(r.cells[col]) || 0)), 0)
  rows.push({ cells: ['', '', 'ИТОГО', '', '', '', null, null, null, { v: totals(9), f: `SUBTOTAL(9,J2:J${last})` }, { v: totals(10), f: `SUBTOTAL(9,K2:K${last})` }, { v: totals(11), f: `SUBTOTAL(9,L2:L${last})` }] })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, toSheet(XLSX, rows.map((r) => r.cells)), 'Комм. затраты')
  return wb
}

// Книга, где КП и смета ПЗ — листами одного файла.
export function sampleBothSheetsWorkbook(XLSX) {
  const wb = sampleKpWorkbook(XLSX)
  const pz = samplePzWorkbook(XLSX)
  for (const name of pz.SheetNames) XLSX.utils.book_append_sheet(wb, pz.Sheets[name], name)
  return wb
}

export const SAMPLE_TOTAL = [...POS, ...AGG_CHILDREN, LUK, ...SEC2].reduce((s, p) => s + commercial(p).j + commercial(p).k, 0)

export function samplePzWorkbook(XLSX, { withMastering = false } = {}) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['ЖК Пример, корпус 1'], [], ['Объект', 'ЖК Пример, корпус 1'], ['Файл-источник', 'Пример К1.xlsx'], ['Дата сборки', '10.11.2026'],
    ['Коэффициенты', 'портал на 02.11.2026'], ['НДС в этой смете', '20%'],
  ]), 'Паспорт')
  const header = ['Код', '№ п/п', 'Код раздела', 'Раздел', 'Наименование', 'Примечание', 'Ед. изм.', 'Кол-во заказчика', 'Кол-во ГП',
    'Прямые затраты', 'Прямые: основные материалы', 'Прямые: вспом. материалы', 'Прямые: работы', 'Коммерция: материалы', 'Коммерция: работы',
    'Коммерция итого', 'Цена за ед. коммерч.', 'НДС', 'Забрано', 'Остаток', 'Статус']
  const rows = [header]
  const add = (p, sec, secName) => {
    const R = rows.length + 1
    const { j, k } = commercial(p)
    rows.push([p[0] || p[1], p[1], sec, secName, p[2], p[8], p[3], p[5], p[4], p[9] + p[10] + p[11], p[9], p[10], p[11], j, k, j + k,
      { v: p[4] ? (j + k) / p[4] : '', f: `IF(I${R}<>0,P${R}/I${R},IF(H${R}<>0,P${R}/H${R},""))` }, '20%',
      { v: 0, f: `SUMIF(Освоение!C:C,A${R},Освоение!F:F)` }, { v: j + k, f: `P${R}-S${R}` }, { v: 'не начато', f: `IF(S${R}=0,"не начато",IF(T${R}>0.5,"частично","выбрано"))` }])
  }
  for (const p of [POS[0], POS[1], ...AGG_CHILDREN, LUK]) add(p, 1, 'Раздел 1. Подземная часть')
  for (const p of SEC2) add(p, 2, 'Раздел 2. Надземная часть')
  rows.push(['ОКРУГЛ', null, 'ОКРУГЛ', 'Округление', 'Округление до копеек', 'Техническая строка', null, 0, 0, 0, 0, 0, 0, -0.15, -0.17, -0.32, '', '20%', 0, -0.32, 'не начато'])
  XLSX.utils.book_append_sheet(wb, toSheet(XLSX, rows), 'Смета')
  const mastering = [['Дата', 'Код раздела', 'Код позиции', 'Наименование', 'Документ', 'Сумма', 'Комментарий']]
  if (withMastering) mastering.push(['01.11.2026', 2, '2.1.1', 'Стена железобетонная монолитная B30', 'Тендер № 501', 6826800, 'Монолит секции 1'])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mastering), 'Освоение')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Коэффициенты наценки на 02.11.2026'], ['Тендер', 'ЖК Пример, корпус 1'], ['Работы (раб)', 2.770111], ['Материалы (мат)', 1.512766],
    ['Субподряд работы, с ростом', 1.16995725], ['Субподряд работы, без роста', 1.114245], [],
    ['Затраты, по которым субподряд берётся с коэффициентом роста'], ['Категория', 'Вид затрат', 'Локализация', 'Суб-раб с ростом'],
    ['ФАСАДНЫЕ РАБОТЫ', 'Облицовка НВФ', 'Здание', 1.16995725],
  ]), 'Коэффициенты')
  return wb
}

// ── КП с ресурсами ПЗ одним листом (раскладка «Алия — КП до перекидок после ДС1–8», 26.11.2026) ─────────────────
// Вымышленные позиции. Есть всё, что встречается в настоящем файле: строки названия и пояснений над шапкой, итоги
// файла между шапкой и деревом (один — с доначислением НДС, другой — в базе строк), разделы / подразделы / работы с
// группировкой строк Excel, ресурсы мат / суб-мат / раб / суб-раб (тип материала основн. / вспомогат.), ресурс без цены,
// добавка ДС «Работы» под обычной работой («Работа» ≠ «Работы»), позиция «КП · ДС1» с ресурсом «Материалы» без цены,
// «Контроль ДС1» без единицы, нулевая «Строка КП», вставленная работа без кода (№ 7.1), подраздел с единицей
// (укрупнённая), заголовок подраздела с постоянным 0 над оценённой работой (как в файле), цепочка глубже 7 уровней
// (ресурсы — на уровне своей работы), под деревом — контрольные расчёты: коэффициенты, таблица ДС с типами «суб-раб» /
// «суб-мат» и строки «ИТОГО …» (в смету не попадают).
const TREE_HEADER = ['Код раздела', '№ позиции', 'Наименование раздела / работы / ресурса', 'Тип строки / затрат', 'Ед. изм.',
  'Кол-во заказчика', 'Кол-во ГП / ресурса', 'КП · материалы, ₽', 'КП · работы, ₽', 'КП · всего, ₽', 'ПЗ · известная часть, ₽',
  'Коэффициент', 'ПЗ × коэфф., ₽', 'Статус / примечание', 'Строка КП', 'Строка ПЗ', 'База по КП, ₽', 'База КП за ед., ₽',
  'КП · мат. за ед., ₽', 'КП · раб. за ед., ₽', 'КП · всего за ед., ₽', 'Примечание заказчика (КП)', 'Примечание ГП (КП)',
  'Затрата на строительство', 'Привязка материала к работе', 'Тип материала', 'Коэфф. перевода', 'Коэфф. расхода', 'Валюта',
  'Тип доставки', 'Доставка за ед., ₽', 'Цена ПЗ за ед., ₽', 'Коммерческое предложение / источник цены ПЗ',
  'Примечание заказчика (ПЗ)', 'Примечание ГП (ПЗ)']
export const TREE_COEF = { 'раб': 2.4, 'мат': 1.6, 'суб-раб': 1.25, 'суб-мат': 1.25, 'Работы': 1.25, 'Материалы': 1.25 }
// Ресурс: [тип, наименование, ед., кол-во, сумма ПЗ (null — нет цены), тип материала, статус].
const deep = (n, name, kids) => ({ type: 'Подраздел', code: `К1.4${'.1'.repeat(n)}`, name, kids })
export const TREE_SAMPLE = [
  { type: 'Раздел', code: 'ПР', pos: 1, name: 'Проектные работы', kids: [
    { type: 'Работа', code: 'ПР.1', pos: 2, name: 'Разработка рабочей документации', unit: 'компл', qtyC: 1, qtyGp: 1, unitMat: 0, unitWorks: 3000000,
      gpNote: 'Финансовый лимит по ДС1', res: [
        ['суб-раб', 'Разработка РД', 'м2', 1200, 2400000],
        ['Работы', 'Корректировка РД — добавка ДС2', 'компл', 1, null, null, 'Цена ПЗ к подтверждению.'],
      ] },
  ] },
  { type: 'Раздел', code: 'К1', pos: 3, name: 'Корпус 1', kids: [
    { type: 'Подраздел', code: 'К1.1', pos: 4, name: 'Фундаменты', unit: 'м3', qtyC: 500, qtyGp: 0, kids: [
      { type: 'Подраздел', code: 'К1.1.1', pos: 5, name: 'Бетонирование', zero: true, kids: [
        { type: 'Работа', code: 'К1.1.1', pos: 6, name: 'Бетонирование фундаментной плиты B30', unit: 'м3', qtyC: 410, qtyGp: 400, unitMat: 9000, unitWorks: 3000,
          customerNote: 'По РД КЖ', res: [
            ['раб', 'Бетонирование', 'м3', 400, 600000],
            ['мат', 'Бетон B30', 'м3', 404, 2800000, 'основн.'],
            ['мат', 'Проволока вязальная', 'кг', 200, 40000, 'вспомогат.'],
            ['суб-мат', 'Пеноплэкс 50 мм', 'м2', 300, 100000],
            ['мат', 'Фиксаторы арматуры', 'шт', 2000, null, 'вспомогат.', 'Сумма ПЗ и цена отсутствуют в источнике.'],
          ] },
      ] },
      { type: 'Работа', code: 'К1.1.2', pos: 7, name: 'Обмазочная гидроизоляция фундаментов', unit: 'м2', qtyC: 1000, qtyGp: 1000, unitMat: 500, unitWorks: 300, res: [
        ['суб-раб', 'Устройство гидроизоляции', 'м2', 1000, 200000],
        ['суб-мат', 'Мастика битумная', 'кг', 1500, 350000, 'основн.'],
      ] },
    ] },
    { type: 'Работа', code: '', pos: 7.1, name: 'Люк потолочный — вставленная строка', unit: 'шт', qtyGp: 2, unitMat: 4000, unitWorks: 1000, res: [
      ['суб-раб', 'Монтаж люка', 'шт', 2, 1500],
      ['суб-мат', 'Люк 300×300', 'шт', 2, 5000, 'основн.'],
    ] },
    { type: 'КП · ДС1', code: 'К1.2.1', name: 'Устройство свай вдавливанием — новая позиция ДС1', unit: 'шт', qtyGp: 10, mat: 100000, works: 50000,
      status: 'Новая договорная позиция ДС1.', res: [['Материалы', 'Сваи — марку уточнить', 'шт', 10, null, null, 'Цена ПЗ к подтверждению.']] },
    { type: 'Контроль ДС1', name: 'Входящее расхождение КП и ПСДЦ до ДС1', mat: -10, works: 1000, status: 'Часть лимита КП, сохранённая при замене работ.' },
    { type: 'Строка КП', code: 'К1.3', pos: 8, name: 'Учтено в других строках' },
    { type: 'Подраздел', code: 'К1.4', pos: 9, name: 'Отделка МОП', kids: [
      deep(1, 'Секция 1', [deep(2, 'Этаж 1', [deep(3, 'Коридор', [deep(4, 'Помещение 101', [deep(5, 'Стены', [
        { type: 'Работа', code: 'К1.4.1.1.1.1.1', pos: 10, name: 'Грунтовка стен', unit: 'м2', qtyGp: 100, unitMat: 10, unitWorks: 20, res: [
          ['раб', 'Грунтование стен', 'м2', 100, 1500],
          ['мат', 'Грунт глубокого проникновения', 'л', 20, 700, 'основн.'],
        ] },
        { type: 'Работа', code: 'К1.4.1.1.1.1.2', pos: 11, name: 'Шпаклёвка стен', unit: 'м2', qtyGp: 100, unitMat: 30, unitWorks: 40, res: [
          ['раб', 'Шпаклевание стен', 'м2', 100, 2000],
        ] },
      ])])])])]),
    ] },
  ] },
]
// Начисление НДС сверх базы строк — только в итоге файла «КП после ДС2» (в смету не входит).
export const TREE_VAT_ACCRUAL = 1000

// Итоги образца — обходом TREE_SAMPLE (тест сверяет с ними разбор).
export function treeSampleExpect() {
  const out = { kpRows: 0, resources: 0, unpriced: 0, materials: 0, works: 0, total: 0, direct: 0, main: 0, aux: 0, dworks: 0, coef: 0 }
  const walk = (node) => {
    out.kpRows++
    const m = node.mat ?? (node.unitMat !== undefined ? node.qtyGp * node.unitMat : 0)
    const w = node.works ?? (node.unitWorks !== undefined ? node.qtyGp * node.unitWorks : 0)
    if (!node.kids) { out.materials += m; out.works += w; out.total += m + w }
    for (const r of node.res || []) {
      out.resources++
      if (r[4] === null) { out.unpriced++; continue }
      out.direct += r[4]
      out.coef += r[4] * TREE_COEF[r[0]]
      if (['раб', 'суб-раб', 'Работы'].includes(r[0])) out.dworks += r[4]
      else if (r[5] === 'вспомогат.') out.aux += r[4]
      else out.main += r[4]
    }
    for (const k of node.kids || []) walk(k)
  }
  for (const n of TREE_SAMPLE) walk(n)
  return out
}

// outline: false — книга без группировки строк (так её видит SheetJS без cellStyles).
export function sampleTreeWorkbook(XLSX, { outline = true } = {}) {
  const C = Object.fromEntries(TREE_HEADER.map((h, i) => [h, i]))
  const col = (h) => XLSX.utils.encode_col(C[h])
  const aoa = []
  const levels = []
  const push = (cells, level = 0) => { aoa.push(cells); levels.push(level); return aoa.length } // номер строки Excel
  const exp = treeSampleExpect()
  push(['ПРИМЕР  /  КП ДО ПЕРЕКИДОК'])
  push(['Редакция после ДС №1–2 · суммы в рублях. В дереве КП и ПЗ приведены в сопоставимой базе НДС 20%.'])
  push(['Кнопки слева раскрывают разделы и ресурсы.'])
  push([])
  push(TREE_HEADER)
  const line = (name, m, w, extra = {}) => {
    const cells = []
    cells[C['Наименование раздела / работы / ресурса']] = name
    cells[C['КП · материалы, ₽']] = m
    cells[C['КП · работы, ₽']] = w
    cells[C['КП · всего, ₽']] = m + w
    for (const [h, v] of Object.entries(extra)) cells[C[h]] = v
    return cells
  }
  push(line('КП после ДС2, с опционом', exp.materials, exp.works + TREE_VAT_ACCRUAL, {
    'ПЗ · известная часть, ₽': exp.direct, 'ПЗ × коэфф., ₽': exp.coef, 'Статус / примечание': 'Смешанный НДС 20% / 22%. ПЗ остаются в базе НДС 20%.' }))
  push(line('КП в сопоставимой базе НДС 20%, с опционом', exp.materials, exp.works, { 'Статус / примечание': 'Доначисление НДС — в контрольных расчётах.' }))
  push([])

  // Дерево: значения групп — суммой листьев (SUBTOTAL), у заголовка с zero — постоянный 0, как в настоящем файле.
  const addNode = (node, depth) => {
    const R = aoa.length + 1
    const cells = []
    cells[C['Код раздела']] = node.code || null
    cells[C['№ позиции']] = node.pos ?? null
    cells[C['Наименование раздела / работы / ресурса']] = node.name
    cells[C['Тип строки / затрат']] = node.type
    cells[C['Ед. изм.']] = node.unit || null
    cells[C['Кол-во заказчика']] = node.qtyC ?? null
    cells[C['Кол-во ГП / ресурса']] = node.unit ? (node.qtyGp ?? 0) : null
    cells[C['Примечание заказчика (КП)']] = node.customerNote || null
    cells[C['Примечание ГП (КП)']] = node.gpNote || null
    cells[C['Статус / примечание']] = node.status || null
    push(cells, Math.min(depth, 7))
    const sums = { m: 0, w: 0, k: 0, coef: 0, hasK: false }
    if (node.kids) {
      const first = aoa.length + 1
      for (const k of node.kids) {
        const s = addNode(k, depth + 1)
        sums.m += s.m; sums.w += s.w; sums.k += s.k; sums.coef += s.coef; sums.hasK ||= s.hasK
      }
      const last = aoa.length
      const sub = (h, v) => ({ v, f: `SUBTOTAL(9,${col(h)}${first}:${col(h)}${last})` })
      if (node.zero) {
        cells[C['КП · материалы, ₽']] = 0
        cells[C['КП · работы, ₽']] = 0
        cells[C['КП · всего, ₽']] = { v: 0, f: `${col('КП · материалы, ₽')}${R}+${col('КП · работы, ₽')}${R}` }
      } else {
        cells[C['КП · материалы, ₽']] = sub('КП · материалы, ₽', sums.m)
        cells[C['КП · работы, ₽']] = sub('КП · работы, ₽', sums.w)
        cells[C['КП · всего, ₽']] = sub('КП · всего, ₽', sums.m + sums.w)
      }
      if (sums.hasK) cells[C['ПЗ · известная часть, ₽']] = sub('ПЗ · известная часть, ₽', sums.k)
      return sums
    }
    const G = col('Кол-во ГП / ресурса')
    let m = node.mat ?? 0
    let w = node.works ?? 0
    if (node.unitMat !== undefined) {
      m = node.qtyGp * node.unitMat
      w = node.qtyGp * node.unitWorks
      cells[C['КП · мат. за ед., ₽']] = node.unitMat
      cells[C['КП · раб. за ед., ₽']] = node.unitWorks
      cells[C['КП · всего за ед., ₽']] = node.unitMat + node.unitWorks
      cells[C['КП · материалы, ₽']] = { v: m, f: `${G}${R}*${col('КП · мат. за ед., ₽')}${R}` }
      cells[C['КП · работы, ₽']] = { v: w, f: `${G}${R}*${col('КП · раб. за ед., ₽')}${R}` }
    } else if (node.mat !== undefined) {
      cells[C['КП · материалы, ₽']] = m
      cells[C['КП · работы, ₽']] = w
    }
    cells[C['КП · всего, ₽']] = { v: m + w, f: `${col('КП · материалы, ₽')}${R}+${col('КП · работы, ₽')}${R}` }
    const out = { m, w, k: 0, coef: 0, hasK: false }
    const resFirst = aoa.length + 1
    for (const r of node.res || []) {
      const rc = []
      rc[C['№ позиции']] = node.pos ?? null
      rc[C['Наименование раздела / работы / ресурса']] = r[1]
      rc[C['Тип строки / затрат']] = r[0]
      rc[C['Ед. изм.']] = r[2]
      rc[C['Кол-во ГП / ресурса']] = r[3]
      rc[C['Коэффициент']] = TREE_COEF[r[0]]
      rc[C['Тип материала']] = r[5] || null
      rc[C['Статус / примечание']] = r[6] || null
      rc[C['Затрата на строительство']] = 'ПРИМЕР / Затрата'
      if (r[4] !== null) {
        rc[C['ПЗ · известная часть, ₽']] = r[4]
        rc[C['ПЗ × коэфф., ₽']] = r[4] * TREE_COEF[r[0]]
        out.k += r[4]
        out.coef += r[4] * TREE_COEF[r[0]]
        out.hasK = true
      }
      push(rc, Math.min(depth + 1, 7))
    }
    // Как в файле: у работы с ресурсами — SUBTOTAL их сумм, и 0, когда ни у одного ресурса нет цены (позиция ДС1).
    if (node.res?.length) {
      cells[C['ПЗ · известная часть, ₽']] = { v: out.k, f: `SUBTOTAL(9,${col('ПЗ · известная часть, ₽')}${resFirst}:${col('ПЗ · известная часть, ₽')}${aoa.length})` }
      if (out.hasK) cells[C['ПЗ × коэфф., ₽']] = out.coef
    }
    return out
  }
  for (const n of TREE_SAMPLE) addNode(n, 0)

  push([])
  push(['КОНТРОЛЬНЫЕ РАСЧЁТЫ И ИСТОЧНИКИ'])
  push(['Коэффициенты Пример · версия 1'], 1)
  push([null, null, null, 'раб', 'мат', 'суб-раб', 'суб-мат', 'Позиций с ростом'], 2)
  push([null, null, 'ЖК Пример', TREE_COEF['раб'], TREE_COEF['мат'], TREE_COEF['суб-раб'], TREE_COEF['суб-мат'], 0], 2)
  push(['ДС1 новые ПЗ'], 1)
  push(['Корпус', 'Код ДС1', 'Ресурс', 'Тип затрат', 'Ед.', 'Объём ДС'], 2)
  push(['К1', 'К1.2.1', 'Сваи для вдавливания — из таблицы ДС', 'суб-мат', 'шт', 10], 2)
  push([null, null, 'ИТОГО КП — сопоставимая база с НДС20', null, null, null, null, exp.materials, exp.works, exp.total], 2)
  push([null, null, 'ИТОГО АКТУАЛЬНЫЙ КП — смешанный НДС20/22, с опционом', null, null, null, null, exp.materials, exp.works + TREE_VAT_ACCRUAL, exp.total + TREE_VAT_ACCRUAL], 2)

  const ws = toSheet(XLSX, aoa)
  if (outline) ws['!rows'] = levels.map((level) => (level ? { level } : {}))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'КП до перекидок')
  return wb
}

function toSheet(XLSX, aoa) {
  const ws = {}
  let maxC = 0
  aoa.forEach((row, r) => row.forEach((value, c) => {
    if (value === null || value === undefined) return
    maxC = Math.max(maxC, c)
    const ref = XLSX.utils.encode_cell({ r, c })
    if (typeof value === 'object') ws[ref] = { t: typeof value.v === 'string' ? 's' : 'n', v: value.v, f: value.f }
    else ws[ref] = { t: typeof value === 'number' ? 'n' : 's', v: value }
  }))
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: maxC } })
  return ws
}

// ── КП с этапами договора (раскладка «Событие_6_2_КП_до_перекидок,_ДГП,_Допники», 27.11.2026) ───────────────────────────
// Лист «Комм. затраты»: шапка во второй строке (в первой — подписи этапов), номера позиции нет, код раздела у каждой строки;
// группа — SUBTOTAL материалов и работ, итог строки — SUM(материалы:работы); позиция — Кол-во ГП × цена; позиция, у которой
// «Кол-во ГП» пусто, а сумма посчитана от кол-ва заказчика (C×F); нулевая «Учтено в …» с кол-вом заказчика; позиция [ДОП]
// без кода; ИТОГО; под итогом — «Новые позиции ПСДЦ» (в смету не идут) и пояснения этапов. Этапы: ДГП и ДС №1 — суммы строк.
export const STAGES_POS = [
  // [код, наименование, кол-во заказчика, кол-во ГП, ед., за ед. мат., за ед. раб., примечание ГП, ДГП мат., ДГП раб.]
  ['01.01.01', 'Временная дорога из плит ПДП', 765, 765, 'м2', 2300, 600, '', 1300000, 300000],
  ['01.01.02', 'Временное ограждение площадки', 420, 420, 'м.п.', 5800, 4800, '', 1700000, 1000000],
  ['01.01.03', 'Мобилизация башенного крана', 2, 0, 'к-с', 0, 0, 'Учтено в монолитных работах', 0, 0],
  ['02.01.01', 'Распор D630х7 мм', 44.654, null, 'тн', 81000, 132000, '', 3600000, 3000000, 'customer'],
  ['02.01.02', 'Демонтаж распорной системы', 300, 300, 'тн', 0, 57000, '', 0, 8600000],
]
export const STAGES_DOP = ['', ' [ДОП] Комплекс работ по водоотливу', null, 1, 'к-с', 1290000, 5530000, '', 0, 0]
export function sampleStagesWorkbook(XLSX) {
  const aoa = []
  const put = (cells) => { aoa.push(cells); return aoa.length }
  const h1 = []
  h1[0] = 'Коммерческие затраты'
  h1[12] = 'ДГП '
  h1[17] = 'ДС №1 01.03.2026 '
  put(h1)
  put(['Номер раздела', 'Наименование', 'Кол-во заказчика', 'Кол-во ГП', 'Ед. изм.', 'Цена за ед. мат-ал в КП', 'Цена за ед. раб', 'Итого материалы',
    'Итого работы', 'Примечание ГП', 'КП до перекидок Итого материалы + работы, руб.', null, 'ДГП 12.01.2026 Материалы, руб.', 'ДГП 12.01.2026 Работы, руб.',
    'ДГП 12.01.2026 Итого, руб.', 'ДГП 12.01.2026 Изменение к КП, %', null, 'ДС №1 01.03.2026 Цена без изменений Материалы, руб.',
    'ДС №1 01.03.2026 Цена без изменений Работы, руб.', 'ДС №1 01.03.2026 Цена без изменений Итого, руб.'])
  const ws = {}
  const formulas = []
  const setF = (r, c, f) => formulas.push([r, c, f])
  const sections = [
    { code: '01', name: 'Подготовительный период', kids: STAGES_POS.slice(0, 3) },
    { code: '02', name: 'Устройство котлована', kids: STAGES_POS.slice(3, 5) },
  ]
  const rowOf = (p) => {
    const cells = []
    const byCustomer = p[10] === 'customer'
    const qty = byCustomer ? p[2] : p[3]
    cells.push(p[0], p[1], p[2], p[3], p[4], p[5], p[6], qty * p[5], qty * p[6], p[7], qty * (p[5] + p[6]), null, p[8], p[9], p[8] + p[9], null, null, p[8], p[9], p[8] + p[9])
    const R = put(cells)
    const q = byCustomer ? 'C' : 'D'
    setF(R, 7, `${q}${R}*F${R}`); setF(R, 8, `${q}${R}*G${R}`); setF(R, 10, `SUM(H${R}:I${R})`)
    setF(R, 14, `SUM(M${R}:N${R})`); setF(R, 17, `M${R}`); setF(R, 18, `N${R}`); setF(R, 19, `SUM(R${R}:S${R})`)
    return R
  }
  for (const s of sections) {
    const R = put([s.code, s.name])
    const first = R + 1
    let last = R
    for (const p of s.kids) last = rowOf(p)
    const sum = (col) => s.kids.reduce((acc, p) => acc + ({ H: (p[10] === 'customer' ? p[2] : p[3]) * p[5], I: (p[10] === 'customer' ? p[2] : p[3]) * p[6], M: p[8], N: p[9] }[col]), 0)
    aoa[R - 1] = [s.code, s.name, null, null, null, 0, 0, sum('H'), sum('I'), null, sum('H') + sum('I'), null, sum('M'), sum('N'), sum('M') + sum('N'), null, null, sum('M'), sum('N'), sum('M') + sum('N')]
    for (const [c, col] of [[7, 'H'], [8, 'I'], [12, 'M'], [13, 'N']]) setF(R, c, `SUBTOTAL(9,${col}${first}:${col}${last})`)
    setF(R, 10, `SUM(H${R}:I${R})`); setF(R, 14, `SUM(M${R}:N${R})`)
  }
  rowOf(STAGES_DOP)
  const T = aoa.length
  const all = [...STAGES_POS, STAGES_DOP]
  const tot = (i) => all.reduce((s, p) => s + (i === 'H' ? (p[10] === 'customer' ? p[2] : p[3]) * p[5] : i === 'I' ? (p[10] === 'customer' ? p[2] : p[3]) * p[6] : i === 'M' ? p[8] : p[9]), 0)
  const R = put([null, 'ИТОГО:', null, null, null, null, null, tot('H'), tot('I'), null, tot('H') + tot('I'), null, tot('M') + 200000, tot('N'), tot('M') + 200000 + tot('N'), null, null, tot('M') + 200000, tot('N'), tot('M') + 200000 + tot('N')])
  setF(R, 7, `SUBTOTAL(9,H3:H${T})`); setF(R, 8, `SUBTOTAL(9,I3:I${T})`); setF(R, 10, `SUM(H${R}:I${R})`)
  put([])
  put([null, 'Новые позиции ПСДЦ, отсутствующие в КП (включены в итог строки ДГП)'])
  put(['06.01.07', 'Временные стены между очередями', null, null, 'м2', null, null, null, null, null, null, null, 200000, 0, 200000])
  const notes = []
  notes[12] = 'ДГП. Источник: подписанное ПСДЦ, части 1 и 2.'
  notes[17] = 'ДС №1, п.1. Цена не меняется.'
  put(notes)
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  for (const [r, c, f] of formulas) {
    const ref = XLSX.utils.encode_cell({ r: r - 1, c })
    sheet[ref] = { ...(sheet[ref] || { t: 'n', v: 0 }), f }
  }
  Object.assign(ws, sheet)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Комм. затраты')
  return wb
}
// Итоги образца: КП (по формулам файла) и ДГП позиций сметы (без «новых позиций ПСДЦ» под итогом).
export function stagesSampleExpect() {
  const all = [...STAGES_POS, STAGES_DOP]
  const qty = (p) => (p[10] === 'customer' ? p[2] : p[3])
  return {
    kp: all.reduce((s, p) => s + qty(p) * (p[5] + p[6]), 0),
    dgp: all.reduce((s, p) => s + p[8] + p[9], 0),
    customerBasis: all.filter((p) => p[10] === 'customer').length,
  }
}
