// Журнал ручных сопоставлений (27.11.2026, просьба пользователя: «лог, по которому ты улучшаешь сопоставление: что ты не различил, а я
// проставил вручную»). Решения человека лежат при файлах счетов (notes: k / ka / kn), выгрузка — scripts/supply-match-log.sh, разбор —
// scripts/supply-match-review.mjs. Здесь — корпус: решения, которые алгоритм уже повторяет, не должны потеряться при следующей правке
// похожести (src/utils/supplyDocMatch.js); новые решения из журнала дописываются сюда после разбора (порядок —
// docs/claude-reference/supply-pricing.md, «Журнал ручных сопоставлений»). Наименования — как в документах, без цен.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTO_MIN, MATCH_CANDIDATES, expandName, itemCandidates, matchIndex, positionGroups } from '../../src/utils/supplyDocMatch.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const corpus = (file) => JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures', file), 'utf8'))
const groupsOf = (positions) => positionGroups([{ name: 'ВОР', positions: positions.map((p) => ({ ...p, k: normName(p.name) })) }])
const candidates = (groups, index, name, unit) => itemCandidates({ name, unit, price: 1 }, groups, index, MATCH_CANDIDATES, { packs: true })

describe('корпус ручных сопоставлений: тендер № 1157 (КП «Металлсервиса», двери и ворота КП 116)', () => {
  const fx = corpus('match-corpus-1157.json')
  const groups = groupsOf(fx.positions)
  const index = matchIndex(groups)

  for (const d of fx.decisions) {
    it(`${d.expect}: «${d.line.slice(0, 60)}» = «${d.position.slice(0, 40)}»`, () => {
      const list = candidates(groups, index, d.line, d.lineUnit)
      const at = list.findIndex((c) => c.group.name === d.position)
      if (d.expect === 'listed') assert.ok(at >= 0, 'позиция есть в списке выбора')
      else assert.equal(at, 0, `первой; первая сейчас — «${list[0]?.group.name}» ${list[0]?.score}`)
      if (d.expect === 'auto') assert.ok(list[0].score >= AUTO_MIN, `ставится сама: ${list[0].score}`)
    })
  }

  it('марка решает: строка «Д-1» — не позиции «Д-2», хотя размеры у КП свои', () => {
    const list = candidates(groups, index, 'Дверь металлическая ГОСТ 57327-2016 ДП-02( EI -60) 2570*1100 R 1020 7021 Марк. Д-1', 'Шт')
    assert.match(list[0].group.name, /^Д-1\./)
    const d2 = list.find((c) => /^Д-2\./.test(c.group.name))
    assert.ok(!d2 || d2.score < AUTO_MIN, 'позиция с другой маркой сама не выбирается')
  })

  // Как те же строки читает распознавание с 27.11.2026 (своё увеличение мелкой картинки, правка наименований): ставятся сами.
  for (const [line, position] of [
    ['уголок неравнополочный ГОСТ 8510 Ст3пс/сп5 63х40х5 дл 12м (Северсталь)', 'Уголок 63*40*5 (м/п=3,91 кг)'],
    ['швеллер ГОСТ 8240/ТУ Ст3пс/сп5 16П дл 12м (ПромСорт Тула)', 'Швеллер 16П ГОСТ 8240-97 (м/п=14,2 кг)'],
    ['полоса г/к норм точн Б ГОСТ 103-2006 Ст3сп2 6х100 дл. 6м (Ижсталь)', 'Полоса 100*6 ГОСТ 103-2006 (м/п=4,71 кг)'],
    ['трубы электросварные квадрат 50х3 6м ГОСТ дл.6000 ГОСТ13663-86', 'Труба профильная 50*50*3 ГОСТ 8639-82 (м/п=4,25 кг)'],
  ]) {
    it(`чистое чтение скана: «${line.slice(0, 50)}» — сама`, () => {
      const list = candidates(groups, index, line, 'т')
      assert.equal(list[0]?.group.name, position)
      assert.ok(list[0].score >= AUTO_MIN, String(list[0].score))
    })
  }
})

describe('металлопрокат: записи металлобаз и смет', () => {
  it('масса метра, марка стали и длина проката — не признак позиции; сокращения — словами', () => {
    assert.equal(expandName('Уголок 50*50*5 ГОСТ 8509-93 (м/п=3,77 кг)').trim(), 'Уголок 50*50*5 ГОСТ 8509-93')
    assert.match(expandName('угл р/пол ГОСТ 8509 Ст3пс/сп5 50х5 дл 12м'), /^уголок равнополочный ГОСТ 8509\s+50×50×5\s*$/)
    assert.match(expandName('уголок неравнополочный 63х40х5'), /63х40х5/, 'неравнополочный — как есть')
    assert.match(expandName('лист г/к Ст3пс/сп5 5х1500х3000'), /5 5×1500×3000/, 'толщина листа — отдельным числом')
    assert.match(expandName('сетка стальная сварная ТУ 200х4х2000х6000'), /200×200×4 2000×6000/, 'ячейка — квадратом, «ТУ» перед размером убрано')
  })

  it('то, что размером не является, не трогаем', () => {
    assert.equal(expandName('Шуруп дл 50мм'), 'Шуруп дл 50мм', 'длина шурупа — размер')
    assert.equal(expandName('Проволока ст 2мм'), 'Проволока ст 2мм')
    assert.equal(expandName('Сетка рабица 50х50х2'), 'Сетка рабица 50х50х2')
    assert.equal(expandName('Клапан Воздушный (Пр) 300×200, L=250 (ст. 0,5) Галвент'), 'Клапан Воздушный (Пр) 300×200, L=250 (ст. 0,5) Галвент')
  })
})
