// Ячейка «КП / Документы» участника тендера (TenderCounterpartyFiles) и статус участника
// (ParticipantStatusSelect) — лента по образцу «Проверки КП» (29.10.2026; позже в тот же день — по
// замечаниям пользователя: КП блоками по версиям, имя файла в одну строку, состояние — только полосой
// слева, «ждёт проверки» — серым, «Скачать» с подписью у текущей версии КП, галочка «Свернуть всё» (весь тендер
// компактно), колонки «компания (со статусом) · контакты · КП · примечание»):
//   • разбор ленты (src/utils/proposalTimeline.js): КП и документы — старые сверху, версии одного КП
//     по порядку загрузки, у прежних — когда заменены; группы версий и сводка проверки;
//   • в Chromium на стенде (tcFiles=1&tcReview=1): карточка тендера → «Участники» и раскрытая строка
//     реестра «Тендеры — Основное строительство» — дата и время загрузки, кто загрузил, версия, проверка,
//     имя файла открывает просмотр (отдельной кнопки нет), документы, новая версия КП в окне загрузки,
//     статус участника плашкой (и без права правки — читаемой), сворачивание КП.
// 30.10.2026 (замечания пользователя): подписей «КП 1», «КП 2» нет; имя файла — целиком, плашкой, у PDF,
// Excel и Word без расширения (значок — красный, зелёный, синий); «Скачать» — значком справа по середине строки файла; в сводке — «Файлов: N»; фон
// раскрытого тендера и строк участников — без серого (серые только шапка и рамка); в карточке, открытой не
// из реестра, таблица во всю ширину, «Свернуть всё» — за заголовком; без права правки нет пустой колонки.
// 30.10.2026, позже: дата и время загрузки — только при наведении на строку файла (плашкой, строки не
// сдвигаются); метка версии и другие пометки — 500; телефон и почта контакта копируются нажатием, внизу —
// плашка «Номер скопирован» / «Email скопирован»; в свёрнутом виде видна и почта.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { buildFilesTimeline, currentProposals, byUploadTime, groupProposals, reviewSummary } from '../../src/utils/proposalTimeline.js'
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

  it('КП — блоками по группам версий: КП по первой загрузке, версии по порядку; сводка — по текущим версиям', () => {
    const { proposals } = buildFilesTimeline([
      kp('a', '2026-10-18T10:00:00Z', 'g1', { review_required: true, review_status: 'approved' }),
      kp('b', '2026-10-20T10:00:00Z', 'g2', { review_required: true, review_status: 'has_remarks' }),
      kp('c', '2026-10-21T10:00:00Z', 'g1', { review_required: true }),
      kp('d', '2026-10-22T10:00:00Z', 'g3'),
    ])
    const groups = groupProposals(proposals)
    assert.deepEqual(groups.map((g) => [g.groupId, g.items.map((p) => p.file.id), g.current.file.id]),
      [['g1', ['a', 'c'], 'c'], ['g2', ['b'], 'b'], ['g3', ['d'], 'd']])
    // У g1 текущая версия ещё на проверке — прежнее «проверено» не в счёт; КП без проверки (g3) не считается.
    assert.deepEqual(reviewSummary(groups), { approved: 0, has_remarks: 1, pending: 1 })
    assert.deepEqual(groupProposals([]), [])
  })

  it('карточка тендера сама подключает базовые стили таблиц (Tenders.css) — до своих', () => {
    // Без этого .data-table { width: 100% }, шапка и выравнивание заголовков были только у того, кто сначала
    // открыл реестр: экономист приходит в тендер из «Планов затрат» и «Проверки КП» — таблица участников
    // сжималась до минимальной ширины, справа пусто, заголовки по центру.
    const src = fs.readFileSync(path.join(REPO, 'src/pages/TenderDetailPage.jsx'), 'utf8')
    const base = src.indexOf("import '../components/Tenders.css'")
    assert.ok(base > 0, 'TenderDetailPage импортирует Tenders.css')
    assert.ok(base < src.indexOf("import '../components/TenderDetail.css'"), 'базовые стили — раньше стилей карточки')
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

  it('КП — блоками по версиям без подписей «КП 1»: «в1», «в2», дата и время, кто загрузил, метка; имя целиком, столбец ровный', async () => {
    const { page, errors, close } = await openCard()
    try {
      const one = row(page, 'Подрядчик 01')
      const items = kpItems(one)
      assert.deepEqual(await items.locator('.tcpf-date').allTextContents(), ['18.10.26', '21.10.26'])
      assert.deepEqual(await items.locator('.tcpf-time').allTextContents(), ['13:00', '13:00'])
      assert.equal(await items.first().locator('.tcpf-when').getAttribute('title'), 'Загружено 18.10.2026, 13:00')
      // Версии одного КП — одним блоком с метками «в1», «в2»; у прежней — когда заменена.
      assert.equal(await one.locator('.tcpf-kp').count(), 1)
      assert.deepEqual(await items.locator('.tcpf-vtag').allTextContents(), ['в1', 'в2'])
      assert.match(await items.nth(1).locator('.tcpf-vtag').getAttribute('class'), /is-current/)
      assert.deepEqual(await items.locator('.tcpf-ver').allTextContents(), ['заменена 21.10.26'])
      assert.deepEqual(await items.locator('.tcpf-vlabel').allTextContents(), ['«исходное»', '«после переторжки»'])
      assert.match(await items.first().getAttribute('class'), /is-replaced/)
      assert.doesNotMatch(await items.nth(1).getAttribute('class'), /is-replaced/)
      assert.deepEqual(await items.locator('.tcpf-uploader').allTextContents(), ['Иванов И. И.', 'Иванов И. И.'])
      // Сводка — сколько всего файлов (КП всех версий и документы), плашкой.
      assert.equal((await one.locator('.tcpf-summary').textContent()).trim(), 'Файлов: 3')
      // Несколько КП — блоки без подписей «КП 1», «КП 2», у одиночных версий меток нет (полоса слева — состояние проверки, ниже).
      const two = row(page, 'Подрядчик 02')
      assert.equal(await two.locator('.tcpf-kp').count(), 2)
      assert.equal((await two.locator('.tcpf-summary').textContent()).trim(), 'Файлов: 6')
      assert.doesNotMatch(await two.locator('section[aria-label="Коммерческие предложения"]').textContent(), /КП\s*\d/)
      assert.equal(await two.locator('.tcpf-vtag').count(), 0)

      // Имя файла — целиком (переносится, без многоточия; у PDF, Excel и Word без расширения, полное — в
      // подсказке); дата — целиком; имена в одном блоке начинаются с одной линии.
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
      const long = kpItems(two).nth(1)
      assert.equal(await long.locator('.tcpf-file-name').textContent(), 'КП Подрядчик 02 — кровля и водосток, корпус 2, секции 1–4')
      assert.equal(await page.locator('.participants-section .tcpf-file-ext').count(), 0)
      assert.equal(await items.first().locator('.tcpf-file-name').textContent(), 'КП Подрядчик 01', 'у Excel — без .xlsx')
      assert.match(await long.locator('.tcpf-file').getAttribute('title'), /^Открыть: КП Подрядчик 02 — кровля и водосток, корпус 2, секции 1–4\.pdf/)
      const shape = await long.locator('.tcpf-file').evaluate((btn) => {
        const name = btn.querySelector('.tcpf-file-name')
        const box = btn.getBoundingClientRect()
        const cell = btn.closest('td').getBoundingClientRect()
        const cs = getComputedStyle(btn)
        return {
          whole: name.scrollWidth <= name.clientWidth + 0.5 && getComputedStyle(name).textOverflow !== 'ellipsis',
          inside: box.right <= cell.right + 0.5,
          chip: cs.borderTopWidth !== '0px' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
        }
      })
      assert.equal(shape.whole, true, 'имя — целиком, без многоточия')
      assert.equal(shape.inside, true, 'длинное имя переносится, а не вылезает из колонки')
      assert.equal(shape.chip, true, 'имя — плашкой (рамка и фон), как в «Проверке КП»')
      // Тип файла — цветом значка; состояние КП — полосой слева у блока (по текущей версии), без фона и рамки;
      // «ждёт проверки» — серой полосой, как в «Проверке КП».
      assert.equal(await long.locator('.tcpf-ftype.is-pdf').count(), 1)
      assert.equal(await items.first().locator('.tcpf-ftype.is-sheet').count(), 1)
      const tones = async (name) => row(page, name).locator('.tcpf-kp').evaluateAll((els) =>
        els.map((el) => [...el.classList].find((c) => c.startsWith('tcpf-tone-'))))
      assert.deepEqual(await tones('Подрядчик 01'), ['tcpf-tone-pending'])
      assert.deepEqual(await tones('Подрядчик 02'), ['tcpf-tone-ok', 'tcpf-tone-warn'])
      const look = await page.evaluate(() => {
        const kps = [...document.querySelectorAll('.participants-section .tcpf-kp')]
        const files = [...document.querySelectorAll('.participants-section .tcpf-item')]
        const pending = document.querySelector('.participants-section .tcpf-kp.tcpf-tone-pending')
        return {
          tinted: [...kps, ...files].filter((el) => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)').length,
          boxed: files.filter((el) => getComputedStyle(el).borderTopWidth !== '0px').length,
          lines: kps.map((el) => getComputedStyle(el).borderLeftWidth),
          pendingLine: getComputedStyle(pending).borderLeftColor,
        }
      })
      assert.equal(look.tinted, 0, 'фон блоков и строк не красится')
      assert.equal(look.boxed, 0, 'у строк файлов нет рамки')
      assert.deepEqual(look.lines, ['3px', '3px', '3px'])
      assert.equal(look.pendingLine, 'rgb(148, 163, 184)', 'ждёт проверки — серая полоса, не синяя')
      assert.equal(await docItems(one).count(), 1)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('дата и время загрузки — только при наведении на строку файла, ничего не сдвигается; пометки — 500', async () => {
    const { page, errors, close } = await openCard()
    try {
      const items = kpItems(row(page, 'Подрядчик 01'))
      const when = items.nth(1).locator('.tcpf-when')
      const state = () => items.nth(1).evaluate((li) => ({
        position: getComputedStyle(li.querySelector('.tcpf-when')).position,
        uploader: Math.round(li.querySelector('.tcpf-uploader').getBoundingClientRect().left),
        file: Math.round(li.querySelector('.tcpf-file').getBoundingClientRect().left),
        height: Math.round(li.getBoundingClientRect().height),
      }))
      const opacityIs = async (value) => page.waitForFunction(([el, v]) => getComputedStyle(el).opacity === v,
        [await when.elementHandle(), value], { timeout: 5000 })
      // Мышь — в стороне: даты не видно, место в строке сведений она не держит (кто загрузил — первым,
      // вровень с именем файла).
      await page.mouse.move(5, 5)
      await opacityIs('0')
      const idle = await state()
      assert.equal(idle.position, 'absolute')
      assert.ok(Math.abs(idle.uploader - idle.file) < 4, `кто загрузил — в начале строки сведений: ${idle.uploader} / ${idle.file}`)
      // Наведение на строку файла — дата видна плашкой у правого края, рядом со «Скачать»; строка не
      // сдвинулась и не выросла.
      await items.nth(1).locator('.tcpf-meta').hover()
      await opacityIs('1')
      const hovered = await state()
      assert.equal(hovered.uploader, idle.uploader, 'ничего не сдвинулось')
      assert.equal(hovered.height, idle.height, 'высота строки та же')
      assert.match(await when.textContent(), /21\.10\.26\s*13:00/)
      const chip = await when.boundingBox()
      const name = await items.nth(1).locator('.tcpf-file').boundingBox()
      const uploader = await items.nth(1).locator('.tcpf-uploader').boundingBox()
      const dl = await items.nth(1).locator('.tcpf-dl').boundingBox()
      assert.ok(chip.x >= name.x + name.width && chip.x >= uploader.x + uploader.width, 'плашка даты — правее имени и сведений, не закрывает их')
      assert.ok(chip.x + chip.width <= dl.x && dl.x - (chip.x + chip.width) < 48, 'плашка даты — рядом со «Скачать»')
      const item = await items.nth(1).boundingBox()
      assert.ok(chip.y >= item.y && chip.y + chip.height <= item.y + item.height, 'плашка — в своей строке, соседнюю не закрывает')
      // У соседней строки дата по-прежнему скрыта.
      assert.equal(await items.first().locator('.tcpf-when').evaluate((el) => getComputedStyle(el).opacity), '0')
      // Метка версии, «в1», «заменена», вердикт — чуть жирнее (500), имя загрузившего — обычным.
      const weight = (loc) => loc.evaluate((el) => getComputedStyle(el).fontWeight)
      assert.equal(await weight(items.first().locator('.tcpf-vlabel')), '500')
      assert.equal(await weight(items.first().locator('.tcpf-vtag')), '500')
      assert.equal(await weight(items.first().locator('.tcpf-ver')), '500')
      assert.equal(await weight(items.first().locator('.tcpf-uploader')), '400')
      const verdict = kpItems(row(page, 'Подрядчик 02')).first().locator('.kpb-pill')
      assert.equal(await weight(verdict), '500')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('имя файла открывает просмотр — отдельной кнопки «Просмотр» нет; у файла «Скачать» значком справа по середине и «Удалить»', async () => {
    const { page, errors, close } = await openCard()
    try {
      const cell = row(page, 'Подрядчик 01')
      assert.equal(await cell.locator('button[title="Просмотр"]').count(), 0)
      assert.equal(await cell.locator('.tcpf-summary').getAttribute('aria-expanded'), 'true', 'файлы видны сразу')
      const first = kpItems(cell).first()
      assert.deepEqual(await first.locator('.tcpf-item-actions .tcpf-icon-btn').evaluateAll((els) => els.map((b) => b.getAttribute('aria-label'))),
        ['Удалить КП Подрядчик 01.xlsx', 'Скачать КП Подрядчик 01.xlsx'])
      // «Скачать» — значком без подписи у каждого файла: у правого края строки файла, по её середине.
      const dl = await page.locator('.participants-section .tcpf-item').evaluateAll((lis) => lis.map((li) => {
        const btn = li.querySelector('.tcpf-dl')
        const a = btn.getBoundingClientRect()
        const b = li.getBoundingClientRect()
        return { text: btn.textContent.trim(), dy: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2), dx: b.right - a.right }
      }))
      assert.ok(dl.length >= 3)
      assert.deepEqual(dl.filter((d) => d.text || d.dy > 1 || d.dx > 1), [], 'значок без подписи, справа, по середине')
      // «Скачать всё» участника — текстом.
      assert.equal(await cell.locator('.tcpf-zip-btn').textContent(), 'Скачать всё')
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
      // Кто и когда проверил — не строкой в ячейке, а в подсказке вердикта.
      assert.equal(await own.first().locator('.tcpf-who').count(), 0)
      const who = await own.first().locator('.kpb-pill').getAttribute('title')
      assert.ok(who.includes('Петрова') && who.includes('19.10.2026'), who)
      // Шаги — только у текущей версии: у заменённой «в сводной» уже не задача.
      assert.deepEqual(await own.first().locator('.tcpf-step').allTextContents(), [])
      assert.equal(await own.nth(1).locator('.kpb-pill').count(), 0)
      await own.nth(1).locator('.tcpf-check-btn', { hasText: 'Проверить' }).click()
      await page.locator('.kprm-modal .kprm-title', { hasText: 'Проверка КП' }).waitFor({ timeout: 10000 })
      await page.locator('.kprm-close').click()

      const other = kpItems(row(page, 'Подрядчик 02'))
      assert.deepEqual(await other.first().locator('.tcpf-step').allTextContents(), ['к занесению в сводную'])
      assert.match(await other.nth(1).locator('.kpb-pill').textContent(), /Замечания/)
      assert.match(await other.nth(1).locator('.kpb-pill').getAttribute('title'), /^Замечания · Смирнов/)
      // Замечания — одной строкой, полностью — в подсказке.
      const remarks = other.nth(1).locator('.tcpf-remarks')
      assert.match(await remarks.textContent(), /Нет цены на водосточную систему/)
      assert.match(await remarks.getAttribute('title'), /гарантия 2 года вместо 5/)
      assert.equal(await remarks.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))), 1)
      assert.deepEqual(await other.nth(1).locator('.tcpf-step').allTextContents(), ['в сводной', 'к отправке подрядчику'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('колонки: компания со статусом под названием, «Контакты» сразу за ней, затем КП, примечание — справа', async () => {
    const heads = (page, sel) => page.locator(`${sel} thead th`).evaluateAll((ths) =>
      ths.map((th) => th.textContent.replace(/Скачать всё/, '').trim()).filter(Boolean))
    const expected = ['№', 'Наименование компании', 'Контакты', 'КП / Документы', 'Примечание']
    const card = await openCard('&cpContacts=1')
    try {
      const { page, errors } = card
      assert.deepEqual(await heads(page, '.participants-section'), expected)
      // Статус — плашкой под названием компании; название — 500, не жирное.
      const company = row(page, 'Подрядчик 01').locator('td.tc-company-cell')
      assert.equal(await company.locator('.tc-status-fdrop').count(), 1)
      assert.equal(await company.locator('.tc-company-name').evaluate((el) => getComputedStyle(el).fontWeight), '500')
      // Подрядчики разделены чертой, всё по верхнему краю; подложки через одного нет — серые только шапка и рамка.
      const rows = await page.locator('.participants-section tbody tr').evaluateAll((trs) => trs.map((tr) => ({
        bg: getComputedStyle(tr).backgroundColor,
        top: [...tr.cells].every((td) => getComputedStyle(td).verticalAlign === 'top'),
      })))
      assert.ok(rows.every((r) => r.top), 'ячейки — по верхнему краю')
      assert.deepEqual([...new Set(rows.map((r) => r.bg))], ['rgba(0, 0, 0, 0)'], 'без подложки через одного')
      const contacts = row(page, 'Подрядчик 01').locator('.tcc-item')
      assert.equal(await contacts.count(), 2)
      assert.equal(await contacts.first().locator('.tcc-name').textContent(), 'Шахмиров Джабраил Алиевич')
      // Каждый телефон и каждая почта — своей строкой-ссылкой; почта копируется без невидимых знаков.
      assert.deepEqual(await contacts.first().locator('.tcc-line').evaluateAll((as) => as.map((a) => a.getAttribute('href'))),
        ['tel:+79637950185', 'tel:+77273000000', 'mailto:shahmirov.dzhabrail@yahoo.com'])
      assert.equal(await contacts.first().locator('.tcc-mail').textContent(), 'shahmirov.dzhabrail@yahoo.com')
      assert.equal(await row(page, 'Подрядчик 03').locator('.tcc-none').textContent(), '—')
      // Нажатие копирует номер или почту (как написано, без невидимых знаков переноса), внизу — плашка с
      // галочкой; страница никуда не уходит.
      await page.evaluate(() => {
        window.__copied = []
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t) } } })
      })
      const url = page.url()
      await contacts.first().locator('.tcc-line').first().click()
      const toast = page.locator('.copy-toast')
      await toast.waitFor({ timeout: 5000 })
      assert.equal((await toast.textContent()).trim(), 'Номер скопирован')
      assert.equal(await toast.locator('.copy-toast-ic svg').count(), 1, 'зелёная галочка')
      assert.equal(await toast.locator('.copy-toast-ic').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(22, 163, 74)')
      const box = await toast.boundingBox()
      assert.ok(box.y + box.height > 1000 - 40 && box.height < 40, `маленькая плашка внизу: ${JSON.stringify(box)}`)
      await contacts.first().locator('.tcc-line').nth(2).click()
      await page.waitForFunction(() => document.querySelector('.copy-toast')?.textContent.trim() === 'Email скопирован')
      assert.deepEqual(await page.evaluate(() => window.__copied), ['+7(963)795-01-85', 'shahmirov.dzhabrail@yahoo.com'])
      assert.match(await contacts.first().locator('.tcc-line').first().getAttribute('title'), /^Скопировать номер: \+7\(963\)795-01-85$/)
      assert.equal(page.url(), url)
      // Плашка сама пропадает.
      await toast.waitFor({ state: 'detached', timeout: 5000 })
      assert.deepEqual(errors, [])
    } finally {
      await card.close()
    }
    const reg = await openPage('/tenders/construction', '&cpContacts=1')
    try {
      const { page, errors } = reg
      const search = page.locator('input[placeholder^="№, объект"]')
      await search.waitFor({ timeout: 120000 })
      await search.fill('200')
      await page.locator('.expand-toggle').first().click()
      await page.locator('.expanded-cp-table-wrap .tcc-item').first().waitFor({ timeout: 30000 })
      assert.deepEqual(await heads(page, '.expanded-cp-table-wrap'), expected)
      assert.equal(await page.locator('.expanded-cp-table-wrap tbody tr').first().locator('td.tc-company-cell .tc-status-fdrop').count(), 1)
      // Раскрытый тендер — на белом: серые только шапка таблицы участников и рамка вокруг неё.
      const look = await page.evaluate(() => {
        const bg = (el) => getComputedStyle(el).backgroundColor
        const wrap = document.querySelector('.expanded-cp-table-wrap')
        return {
          area: bg(document.querySelector('td.expanded-cp-row')),
          rows: [...new Set([...wrap.querySelectorAll('tbody > tr')].map(bg))],
          head: bg(wrap.querySelector('thead th')),
          frame: getComputedStyle(wrap).borderTopWidth,
        }
      })
      assert.equal(look.area, 'rgb(255, 255, 255)', 'область тендера — без серого')
      assert.deepEqual(look.rows, ['rgba(0, 0, 0, 0)'])
      assert.notEqual(look.head, 'rgba(0, 0, 0, 0)', 'шапка — серая')
      assert.equal(look.frame, '1px', 'рамка на месте')
      assert.deepEqual(errors, [])
    } finally {
      await reg.close()
    }
  })

  it('документы — своим списком, старые сверху; больше трёх — свёрнуты; без КП — «КП не загружено»', async () => {
    const { page, errors, close } = await openCard()
    try {
      const one = row(page, 'Подрядчик 01')
      assert.equal(await one.locator('.tcpf-section-toggle').getAttribute('aria-expanded'), 'true')
      assert.deepEqual(await docItems(one).locator('.tcpf-file').allTextContents(), ['Выписка ЕГРЮЛ'])

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

  it('значок типа — цветом: Excel зелёный, PDF красный, Word синий; у всех трёх имя без расширения', async () => {
    const { page, errors, close } = await openCard()
    try {
      await page.evaluate(() => {
        window.__fakeAfter = { ...(window.__fakeAfter || {}),
          tender_proposal_files: (op, r) => { if (op === 'insert') r.s3 = window.__fakeDb.s3_documents.find((d) => d.id === r.s3_document_id) } }
      })
      const cell = row(page, 'Подрядчик 01')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), cell.locator('.tcpf-quick-actions button', { hasText: '+ Документ' }).click()])
      await chooser.setFiles({ name: 'Договор подряда.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') })
      await docItems(cell).nth(1).waitFor({ timeout: 10000 })
      const look = async (item) => item.evaluate((li) => ({
        name: li.querySelector('.tcpf-file-name').textContent,
        color: getComputedStyle(li.querySelector('.tcpf-ftype')).color,
      }))
      assert.deepEqual(await look(kpItems(cell).nth(1)), { name: 'КП Подрядчик 01', color: 'rgb(21, 128, 61)' })
      assert.deepEqual(await look(docItems(cell).first()), { name: 'Выписка ЕГРЮЛ', color: 'rgb(220, 38, 38)' })
      assert.deepEqual(await look(docItems(cell).nth(1)), { name: 'Договор подряда', color: 'rgb(37, 99, 235)' })
      assert.match(await docItems(cell).nth(1).locator('.tcpf-file').getAttribute('title'), /^Открыть: Договор подряда\.docx \(Документ Word/)
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
      assert.deepEqual(await items.locator('.tcpf-ver').allTextContents(), ['заменена 21.10.26', `заменена ${today}`])
      assert.deepEqual(await items.locator('.tcpf-vtag').allTextContents(), ['в1', 'в2', 'в3'])
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

  it('«Свернуть всё»: весь тендер компактно — сводка КП, первый контакт, примечание строкой; стрелка раскрывает КП одного; выбор помнится', async () => {
    const { page, errors, close } = await openCard('&cpContacts=1')
    try {
      const toggle = page.locator('.participants-section .tcpf-collapse-toggle')
      assert.match(await toggle.textContent(), /Свернуть всё/)
      assert.equal(await toggle.locator('input').isChecked(), false)
      const heightOf = () => row(page, 'Подрядчик 01').evaluate((tr) => tr.getBoundingClientRect().height)
      const tall = await heightOf()
      await toggle.click()
      await page.waitForFunction(() => document.querySelectorAll('.participants-section .tcpf-kp').length === 0)
      assert.equal(await page.locator('.participants-section .tcpf-item').count(), 0, 'и документы свёрнуты')
      assert.match(await page.locator('.participants-section table').getAttribute('class'), /is-compact/)
      // Сводка свёрнутого: «Файлов: N» — в строке со стрелкой, проверка текущих версий — строкой под ней.
      const one = row(page, 'Подрядчик 01')
      assert.equal(await one.locator('.tcpf-summary').getAttribute('aria-expanded'), 'false')
      assert.equal((await one.locator('.tcpf-summary').textContent()).trim(), 'Файлов: 3')
      assert.equal((await one.locator('.tcpf-sum-more').textContent()).trim(), 'на проверке 1')
      assert.match(await row(page, 'Подрядчик 02').locator('.tcpf-sum-more').textContent(), /проверено 1.*замечания 1/)
      // Контакты — первый одной строкой (ФИО, телефон и почта), остальные — «ещё N», все — в подсказке; вида работ нет.
      const contacts = one.locator('.tcc-compact')
      assert.equal(await contacts.locator('.tcc-name').textContent(), 'Шахмиров Джабраил Алиевич')
      assert.deepEqual(await contacts.locator('.tcc-line').evaluateAll((as) => as.map((a) => a.getAttribute('href'))),
        ['tel:+79637950185', 'mailto:shahmirov.dzhabrail@yahoo.com'])
      // Почты нет — только телефон.
      const second = row(page, 'Подрядчик 02').locator('.tcc-compact')
      assert.deepEqual(await second.locator('.tcc-line').evaluateAll((as) => as.map((a) => a.getAttribute('href'))), ['tel:+77015551234'])
      assert.equal(await contacts.locator('.tcc-more').textContent(), 'ещё 1')
      assert.match(await contacts.getAttribute('title'), /Петров Пётр, Сметчик, smeta@example\.invalid/)
      assert.equal(await one.locator('.tc-company-sub').isVisible(), false)
      const short = await heightOf()
      assert.ok(short < tall / 2, `строка подрядчика ниже вдвое: ${Math.round(tall)} → ${Math.round(short)}`)
      // Загрузка — и в свёрнутом виде.
      assert.equal(await one.locator('.tcpf-quick-actions button', { hasText: '+ КП' }).count(), 1)
      // Стрелка раскрывает только этого участника.
      await one.locator('.tcpf-summary').click()
      assert.equal(await kpItems(one).count(), 2)
      assert.equal(await kpItems(row(page, 'Подрядчик 02')).count(), 0)
      assert.equal(await page.evaluate(() => localStorage.getItem('tenders:participantsCollapsed')), '1')
      // Снятая галочка раскрывает всех.
      await toggle.click()
      assert.equal(await kpItems(row(page, 'Подрядчик 02')).count(), 2)
      assert.equal(await one.locator('.tcc-item').count(), 2, 'контакты — снова полностью')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    // Выбор общий с реестром: в раскрытой строке тендера галочка уже стоит.
    const reg = await openPage('/tenders/construction')
    try {
      const { page, errors } = reg
      await page.evaluate(() => localStorage.setItem('tenders:participantsCollapsed', '1'))
      await page.reload()
      const search = page.locator('input[placeholder^="№, объект"]')
      await search.waitFor({ timeout: 120000 })
      await search.fill('200')
      await page.locator('.expand-toggle').first().click()
      const toolbar = page.locator('.expanded-cp-toolbar')
      await toolbar.locator('.tcpf-collapse-toggle').waitFor({ timeout: 30000 })
      assert.equal(await toolbar.locator('.tcpf-collapse-toggle input').isChecked(), true)
      // Галочка — справа от «Копировать email».
      const order = await toolbar.evaluate((el) => [...el.children].map((c) => c.textContent.trim()))
      assert.ok(order.indexOf('Свернуть всё') > order.findIndex((t) => /Копировать email/.test(t)), order.join(' | '))
      await page.locator('.expanded-cp-table-wrap .tcpf[aria-busy="false"] .tcpf-summary').first().waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.expanded-cp-table-wrap .tcpf-kp').count(), 0)
      assert.match(await page.locator('.expanded-cp-table-wrap table').getAttribute('class'), /is-compact/)
      assert.deepEqual(errors, [])
    } finally {
      await reg.close()
    }
  })

  it('без права правки (экономист, инженер): «Свернуть всё» — за заголовком, таблица во всю ширину, справа нет пустой колонки', async () => {
    for (const query of ['&canEdit=0', '']) {
      const card = await openCard(query)
      try {
        const { page, errors } = card
        const place = await page.evaluate(() => {
          const sec = document.querySelector('.participants-section')
          const title = sec.querySelector('.tc-section-title h3').getBoundingClientRect()
          const toggle = sec.querySelector('.tc-section-title .tcpf-collapse-toggle').getBoundingClientRect()
          const wrap = sec.querySelector('.table-container')
          const pad = parseFloat(getComputedStyle(wrap).paddingLeft) + parseFloat(getComputedStyle(wrap).paddingRight)
          return {
            gap: toggle.left - title.right,
            free: wrap.clientWidth - pad - sec.querySelector('table').getBoundingClientRect().width,
            invite: sec.querySelectorAll('.section-header .btn-primary').length,
          }
        })
        assert.ok(place.gap >= 0 && place.gap < 24, `галочка сразу за заголовком: ${place.gap}`)
        assert.ok(Math.abs(place.free) < 1, `таблица во всю ширину: свободно ${place.free}px`)
        assert.equal(place.invite, query ? 0 : 1)
        assert.deepEqual(errors, [])
      } finally {
        await card.close()
      }
    }
    const reg = await openPage('/tenders/construction', '&canEdit=0')
    try {
      const { page, errors } = reg
      const search = page.locator('input[placeholder^="№, объект"]')
      await search.waitFor({ timeout: 120000 })
      await search.fill('200')
      await page.locator('.expand-toggle').first().click()
      await page.locator('.expanded-cp-table-wrap .tcpf[aria-busy="false"]').first().waitFor({ timeout: 30000 })
      const cols = await page.locator('.expanded-cp-table-wrap table').evaluate((t) => ({
        heads: [...t.tHead.rows[0].cells].map((th) => th.textContent.trim()),
        cells: t.tBodies[0].rows[0].cells.length,
      }))
      assert.equal(cols.heads.at(-1), 'Примечание', cols.heads.join(' | '))
      assert.equal(cols.cells, cols.heads.length)
      assert.deepEqual(errors, [])
    } finally {
      await reg.close()
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
