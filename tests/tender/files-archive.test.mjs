// «Скачать всё» в разделе «Участники» карточки тендера (src/utils/tenderFilesArchive.js):
// имена, допустимые в Windows, раскладка по папкам компаний и сборка ZIP с подставной загрузкой.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import PizZipNs from 'pizzip'
import {
  safeName, safeFileName, uniqueName, archiveBaseName, planTenderArchive, buildTenderArchive,
  ARCHIVE_NAME_MAX, ENTRY_PATH_MAX, OLDER_VERSIONS_FOLDER, FAILED_LIST_NAME,
} from '../../src/utils/tenderFilesArchive.js'

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default
const bytesOf = (text) => new TextEncoder().encode(text)

let seq = 0
function fileRow(counterpartyId, fileName, { kind = 'attachment', group = null, label = null, at = '2026-10-01T10:00:00Z', key, size = 10 } = {}) {
  seq++
  return {
    id: `f${String(seq).padStart(3, '0')}`,
    counterparty_id: counterpartyId,
    file_kind: kind,
    proposal_group_id: group,
    version_label: label,
    created_at: at,
    s3: { s3_key: key ?? `tenders/t1/${seq}-${fileName}`, file_name: fileName, size_bytes: size },
  }
}

describe('Скачать всё: имена', () => {
  it('убирает запрещённые в Windows знаки, кавычки заменяет, точки в конце снимает', () => {
    assert.equal(safeName('ООО "Ромашка" / филиал: №2*?'), "ООО 'Ромашка' филиал №2")
    assert.equal(safeName('ИП Иванов И.И.'), 'ИП Иванов И.И')
    assert.equal(safeName('строка\u0000с\tуправляющими\nзнаками'), 'строка с управляющими знаками')
    assert.equal(safeName('  ...  '), 'Без названия')
    assert.equal(safeName('CON'), '_CON')
    assert.equal(safeFileName('nul.txt'), '_nul.txt')
  })

  it('длинное имя режет по слову с «…», у файла сохраняет расширение', () => {
    const cut = safeName('Устройство монолитных железобетонных конструкций подземной части', { max: 40 })
    assert.ok(cut.length <= 40, cut)
    assert.ok(cut.endsWith('…'), cut)
    assert.ok(!/\s…$/.test(cut), cut)
    const file = safeFileName(`${'Коммерческое предложение '.repeat(6)}.xlsx`, 50)
    assert.ok(file.length <= 50, file)
    assert.ok(file.endsWith('….xlsx'), file)
  })

  it('совпадения — « (2)», без учёта регистра, у файла — перед расширением', () => {
    const used = new Set()
    assert.equal(uniqueName('КП.xlsx', used, { isFile: true }), 'КП.xlsx')
    assert.equal(uniqueName('кп.XLSX', used, { isFile: true }), 'кп (2).XLSX')
    assert.equal(uniqueName('КП.xlsx', used, { isFile: true }), 'КП (3).xlsx')
    const folders = new Set()
    assert.equal(uniqueName('ООО Альфа', folders), 'ООО Альфа')
    assert.equal(uniqueName('ООО Альфа', folders), 'ООО Альфа (2)')
  })

  it('имя архива: номер тендера, затем выполняемые работы; без работ — объект', () => {
    assert.equal(archiveBaseName({ public_tender_number: 125, work_description: 'Устройство кровли' }), '125 Устройство кровли')
    assert.equal(archiveBaseName({ public_tender_number: 7, work_description: '  ' }, 'ЖК Север'), '7 ЖК Север')
    assert.equal(archiveBaseName({ public_tender_number: null, work_description: 'Фасад' }), 'Фасад')
    const long = archiveBaseName({ public_tender_number: 300, work_description: 'Выполнение работ '.repeat(20) })
    assert.ok(long.startsWith('300 Выполнение работ'), long)
    assert.ok(long.length <= ARCHIVE_NAME_MAX, long)
  })
})

describe('Скачать всё: раскладка по папкам', () => {
  const participants = [
    { counterpartyId: 'c1', name: 'ООО "Альфа"' },
    { counterpartyId: 'c2', name: 'ИП Без файлов' },
    { counterpartyId: 'c3', name: 'ООО "Альфа"' },
  ]
  const rows = [
    fileRow('c1', 'КП.xlsx', { kind: 'commercial_proposal', group: 'g1', at: '2026-10-01T10:00:00Z', label: 'первая' }),
    fileRow('c1', 'КП.xlsx', { kind: 'commercial_proposal', group: 'g1', at: '2026-10-05T10:00:00Z' }),
    fileRow('c1', 'КП.xlsx', { kind: 'commercial_proposal', group: 'g1', at: '2026-10-03T10:00:00Z' }),
    fileRow('c1', 'Выписка.pdf', { size: 2000 }),
    fileRow('c3', 'КП.xlsx', { kind: 'commercial_proposal', group: 'g9' }),
    fileRow('c9', 'Чужой.pdf'),
  ]
  const { entries, totalBytes } = planTenderArchive(rows, participants)
  const paths = entries.map((e) => e.path)

  it('папка на компанию; одинаковые названия различаются, участник без файлов — без папки', () => {
    assert.deepEqual(paths, [
      "ООО 'Альфа'/КП.xlsx",
      "ООО 'Альфа'/Выписка.pdf",
      `ООО 'Альфа'/${OLDER_VERSIONS_FOLDER}/КП.xlsx`,
      `ООО 'Альфа'/${OLDER_VERSIONS_FOLDER}/КП (первая).xlsx`,
      "ООО 'Альфа' (2)/КП.xlsx",
    ])
  })

  it('текущая версия КП — самая новая, прежние уходят в подпапку', () => {
    const current = entries.find((e) => e.path === "ООО 'Альфа'/КП.xlsx")
    assert.equal(current.createdAt, '2026-10-05T10:00:00Z')
  })

  it('файлы тех, кого нет среди участников, не попадают; размер — сумма файлов архива', () => {
    assert.ok(!paths.some((p) => p.includes('Чужой')))
    assert.equal(totalBytes, 10 * 4 + 2000)
  })

  it('путь внутри архива не длиннее предела даже у длинных названий', () => {
    const { entries: longEntries } = planTenderArchive(
      [fileRow('x', `${'Очень длинное имя файла '.repeat(10)}.pdf`, { kind: 'commercial_proposal', group: 'gx', at: '2026-01-01T00:00:00Z' }),
        fileRow('x', 'новое.pdf', { kind: 'commercial_proposal', group: 'gx', at: '2026-02-01T00:00:00Z' })],
      [{ counterpartyId: 'x', name: 'Общество с ограниченной ответственностью '.repeat(4) }],
    )
    for (const e of longEntries) assert.ok(e.path.length <= ENTRY_PATH_MAX, `${e.path.length}: ${e.path}`)
  })
})

describe('Скачать всё: сборка архива', () => {
  const participants = [{ counterpartyId: 'c1', name: 'ООО Альфа' }, { counterpartyId: 'c2', name: 'ИП Петров' }]

  it('архив содержит файлы с кириллическими путями и их содержимое', async () => {
    const rows = [fileRow('c1', 'КП Альфа.xlsx', { kind: 'commercial_proposal', group: 'a' }), fileRow('c2', 'Смета.pdf')]
    const { entries } = planTenderArchive(rows, participants)
    const progress = []
    const { bytes, added, failed } = await buildTenderArchive(
      entries,
      async (entry) => bytesOf(`содержимое ${entry.fileName}`),
      { onProgress: (p) => progress.push(p) },
    )
    assert.equal(added, 2)
    assert.deepEqual(failed, [])
    const zip = new PizZip(bytes)
    const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort()
    assert.deepEqual(files, ['ИП Петров/Смета.pdf', 'ООО Альфа/КП Альфа.xlsx'])
    assert.equal(zip.file('ООО Альфа/КП Альфа.xlsx').asText(), 'содержимое КП Альфа.xlsx')
    assert.ok(zip.files['ООО Альфа/'].dir, 'папка компании — отдельная запись')
    assert.deepEqual(progress.at(-1), { done: 2, total: 2 })
  })

  it('сбой — один повтор; не скачанный файл — в «Не скачано.txt», архив сохраняется', async () => {
    const rows = [
      fileRow('c1', 'Скачается со второго раза.pdf', { key: 'k-flaky' }),
      fileRow('c1', 'Не скачается.pdf', { key: 'k-broken' }),
      fileRow('c2', 'Нормальный.pdf', { key: 'k-ok' }),
    ]
    const { entries } = planTenderArchive(rows, participants)
    const calls = new Map()
    const { bytes, added, failed } = await buildTenderArchive(entries, async (entry) => {
      const n = (calls.get(entry.s3Key) || 0) + 1
      calls.set(entry.s3Key, n)
      if (entry.s3Key === 'k-broken') throw new Error('хранилище ответило 403')
      if (entry.s3Key === 'k-flaky' && n === 1) throw new Error('сеть')
      return bytesOf(entry.fileName)
    }, { retryDelayMs: 0 })
    assert.equal(calls.get('k-flaky'), 2)
    assert.equal(calls.get('k-broken'), 2, 'повтор ровно один')
    assert.equal(added, 2)
    assert.equal(failed.length, 1)
    const zip = new PizZip(bytes)
    assert.ok(zip.file('ООО Альфа/Скачается со второго раза.pdf'))
    assert.equal(zip.file('ООО Альфа/Не скачается.pdf'), null)
    const list = zip.file(FAILED_LIST_NAME).asText()
    assert.match(list, /ООО Альфа — Не скачается\.pdf: хранилище ответило 403/)
  })

  it('файл без записи в хранилище — в списке пропусков без запроса; ничего не скачалось — архива нет', async () => {
    const rows = [fileRow('c1', 'Потерянный.pdf', { key: null })]
    rows[0].s3.s3_key = null
    const { entries } = planTenderArchive(rows, participants)
    let fetched = 0
    const result = await buildTenderArchive(entries, async () => { fetched++; return bytesOf('x') }, { retryDelayMs: 0 })
    assert.equal(fetched, 0)
    assert.equal(result.bytes, null)
    assert.equal(result.added, 0)
    assert.match(result.failed[0].error, /не найден/)
  })

  it('одновременно идёт не больше concurrency загрузок', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => fileRow('c1', `Файл ${i}.pdf`))
    const { entries } = planTenderArchive(rows, participants)
    let active = 0
    let maxActive = 0
    await buildTenderArchive(entries, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return bytesOf('x')
    }, { concurrency: 3 })
    assert.equal(maxActive, 3)
  })
})
