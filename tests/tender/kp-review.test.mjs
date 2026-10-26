// «Проверка КП» (/kp-review) в настоящем браузере. Стенд — tests/tender/ui (kpReview=1): шесть тендеров всех
// направлений, 15 КП на всех семи этапах; kpReviewMany=N — длинный список, kpRole — роль (см. seed.js).
//   • КП сгруппированы по тендеру: строка тендера (№, направление, работы · объект, ответственный, план затрат,
//     папка), под ней — КП этого тендера; тендер с самым свежим КП — первым;
//   • в строке КП — «КП» и «Скачать» вместо имени файла (оно — в подсказке), файл скачивается под именем
//     «№ тендера_контрагент_тендер_объект»; даты — «дд.мм.гг», ФИО — «Фамилия И. О.» (полностью — в подсказке);
//   • план затрат — мини-кнопка «ПЗ» со ссылкой или стадия («ПЗ: нет ссылки», «ПЗ: ожидание КП»);
//   • этапы и направления (ОС / ГО / Проч. / Совм.) отбирают КП, счётчики сходятся; отметки «В сводной» и
//     «Подрядчику» переводят КП по маршруту; без прав — только состояние; суперпользователь ставит этап вручную.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { kpDownloadName } from '../../src/utils/kpDownloadName.js'

const launch = browserLaunchOptions()

describe('Проверка КП: группы по тендеру, компактная строка КП, этапы', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    // Прогрев: первая загрузка компилирует модули dev-сервером.
    const page = await browser.newPage()
    await page.goto(`${stand.url}?route=/kp-review&kpReview=1&latency=0`)
    await page.locator('.kprv-table').waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function open({ role = '', extra = '', viewport = { width: 1600, height: 1000 } } = {}) {
    // Время — московское: даты стенда в UTC, подписи и подсказки сверяются по местному времени.
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?route=/kp-review&kpReview=1&latency=10${role ? `&kpRole=${role}` : ''}${extra}`)
    await page.locator('.kprv-table, .kprv-empty').first().waitFor({ timeout: 60000 })
    return { context, page, errors }
  }

  // Порядок строк таблицы: «g:<id тендера>» — строка тендера, иначе id КП.
  const order = (page) => page.locator('.kprv-table tbody tr:not(.vt-spacer)').evaluateAll((trs) => trs
    .map((tr) => (tr.dataset.tender ? `g:${tr.dataset.tender}` : tr.dataset.kp)))
  const counts = (page) => page.locator('.kprv-stage').evaluateAll((tabs) => Object.fromEntries(tabs
    .map((b) => [b.dataset.stage, Number(b.querySelector('.kprv-stage-count').textContent)])))
  const openStage = async (page, stage) => {
    await page.locator(`.kprv-stage[data-stage="${stage}"]`).click()
    await page.locator(`.kprv-stage[data-stage="${stage}"][aria-selected="true"]`).waitFor()
  }
  const kpRow = (page, id) => page.locator(`.kprv-kp[data-kp="${id}"]`)
  const group = (page, id) => page.locator(`.kprv-group[data-tender="${id}"]`)
  const dbRow = (page, id) => page.evaluate((x) => {
    const r = window.__fakeDb.tender_proposal_files.find((f) => f.id === x)
    return {
      review_status: r.review_status, reviewed_by: r.reviewed_by,
      summary_added: r.summary_added, summary_added_by: r.summary_added_by,
      remarks_sent: r.remarks_sent, remarks_sent_by: r.remarks_sent_by,
    }
  }, id)
  // Видимая часть PersonName (полное ФИО — в подсказке и для диктора).
  const shortName = (loc) => loc.locator('span[aria-hidden="true"]').first().evaluate((el) => el.textContent.replace(/\u00a0/g, ' '))

  it('все этапы: КП под строкой своего тендера, тендер с самым свежим КП — первым', async () => {
    const { context, page, errors } = await open()
    try {
      assert.deepEqual(await counts(page), {
        pending: 6, ok_summary: 2, ok_done: 2, remarks_work: 2, remarks_sent: 1, nosend_summary: 1, nosend_done: 1, all: 15,
      })
      // Подписи веток над этапами — маршрут читается без схемы.
      assert.deepEqual(await page.locator('.kprv-stage-cap').allInnerTexts(),
        ['', 'Без замечаний', 'С замечаниями · подрядчику', 'С замечаниями · без отправки', ''])

      await openStage(page, 'all')
      assert.deepEqual(await order(page), [
        'g:kt-6', 'kp-12', 'kp-13', 'kp-14', 'kp-15',
        'g:kt-2', 'kp-6', 'kp-5',
        'g:kt-1', 'kp-1', 'kp-2', 'kp-3', 'kp-4',
        'g:kt-5', 'kp-11',
        'g:kt-3', 'kp-7',
        'g:kt-4', 'kp-10', 'kp-9', 'kp-8',
      ])
      assert.match(await page.locator('.kprv-shown').innerText(), /15 КП · 6 тендеров/)

      // Строка тендера: номер, направление, работы — ссылка в карточку, объект.
      const g1 = group(page, 'kt-1')
      assert.equal(await g1.locator('.kprv-tnum').innerText(), '412')
      assert.equal(await g1.locator('.kprv-dept').innerText(), 'ОС')
      assert.equal(await g1.locator('a.kprv-tender-link').getAttribute('href'), '/tenders/kt-1')
      assert.match(await g1.locator('.kprv-group-title').innerText(), /Устройство кровли корпуса 2.*· ЖК «Северный квартал»/s)
      // Без номера и направления: «—», отдел — по статусу объекта.
      assert.equal(await group(page, 'kt-5').locator('.kprv-tnum').innerText(), '—')
      assert.equal(await group(page, 'kt-5').locator('.kprv-dept').innerText(), 'ОС')
      assert.equal(await group(page, 'kt-3').locator('.kprv-dept').innerText(), 'Совм.')
      assert.equal(await group(page, 'kt-4').locator('.kprv-dept').innerText(), 'Проч.')
      assert.equal(await group(page, 'kt-2').locator('.kprv-dept').innerText(), 'ГО')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('строка тендера: ФИО коротко, план затрат — мини-кнопка или стадия, путь к папке копируется', async () => {
    const { context, page, errors } = await open()
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(stand.url).origin })
      await openStage(page, 'all')
      const g1 = group(page, 'kt-1')
      const metas = g1.locator('.kprv-meta')
      assert.equal(await shortName(metas.nth(0)), 'Архипов А. М.')
      assert.match(await metas.nth(0).locator('[title]').first().getAttribute('title'), /Ответственный по тендеру: Архипов Антон Михайлович/)
      // ПЗ: ссылка открывается в новой вкладке, рядом — ответственный по плану затрат.
      const plan = g1.locator('a.kprv-plan-btn')
      assert.equal(await plan.innerText(), 'ПЗ')
      assert.equal(await plan.getAttribute('href'), 'https://docs.example.ru/plans/412')
      assert.equal(await plan.getAttribute('target'), '_blank')
      assert.equal(await plan.getAttribute('aria-label'), 'ПЗ — открыть план затрат')
      assert.equal(await shortName(metas.nth(1)), 'Крюкова Ю. Д.')
      // Ссылки нет: «Завершён» — предупреждение, иначе — стадия (аббревиатура прописными).
      assert.equal(await group(page, 'kt-2').locator('.kprv-plan-state').innerText(), 'ПЗ: нет ссылки')
      assert.ok(await group(page, 'kt-2').locator('.kprv-plan-state.is-warn').count())
      assert.equal(await group(page, 'kt-3').locator('.kprv-plan-state').innerText(), 'ПЗ: ожидание КП')
      assert.equal(await group(page, 'kt-5').locator('.kprv-plan-state').innerText(), 'ПЗ: не начат')

      // Папка: путь — в подсказке, копируется одним нажатием; нет пути — нет кнопки.
      const folder = g1.locator('.kprv-mini-btn', { hasText: 'Папка' })
      assert.match(await folder.getAttribute('title'), /^\\\\su10-fs\\Тендеры\\ЖК Северный квартал\\412 Кровля/)
      await folder.click()
      await g1.locator('.kprv-mini-btn.is-done').waitFor()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '\\\\su10-fs\\Тендеры\\ЖК Северный квартал\\412 Кровля')
      assert.equal(await group(page, 'kt-2').locator('.kprv-mini-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('строка КП: «КП» и «Скачать» вместо имени файла, даты «дд.мм.гг», проверка — вердикт, кто и когда', async () => {
    const { context, page, errors } = await open()
    try {
      await openStage(page, 'all')
      const row = kpRow(page, 'kp-2')
      const fileName = 'Коммерческое предложение СМИК от 23.10.2026 (с НДС).pdf'
      // Имени файла в строке не видно — только «КП», полное имя — в подсказке.
      assert.equal(await row.locator('.kprv-file-btn').innerText(), 'КП')
      assert.equal(await row.locator('.kprv-file-btn').getAttribute('title'), `Открыть КП: ${fileName}`)
      assert.ok(!(await row.innerText()).includes(fileName))
      // Дата загрузки — год двумя цифрами, полностью и со временем — в подсказке (15:40 UTC = 18:40 Мск).
      assert.equal(await row.locator('.kprv-date').innerText(), '23.10.26')
      assert.equal(await row.locator('.kprv-date').getAttribute('title'), 'Загружено 23.10.2026, 18:40')
      const dates = await page.locator('.kprv-kp .kprv-date').allInnerTexts()
      assert.equal(dates.length, 15)
      for (const d of dates) assert.match(d, /^\d\d\.\d\d\.\d\d$/)

      // Проверка: вердикт, «Фамилия И. О.» и дата проверки, ниже — замечания и файл замечаний.
      const status = row.locator('.kprv-status')
      assert.match(await status.locator('.kpb-pill').innerText(), /Замечания/)
      assert.equal(await shortName(status.locator('.kprv-who')), 'Петрова А. С.')
      assert.equal(await status.locator('.kprv-who .kprv-sub').innerText(), '24.10.26')
      assert.match(await status.locator('.kprv-remarks').innerText(), /Не учтены пароизоляция/)
      assert.match(await status.locator('.kpb-remarks-file').innerText(), /Замечания к КП СМИК/)
      // Метка версии — рядом с контрагентом.
      assert.match(await kpRow(page, 'kp-13').locator('.kprv-cp').innerText(), /ООО «Термотехника» · после переторжки/)
      // Без замечаний отправлять нечего, без отправки — так и написано, до проверки шагов нет.
      assert.equal(await kpRow(page, 'kp-3').locator('.kprv-step-sent').innerText(), '')
      assert.equal(await kpRow(page, 'kp-5').locator('.kprv-step-sent').innerText(), 'без отправки')
      assert.equal(await kpRow(page, 'kp-1').locator('.kprv-step-cell input').count(), 0)

      // Скачать — одним нажатием, под именем «№ тендера_контрагент_тендер_объект.расширение».
      const seed = await page.evaluate(() => {
        const r = window.__fakeDb.tender_proposal_files.find((f) => f.id === 'kp-2')
        return { s3: { file_name: r.s3.file_name }, counterparties: r.counterparties, tenders: r.tenders }
      })
      const expected = kpDownloadName(seed)
      assert.match(expected, /^412_ТОО «СтройМонтаж-Инжиниринг Казахстан»_Устройство кровли.*\.pdf$/)
      const dl = row.locator('.kprv-icon-btn[aria-label="Скачать КП"]')
      assert.equal(await dl.getAttribute('title'), `Скачать как «${expected}»`)
      const [download] = await Promise.all([page.waitForEvent('download'), dl.click()])
      assert.equal(download.suggestedFilename(), expected)

      // «КП» открывает просмотр файла.
      await row.locator('.kprv-file-btn').click()
      await page.locator('.s3-doc-modal').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('направления: галочки отбирают КП, счётчики этапов — по отбору, выбор переживает обновление', async () => {
    const { context, page, errors } = await open()
    try {
      const chip = (title) => page.locator(`.kprv-dept-chip[title="${title}"]`)
      const chipCount = async (title) => Number(await chip(title).locator('.kprv-dept-chip-count').innerText())
      // На проверке: ОС — 5 (у тендера без направления отдел по объекту), ГО — 1.
      assert.equal(await chipCount('Основное строительство'), 5)
      assert.equal(await chipCount('Гарантийный отдел'), 1)
      assert.equal(await chipCount('Тендеры (прочее)'), 0)
      assert.equal(await chipCount('Совместные тендеры'), 0)

      await chip('Гарантийный отдел').click()
      assert.deepEqual(await order(page), ['g:kt-2', 'kp-6'])
      const c = await counts(page)
      assert.equal(c.pending, 1)
      assert.equal(c.nosend_summary, 1)
      assert.equal(c.all, 2)
      assert.equal(await page.evaluate(() => localStorage.getItem('kpReview:depts')), '["warranty"]')

      await page.reload()
      await page.locator('.kprv-table').waitFor()
      assert.ok(await chip('Гарантийный отдел').locator('input').isChecked())
      assert.deepEqual(await order(page), ['g:kt-2', 'kp-6'])
      // Две галочки сразу — оба направления.
      await chip('Совместные тендеры').click()
      await openStage(page, 'all')
      assert.deepEqual((await order(page)).filter((x) => x.startsWith('g:')), ['g:kt-2', 'g:kt-3'])
      // Пусто по отбору — своё сообщение.
      await chip('Гарантийный отдел').click()
      await chip('Совместные тендеры').click()
      await chip('Тендеры (прочее)').click()
      await openStage(page, 'pending')
      assert.equal(await page.locator('.kprv-empty').innerText(), 'Нет КП по выбранным направлениям.')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('отметки «В сводной» и «Подрядчику» переводят КП по этапам; проверка — из строки', async () => {
    const { context, page, errors } = await open()
    try {
      // Без замечаний → в сводную: отметка уводит КП в «Готово».
      await openStage(page, 'ok_summary')
      assert.deepEqual(await order(page), ['g:kt-1', 'kp-3', 'g:kt-4', 'kp-9'])
      await kpRow(page, 'kp-3').locator('.kprv-step-sum input').click({ force: true })
      await kpRow(page, 'kp-3').waitFor({ state: 'detached' })
      let c = await counts(page)
      assert.equal(c.ok_summary, 1)
      assert.equal(c.ok_done, 3)
      assert.deepEqual(await dbRow(page, 'kp-3'), {
        review_status: 'approved', reviewed_by: 'Петрова Анна Сергеевна',
        summary_added: true, summary_added_by: 'Тест', remarks_sent: false, remarks_sent_by: null,
      })

      // С замечаниями для подрядчика: в сводную уже внесено — отметка отправки закрывает этап.
      await openStage(page, 'remarks_work')
      const kp2 = kpRow(page, 'kp-2')
      assert.ok(await kp2.locator('.kprv-step-sum input').isChecked())
      assert.ok(!(await kp2.locator('.kprv-step-sent input').isChecked()))
      assert.match(await kp2.locator('.kprv-step-sum .kprv-step').getAttribute('title'), /Занесено в сводную таблицу: Крюкова Юлия Денисовна · 24\.10\.2026, 15:00/)
      await kp2.locator('.kprv-step-sent input').click({ force: true })
      await kp2.waitFor({ state: 'detached' })
      c = await counts(page)
      assert.equal(c.remarks_work, 1)
      assert.equal(c.remarks_sent, 2)
      assert.equal((await dbRow(page, 'kp-2')).remarks_sent_by, 'Тест')
      // Снятая отметка возвращает КП в работу.
      await openStage(page, 'remarks_sent')
      await kpRow(page, 'kp-7').locator('.kprv-step-sent input').click({ force: true })
      await kpRow(page, 'kp-7').waitFor({ state: 'detached' })
      assert.equal((await counts(page)).remarks_work, 2)
      assert.equal((await dbRow(page, 'kp-7')).remarks_sent, false)

      // Проверка из строки: «Проверить» → «замечаний нет» → КП уходит из очереди.
      await openStage(page, 'pending')
      await kpRow(page, 'kp-1').locator('.kprv-btn', { hasText: 'Проверить' }).click()
      await page.locator('.kprm-modal').waitFor()
      await page.locator('.kprm-option', { hasText: 'Проверено, замечаний нет' }).click()
      await page.locator('.kprm-btn-primary').click()
      await kpRow(page, 'kp-1').waitFor({ state: 'detached' })
      c = await counts(page)
      assert.equal(c.pending, 5)
      assert.equal(c.ok_summary, 2)
      assert.equal((await dbRow(page, 'kp-1')).reviewed_by, 'Тест')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('без прав — состояние шагов без флажков и без колонки действий; суперпользователь ставит этап вручную', async () => {
    const viewer = await open({ role: 'viewer' })
    try {
      await openStage(viewer.page, 'all')
      assert.deepEqual(await viewer.page.locator('.kprv-table thead th').allInnerTexts(),
        ['№', 'Контрагент', 'КП', 'Загружен', 'Проверка', 'В сводной', 'Подрядчику'])
      assert.equal(await viewer.page.locator('.kprv-step input').count(), 0)
      assert.ok(await kpRow(viewer.page, 'kp-7').locator('.kprv-step-sum .kprv-step.is-static.is-done').count())
      assert.ok(await kpRow(viewer.page, 'kp-3').locator('.kprv-step-sum .kprv-step.is-static:not(.is-done)').count())
      // Вердикт не нажимается, скачать — можно.
      assert.equal(await viewer.page.locator('button.kpb-pill').count(), 0)
      assert.equal(await viewer.page.locator('.kprv-icon-btn[aria-label="Скачать КП"]').count(), 15)
      assert.deepEqual(viewer.errors, [])
    } finally {
      await viewer.context.close()
    }

    const sa = await open({ role: 'super' })
    try {
      await openStage(sa.page, 'remarks_work')
      const row = kpRow(sa.page, 'kp-14')
      await row.locator('.kprv-stage-btn').click()
      const menu = row.locator('.kprv-stage-menu')
      await menu.waitFor()
      assert.equal(await menu.locator('.kprv-stage-item.is-current').innerText(), 'Сводная + отправка')
      await menu.locator('.kprv-stage-group', { hasText: 'Без замечаний' }).locator('.kprv-stage-item', { hasText: 'Готово' }).click()
      await row.waitFor({ state: 'detached' })
      const db = await dbRow(sa.page, 'kp-14')
      assert.equal(db.review_status, 'approved')
      assert.equal(db.summary_added, true)
      assert.equal(db.summary_added_by, 'Стендов Стенд Стендович')
      await openStage(sa.page, 'ok_done')
      await kpRow(sa.page, 'kp-14').waitFor()
      assert.deepEqual(sa.errors, [])
    } finally {
      await sa.context.close()
    }
  })

  it('сортировка по № тендера, поиск, свёрнутый тендер', async () => {
    const { context, page, errors } = await open()
    try {
      await openStage(page, 'all')
      const groups = async () => (await order(page)).filter((x) => x.startsWith('g:'))
      await page.locator('.kprv-th-num .kprv-sort-btn').click()
      assert.deepEqual(await groups(), ['g:kt-4', 'g:kt-1', 'g:kt-2', 'g:kt-3', 'g:kt-6', 'g:kt-5'])
      // Внутри тендера — свежие КП сверху.
      assert.deepEqual((await order(page)).slice(0, 4), ['g:kt-4', 'kp-10', 'kp-9', 'kp-8'])
      await page.locator('.kprv-th-num .kprv-sort-btn').click()
      assert.deepEqual(await groups(), ['g:kt-6', 'g:kt-3', 'g:kt-2', 'g:kt-1', 'g:kt-4', 'g:kt-5'])

      // Поиск — по контрагенту, номеру тендера, ответственным; тендер — только со своими найденными КП.
      await page.locator('.kprv-search input').fill('Аквастрой')
      assert.deepEqual(await order(page), ['g:kt-3', 'kp-7', 'g:kt-2', 'kp-6'])
      assert.match(await page.locator('.kprv-shown').innerText(), /2 КП · 2 тендера/)
      await page.locator('.kprv-search input').fill('431')
      assert.deepEqual(await groups(), ['g:kt-6'])
      // ФИО ищется и так, как видно в таблице: «Фамилия И. О.».
      await page.locator('.kprv-search input').fill('Петрова А. С.')
      assert.deepEqual(await order(page), ['g:kt-3', 'kp-7', 'g:kt-1', 'kp-2', 'kp-3', 'g:kt-4', 'kp-10'])
      await page.locator('.kprv-search input').fill('')

      // Свернуть тендер: его КП скрыты, в строке тендера — сколько скрыто.
      const g6 = group(page, 'kt-6')
      await g6.locator('.kprv-collapse').click()
      assert.equal(await g6.locator('.kprv-collapse').getAttribute('aria-expanded'), 'false')
      assert.equal(await kpRow(page, 'kp-12').count(), 0)
      assert.match(await g6.locator('.kprv-group-title').innerText(), /скрыто КП: 4/)
      await g6.locator('.kprv-collapse').click()
      await kpRow(page, 'kp-12').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('длинный список виртуализован, строка тендера залипает под шапкой', async () => {
    // shell=1 — страница в обвязке приложения (.main-content): только так у таблицы своя прокрутка.
    const { context, page, errors } = await open({ extra: '&kpReviewMany=400&shell=1', viewport: { width: 1440, height: 900 } })
    try {
      await openStage(page, 'all')
      assert.match(await page.locator('.kprv-shown').innerText(), /415 КП · 106 тендеров/)
      const rendered = await page.locator('.kprv-table tbody tr:not(.vt-spacer)').count()
      assert.ok(rendered < 150, `в DOM ${rendered} строк из 521`)
      // Прокрутка внутри тендера: его строка уже ушла вверх (место строки — выше шапки), а ячейки
      // стоят сразу под шапкой таблицы.
      const stuck = await page.evaluate(async () => {
        const wrap = document.querySelector('.kprv-table-wrap')
        wrap.scrollTop = 900
        await new Promise((r) => setTimeout(r, 300))
        const headBottom = document.querySelector('.kprv-table thead th').getBoundingClientRect().bottom
        return [...document.querySelectorAll('.kprv-group')].some((tr) => tr.getBoundingClientRect().top < headBottom - 20
          && Math.abs(tr.querySelector('td.kprv-gutter').getBoundingClientRect().top - headBottom) < 2)
      })
      assert.ok(stuck, 'строка тендера не залипла под шапкой')
      // Конец списка тоже дорисовывается.
      await page.evaluate(() => { const w = document.querySelector('.kprv-table-wrap'); w.scrollTop = w.scrollHeight })
      await page.locator('.kprv-group[data-tender="ktm-0"]').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('телефон: КП — карточки без горизонтальной прокрутки', async () => {
    const { context, page, errors } = await open({ viewport: { width: 390, height: 844 }, extra: '&shell=1' })
    try {
      await openStage(page, 'all')
      const sizes = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        wrap: document.querySelector('.kprv-table-wrap').scrollWidth,
        wrapClient: document.querySelector('.kprv-table-wrap').clientWidth,
      }))
      assert.ok(sizes.page <= 390, `страница шире экрана: ${sizes.page}`)
      assert.ok(sizes.wrap <= sizes.wrapClient + 1, `таблица шире экрана: ${sizes.wrap} > ${sizes.wrapClient}`)
      assert.equal(await page.locator('.kprv-table thead').isVisible(), false)
      const card = kpRow(page, 'kp-12')
      assert.ok(await card.locator('.kprv-file-btn').isVisible())
      assert.ok(await card.locator('.kprv-btn', { hasText: 'Проверить' }).isVisible())
      // Пустые шаги (до проверки) на телефоне не занимают места.
      assert.equal(await card.locator('.kprv-step-sum').isVisible(), false)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
