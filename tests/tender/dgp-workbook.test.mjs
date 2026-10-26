// ДГП объекта (вкладка «Смета»): вид файла — комплектный или полный — по шапке единого ПСДЦ.
// Книги собираются здесь по образцу настоящих файлов: комплектный — «ЖК STORIES, договор №165/9/2024»
// (шапка в 9-й строке, над ней «Актуальная цена договора»), полный — «Корпус 14» (шапка во 2-й строке,
// в первой — «ПСДЦ, ₽» и «КП · справочно»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  cellNumber, detectDgp, dgpKindOfCategory, dgpNotes, parseDgpNotes, planDgpUpload, readDgpWorkbook,
} from '../../src/utils/dgpWorkbook.js'

const COMPACT_HEADER = ['Раздел', '№ позиции', 'Наименование работы / затрат', 'Период / НДС', 'Ед. изм', 'Объём',
  'Цена за ед., ₽', 'Прежн., ₽', 'Актуально, ₽', 'Изменение, ₽', 'Статус', 'Основание', 'Дата основания',
  'Что фактически изменилось', 'Подраздел / место работ', 'Источник', 'Тип строки', 'В итог фильтра, ₽']

const FULL_HEADER = ['Раздел', 'Подраздел', 'Код позиции', 'Наименование работ и затрат', 'Ед. изм', 'Количество',
  'Прежняя цена, ₽', 'Цена, ₽ с НДС', 'Прежняя стоимость, ₽', 'Стоимость, ₽ с НДС', 'Тип строки', 'Изменение',
  'Основание / состав', 'Материалы КП, ₽', 'Работы КП, ₽', 'Материалы за ед., ₽', 'Работы за ед., ₽', 'Связь с ПСДЦ',
  'Источник / строка', 'Проверка источника', 'В итог ПСДЦ, ₽', 'В итог КП, ₽', 'Часть 20%, ₽', 'Часть 22%, ₽',
  'Кол-во 20%', 'Кол-во 22%', 'UID КП', 'Вид ресурса', 'Норма расхода', 'Базовый объём', 'Базовая цена мат., ₽',
  'Базовая цена работ, ₽', 'Прямые затраты, ₽', 'Производитель / марка', 'НДС / примечание источника']

function compactRows() {
  return [
    ['ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165/9/2024'],
    ['Редакция с учётом ДС №1–10 · один лист · 2 438 конечных позиций · суммы в рублях с НДС'],
    ['АКТУАЛЬНАЯ ЦЕНА ДОГОВОРА', '', '', '', '', '', 5932993892.39, 'До 2026 года · 20%', '', '', 3136337907.52, 'С 2026 года · 22%', '', '', '', '', '', 2796655984.87],
    ['СУММА ПО ТЕКУЩЕМУ ФИЛЬТРУ', '', '', '', '', '', '5 932 993 892,39', 'Цена в тексте ДС№10', '', '', '5 932 993 892,39', 'Контроль: сходимость с ДС№10'],
    ['ФИЛЬТРЫ: «Раздел» — навигация; «Статус» — изменения; «Основание» — нужное ДС; «Период» — НДС.'],
    ['Серая зачёркнутая — только заменённая сумма. Зелёный — добавлено.'],
    ['В старых источниках есть расхождения (ДС №6–5). Итог ДС№10 подтверждён детализацией позиций.'],
    ['Разделы и группы собраны по номенклатуре.'],
    COMPACT_HEADER,
    ['1 · Подготовительный период', '1', 'Подготовительный период', '', '', '', '', '', 107286677.85],
    ['1 · Подготовительный период', '1.1.1.1', 'Монтаж помещений разного назначения с подключением (имс)', 'До 2026 · 20%', 'комплект', 6, 3878572.5, '', 23271435, '', 'Действующая позиция'],
  ]
}

function fullRows() {
  return [
    ['ЕДИНЫЙ ПСДЦ  |  КОРПУС 14', '', '', '', 'ПСДЦ, ₽', '', 15783711735.72, 'По фильтру, ₽', '', '', 15783711735.72, 'КП · справочно, ₽', '', '', 15800053834.52],
    FULL_HEADER,
    ['2 · Надземная часть', '2.6 · Заполнение проёмов', 'КП 2.6.1.40', 'Люк скрытого типа под чистовую отделку, 800х800, однопольный', 'шт', 7, '', 56023.01, '', 392161.08, 'КП · Позиция'],
    ['2 · Надземная часть', '2.6 · Заполнение проёмов', '└ 580.2', 'Пена монтажная 850мл', 'шт', 10, '', 674.28, '', 6742.79, 'Ресурс · мат'],
  ]
}

function workbookBytes(rows, sheet = 'Единый ПСДЦ') {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet)
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer
}

describe('ДГП: вид файла по шапке единого ПСДЦ', () => {
  it('комплектный: шапка в 9-й строке, заголовок, подзаголовок и актуальная цена договора', () => {
    const d = detectDgp(compactRows())
    assert.equal(d.kind, 'compact')
    assert.equal(d.headerRow, 8)
    assert.equal(d.title, 'ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165/9/2024')
    assert.match(d.subtitle, /^Редакция с учётом ДС №1–10/)
    assert.equal(d.total, 5932993892.39)
    assert.equal(d.totalLabel, 'Актуальная цена договора')
    assert.ok(d.scores.compact >= 5 && d.scores.full <= 1, JSON.stringify(d.scores))
  })

  it('полный: шапка во 2-й строке, сумма — «ПСДЦ, ₽», а не «КП · справочно»', () => {
    const d = detectDgp(fullRows())
    assert.equal(d.kind, 'full')
    assert.equal(d.headerRow, 1)
    assert.equal(d.title, 'ЕДИНЫЙ ПСДЦ  |  КОРПУС 14')
    assert.equal(d.subtitle, '')
    assert.equal(d.total, 15783711735.72)
    assert.equal(d.totalLabel, 'ПСДЦ')
    assert.ok(d.scores.full >= 10 && d.scores.compact <= 1, JSON.stringify(d.scores))
  })

  it('чужая таблица — вид не определён (выбирает человек)', () => {
    assert.equal(detectDgp([['Смета'], ['Код', 'Наименование', 'Ед. изм.', 'Кол-во']]).kind, null)
    assert.equal(detectDgp([]).kind, null)
  })

  it('сумма — только из числовой ячейки: «Цена в тексте ДС№10» — не 10', () => {
    assert.equal(cellNumber('5 932 993 892,39'), 5932993892.39)
    assert.equal(cellNumber('15 783 711 735,72 ₽'), 15783711735.72)
    assert.equal(cellNumber(42), 42)
    assert.equal(cellNumber('Цена в тексте ДС№10'), null)
    assert.equal(cellNumber(''), null)
  })

  it('чтение книги: лист «Единый ПСДЦ», только первые строки', async () => {
    const many = [...fullRows()]
    for (let i = 0; i < 5000; i++) many.push(['2 · Надземная часть', '2.7', `КП 2.7.${i}`, `Позиция ${i}`, 'шт', 1, '', 1, '', 1, 'КП · Позиция'])
    const full = await readDgpWorkbook(workbookBytes(many))
    assert.equal(full.kind, 'full')
    assert.equal(full.total, 15783711735.72)
    const compact = await readDgpWorkbook(workbookBytes(compactRows(), 'Лист1'))
    assert.equal(compact.kind, 'compact')
    await assert.rejects(readDgpWorkbook(new TextEncoder().encode('не excel, а текст').buffer), /не читается/)
    await assert.rejects(readDgpWorkbook(new ArrayBuffer(0)), /не читается/)
  })

  it('куда класть выбранные файлы', () => {
    assert.deepEqual(planDgpUpload([{ kind: 'full' }]), { assign: ['full'], ok: true })
    assert.deepEqual(planDgpUpload([{ kind: 'compact' }, { kind: 'full' }]), { assign: ['compact', 'full'], ok: true })
    // Два одного вида — спросить.
    assert.equal(planDgpUpload([{ kind: 'full' }, { kind: 'full' }]).ok, false)
    // Один не определился — ему оставшийся вид, но спросить.
    assert.deepEqual(planDgpUpload([{ kind: null }, { kind: 'full' }]), { assign: ['compact', 'full'], ok: false })
    assert.deepEqual(planDgpUpload([{ kind: null }]), { assign: [null], ok: false })
    assert.equal(planDgpUpload([{ kind: 'full' }, { kind: 'compact' }, { kind: 'full' }]).ok, false)
  })

  it('сводка в notes: туда и обратно; категории', () => {
    const notes = dgpNotes({ title: 'ЕДИНЫЙ ПСДЦ', subtitle: '', total: 1.5, totalLabel: 'ПСДЦ', detected: true })
    assert.deepEqual(parseDgpNotes(notes), { v: 1, title: 'ЕДИНЫЙ ПСДЦ', subtitle: '', total: 1.5, totalLabel: 'ПСДЦ', detected: true })
    assert.equal(parseDgpNotes('просто текст'), null)
    assert.equal(parseDgpNotes(null), null)
    assert.equal(dgpKindOfCategory('dgp_compact'), 'compact')
    assert.equal(dgpKindOfCategory('dgp_full'), 'full')
    assert.equal(dgpKindOfCategory('general'), null)
  })
})
