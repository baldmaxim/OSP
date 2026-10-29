// Ячейка «КП / Документы» участника тендера (TenderCounterpartyFiles) и статус участника
// (ParticipantStatusSelect) — лента по образцу «Проверки КП» (29.10.2026; позже в тот же день — карточки с цветом
// состояния проверки, имя файла целиком):
//   • разбор ленты (src/utils/proposalTimeline.js): КП и документы — старые сверху, версии одного КП
//     по порядку загрузки, у прежних — когда заменены;
//   • в Chromium на стенде (tcFiles=1&tcReview=1): карточка тендера → «Участники» и раскрытая строка
//     реестра «Тендеры — Основное строительство» — дата и время загрузки, кто загрузил, версия, проверка,
//     имя файла открывает просмотр (отдельной кнопки нет), документы, новая версия КП в окне загрузки,
//     статус участника плашкой (и без права правки — читаемой).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { buildFilesTimeline, currentProposals, byUploadTime } from '../../src/utils/proposalTimeline.js'
import { participantStatusKey, participantStatusLabel, PARTICIPANT_STATUS_OPTIONS } from '../../src/utils/participantStatus.js'

const kp = (id, at, group, extra = {}) => ({ id, created_at: at, file_kind: 'commercial_proposal', proposal_group_id: group, ...extra })
const doc = (id, at) => ({ id, created_at: at, file_kind: 'attachment', proposal_group_id: null })

describe('Лента файлов участника: разбор', () => {
  it('КП и документы — старые сверху; версии одного КП по порядку, прежние — «заменена» датой следующей', () => {
    const rows = [
      kp('c', '2026-10-21T10:00:00Z', 'g1'),
      doc('d2', '2026-10-25T10:00:00Z'),
      kp('a', '2026-10-18T10:00:00Z', 'g1'),
      kp('b', '2026-10-20T10:00:00Z', 'g2'),
      doc('d1', '2026-10-01T10:00:00Z'),
      kp('e', '2026-10-28T10:00:00Z', 'g1'),
    ]
    const { proposals, attachments } = buildFilesTimeline(rows)
    assert.deepEqual(proposals.map((p) => p.file.id), ['a', 'b', 'c', 'e'])
    assert.deepEqual(proposals.map((p) => [p.version, p.versions]), [[1, 3], [1, 1], [2, 3], [3, 3]])
    assert.deepEqual(proposals.map((p) => p.replacedAt), ['2026-10-21T10:00:00Z', null, '2026-10-28T10:00:00Z', null])
    assert.deepEqual(attachments.map((d) => d.id), ['d1', 'd2'])
    assert.deepEqual(currentProposals(proposals).map((p) => p.file.id), ['b', 'e'], 'новая версия — только к текущим')
  })

  it('та же секунда — по id; КП без группы — одиночная версия; пусто — пустая лента', () => {
    const same = '2026-10-20T10:00:00Z'
    const { proposals } = buildFilesTimeline([kp('z', same, null), kp('y', same, null)])
    assert.deepEqual(proposals.map((p) => [p.file.id, p.version, p.versions, p.groupId]), [['y', 1, 1, 'y'], ['z', 1, 1, 'z']])
    assert.deepEqual(buildFilesTimeline(null), { proposals: [], attachments: [] })
    assert.ok(byUploadTime({ id: 'a', created_at: null }, { id: 'b', created_at: same }) < 0, 'без даты — в начало, не падает')
  })

  it('статус участника: пустой — «Запрос отправлен», подписи — из одного списка', () => {
    assert.equal(participantStatusKey(null), 'request_sent')
    assert.equal(participantStatusKey('declined'), 'declined')
    assert.equal(participantStatusLabel('accepted_for_work'), 'Принято в работу')
    assert.deepEqual(PARTICIPANT_STATUS_OPTIONS.map((o) => o.value), ['request_sent', 'accepted_for_work', 'proposal_provided', 'declined'])
  })
})

const launch = browserLaunchOptions()

describe('Лента файлов участника: карточка тендера и реестр', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const openPage = async (route, query = '') => {
    // Время загрузки показывается по часам браузера — фиксируем Москву.
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.accept() })
    await page.goto(`${stand.url}?route=${route}&items=20&cps=4&latency=0&tcFiles=1&tcReview=1${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const openCard = async (query = '') => {
    const opened = await openPage('/tenders/tender-1', query)
    const { page } = opened
    await page.locator('.tender-tab', { hasText: 'Участники' }).click({ timeout: 120000 })
    for (let i = 0; i < 4; i++) {
      await page.locator('.participants-section tbody tr').nth(i).locator('.tcpf[aria-busy="false"]').waitFor({ timeout: 30000 })
    }
    return opened
  }
  const row = (page, name) => page.locator('.participants-section tbody tr').filter({ hasText: name })
  const kpItems = (scope) => scope.locator('section[aria-label="Коммерческие предложения"] .tcpf-item')
  const docItems = (scope) => scope.locator('section[aria-label="Документы"] .tcpf-item')

  it('КП — старые сверху: дата и время, кто загрузил, версия и метка; дата не обрезана, столбец ровный', async () => {
    const { page, errors, close } = await openCard()
    try {
      const items = kpItems(row(page, 'Подрядчик 01'))
      assert.deepEqual(await items.locator('.tcpf-date').allTextContents(), ['18.10.26', '21.10.26'])
      assert.deepEqual(await items.locator('.tcpf-time').allTextContents(), ['13:00', '13:00'])
      assert.equal(await items.first().locator('.tcpf-when').getAttribute('title'), 'Загружено 18.10.2026, 13:00')
      assert.deepEqual(await items.locator('.tcpf-ver').allTextContents(), ['заменена 21.10.26', 'версия 2'])
      assert.deepEqual(await items.locator('.tcpf-vlabel').allTextContents(), ['«исходное»', '«после переторжки»'])
      assert.match(await items.first().getAttribute('class'), /is-replaced/)
      assert.doesNotMatch(await items.nth(1).getAttribute('class'), /is-replaced/)
      assert.deepEqual(await items.locator('.tcpf-uploader').allTextContents(), ['Иванов И. И.', 'Иванов И. И.'])

      // Имя файла — целиком (длинное переносится, не режется многоточием); дата — целиком;
      // имена в одной ленте начинаются с одной линии.
      const geometry = await page.evaluate(() => {
        const dates = [...document.querySelectorAll('.participants-section .tcpf-date')]
        const files = [...document.querySelectorAll('.participants-section .tcpf-list')].map((list) =>
          [...list.querySelectorAll(':scope > .tcpf-item .tcpf-file')].map((b) => Math.round(b.getBoundingClientRect().left)))
        return {
          clipped: dates.filter((d) => d.scrollWidth > d.clientWidth + 0.5).map((d) => d.textContent),
          ragged: files.filter((xs) => new Set(xs).size > 1),
        }
      })
      assert.deepEqual(geometry.clipped, [], 'дата помещается целиком')
      assert.deepEqual(geometry.ragged, [], 'имена файлов в одной ленте начинаются с одной линии')
      const long = kpItems(row(page, 'Подрядчик 02')).nth(1)
      const name = long.locator('.tcpf-file-name')
      assert.equal(await name.textContent(), 'КП Подрядчик 02 — кровля и водосток, корпус 2, секции 1–4.pdf')
      const shape = await name.evaluate((el) => ({
        clipped: el.scrollWidth > el.clientWidth + 0.5,
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      }))
      assert.equal(shape.clipped, false, 'длинное имя видно целиком')
      assert.ok(shape.lines >= 2, `длинное имя переносится (строк: ${shape.lines})`)
      // Тип файла — цветом значка; состояние КП — цветом карточки.
      assert.equal(await long.locator('.tcpf-ftype.is-pdf').count(), 1)
      assert.equal(await kpItems(row(page, 'Подрядчик 01')).first().locator('.tcpf-ftype.is-sheet').count(), 1)
      const tones = async (name) => kpItems(row(page, name)).evaluateAll((els) =>
        els.map((el) => [...el.classList].find((c) => c.startsWith('tcpf-tone-'))))
      assert.deepEqual(await tones('Подрядчик 01'), ['tcpf-tone-old', 'tcpf-tone-pending'])
      assert.deepEqual(await tones('Подрядчик 02'), ['tcpf-tone-ok', 'tcpf-tone-warn'])
      assert.deepEqual(await docItems(row(page, 'Подрядчик 01')).evaluateAll((els) => els.map((el) => el.classList.contains('tcpf-tone-doc'))), [true])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('имя файла открывает просмотр — отдельной кнопки «Просмотр» нет; у файла «Скачать» и «Удалить»', async () => {
    const { page, errors, close } = await openCard()
    try {
      const cell = row(page, 'Подрядчик 01')
      assert.equal(await cell.locator('button[title="Просмотр"]').count(), 0)
      assert.equal(await cell.locator('.tcpf-toggle-header, .tcpf-toggle').count(), 0, 'файлы видны сразу, без переключателя')
      const first = kpItems(cell).first()
      assert.deepEqual(await first.locator('.tcpf-line .tcpf-icon-btn').evaluateAll((els) => els.map((b) => b.getAttribute('aria-label'))),
        ['Скачать КП Подрядчик 01.xlsx', 'Удалить КП Подрядчик 01.xlsx'])
      await first.locator('.tcpf-file').click()
      await page.locator('.s3-doc-modal-title', { hasText: 'КП Подрядчик 01.xlsx' }).waitFor({ timeout: 10000 })
      await page.locator('.s3-doc-modal-close').click()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('проверка КП в строке: «Проверить» у ждущего, вердикт с тем, кто и когда проверил, замечания и шаги', async () => {
    const { page, errors, close } = await openCard()
    try {
      const own = kpItems(row(page, 'Подрядчик 01'))
      assert.match(await own.first().locator('.kpb-pill').textContent(), /Проверено/)
      const who = await own.first().locator('.tcpf-who').textContent()
      assert.ok(who.includes('Петрова') && who.includes('19.10.26'), who)
      assert.deepEqual(await own.first().locator('.tcpf-step').allTextContents(), ['в сводной'])
      assert.equal(await own.nth(1).locator('.kpb-pill').count(), 0)
      await own.nth(1).locator('.tcpf-check-btn', { hasText: 'Проверить' }).click()
      await page.locator('.kprm-modal .kprm-title', { hasText: 'Проверка КП' }).waitFor({ timeout: 10000 })
      await page.locator('.kprm-close').click()

      const other = kpItems(row(page, 'Подрядчик 02'))
      assert.deepEqual(await other.first().locator('.tcpf-step').allTextContents(), ['к занесению в сводную'])
      assert.match(await other.nth(1).locator('.kpb-pill').textContent(), /Замечания/)
      assert.match(await other.nth(1).locator('.tcpf-remarks').textContent(), /Нет цены на водосточную систему/)
      assert.deepEqual(await other.nth(1).locator('.tcpf-step').allTextContents(), ['в сводной', 'к отправке подрядчику'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('документы — своим списком, старые сверху; больше трёх — свёрнуты; без КП — «КП не загружено»', async () => {
    const { page, errors, close } = await openCard()
    try {
      const one = row(page, 'Подрядчик 01')
      assert.equal(await one.locator('.tcpf-section-toggle').getAttribute('aria-expanded'), 'true')
      assert.deepEqual(await docItems(one).locator('.tcpf-file-name').allTextContents(), ['Выписка ЕГРЮЛ.pdf'])

      const many = row(page, 'Подрядчик 02')
      const toggle = many.locator('.tcpf-section-toggle')
      assert.equal(await toggle.textContent(), 'Документы · 4')
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      assert.equal(await docItems(many).count(), 0)
      await toggle.click()
      assert.deepEqual(await docItems(many).locator('.tcpf-date').allTextContents(), ['15.10.26', '16.10.26', '17.10.26', '18.10.26'])
      assert.equal(await docItems(many).locator('.tcpf-review').count(), 0, 'у документа проверки нет')

      assert.equal(await row(page, 'Подрядчик 03').locator('.tcpf-none').textContent(), 'КП не загружено')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('новая версия КП — выбором в окне загрузки: встаёт в конец ленты, прежняя — «заменена»', async () => {
    const { page, errors, close } = await openCard()
    try {
      // Встраивание s3 в новую строку (в базе его делает PostgREST).
      await page.evaluate(() => {
        window.__fakeAfter = { ...(window.__fakeAfter || {}),
          tender_proposal_files: (op, r) => { if (op === 'insert') r.s3 = window.__fakeDb.s3_documents.find((d) => d.id === r.s3_document_id) } }
      })
      const cell = row(page, 'Подрядчик 01')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), cell.locator('.tcpf-quick-actions button', { hasText: '+ КП' }).click()])
      await chooser.setFiles({ name: 'КП Подрядчик 01 финал.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('xlsx') })
      const modal = page.locator('.tcpf-modal')
      await modal.waitFor({ timeout: 10000 })
      const choices = modal.locator('.tcpf-modal-choice')
      assert.deepEqual((await choices.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()),
        ['Новое КП', 'Новая версия КП от 21.10.26КП Подрядчик 01.xlsx · версия 2 · после переторжки'])
      assert.equal(await choices.first().locator('input').isChecked(), true, 'по умолчанию — отдельное КП, как раньше «+ КП»')
      await choices.nth(1).locator('input').check()
      assert.equal(await modal.locator('.tcpf-modal-title').textContent(), 'Загрузка новой версии КП')
      await modal.locator('.tcpf-modal-input').fill('финальная')
      await modal.locator('.tcpf-modal-footer .tcpf-btn-primary').click()
      await modal.waitFor({ state: 'detached', timeout: 10000 })

      const items = kpItems(cell)
      await items.nth(2).waitFor({ timeout: 10000 })
      const today = await page.evaluate(() => {
        const d = new Date()
        const p = (x) => String(x).padStart(2, '0')
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)}`
      })
      assert.deepEqual(await items.locator('.tcpf-ver').allTextContents(), ['заменена 21.10.26', `заменена ${today}`, 'версия 3'])
      assert.equal(await items.nth(2).locator('.tcpf-vlabel').textContent(), '«финальная»')
      const saved = await page.evaluate(() => window.__fakeDb.tender_proposal_files.at(-1))
      assert.equal(saved.proposal_group_id, 'g-1')
      assert.equal(saved.version_label, 'финальная')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('статус участника — плашка с точкой: меняется из списка; без права правки — та же, читаемая, без загрузки и удаления', async () => {
    const { page, errors, close } = await openCard()
    try {
      const status = row(page, 'Подрядчик 03').locator('.tc-status-fdrop')
      assert.match(await status.getAttribute('class'), /tc-st-accepted_for_work/)
      assert.equal(await status.locator('.fdrop-value').textContent(), 'Принято в работу')
      await status.locator('.fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'КП предоставлено' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_counterparties.find((t) => t.id === 'tc-3').status === 'proposal_provided')
      await row(page, 'Подрядчик 03').locator('.tc-status-fdrop.tc-st-proposal_provided').waitFor({ timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    const ro = await openCard('&canEdit=0')
    try {
      const declined = row(ro.page, 'Подрядчик 04').locator('.tc-status-fdrop')
      assert.match(await declined.getAttribute('class'), /is-disabled/)
      assert.equal(await declined.locator('.fdrop-trigger').evaluate((el) => getComputedStyle(el).opacity), '1')
      assert.equal(await ro.page.locator('.participants-section .tcpf-icon-del').count(), 0)
      assert.equal(await ro.page.locator('.participants-section .tcpf-quick-actions button', { hasText: '+ КП' }).count(), 0)
      // Без права проверки — состояние без кнопки.
      const pending = kpItems(row(ro.page, 'Подрядчик 01')).nth(1)
      assert.equal(await pending.locator('.tcpf-check-btn').count(), 0)
      assert.equal(await pending.locator('span.kpb-pill').textContent(), 'На проверке')
      assert.deepEqual(ro.errors, [])
    } finally {
      await ro.close()
    }
  })

  it('реестр «Тендеры — Основное строительство»: та же лента и статус в раскрытой строке', async () => {
    const { page, errors, close } = await openPage('/tenders/construction')
    try {
      const search = page.locator('input[placeholder^="№, объект"]')
      await search.waitFor({ timeout: 120000 })
      await search.fill('200')
      await page.locator('.expand-toggle').first().click()
      const wrap = page.locator('.expanded-cp-table-wrap')
      const cp = (name) => wrap.locator('tbody tr').filter({ hasText: name })
      await cp('Подрядчик 02').locator('.tcpf[aria-busy="false"]').waitFor({ timeout: 30000 })
      assert.deepEqual(await kpItems(cp('Подрядчик 01')).locator('.tcpf-date').allTextContents(), ['18.10.26', '21.10.26'])
      assert.deepEqual(await kpItems(cp('Подрядчик 02')).locator('.tcpf-date').allTextContents(), ['20.10.26', '22.10.26'])
      assert.equal(await cp('Подрядчик 04').locator('.tc-status-fdrop .fdrop-value').textContent(), 'Отказ')
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.expanded-cp-table-wrap .tcpf-date')]
        .filter((d) => d.scrollWidth > d.clientWidth + 0.5).length)
      assert.equal(clipped, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
