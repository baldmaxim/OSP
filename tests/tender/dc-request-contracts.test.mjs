// Заявки на ДС ↔ договоры (миграция 20261109, обе базы) и «есть договор» у контрагентов:
//   • номер договора и номер ДС — раздельно: договор из реестра «Договоры и ДС» (договоры контрагента заявки,
//     единственный по объекту подставляется сам), «№ ДС» — текстом, «занесена в ДС» — ДС этого договора (с тем же
//     номером — подставляется само или «связать с ДС»);
//   • подразделение заявки — коды подразделений ВОР, фильтр как у тендеров; колонки «Задачи» нет;
//   • карточка контрагента: заявки на ДС по его договорам — отработанные и занесённые в ДС;
//   • реестр контрагентов: галочка «Договор» (заключённый договор — «Завершено» или есть дата подписания; сторона
//     или прикреплён вручную) и фильтр «С договором»;
//   • без колонок в базе — реестр заявок как раньше.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  amendmentLabel, amendmentsOf, autoContractFor, contractChoicesFor, contractLabel, dsNumberKey, groupDcRequestsByContract,
  matchAmendment, normalizeDocNumber, summarizeDcRequests,
} from '../../src/utils/dcRequestContracts.js'
import { concludedContractsByCounterparty, isConcludedContract } from '../../src/utils/counterpartyDocs.js'

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')

const K = (id, over = {}) => ({ id, record_type: 'dp', deleted_at: null, status: 'completed', counterparty_id: 'cp-1',
  object_id: 'o-1', contract_number: null, contract_date: null, parent_contract_id: null, root_contract_id: null, ...over })

describe('Заявка на ДС ↔ договор: правила', () => {
  it('номер ДС сравнивается по сути: «ДС №5 от …», «ДС-5», «5» — одно; приложение к другому ДС — нет', () => {
    for (const v of ['ДС №5 от 12.01.26', 'ДС-5', '5', 'дс5', 'Доп. соглашение № 5', ' ДС 5 ']) assert.equal(dsNumberKey(v), '5', v)
    assert.equal(dsNumberKey('ДС №5а'), '5а')
    assert.notEqual(dsNumberKey('№1 к ДС18 к дог СУ2-ЗИЛ33'), '1')
    assert.equal(dsNumberKey(''), '')
    assert.equal(normalizeDocNumber('ДС№4 к догСУ2-ЗИЛ-С/П-Э006-13 от 30.01.25г'), 'дс№4кдогсу2зилспэ00613от300125г')
  })

  it('договоры контрагента: объект выбран — только его и без объекта; единственный по объекту — сам; чужие, ДС и удалённые — нет', () => {
    const contracts = [
      K('a', { contract_date: '2026-01-01' }), K('b', { object_id: 'o-2', contract_date: '2026-05-01' }),
      K('c', { object_id: 'o-2', contract_date: '2025-01-01' }), K('x', { counterparty_id: 'cp-2' }),
      K('del', { deleted_at: '2026-10-01' }), K('ds', { record_type: 'ds_extra', root_contract_id: 'a' }),
      K('three', { counterparty_id: 'cp-9', object_id: 'o-3' }), K('none', { object_id: null, contract_date: '2026-09-01' }),
    ]
    // 28.10: договоры другого объекта (a — «o-1») не предлагаются; без объекта — после договоров объекта.
    assert.deepEqual(contractChoicesFor(contracts, 'cp-1', 'o-2').map(c => c.id), ['b', 'c', 'none'])
    // Объекта у заявки нет — все договоры контрагента, свежие выше.
    assert.deepEqual(contractChoicesFor(contracts, 'cp-1', null).map(c => c.id), ['none', 'b', 'a', 'c'])
    assert.equal(autoContractFor(contracts, 'cp-1', 'o-1')?.id, 'a')
    assert.equal(autoContractFor(contracts, 'cp-1', 'o-2'), null, 'два договора по объекту — не угадываем')
    assert.equal(autoContractFor(contracts, 'cp-1', null), null)
    // Вторая сторона договора (contract_counterparties) тоже видит договор.
    const parties = new Map([['three', new Set(['cp-1'])]])
    assert.equal(autoContractFor(contracts, 'cp-1', 'o-3', parties)?.id, 'three')
  })

  it('ДС договора и «занесена в ДС» по номеру — только однозначное совпадение', () => {
    const contracts = [
      K('a'), K('a1', { record_type: 'ds_extra', root_contract_id: 'a', parent_contract_id: 'a', contract_number: 'ДС №3' }),
      K('a2', { record_type: 'ds_vor', root_contract_id: 'a', parent_contract_id: 'a1', contract_number: '4' }),
      K('b1', { record_type: 'ds_extra', root_contract_id: 'b', contract_number: 'ДС-3' }),
    ]
    assert.deepEqual(amendmentsOf(contracts, 'a').map(c => c.id), ['a1', 'a2'])
    assert.equal(matchAmendment('ДС-3', amendmentsOf(contracts, 'a'))?.id, 'a1')
    assert.equal(matchAmendment('дс 4', amendmentsOf(contracts, 'a'))?.id, 'a2')
    assert.equal(matchAmendment('ДС 7', amendmentsOf(contracts, 'a')), null)
    assert.equal(matchAmendment('', amendmentsOf(contracts, 'a')), null)
    assert.equal(contractLabel({ contract_number: 'П-15/26', contract_date: '2026-03-02' }), '№ П-15/26 от 02.03.2026')
    assert.equal(contractLabel({ contract_number: null }), 'без номера')
    assert.equal(amendmentLabel({ contract_number: 'ДС №3', contract_date: '2026-05-10' }), 'ДС №3 от 10.05.2026')
    assert.equal(amendmentLabel({ contract_number: '4' }), 'ДС № 4')
  })

  it('карточка контрагента: группы по договору (без договора — в конце), отработано и в ДС — отдельно', () => {
    const docs = new Map([['a', K('a', { contract_date: '2025-01-01' })], ['b', K('b', { contract_date: '2026-01-01' })]])
    const reqs = [
      { id: 1, contract_id: 'a', status: 'completed', amendment_id: 'a1' }, { id: 2, contract_id: null, status: 'in_work' },
      { id: 3, contract_id: 'b', status: 'completed', amendment_id: null }, { id: 4, contract_id: 'gone', status: 'contract_check' },
    ]
    const groups = groupDcRequestsByContract(reqs, docs)
    assert.deepEqual(groups.map(g => [g.contract?.id || null, g.requests.map(r => r.id)]), [['b', [3]], ['a', [1]], [null, [2, 4]]])
    assert.deepEqual(summarizeDcRequests(reqs), { total: 4, done: 2, inDs: 1 })
  })

  it('заключённый договор — «Завершено» или дата подписания; сторона, вторая сторона и ручная привязка; один раз', () => {
    assert.equal(isConcludedContract(K('a', { status: 'in_work', signed_date: '2026-01-01' })), true)
    assert.equal(isConcludedContract(K('a', { status: 'in_work' })), false)
    assert.equal(isConcludedContract(K('a', { record_type: 'ds_extra' })), false)
    assert.equal(isConcludedContract(K('a', { deleted_at: '2026-01-01' })), false)
    const counts = concludedContractsByCounterparty(
      [K('a'), K('b', { status: 'new_request' }), K('c', { counterparty_id: 'cp-2' })],
      [{ contract_id: 'c', counterparty_id: 'cp-1' }, { contract_id: 'b', counterparty_id: 'cp-3' }, { contract_id: 'a', counterparty_id: 'cp-1' }],
      [{ contract_id: 'c', counterparty_id: 'cp-4' }],
    )
    assert.deepEqual(Object.fromEntries(counts), { 'cp-1': 2, 'cp-2': 1, 'cp-4': 1 })
  })
})

describe('Миграция 20261109: обе базы', () => {
  it('те же колонки, ограничение, договор прежних заявок и «Шаблон ДГП»; номера сравниваются как normalizeDocNumber', () => {
    const files = ['supabase/migrations/20261109_contracts_dc_requests.sql', 'migration/yandex/20261109_contracts_dc_requests.sql']
    const bodies = files.map(read)
    for (const [i, sql] of bodies.entries()) {
      for (const col of ['contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL',
        'amendment_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL', 'division text']) {
        assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `${files[i]}: ${col}`)
      }
      assert.match(sql, /division IN \('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'\)/)
      assert.match(sql, /INSERT INTO public\.section_templates \(code, title\) VALUES \('contracts_dgp', 'Шаблон ДГП'\)/)
      assert.match(sql, /WHERE t\.id = m\.id AND t\.contract_id IS NULL/, 'заполненный договор не трогается')
      assert.match(sql, /\[\[:space:\]_\.\/\\\\–—-\]/, 'набор символов — как в normalizeDocNumber')
    }
    assert.doesNotMatch(bodies[1], /\bBEGIN;|\bCOMMIT;|TO authenticated/, 'Яндекс: без транзакции и ролей Supabase')
    // Коды подразделений — те же, что у тендеров.
    const codes = [...read('src/utils/vorDivisions.js').matchAll(/value: '([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual(codes, ['monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'])
    assert.ok(read('tests/db/baseline/candidate-migrations.txt').includes('20261109_contracts_dc_requests.sql'))
  })
})

const launch = browserLaunchOptions()

describe('Договоры в заявках на ДС и у контрагентов', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  const openPage = async (query, ready, viewport = { width: 1800, height: 1000 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${query}`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const DC = 'route=/dc-requests&dcStats=1&dcNumbers=1&latency=0'
  const row = (page, no) => page.locator('.dcr-table tbody tr', { has: page.locator('td.ui-rownum', { hasText: new RegExp(`^${no}$`) }) })
  const dcRow = (page, id) => page.evaluate((i) => {
    const r = window.__fakeDb.dc_requests.find(x => x.id === i)
    return { contract_id: r.contract_id, amendment_id: r.amendment_id, division: r.division, ds_number: r.ds_number }
  }, id)

  it('реестр заявок: договор и № ДС — в одном столбце, без «Задач»; договор и ДС — из таблицы, подразделение — плашкой', async () => {
    const { page, errors, close } = await openPage(`${DC}&dcContracts=1`, '.dcr-table tbody tr')
    try {
      const headers = (await page.locator('.dcr-table thead th').allInnerTexts()).map(h => h.trim())
      assert.ok(!headers.includes('Задачи') && !headers.includes('№ ДС'), headers.join(' | '))
      assert.equal(headers[headers.indexOf('Контрагент') + 1], 'Договор и № ДС')
      // Номер ДС — под выбором договора, с подписью.
      assert.match(await row(page, 12).locator('td.dcr-cell-contract .dcr-dsnum-line').innerText(), /^№ ДС:\s*ДС-3$/)

      // d4 (№ 15) — занесена в ДС №3; d2 (№ 12) — ДС не отмечено, номер совпал — «связать с ДС».
      await row(page, 15).locator('.dcr-in-ds', { hasText: 'в ДС' }).waitFor({ timeout: 10000 })
      assert.equal(await row(page, 15).locator('.dcr-in-ds').getAttribute('href'), '/contracts/kd-1-ds3')
      await row(page, 12).getByRole('button', { name: 'связать с ДС' }).click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd2').amendment_id === 'kd-1-ds3')
      await row(page, 12).locator('.dcr-in-ds').waitFor({ timeout: 5000 })

      // d3 (№ 14, «ЖК Бета») — два договора по объекту, выбора сам не делает; договоры другого объекта (П-15/26 —
      // «ЖК Альфа») и другого подрядчика не предлагаются, договор без объекта — последним, с пометкой.
      const select = row(page, 14).getByRole('combobox', { name: 'Договор заявки' })
      const options = await select.locator('option').allTextContents()
      assert.deepEqual(options, ['Не выбран', '№ Г-8 от 15.01.2026', '№ Г-7 от 20.11.2025', '№ Б/Н-1 от 01.06.2025 · объект не указан'])
      await select.selectOption({ label: '№ Г-8 от 15.01.2026' })
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd3').contract_id === 'kd-3')
      const audit = await page.evaluate(() => window.__fakeDb.dc_request_audit_log.filter(a => a.dc_request_id === 'd3').map(a => a.description))
      assert.ok(audit.some(d => /^Договор: — → № Г-8 от 15\.01\.2026$/.test(d)), audit.join(' | '))

      // Подразделение — под описанием; у d1 (№ 17) «Монолит».
      assert.match(await row(page, 17).locator('.dcr-division').innerText(), /Монолит/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('фильтр по подразделению — как у тендеров; ?counterparty= — реестр сразу по контрагенту', async () => {
    const { page, errors, close } = await openPage(`${DC}&dcContracts=1`, '.dcr-table tbody tr')
    try {
      const nums = async () => (await page.locator('.dcr-table tbody td.ui-rownum').allInnerTexts()).map(Number).sort((a, b) => a - b)
      assert.deepEqual(await nums(), [11, 12, 14, 15, 17])
      await page.locator('.dcr-toolbar .fdrop-trigger', { hasText: 'Все подразделения' }).click()
      // Числа — по заявкам вкладки без этого фильтра: у d1 «Монолит», у d3 «ЭОМ/СС», у остальных — не указано.
      assert.deepEqual(await page.locator('.fdrop-panel .fdrop-option-text').allTextContents(),
        ['Монолит (1)', 'НВФ/СПК (0)', 'Общестроительные работы (0)', 'ОВиВК (0)', 'ЭОМ/СС (1)', 'Отделка (0)', 'Не указано (3)'])
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'ЭОМ/СС' }).click()
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('.dcr-table tbody td.ui-rownum').length === 1)
      assert.deepEqual(await nums(), [14])
      await page.locator('.dcr-filter-clear').click()
      await page.waitForFunction(() => document.querySelectorAll('.dcr-table tbody td.ui-rownum').length === 5)
      assert.deepEqual(errors, [])
    } finally { await close() }

    const p2 = await openPage(`route=${encodeURIComponent('/dc-requests?counterparty=cp-2')}&dcStats=1&latency=0`, '.dcr-table tbody tr')
    try {
      // У «Подрядчика 02» заявок нет — фильтр включён, список пуст.
      await p2.page.locator('.dcr-filter-drop.is-active').first().waitFor({ timeout: 10000 })
      await p2.page.locator('.dcr-table tbody td.no-data').waitFor({ timeout: 10000 })
      assert.deepEqual(p2.errors, [])
    } finally { await p2.close() }
  })

  it('форма: договор подставляется сам по контрагенту и объекту, ДС — по номеру; запись — раздельно', async () => {
    const { page, errors, close } = await openPage(`${DC}&dcContracts=1`, '.dcr-table tbody tr')
    try {
      await row(page, 17).getByRole('button', { name: 'Редактировать' }).click()
      const contract = page.locator('#dcr-form-contract')
      await contract.waitFor({ timeout: 10000 })
      // d1: «Подрядчик 01», «ЖК Альфа» — договор один, подставлен; «№ ДС» → ДС №3 этого договора.
      await page.locator('#dcr-form-dsnum').fill('3')
      assert.equal(await contract.inputValue(), 'kd-1')
      assert.equal(await page.locator('#dcr-form-amendment').inputValue(), 'kd-1-ds3')
      await page.locator('#dcr-form-dsnum').fill('7')
      assert.equal(await page.locator('#dcr-form-amendment').inputValue(), '', 'другой номер — не занесена')
      await page.locator('#dcr-form-division').selectOption({ label: 'Отделка' })
      await page.getByRole('button', { name: /^Сохранить/ }).click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd1').contract_id === 'kd-1')
      assert.deepEqual(await dcRow(page, 'd1'), { contract_id: 'kd-1', amendment_id: null, division: 'finishing', ds_number: '7' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без колонок договора в базе — реестр как раньше: без «Договора», фильтра и подразделения; «Задач» нет', async () => {
    const { page, errors, close } = await openPage(DC, '.dcr-table tbody tr')
    try {
      const headers = (await page.locator('.dcr-table thead th').allInnerTexts()).map(h => h.trim())
      assert.ok(!headers.includes('Договор и № ДС') && !headers.includes('Задачи'), headers.join(' | '))
      assert.equal(headers[headers.indexOf('Контрагент') + 1], '№ ДС')
      assert.equal(await page.locator('.dcr-division').count(), 0)
      await row(page, 17).getByRole('button', { name: 'Редактировать' }).click()
      await page.locator('#dcr-form-dsnum').waitFor({ timeout: 10000 })
      assert.equal(await page.locator('#dcr-form-contract').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // 28.10.2026: с «Договором», «Статусом ОКС» и «Комментарием» таблица выросла до 124.75rem, а порог overflow-x: clip
  // остался под 98.75rem — на широком мониторе «Комментарий» и «Действия» уходили за край без прокрутки. Теперь
  // связанное — в одном столбце (99.5rem, как до этих столбцов), а clip — только там, где таблица помещается.
  it('реестр помещается в окно: № ДС — под договором, ответственный — под статусом, комментарий — под статусом ОКС', async () => {
    // Обвязка приложения и полоса 217px слева: сайдбар 200px + полоса прокрутки 17px (у безголового Chromium её нет).
    for (const width of [1880, 1920, 2000, 2400]) {
      const { page, errors, close } = await openPage(`${DC}&dcContracts=1&dcSubmission=1&shell=1`, '.dcr-table tbody tr', { width, height: 1000 })
      try {
        await page.addStyleTag({ content: '.layout { display: flex; } .layout::before { content: ""; flex: 0 0 217px; }' })
        // Помещается ли таблица, страница узнаёт по изменению размера места под неё — кадр-другой.
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
        const m = await page.evaluate(() => {
          const t = document.querySelector('.dcr-table')
          const c = t.closest('.table-container')
          const ths = [...t.querySelectorAll('thead th')]
          return {
            overflow: getComputedStyle(c).overflowX,
            lastRight: ths.at(-1).getBoundingClientRect().right,
            boxRight: c.getBoundingClientRect().right,
            headers: ths.map(th => th.innerText.trim()),
          }
        })
        assert.deepEqual(m.headers, ['№', 'Объект', 'Контрагент', 'Договор и № ДС', 'Описание ДС', 'Сумма, руб. с НДС 22%',
          'Статус и ответственный', 'Документы', 'Статус ОКС', 'Действия'])
        // Срезать без прокрутки нельзя: когда горизонтальной прокрутки нет (hidden — с 28.10, когда таблица
        // прокручивается в своём блоке под закреплённой шапкой; раньше clip), «Действия» целиком внутри; от 1920 окна
        // таблица помещается вся.
        if (['clip', 'hidden'].includes(m.overflow) || width >= 1920) assert.ok(m.lastRight <= m.boxRight + 0.5, `${width}: ${JSON.stringify(m)}`)
        if (width === 1880) assert.equal(m.overflow, 'auto', 'не помещается — прокрутка, а не обрезка')
        if (width === 1920) {
          assert.match(await row(page, 12).locator('.dcr-resp-line').innerText(), /Юристов Ю\.\s*Ю\./)
          assert.match(await row(page, 14).locator('.dcr-resp-line').innerText(), /Не назначен/)
          // Комментарий статуса ОКС правит только «Отдел по удорожанию» (20261118) — у администратора стенда он текстом.
          assert.equal((await row(page, 12).locator('td.dcr-cell-sub .dcr-sub-comment-text').innerText()).trim(), 'Письмо № 123')
        }
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  })

  const CP = 'route=/general/counterparties&cps=6&cpCard=1&items=20&latency=0'

  it('контрагенты: галочка «Договор» и фильтр «С договором»', async () => {
    const { page, errors, close } = await openPage(CP, 'table.compact-table tbody tr.table-row')
    try {
      const mark = (name) => page.locator('table.compact-table tbody tr.table-row', { hasText: name }).locator('td.col-contract .cp-contract-mark')
      // cp-1: k-2 (вторая сторона, «Завершено») и k-4 (прикреплён вручную); cp-3 — k-2; cp-5 — k-4; cp-4 — только «В работе».
      await mark('Подрядчик 01').waitFor({ timeout: 10000 })
      assert.equal(await mark('Подрядчик 01').innerText(), '2')
      assert.equal(await mark('Подрядчик 04').count(), 0)
      const filter = page.getByRole('button', { name: /С договором/ })
      assert.match(await filter.innerText(), /С договором\s*3/)
      await filter.click()
      assert.equal(await filter.getAttribute('aria-pressed'), 'true')
      const names = await page.locator('table.compact-table tbody tr.table-row .company-name').allInnerTexts()
      assert.deepEqual(names, ['Подрядчик 01', 'Подрядчик 03', 'Подрядчик 05'])
      await filter.click()
      await page.waitForFunction(() => document.querySelectorAll('table.compact-table tbody tr.table-row').length === 6)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('карточка контрагента: заявки на ДС по договорам — отработанные и занесённые в ДС', async () => {
    const { page, errors, close } = await openPage(`${CP}&dcStats=1&dcNumbers=1&dcContracts=1`, 'table.compact-table tbody tr.table-row')
    try {
      await page.locator('table.compact-table tbody tr.table-row', { hasText: 'Подрядчик 01' }).locator('.company-name').click()
      const section = page.locator('.cpg-dcr')
      await section.locator('.cpg-dcr-table').waitFor({ timeout: 10000 })
      assert.match(await section.locator('.cpg-dcr-count').innerText(), /Заявок на ДС: 5 · отработано: 2 · занесено в ДС: 1/)
      const groups = await section.locator('tr.cpg-dcr-group').allInnerTexts()
      assert.match(groups[0], /Договор № П-15\/26 от 02\.03\.2026.*заявок: 2 · отработано: 1 · в ДС: 1/s)
      assert.match(groups.at(-1), /Договор не указан/)
      const d4 = section.locator('tbody tr', { hasText: '№ 15' })
      assert.match(await d4.innerText(), /Отработана/)
      assert.equal(await d4.getByRole('link', { name: 'ДС №3 от 10.05.2026' }).getAttribute('href'), '/contracts/kd-1-ds3')
      assert.equal(await section.getByRole('link', { name: 'Открыть в реестре заявок' }).getAttribute('href'), '/dc-requests?counterparty=cp-1')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
