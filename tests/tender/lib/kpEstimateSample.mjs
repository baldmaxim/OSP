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

export function sampleKpWorkbook(XLSX) {
  const rows = []
  const header = ['Номер раздела', 'Номер позиции', 'Название', 'Примечание Заказчика', 'Примечание ГП', 'Единица', 'Количество (ГП)',
    'Кол-во Заказчика', 'Базовая стоимость', 'Итого материалов (КП), руб', 'Итого работ (КП), руб', 'Коммерческая стоимость',
    'За единицу (база)', 'За единицу (коммерч.)', 'За единицу материалов', 'За единицу работ']
  rows.push({ cells: header })
  const pos = (p) => {
    const R = rows.length + 1
    const { j, k } = commercial(p)
    const direct = p[9] + p[10] + p[11]
    return {
      cells: [p[0], p[1], p[2], '', p[8], p[3], p[4], p[5], direct, { v: j, f: `G${R}*O${R}` }, { v: k, f: `G${R}*P${R}` }, { v: j + k, f: `J${R}+K${R}` },
        p[4] ? Math.round((direct / p[4]) * 100) / 100 : 0, p[4] ? Math.round(((j + k) / p[4]) * 100) / 100 : 0, p[6], p[7]],
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
