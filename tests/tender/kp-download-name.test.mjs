// «Проверка КП»: имя скачиваемого файла КП (src/utils/kpDownloadName.js) —
// «№ тендера_контрагент_тендер_объект.расширение», допустимое в Windows.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { kpDownloadName, KP_PART_MAX } from '../../src/utils/kpDownloadName.js'

function row({ number = 125, cp = 'ООО Ромашка', works = 'Устройство кровли', object = 'ЖК Север', file = 'КП финал.xlsx' } = {}) {
  return {
    s3: file == null ? null : { file_name: file },
    counterparties: cp == null ? null : { name: cp },
    tenders: { public_tender_number: number, work_description: works, objects: object == null ? null : { name: object } },
  }
}

describe('Проверка КП: имя скачиваемого файла', () => {
  it('порядок: номер тендера, контрагент, тендер, объект; расширение исходного файла', () => {
    assert.equal(kpDownloadName(row()), '125_ООО Ромашка_Устройство кровли_ЖК Север.xlsx')
    assert.equal(kpDownloadName(row({ file: 'scan.PDF' })), '125_ООО Ромашка_Устройство кровли_ЖК Север.PDF')
  })

  it('пустые части пропускает, без лишних разделителей', () => {
    assert.equal(kpDownloadName(row({ number: null, object: null })), 'ООО Ромашка_Устройство кровли.xlsx')
    assert.equal(kpDownloadName(row({ cp: '   ', works: '' })), '125_ЖК Север.xlsx')
    assert.equal(kpDownloadName(row({ number: 0 })), '0_ООО Ромашка_Устройство кровли_ЖК Север.xlsx')
  })

  it('без данных тендера — исходное имя файла', () => {
    assert.equal(kpDownloadName(row({ number: null, cp: null, works: null, object: null })), 'КП финал.xlsx')
    assert.equal(kpDownloadName({}), 'КП')
  })

  it('файл без расширения — имя без расширения', () => {
    assert.equal(kpDownloadName(row({ file: 'предложение' })), '125_ООО Ромашка_Устройство кровли_ЖК Север')
  })

  it('убирает запрещённые в Windows знаки и кавычки', () => {
    const name = kpDownloadName(row({ cp: 'ООО "СК / Альфа"', works: 'Окна: ПВХ*', object: 'ЖК <Север>?' }))
    assert.equal(name, "125_ООО 'СК Альфа'_Окна ПВХ_ЖК Север.xlsx")
    assert.doesNotMatch(name, /[\\/:*?"<>|]/)
  })

  it('длинные части режет, имя укладывается в предел пути Windows', () => {
    const long = 'Устройство монолитных железобетонных конструкций подземной и надземной части здания '.repeat(3)
    const name = kpDownloadName(row({ cp: long, works: long, object: long }))
    const parts = name.replace(/\.xlsx$/, '').split('_')
    assert.equal(parts.length, 4)
    assert.ok(parts[1].length <= KP_PART_MAX.counterparty, parts[1])
    assert.ok(parts[2].length <= KP_PART_MAX.tender, parts[2])
    assert.ok(parts[3].length <= KP_PART_MAX.object, parts[3])
    assert.ok(name.length <= 180, String(name.length))
    assert.ok(name.endsWith('.xlsx'))
  })
})
