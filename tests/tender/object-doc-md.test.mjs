// Карточка объекта → «Документы»: маленький столбец «.md» справа от «Подписанный» (миграция 20261202), Chromium — стенд:
//   • у каждого документа (договор, ДС, приложения любого уровня): крестик и «.md» — файла нет, зелёная галочка — есть;
//   • один файл на документ: загрузка, замена (прежний удаляется после привязки нового), удаление, скачивание;
//   • только .md, пустой файл не принимается; не привязалось — загруженный файл убран, прежний на месте;
//   • удаление документа убирает и его .md; без права правки — только отметка и скачивание;
//   • миграции нет — столбца нет, карточка как раньше;
//   • «Скачать все» над столбцом: все файлы .md объекта одним ZIP, шириной с колонку, одна кнопка на объект.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import PizZipNs from 'pizzip'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { objectMdArchiveName, planObjectMdArchive } from '../../src/utils/objectMdArchive.js'

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')

const MD_FILE = {
  id: 'md-ds', owner_type: 'object', owner_id: 'o-1', s3_key: 'objects/o-1/md-ds-ДС 1.md', file_name: 'ДС 1.md',
  mime_type: 'text/markdown', size_bytes: 12, doc_category: 'object_doc_md', created_at: '2026-11-01T09:00:00Z',
}
const docRow = (id, extra) => ({
  id, object_id: 'o-1', parent_document_id: null, document_type: 'attachment', name: id, document_number: null, document_date: null,
  notes: null, order_number: 0, created_at: '2026-10-01T09:00:00Z', signed: null, editable: null, md: null, md_s3_document_id: null, ...extra,
})
const DOCS = [
  docRow('gc', { document_type: 'general_contract', name: 'Договор генподряда', document_number: 'ГП-7' }),
  docRow('gc-att', { parent_document_id: 'gc', name: 'Приложение к договору', document_number: 'Прил. 1' }),
  docRow('gc-att-att', { parent_document_id: 'gc-att', name: 'Приложение к приложению', document_number: 'Прил. 1.1' }),
  docRow('ds', { document_type: 'additional_agreement', name: 'ДС № 1', md: MD_FILE, md_s3_document_id: MD_FILE.id }),
  docRow('ds-att', { parent_document_id: 'ds', name: 'Приложение к ДС', document_number: 'Прил. 2' }),
]
const md = (name, text = '# Документ\n') => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

describe('файл .md документа объекта: миграция и места загрузки', () => {
  it('связь — как у подписанного файла, в обеих базах; проверки и откат на месте', () => {
    for (const f of ['supabase/migrations/20261202_object_documents_md.sql', 'migration/yandex/20261202_object_documents_md.sql']) {
      assert.match(read(f), /ADD COLUMN IF NOT EXISTS md_s3_document_id uuid REFERENCES public\.s3_documents\(id\) ON DELETE SET NULL/, f)
    }
    for (const f of ['migration/yandex/20261202_object_documents_md.check.sql', 'migration/backup/checks/20261202.sql']) {
      assert.match(read(f), /md_s3_document_id/, f)
    }
    assert.match(read('migration/rollback/20261202_object_documents_md_rollback.sql'), /DROP COLUMN IF EXISTS md_s3_document_id/)
    assert.match(read('tests/db/baseline/candidate-migrations.txt'), /^20261202_object_documents_md\.sql$/m)
  })

  it('категория файла не забирает чужое право: как у прочих файлов объекта — правка «Объектов»', () => {
    const presign = read('server/osp-api/src/routes/s3Presign.js')
    assert.doesNotMatch(presign, /object_doc_md/)
    assert.match(presign, /objects: \[\['objects', 'edit'\]\]/)
  })
})

describe('«Скачать все» .md: состав и имена архива', () => {
  const file = (file_name, extra) => ({ file_name, s3_key: `k/${file_name}`, size_bytes: 5, created_at: '2026-11-01T09:00:00Z', ...extra })

  it('только документы с файлом; имена исходные, совпадения — «(2)», без учёта регистра', () => {
    const { entries } = planObjectMdArchive([
      { name: 'Договор', md: file('Договор.md') },
      { name: 'Без файла', md: null },
      { name: 'ДС 1', md: file('ДОГОВОР.md') },
      { document_number: 'Прил. 2', md: file('а/б:в.md') },
    ])
    assert.deepEqual(entries.map((e) => e.path), ['Договор.md', 'ДОГОВОР (2).md', 'а б в.md'])
    assert.deepEqual(entries.map((e) => e.section), ['Договор', 'ДС 1', 'Прил. 2'], 'подпись строки в «Не скачано.txt»')
    assert.equal(entries[1].s3Key, 'k/ДОГОВОР.md')
    assert.deepEqual(planObjectMdArchive(null).entries, [])
  })

  it('имя архива — по объекту, хвост не обрезается, запретные для Windows знаки убраны', () => {
    assert.equal(objectMdArchiveName('ЖК "Южный": корпус 1/2'), "ЖК 'Южный' корпус 1 2 — файлы md")
    assert.equal(objectMdArchiveName(''), 'Объект — файлы md')
    const long = objectMdArchiveName('Очень длинное название объекта '.repeat(10))
    assert.ok(long.length <= 100, long)
    assert.ok(long.endsWith(' — файлы md'), long)
  })
})

const launch = browserLaunchOptions()

describe('столбец «.md» в «Документах» карточки объекта', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function open({ query = '', missing = false, docs = DOCS, viewport = { width: 1400, height: 900 } } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/cost-plans&latency=0${query}`)
    await page.locator('.cost-plans-page .cp-table').first().waitFor({ timeout: 120000 })
    await page.evaluate(([docs, file, noColumn]) => {
      const db = window.__fakeDb
      db.objects = [...db.objects, { id: 'o-1', name: 'ЖК Южный', status: 'main_construction' }]
      db.object_documents = docs
      db.s3_documents.push(file)
      window.__fakeFiles = { ...(window.__fakeFiles || {}), [file.s3_key]: 'data:text/markdown;base64,IyDQlNChIDEK' }
      if (noColumn) window.__fakeMissingEmbeds = { object_documents: ['md_s3_document_id'] }
      // Как в базе: выборка встраивает файл по колонке связи; удалили строку файла — связь обнуляется (ON DELETE SET NULL).
      window.__fakeTriggers = {
        ...window.__fakeTriggers,
        object_documents: (row) => { row.md = window.__fakeDb.s3_documents.find((f) => f.id === row.md_s3_document_id) || null },
      }
      window.__fakeAfter = {
        ...window.__fakeAfter,
        s3_documents: (op, _row, old) => {
          if (op !== 'delete') return
          for (const d of window.__fakeDb.object_documents) if (d.md_s3_document_id === old.id) { d.md_s3_document_id = null; d.md = null }
        },
      }
      for (const t of ['objects', 'object_documents', 's3_documents']) window.__fakeTouch(t)
      window.__navigate('/general/objects/o-1?tab=documents')
    }, [docs, MD_FILE, missing])
    await page.locator(`tr[data-doc-id="${docs.some((d) => d.id === 'gc') ? 'gc' : docs[0].id}"]`).waitFor({ timeout: 60000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  const cell = (page, id) => page.locator(`[data-md-doc="${id}"]`)
  const fakeMd = (page) => page.evaluate(() => ({
    links: Object.fromEntries(window.__fakeDb.object_documents.filter((d) => d.md_s3_document_id).map((d) => [d.id, d.md_s3_document_id])),
    files: window.__fakeDb.s3_documents.filter((f) => f.doc_category === 'object_doc_md' || /\.md$/.test(f.file_name) || f.owner_id === 'o-1')
      .map((f) => ({ id: f.id, owner_type: f.owner_type, owner_id: f.owner_id, doc_category: f.doc_category, file_name: f.file_name })),
  }))
  // Нажатие открывает окно выбора файла, как у пользователя.
  async function choose(page, click, file) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), click()])
    await chooser.setFiles(file)
  }

  it('сразу справа от «Подписанный», маленький; у каждого документа — крестик с «.md» или зелёная галочка', async () => {
    const { page, errors, close } = await open()
    try {
      const heads = page.locator('.doc-table').nth(0).locator('thead th')
      assert.deepEqual(await heads.allTextContents(), ['', 'Наименование', '№ / дата', 'Подписанный', 'Скачать все.md', 'Редактируемый', 'Действия'])
      assert.deepEqual(await page.locator('.doc-table').nth(1).locator('thead th').allTextContents(),
        ['', 'Наименование', 'Дата', 'Описание ДС', 'Подписанный', '.md', 'Редактируемый', 'Действия'])
      const head = page.locator('.doc-th-md').nth(1)
      assert.equal(await head.innerText(), '.md', 'подпись строчными, а не как прочие заголовки')
      assert.ok((await head.boundingBox()).width <= 60, 'столбец маленький')
      // Договор, приложения любого уровня, ДС, приложение ДС.
      assert.equal(await page.locator('.doc-md').count(), DOCS.length)
      for (const id of ['gc', 'gc-att', 'gc-att-att', 'ds-att']) {
        assert.equal((await cell(page, id).innerText()).trim(), '.md', id)
        assert.equal(await cell(page, id).locator('.doc-md-cross').count(), 1, id)
        assert.equal(await cell(page, id).locator('.doc-md-yes').count(), 0, id)
      }
      const yes = cell(page, 'ds').locator('.doc-md-yes')
      assert.equal((await cell(page, 'ds').innerText()).trim(), '', 'у галочки подписи нет')
      assert.equal(await yes.evaluate((el) => getComputedStyle(el).color), 'rgb(21, 128, 61)')
      assert.equal(await yes.getAttribute('title'), 'ДС 1.md')
      // Ячейка стоит между «Подписанным» и «Редактируемым» — и в строках приложений тоже.
      for (const id of ['gc', 'gc-att', 'ds', 'ds-att']) {
        const left = await cell(page, id).evaluate((el) => el.closest('td').cellIndex)
        const headIndex = await cell(page, id).evaluate((el) => {
          const t = el.closest('table')
          return [...t.querySelectorAll('thead th')].findIndex((th) => th.classList.contains('doc-th-md'))
        })
        assert.equal(left, headIndex, id)
      }
      // Кнопка «+ Приложение» — по всей ширине таблицы, колонок на одну больше.
      assert.equal(await page.locator('.doc-row-tr-add-attachment td').first().getAttribute('colspan'), '7')
      assert.equal(await page.locator('.doc-row-tr-add-attachment td').last().getAttribute('colspan'), '8')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('загрузка: один файл к своей строке, без перечитывания карточки; после возврата на страницу — на месте', async () => {
    const { page, errors, close } = await open()
    try {
      const reads = () => page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'objects' && r.op === 'select').length)
      const before = await reads()
      await choose(page, () => cell(page, 'gc-att').locator('button').click(), md('Приложение 1.md'))
      await cell(page, 'gc-att').locator('.doc-md-yes').waitFor({ timeout: 10000 })
      assert.equal(await cell(page, 'gc-att').locator('.doc-md-yes').getAttribute('title'), 'Приложение 1.md')
      assert.equal(await cell(page, 'gc').locator('.doc-md-yes').count(), 0, 'соседняя строка не задета')
      assert.equal(await reads(), before, 'страница не мигает «Загрузкой»')

      const { links, files } = await fakeMd(page)
      assert.deepEqual(Object.keys(links).sort(), ['ds', 'gc-att'])
      const uploaded = files.find((f) => f.id === links['gc-att'])
      assert.deepEqual({ ...uploaded, id: undefined }, { id: undefined, owner_type: 'object', owner_id: 'o-1', doc_category: 'object_doc_md', file_name: 'Приложение 1.md' })

      await page.evaluate(() => window.__navigate('/cost-plans'))
      await page.locator('.cost-plans-page').first().waitFor()
      await page.evaluate(() => window.__navigate('/general/objects/o-1?tab=documents'))
      await cell(page, 'gc-att').locator('.doc-md-yes').waitFor({ timeout: 20000 })
      assert.equal(await cell(page, 'gc').locator('.doc-md-yes').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('только .md и не пустой — иначе понятный отказ, ничего не загружается', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      const filesBefore = (await fakeMd(page)).files.length
      const input = cell(page, 'gc').locator('input[type=file]')
      await input.setInputFiles({ name: 'Договор.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
      await input.setInputFiles({ name: 'Пустой.md', mimeType: 'text/markdown', buffer: Buffer.alloc(0) })
      assert.deepEqual(dialogs, ['Нужен файл с расширением .md', 'Файл .md пустой'])
      assert.equal((await fakeMd(page)).files.length, filesBefore)
      assert.equal(await cell(page, 'gc').locator('.doc-md-yes').count(), 0)
      // Регистр расширения не важен.
      await input.setInputFiles(md('ДОГОВОР.MD'))
      await cell(page, 'gc').locator('.doc-md-yes').waitFor({ timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('галочка: меню «Скачать / Заменить / Удалить»; замена — один файл, прежний удалён; удаление — снова крестик', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      const yes = cell(page, 'ds').locator('.doc-md-yes')
      await yes.click()
      const menu = page.getByRole('menu', { name: 'Файл .md: ДС № 1' })
      assert.equal(await menu.locator('.doc-md-menu-name').innerText(), 'ДС 1.md')
      assert.deepEqual((await menu.getByRole('menuitem').allInnerTexts()).map((s) => s.trim()), ['Скачать', 'Заменить', 'Удалить'])
      // Меню не обрезано рамкой таблицы.
      const box = await menu.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 1400 && box.y + box.height <= 900)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })

      await yes.click()
      await menu.getByRole('menuitem', { name: 'Скачать' }).click()
      await menu.waitFor({ state: 'detached' })
      await page.waitForFunction((key) => window.__fakeLastPresign?.s3_key === key, MD_FILE.s3_key)

      await yes.click()
      await choose(page, () => menu.getByRole('menuitem', { name: 'Заменить' }).click(), md('ДС 1 новая редакция.md'))
      await page.locator('[data-md-doc="ds"] .doc-md-yes[title="ДС 1 новая редакция.md"]').waitFor({ timeout: 10000 })
      const replaced = await fakeMd(page)
      assert.deepEqual(replaced.files.map((f) => f.file_name), ['ДС 1 новая редакция.md'], 'прежний файл удалён')
      assert.equal(replaced.links.ds, replaced.files[0].id)

      await yes.click()
      await menu.getByRole('menuitem', { name: 'Удалить' }).click()
      await cell(page, 'ds').locator('.doc-md-no').waitFor({ timeout: 10000 })
      assert.equal((await cell(page, 'ds').innerText()).trim(), '.md')
      assert.deepEqual(dialogs, ['Удалить файл «ДС 1 новая редакция.md»?'])
      assert.deepEqual(await fakeMd(page), { links: {}, files: [] })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('не привязалось (ошибка, документа уже нет): загруженный файл убран, прежний на месте, ошибка видна', async () => {
    const { page, dialogs, close } = await open()
    try {
      // Замена: запись связи отказала — прежний файл остаётся привязанным.
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'object_documents' && op === 'update' ? { error: { message: 'нет права' } } : {})
      })
      await cell(page, 'ds').locator('input[type=file]').setInputFiles(md('Новая.md'))
      await page.waitForFunction(() => !document.querySelector('.doc-md-busy'))
      await cell(page, 'ds').locator('.doc-md-yes[title="ДС 1.md"]').waitFor()
      assert.deepEqual(dialogs, ['Файл .md не загружен: нет права'])
      assert.deepEqual(await fakeMd(page), {
        links: { ds: MD_FILE.id },
        files: [{ id: MD_FILE.id, owner_type: 'object', owner_id: 'o-1', doc_category: 'object_doc_md', file_name: 'ДС 1.md' }],
      })

      // Документ удалили в другой вкладке: правка не задела строку — это ошибка, а не молчание.
      await page.evaluate(() => {
        window.__fakeHold = null
        window.__fakeDb.object_documents = window.__fakeDb.object_documents.filter((d) => d.id !== 'gc')
        window.__fakeTouch('object_documents')
      })
      await cell(page, 'gc').locator('input[type=file]').setInputFiles(md('Договор.md'))
      await cell(page, 'gc').locator('.doc-md-busy').waitFor({ state: 'detached' })
      await cell(page, 'gc').locator('.doc-md-no').waitFor()
      assert.equal(await page.evaluate(() => window.__fakeDb.s3_documents.some((f) => f.file_name === 'Договор.md')), false)
      assert.equal(dialogs[1], 'Файл .md не загружен: нет права или документ уже удалён')
    } finally {
      await close()
    }
  })

  it('удаление документа убирает и его файл .md', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      await page.locator('tr[data-doc-id="ds"] .doc-action-delete').click()
      await page.locator('tr[data-doc-id="ds"]').waitFor({ state: 'detached', timeout: 10000 })
      assert.deepEqual(dialogs, ['Удалить документ и все его приложения?'])
      assert.deepEqual((await fakeMd(page)).files, [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки: отметка без загрузки, галочка скачивает файл, меню нет', async () => {
    const { page, errors, close } = await open({ query: '&canEdit=0' })
    try {
      assert.equal(await page.locator('.doc-md input[type=file]').count(), 0)
      assert.equal(await cell(page, 'gc').locator('button').count(), 0, 'крестик — не кнопка')
      assert.equal((await cell(page, 'gc').innerText()).trim(), '.md')
      await cell(page, 'ds').locator('.doc-md-yes').click()
      await page.waitForFunction((key) => window.__fakeLastPresign?.s3_key === key, MD_FILE.s3_key)
      assert.equal(await page.getByRole('menu').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('миграции нет: столбца нет, документы на месте', async () => {
    const { page, errors, close } = await open({ missing: true })
    try {
      assert.deepEqual(await page.locator('.doc-table').nth(0).locator('thead th').allTextContents(),
        ['', 'Наименование', '№ / дата', 'Подписанный', 'Редактируемый', 'Действия'])
      assert.equal(await page.locator('.doc-md, .doc-th-md, .doc-md-zip').count(), 0)
      assert.equal(await page.locator('tr[data-doc-id="ds"]').count(), 1)
      assert.equal(await page.locator('.doc-row-tr-add-attachment td').first().getAttribute('colspan'), '6')
      assert.equal(await page.locator('.doc-row-tr-add-attachment td').last().getAttribute('colspan'), '7')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  const zipButton = (page) => page.locator('.doc-md-zip')
  async function downloadZip(page) {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), zipButton(page).click()])
    const zip = new PizZip(await readFile(await download.path()))
    await page.locator('.doc-md-zip:not([disabled])').waitFor({ timeout: 10000 })
    return { name: download.suggestedFilename(), zip, files: Object.keys(zip.files).sort() }
  }

  it('«Скачать все»: одна на объект, над столбцом и шириной с него, небольшой текст', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await zipButton(page).count(), 1, 'одна кнопка, а не в каждой таблице')
      const head = page.locator('.doc-table').first().locator('.doc-th-md')
      assert.equal(await head.locator('.doc-md-zip').count(), 1, 'над столбцом верхней таблицы')
      const button = await zipButton(page).boundingBox()
      const column = await head.boundingBox()
      assert.ok(Math.abs(button.width - column.width) <= 1, `ширина ${button.width} против ${column.width}`)
      assert.ok(Math.abs(button.x - column.x) <= 1, 'не выступает за колонку')
      const label = await head.evaluate((th) => {
        const range = document.createRange()
        range.selectNode([...th.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()))
        return range.getBoundingClientRect().top
      })
      assert.ok(button.y + button.height <= label, 'кнопка над подписью «.md»')
      const look = await zipButton(page).evaluate((el) => {
        const s = getComputedStyle(el)
        return { size: parseFloat(s.fontSize), fits: el.scrollWidth <= el.clientWidth, transform: s.textTransform }
      })
      assert.ok(look.size <= 11, `текст небольшой: ${look.size}px`)
      assert.equal(look.fits, true, 'слова не вылезают за кнопку')
      assert.equal(look.transform, 'none')
      assert.equal(await zipButton(page).innerText(), 'Скачать все')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Скачать все»: архив с именем объекта, файлы всех документов, загруженный только что — тоже; поиск состав не сужает', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      await cell(page, 'gc-att').locator('input[type=file]').setInputFiles(md('Приложение 1.md', '# Приложение\n'))
      await cell(page, 'gc-att').locator('.doc-md-yes').waitFor({ timeout: 10000 })
      await cell(page, 'gc-att-att').locator('input[type=file]').setInputFiles(md('ДС 1.md', '# Другой файл с тем же именем\n'))
      await cell(page, 'gc-att-att').locator('.doc-md-yes').waitFor({ timeout: 10000 })
      assert.match(await zipButton(page).getAttribute('title'), /: 3$/)

      await page.locator('.docs-search-input').fill('Договор генподряда')
      await page.locator('tr[data-doc-id="ds"]').waitFor({ state: 'detached' })
      const { name, zip, files } = await downloadZip(page)
      assert.equal(name, 'ЖК Южный — файлы md.zip')
      assert.deepEqual(files, ['ДС 1 (2).md', 'ДС 1.md', 'Приложение 1.md'].sort())
      assert.equal(zip.file('Приложение 1.md').asText(), '# Приложение\n')
      assert.equal(zip.file('ДС 1.md').asBinary().length > 0, true)
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Скачать все»: файл не скачался — архив честно неполный; ни один — архива нет, причина видна', async () => {
    const { page, dialogs, close } = await open()
    try {
      await cell(page, 'gc').locator('input[type=file]').setInputFiles(md('Договор.md'))
      await cell(page, 'gc').locator('.doc-md-yes').waitFor({ timeout: 10000 })
      await page.evaluate((key) => { delete window.__fakeFiles[key] }, MD_FILE.s3_key)

      const { files, zip } = await downloadZip(page)
      assert.deepEqual(files, ['Договор.md', 'Не скачано.txt'].sort())
      const list = zip.file('Не скачано.txt').asText()
      assert.match(list, /столбец «\.md»/)
      assert.match(list, /ДС № 1 — ДС 1\.md/)
      assert.match(dialogs[0], /^Архив неполный: не скачано 1 из 2\./)

      await page.evaluate(() => { window.__fakeFiles = {} })
      let downloaded = false
      page.on('download', () => { downloaded = true })
      await zipButton(page).click()
      await page.waitForFunction(() => document.querySelector('.doc-md-zip')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 })
      assert.match(dialogs[1], /^Не удалось скачать ни одного файла: /)
      assert.equal(downloaded, false)
    } finally {
      await close()
    }
  })

  it('«Скачать все»: файлов нет — кнопка неактивна; договора нет — над столбцом ДС; без права правки — работает', async () => {
    const empty = DOCS.map((d) => ({ ...d, md: null, md_s3_document_id: null }))
    const none = await open({ docs: empty })
    try {
      assert.equal(await zipButton(none.page).isDisabled(), true)
      assert.equal(await zipButton(none.page).getAttribute('title'), 'Файлов .md пока нет')
      await none.page.locator('[data-md-doc="gc"] input[type=file]').setInputFiles(md('Договор.md'))
      await none.page.locator('.doc-md-zip:not([disabled])').waitFor({ timeout: 10000 })
    } finally {
      await none.close()
    }

    const noContract = await open({ docs: DOCS.filter((d) => d.id === 'ds' || d.id === 'ds-att') })
    try {
      assert.equal(await zipButton(noContract.page).count(), 1)
      assert.equal(await noContract.page.locator('.doc-table').count(), 1)
      assert.equal(await noContract.page.locator('.doc-th-md .doc-md-zip').count(), 1)
    } finally {
      await noContract.close()
    }

    const reader = await open({ query: '&canEdit=0' })
    try {
      assert.deepEqual((await downloadZip(reader.page)).files, ['ДС 1.md'])
      assert.deepEqual(reader.errors, [])
    } finally {
      await reader.close()
    }
  })

  it('узкое окно: столбец на месте, таблица прокручивается в своей рамке', async () => {
    const { page, errors, close } = await open({ viewport: { width: 420, height: 800 } })
    try {
      assert.equal(await page.locator('.doc-md').count(), DOCS.length)
      const { pageWide, tableWide } = await page.evaluate(() => ({
        pageWide: document.documentElement.scrollWidth > window.innerWidth,
        tableWide: document.querySelector('.doc-table').offsetWidth >= 616,
      }))
      assert.equal(pageWide, false, 'сама страница вбок не едет')
      assert.equal(tableWide, true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
