// ДГП объекта (вкладка «Смета»): паспорт и состав единого ПСДЦ — без деления на виды.
// Книги собираются здесь по образцу настоящих файлов трёх раскладок:
//  • «ЖК STORIES, договор №165/9/2024» — одна таблица, шапка в 9-й строке, над ней «Актуальная цена договора»;
//  • «Корпус 14» — шапка во 2-й строке, в первой «ПСДЦ, ₽» и «КП · справочно», договор и действующая редакция —
//    в примечаниях в самом конце листа, учтённые ДС — только в имени файла «(ДС 1-14)»;
//  • «ALIA» — несколько таблиц на одном листе: контроль цены («Цена договора с НДС», НДС 20 % и 22 %),
//    хронология ДС, разбивка с ценами материалов и работ, раздел «Основные материалы».
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  analyzeDgp, cellNumber, describeDgpDoc, dgpContractFromText, dgpContractKey, dgpNotes, dgpReplaced,
  dgpRevisionFromText, dgpRevisionLabel, orderDgpDocs, parseDgpNotes, readDgpWorkbook,
} from '../../src/utils/dgpWorkbook.js'

const STORIES_HEADER = ['Раздел', '№ позиции', 'Наименование работы / затрат', 'Период / НДС', 'Ед. изм', 'Объём',
  'Цена за ед., ₽', 'Прежн., ₽', 'Актуально, ₽', 'Изменение, ₽', 'Статус', 'Основание', 'Дата основания',
  'Что фактически изменилось', 'Подраздел / место работ', 'Источник', 'Тип строки', 'В итог фильтра, ₽']

const K14_HEADER = ['Раздел', 'Подраздел', 'Код позиции', 'Наименование работ и затрат', 'Ед. изм.', 'Количество',
  'Прежняя цена, ₽', 'Цена, ₽ с НДС', 'Прежняя стоимость, ₽', 'Стоимость, ₽ с НДС', 'Тип строки', 'Изменение',
  'Основание / состав', 'Материалы КП, ₽', 'Работы КП, ₽', 'Материалы за ед., ₽', 'Работы за ед., ₽', 'Связь с ПСДЦ',
  'Источник / строка', 'Проверка источника', 'В итог ПСДЦ, ₽', 'В итог КП, ₽', 'Часть 20%, ₽', 'Часть 22%, ₽',
  'Кол-во 20%', 'Кол-во 22%', 'UID КП', 'Вид ресурса', 'Норма расхода', 'Базовый объем', 'Базовая цена мат., ₽',
  'Базовая цена работ, ₽', 'Прямые затраты, ₽', 'Производитель / марка', 'НДС / примечание источника']

const ALIA_HEADER = ['Код позиции', 'Наименование работы / материала', 'Ед. изм.', 'Количество / коэф.',
  'Цена за ед., без НДС', 'Согласованная сумма, без НДС', 'Цена с НДС 22%*', 'Δ суммы / цены, ₽', 'Редакция / статус',
  'Основание и место в источнике', 'Комментарий', 'Цена материала, без НДС', 'Цена работы, без НДС',
  'Сумма материалов, без НДС', 'Сумма работ, без НДС', 'Коэф. осн. материала', 'Цена осн. материала',
  'Цена сопутств. материала', 'В т.ч. основные материалы', 'Сумма по источнику (гр.11)', 'Кодификатор',
  'Наименование статьи', 'Основной материал']

function storiesRows() {
  return [
    ['ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165/9/2024'],
    ['Редакция с учётом ДС №1–10 · один лист · 2 438 конечных позиций · суммы в рублях с НДС'],
    ['АКТУАЛЬНАЯ ЦЕНА ДОГОВОРА', '', '', '', '', '', 5932993892.39, 'До 2026 года · 20%', '', '', 3136337907.52, 'С 2026 года · 22%', '', '', '', '', '', 2796655984.87],
    ['СУММА ПО ТЕКУЩЕМУ ФИЛЬТРУ', '', '', '', '', '', '5 932 993 892,39', 'Цена в тексте ДС№10', '', '', '5 932 993 892,39', 'Контроль: сходимость с ДС№10'],
    ['ФИЛЬТРЫ: «Раздел» — навигация; «Статус» — изменения; «Основание» — нужное ДС; «Период» — НДС.'],
    ['Серая зачёркнутая — только заменённая сумма. Зелёный — добавлено.'],
    ['В старых источниках есть расхождения (ДС №6–5). Итог ДС№10 подтверждён детализацией позиций.'],
    ['Разделы и группы собраны по номенклатуре.'],
    STORIES_HEADER,
    ['1 · Подготовительный период', '1', 'Подготовительный период', '', '', '', '', '', 107286677.85],
    ['1 · Подготовительный период', '1.1.1.1', 'Монтаж помещений разного назначения с подключением (имс)', 'До 2026 · 20%', 'комплект', 6, 3878572.5, '', 23271435, '', 'Действующая позиция'],
  ]
}

function k14Rows(positions = 2) {
  const rows = [
    ['ЕДИНЫЙ ПСДЦ  |  КОРПУС 14', '', '', '', 'ПСДЦ, ₽', '', 15783711735.72, '', '', '', 'По фильтру, ₽', '', 15783711735.72, '', '', '', 'КП · справочно, ₽', '', '', 15800053834.52],
    K14_HEADER,
  ]
  for (let i = 0; i < positions; i++) {
    rows.push(['1 · Подземная часть', '1.1 · Земляные работы', `1.1.1.1.${i + 1}`, `В осях: (3.2) - (3.10) / позиция ${i}`, 'комплект', 1, '', 3034661.72, '', 3034661.72, 'ПСДЦ · Позиция', 'Без изменений'])
    rows.push(['1 · Подземная часть', '1.1 · Земляные работы', `└ 580.${i}`, 'Пена монтажная 850мл', 'шт', 10, '', 674.28, '', 6742.79, 'Ресурс · мат', '', '', 6742.79, 0, 674.28, 0, '1.1'])
  }
  rows.push(
    [],
    ['СВЕРКА И ПРАВИЛА ЧТЕНИЯ'],
    ['ПСДЦ: договор №К14 от 25.04.2025, действующая редакция ДС №8 от 24.02.2026. Серым зачёркнуты только подтверждённые прежние значения.'],
    ['Договорный итог, ₽', '', '', '', '', '', '', '', '', 15783711735.72],
    ['Итог КП, ₽', '', '', '', '', '', '', '', '', 15800053834.52],
    ['УЧТЁННЫЕ ИСТОЧНИКИ'],
    ['ДС №4 · 01.10.2025 · Снижение на 16 288 264,28 ₽: фундаментная плита и подземный железобетон'],
  )
  return rows
}

// Объединённые ячейки ALIA записаны в каждую клетку объединения — заголовок повторяется по строке.
const wide = (text) => Array(11).fill(text)

function aliaRows() {
  return [
    wide('ALIA | ЕДИНЫЙ ПСДЦ С ИСТОРИЕЙ ИЗМЕНЕНИЙ'),
    wide('Договор генерального строительного подряда № ДГСП-13АВ от 07.02.2025 · ДС №1–8 · сверка по файлам ALIA на 10.09.2026'),
    wide('Объект: многоквартирные жилые дома со встроенными нежилыми помещениями и подземной автостоянкой.'),
    wide('Суммировать все строки подряд нельзя: в детализации одновременно показаны разделы и их составляющие.'),
    wide('КОНТРОЛЬ ЦЕНЫ ДОГОВОРА'),
    ['Показатель', 'Наименование', '', '', '', 'Сумма, ₽', '', 'Изменение, ₽', 'Основание', 'Источник'],
    ['', 'Работы BQ без НДС', '', '', '', 12759214389.05, '', '', 'ДС №8', 'F074, п.1.1 / приложение 3'],
    ['', 'НДС 20% в составе договорной цены', '', '', '', 590749323.12, '', '', 'ДС №8', 'F074'],
    ['', 'НДС 22% в составе договорной цены', '', '', '', 2157202910.21, '', '', 'ДС №8', 'F074'],
    ['', 'Цена договора с НДС', 'Цена договора с НДС', '', '', 15507166622.38, '', '', 'ДС №8', 'F074, п.1.1 / приложение 3'],
    ['', 'Опцион с НДС — отдельно от цены договора', '', '', '', 23790000, '', '', 'ДС №8', 'F074'],
    wide('Основание актуальной цены: ДС №8, п.1.1; приложение 3, итог с НДС.'),
    wide('ХРОНОЛОГИЯ ПОДПИСАННЫХ РЕДАКЦИЙ И УЧЁТ КАЖДОГО ДС'),
    ['Редакция', 'Содержание', 'Дата', '', 'Цена без НДС, ₽', 'Цена с НДС, ₽', 'НДС, ₽', 'Δ с НДС, ₽', 'Учёт', 'Источник', 'Примечание'],
    ['Договор', 'Исходная цена и приложения 3–3.3', '07.02.2025', '', 12903951999.38, 15484742399.26, 2580790399.88, '', 'Учтено', 'F077'],
    ['ДС №8', 'РД КЖ/ВК, лифты К3–К6', '18.06.2026', '', 12759214389.05, 15507166622.38, 2747952233.33, -10357062.18, 'Учтено', 'F074'],
    wide('3 | РАЗБИВКА СТОИМОСТИ РАБОТ ПО КОМПЛЕКТАМ'),
    ALIA_HEADER,
    ['ПР', 'Проектные работы', '', '', '', 307878140, '', '', 'До ДС3', 'Договор · PDF с. 401; XLSX стр. 10'],
    ['ПР', 'Проектные работы', '', '', '', 342739435.78, '', 2812115.45, 'Актуально · ДС8', 'ДС8 · PDF с. 7; XLSX стр. 11'],
    wide('3.3 | ОСНОВНЫЕ МАТЕРИАЛЫ И ОБОРУДОВАНИЕ'),
    ALIA_HEADER,
    ['1.1', 'Песок средней крупности', 'м3', 1.15, 1083.33, 1300, 1321.66, 0, 'Актуально · ДС8', 'ДС8 · PDF с. 22'],
  ]
}

function workbookBytes(rows, sheet = 'Единый ПСДЦ') {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet)
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer
}

describe('ДГП: паспорт и состав единого ПСДЦ любой раскладки', () => {
  it('STORIES: одна таблица — договор в заголовке, ДС в подзаголовке, актуальная цена, история, части НДС', () => {
    const d = analyzeDgp(storiesRows(), 'Stories.xlsx')
    assert.equal(d.title, 'ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165/9/2024')
    assert.match(d.subtitle, /^Редакция с учётом ДС №1–10/)
    assert.deepEqual(d.contract, { number: '165/9/2024', date: '' })
    assert.deepEqual(d.revision, { from: 1, to: 10 }, '«ДС №6–5» в примечании ниже — не редакция файла')
    assert.equal(d.total, 5932993892.39)
    assert.equal(d.totalLabel, 'Актуальная цена договора')
    assert.deepEqual(d.features, ['history', 'vatSplit'])
    assert.equal(d.recognized, true)
  })

  it('Корпус 14: цена «ПСДЦ, ₽» (не «КП · справочно»), договор и действующая редакция — из конца листа, ДС — из имени', () => {
    const d = analyzeDgp(k14Rows(), 'Единый_ПСДЦ_К14_(ДС 1-14).xlsx')
    assert.equal(d.title, 'ЕДИНЫЙ ПСДЦ | КОРПУС 14')
    assert.equal(d.subtitle, '', 'под заголовком сразу шапка')
    assert.deepEqual(d.contract, { number: 'К14', date: '25.04.2025' })
    assert.deepEqual(d.revision, { from: 1, to: 14 })
    assert.equal(d.priceBasis, 8, 'цена — по ДС №8, хотя учтены ДС 1–14')
    assert.equal(d.total, 15783711735.72)
    assert.equal(d.totalLabel, 'ПСДЦ', 'верх листа важнее «Договорного итога» внизу')
    assert.deepEqual(d.features, ['history', 'matWork', 'resources', 'vatSplit'])
  })

  it('ALIA: несколько таблиц — цена из контроля цены, материалы и работы, основные материалы', () => {
    const d = analyzeDgp(aliaRows(), 'Единый_ПСДЦ ALIA(ДС 1-8).xlsx')
    assert.equal(d.title, 'ALIA | ЕДИНЫЙ ПСДЦ С ИСТОРИЕЙ ИЗМЕНЕНИЙ')
    assert.match(d.subtitle, /^Договор генерального строительного подряда/)
    assert.deepEqual(d.contract, { number: 'ДГСП-13АВ', date: '07.02.2025' })
    assert.deepEqual(d.revision, { from: 1, to: 8 })
    assert.equal(d.priceBasis, null, 'основание цены — тот же ДС №8')
    assert.equal(d.total, 15507166622.38)
    assert.equal(d.totalLabel, 'Цена договора с НДС')
    assert.deepEqual(d.features, ['history', 'matWork', 'mainMaterials', 'vatSplit'])
  })

  it('чужая таблица — не похожа на ПСДЦ (загрузка — после вопроса); пустой лист', () => {
    const other = analyzeDgp([['Смета'], ['Код', 'Наименование', 'Ед. изм.', 'Кол-во'], ['1', 'Бетон', 'м3', 5]], 'Смета.xlsx')
    assert.equal(other.recognized, false)
    assert.equal(other.total, null)
    assert.deepEqual(other.features, [])
    const empty = analyzeDgp([], '')
    assert.equal(empty.title, '')
    assert.equal(empty.recognized, false)
  })

  it('учтённые ДС: диапазон, одно ДС, дата после номера — не диапазон', () => {
    assert.deepEqual(dgpRevisionFromText('Единый_ПСДЦ_К14_(ДС 1-14).xlsx'), { from: 1, to: 14 })
    assert.deepEqual(dgpRevisionFromText('… · ДС №1–8 · сверка'), { from: 1, to: 8 })
    assert.deepEqual(dgpRevisionFromText('ДС№1 - №12'), { from: 1, to: 12 })
    assert.deepEqual(dgpRevisionFromText('Редакция с учётом ДС №7'), { from: null, to: 7 })
    assert.equal(dgpRevisionFromText('ДС №4 - 01.10.2025 · Снижение'), null)
    assert.equal(dgpRevisionFromText('расход средств 1-2'), null)
    assert.equal(dgpRevisionFromText('ДС №6–5'), null, 'конец раньше начала')
    assert.equal(dgpRevisionLabel({ from: 1, to: 8 }), 'ДС №1–8')
    assert.equal(dgpRevisionLabel({ from: null, to: 8 }), 'ДС №8')
    assert.equal(dgpRevisionLabel(null), '')
  })

  it('договор: номер и дата; ключ не зависит от регистра, пробелов и латиницы', () => {
    assert.deepEqual(dgpContractFromText('Договор генерального строительного подряда № ДГСП-13АВ от 07.02.2025 · ДС'), { number: 'ДГСП-13АВ', date: '07.02.2025' })
    assert.deepEqual(dgpContractFromText('ПСДЦ: договор №К14 от 25.04.2025, действующая'), { number: 'К14', date: '25.04.2025' })
    assert.equal(dgpContractFromText('Затраты по условиям договора'), null)
    assert.equal(dgpContractKey('K14'), dgpContractKey('к14'))
    assert.equal(dgpContractKey('ДГСП-13 АВ'), dgpContractKey('дгсп-13AB'))
  })

  it('сумма — только из числовой ячейки: «Цена в тексте ДС№10» — не 10', () => {
    assert.equal(cellNumber('5 932 993 892,39'), 5932993892.39)
    assert.equal(cellNumber('15 783 711 735,72 ₽'), 15783711735.72)
    assert.equal(cellNumber(42), 42)
    assert.equal(cellNumber('Цена в тексте ДС№10'), null)
    assert.equal(cellNumber(''), null)
  })

  it('чтение книги: лист «Единый ПСДЦ» целиком — примечания в конце большого листа находятся', async () => {
    const big = await readDgpWorkbook(workbookBytes(k14Rows(3000)), 'Корпус 14 (ДС 1-14).xlsx')
    assert.deepEqual(big.contract, { number: 'К14', date: '25.04.2025' })
    assert.equal(big.priceBasis, 8)
    assert.equal(big.total, 15783711735.72)
    const alia = await readDgpWorkbook(workbookBytes(aliaRows(), 'Лист1'), 'ALIA.xlsx')
    assert.equal(alia.total, 15507166622.38)
    await assert.rejects(readDgpWorkbook(new TextEncoder().encode('не excel, а текст').buffer), /не читается/)
    await assert.rejects(readDgpWorkbook(new ArrayBuffer(0)), /не читается/)
  })

  it('паспорт в notes: туда и обратно; прежние notes (v1) — редакция из имени файла', () => {
    const info = analyzeDgp(k14Rows(), 'К14 (ДС 1-14).xlsx')
    const back = describeDgpDoc({ notes: dgpNotes(info), file_name: 'К14 (ДС 1-14).xlsx' })
    assert.deepEqual(back, {
      title: info.title, subtitle: '', contract: info.contract, revision: info.revision, priceBasis: 8,
      total: info.total, totalLabel: 'ПСДЦ', features: info.features,
    })
    assert.equal(parseDgpNotes(dgpNotes(info)).v, 2)
    const legacy = describeDgpDoc({
      file_name: 'Stories (ДС 1-10).xlsx',
      notes: JSON.stringify({ v: 1, title: 'ЕДИНЫЙ ПСДЦ', subtitle: '', total: 1.5, totalLabel: 'ПСДЦ', detected: true }),
    })
    assert.equal(legacy.total, 1.5)
    assert.deepEqual(legacy.revision, { from: 1, to: 10 })
    assert.deepEqual(legacy.features, [])
    assert.equal(parseDgpNotes('просто текст'), null)
    assert.equal(describeDgpDoc({ file_name: 'x.xlsx', notes: null }).title, '')
  })

  it('порядок: прежняя редакция того же договора — вниз с пометкой; без договора не сравнивается', () => {
    const doc = (id, created, info, fileName = `${id}.xlsx`) => ({ id, file_name: fileName, created_at: created, notes: dgpNotes(info) })
    const k14 = (to) => ({ title: 'К14', contract: { number: 'K14', date: '' }, revision: { from: 1, to }, features: [] })
    const old = doc('old', '2026-10-27T10:00:00Z', k14(8))
    const fresh = doc('new', '2026-10-01T10:00:00Z', k14(14))
    const other = doc('alia', '2026-10-20T10:00:00Z', { title: 'ALIA', contract: { number: 'ДГСП-13АВ', date: '' }, revision: { from: 1, to: 8 } })
    const loose = doc('loose', '2026-10-25T10:00:00Z', { title: 'Без договора', revision: { from: 1, to: 2 } })
    const items = orderDgpDocs([old, fresh, other, loose])
    assert.deepEqual(items.map(i => i.doc.id), ['loose', 'alia', 'new', 'old'])
    assert.equal(items.find(i => i.doc.id === 'old').newer.revision.to, 14, '«K14» латиницей = «К14»')
    assert.equal(items.filter(i => i.newer).length, 1)
  })

  it('заменяет только файл с тем же именем', () => {
    const docs = [{ id: 1, file_name: 'ДГП К14.xlsx' }, { id: 2, file_name: 'ALIA.xlsx' }]
    assert.deepEqual(dgpReplaced(' дгп к14.XLSX ', docs).map(d => d.id), [1])
    assert.deepEqual(dgpReplaced('Новый.xlsx', docs), [])
  })
})
