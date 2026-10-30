// «Заявки на ДС»: ответственный за «Статус ОКС» — выбор под статусом только из сотрудников «Отдела по удорожанию»
// (роль udorojanie), фильтр по ответственному — само название столбца «Статус ОКС»; миграция 20261117, обе базы.
// С 30.10.2026 (миграция 20261118 — dc-request-submission-access.test.mjs) статус ОКС и ответственного меняет только
// отдел, а сменивший статус сам становится ответственным; на стенде — вход с ролью отдела (asRole=udorojanie).
// Ограничение и проверки миграции — на временном PostgreSQL (локальный или Docker); реестр — в Chromium, стенд
// tests/tender/ui (route=/dc-requests&dcStats=1&dcSubmission=1&dcSubResp=1).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import {
  NO_SUBMISSION_RESP, costIncreaseEmployees, hasSubmissionRespColumns, isCostIncreaseRole, submissionRespKey,
} from '../../src/utils/dcRequestOptions.js'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = path.join(ROOT, 'supabase/migrations/20261108_dc_request_submission_check.sql')
const SUPABASE = path.join(ROOT, 'supabase/migrations/20261117_dc_request_submission_responsible.sql')
const YANDEX = path.join(ROOT, 'migration/yandex/20261117_dc_request_submission_responsible.sql')
const YANDEX_CHECK = path.join(ROOT, 'migration/yandex/20261117_dc_request_submission_responsible.check.sql')
const PROD_CHECK = path.join(ROOT, 'migration/backup/checks/20261117.sql')

describe('Заявки на ДС: кто может быть ответственным за статус ОКС', () => {
  it('роль «Отдел по удорожанию» — по ключу udorojanie или по названию', () => {
    assert.equal(isCostIncreaseRole('udorojanie', 'Отдел по удорожанию'), true)
    assert.equal(isCostIncreaseRole('udorojanie', undefined), true, 'название не загрузилось — ключа достаточно')
    assert.equal(isCostIncreaseRole('cost_dept', 'Отдел по удорожанию'), true, 'ключ другой — по названию')
    assert.equal(isCostIncreaseRole('smetno', 'Сметно-технический отдел'), false)
    assert.equal(isCostIncreaseRole('admin', 'Администратор'), false)
    assert.equal(isCostIncreaseRole(null, null), false)
  })

  it('из справочника — только сотрудники отдела, по алфавиту', () => {
    const list = costIncreaseEmployees([
      { user_id: 'a', display_name: 'Яковлев Я. Я.', role: 'udorojanie' },
      { user_id: 'b', display_name: 'Петров П. П.', role: 'snabjenie' },
      { user_id: 'c', display_name: 'Абрамова А. А.', role: 'udorojanie' },
      { user_id: '', display_name: 'Без id', role: 'udorojanie' },
    ], { udorojanie: 'Отдел по удорожанию', snabjenie: 'Снабжение' })
    assert.deepEqual(list.map(e => e.user_id), ['c', 'a'])
    assert.deepEqual(costIncreaseEmployees(null), [])
  })

  it('выбор и фильтр — только когда в базе есть колонки; без ответственного — «не назначен»', () => {
    assert.equal(hasSubmissionRespColumns([{ id: 'a', submission_check: 'not_checked' }]), false)
    assert.equal(hasSubmissionRespColumns([{ id: 'a', submission_resp_user_id: null }]), true)
    assert.equal(submissionRespKey({ submission_resp_user_id: 'u1' }), 'u1')
    assert.equal(submissionRespKey({ submission_resp_user_id: null }), NO_SUBMISSION_RESP)
  })

  it('миграции Supabase и базы Яндекса делают одно и то же', () => {
    const body = (file) => fs.readFileSync(file, 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '10s');\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    assert.equal(body(YANDEX), body(SUPABASE))
  })
})

// Окружение Supabase в минимуме (как в dc-request-submission.test.mjs): роли, auth.uid() из токена, своя строка
// user_roles, заявки с правилом «сотрудник — всё».
const BOOTSTRAP = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
GRANT USAGE ON SCHEMA auth, public TO authenticated;
CREATE TABLE public.user_roles (user_id uuid PRIMARY KEY, full_name text);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_roles_select_self ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.user_roles TO authenticated;
CREATE TABLE public.dc_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ds_number text, status text DEFAULT 'contract_check', updated_at timestamptz
);
ALTER TABLE public.dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dc_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dc_requests_all ON public.dc_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.dc_requests TO authenticated;
INSERT INTO public.dc_requests (ds_number) VALUES ('old-1'), ('old-2');
`
const EMPLOYEE = '11111111-1111-4111-8111-111111111111'
const COST = '44444444-4444-4444-8444-444444444444'

describe('Ответственный за статус ОКС в базе', { skip: pgAvailable() ? false : 'нет PostgreSQL (initdb/pg_ctl или Docker)', timeout: 300000 }, () => {
  let db
  const row = (ds) => JSON.parse(db.exec(`SELECT row_to_json(r) FROM (SELECT submission_resp_user_id, submission_resp_name,
    submission_check FROM public.dc_requests WHERE ds_number = '${ds}') r;`).trim())
  const lines = (out) => out.split('\n').filter(Boolean)

  before(() => {
    db = new TestDatabase()
    db.start()
    db.exec(BOOTSTRAP)
    db.applyFile(BASE)
  })
  after(() => db?.stop())

  it('проверка прода до миграции — FAIL, а не ошибка', () => {
    const out = lines(db.exec(fs.readFileSync(PROD_CHECK, 'utf8')))
    assert.ok(out.every(l => /^(OK|FAIL) /.test(l)), out.join('\n'))
    assert.ok(out.some(l => l.startsWith('FAIL ')), out.join('\n'))
  })

  it('прежние заявки — без ответственного; проверки миграции — только OK', () => {
    db.applyFile(SUPABASE)
    assert.deepEqual(row('old-1'), { submission_resp_user_id: null, submission_resp_name: null, submission_check: 'not_checked' })
    for (const file of [PROD_CHECK, YANDEX_CHECK]) {
      const out = lines(db.exec(fs.readFileSync(file, 'utf8')))
      assert.ok(out.length >= 4 && out.every(l => l.startsWith('OK ')), `${path.basename(file)}:\n${out.join('\n')}`)
    }
  })

  it('назначение и снятие пишутся; подпись статуса ОКС не меняется', () => {
    db.asUser(EMPLOYEE, `UPDATE public.dc_requests SET submission_resp_user_id = '${COST}',
      submission_resp_name = 'Удорожаев Иван Петрович' WHERE ds_number = 'old-1';`)
    assert.deepEqual(row('old-1'), {
      submission_resp_user_id: COST, submission_resp_name: 'Удорожаев Иван Петрович', submission_check: 'not_checked',
    })
    const stamp = db.exec(`SELECT submission_at IS NULL FROM public.dc_requests WHERE ds_number = 'old-1';`).trim()
    assert.equal(stamp, 't', 'ответственный — не смена статуса ОКС')
    db.asUser(EMPLOYEE, `UPDATE public.dc_requests SET submission_resp_user_id = NULL, submission_resp_name = NULL
      WHERE ds_number = 'old-1';`)
    assert.equal(row('old-1').submission_resp_user_id, null)
  })

  it('ФИО без ответственного и ФИО длиннее 300 символов база не принимает', () => {
    const orphan = db.tryAsUser(EMPLOYEE, `UPDATE public.dc_requests SET submission_resp_name = 'Кто-то' WHERE ds_number = 'old-2';`)
    assert.equal(orphan.ok, false)
    assert.match(orphan.error, /dc_requests_submission_resp_check/)
    const long = db.tryAsUser(EMPLOYEE, `UPDATE public.dc_requests SET submission_resp_user_id = '${COST}',
      submission_resp_name = repeat('я', 301) WHERE ds_number = 'old-2';`)
    assert.equal(long.ok, false)
    assert.match(long.error, /dc_requests_submission_resp_check/)
    assert.deepEqual(row('old-2'), { submission_resp_user_id: null, submission_resp_name: null, submission_check: 'not_checked' })
  })

  it('повтор миграции (и вариант базы Яндекса поверх) ничего не меняет', () => {
    db.asUser(EMPLOYEE, `UPDATE public.dc_requests SET submission_resp_user_id = '${COST}', submission_resp_name = 'Удорожаев И. П.'
      WHERE ds_number = 'old-2';`)
    const before = row('old-2')
    db.applyFile(SUPABASE)
    db.applyFile(YANDEX)
    assert.deepEqual(row('old-2'), before)
  })
})

describe('Реестр заявок на ДС: ответственный за статус ОКС', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(ROOT)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function open(extra = '') {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1920, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.dismiss() })
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&dcSubmission=1&latency=10&shell=1${extra}`)
    await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page, ds) => page.locator('.dcr-table tbody tr', { hasText: `ДС-${ds}` })
  const visibleIds = (page) => page.locator('.dcr-table tbody tr').evaluateAll(rows => rows
    .map(r => (r.textContent.match(/ДС-(d\d)/) || [])[1]).filter(Boolean))
  const panelOptions = (page) => page.locator('.fdrop-panel .fdrop-option').allTextContents()
  const pickerOptions = (page) => page.locator('.fdrop-panel .fdrop-option .dcr-resp-option').allTextContents()

  it('без колонок в базе — ни выбора, ни фильтра', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await page.locator('.dcr-table .dcr-sub-resp').count(), 0)
      assert.equal(await page.locator('.dcr-table thead .dcr-th-sub').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('выбор — только «Отдел по удорожанию»; назначение пишет id и ФИО, в журнал — ФИО', async () => {
    const { page, errors, close } = await open('&dcSubResp=1&asRole=udorojanie&asUser=ud-1')
    try {
      const d2 = rowOf(page, 'd2')
      assert.match(await d2.locator('.dcr-sub-resp').textContent(), /Удорожаев И\.\s*П\./)
      // Сметанин ушёл из отдела — виден по сохранённому ФИО, в списке — с пометкой.
      const d4 = rowOf(page, 'd4')
      assert.match(await d4.locator('.dcr-sub-resp').textContent(), /Сметанин О\.\s*О\./)

      const d1 = rowOf(page, 'd1')
      assert.match(await d1.locator('.dcr-sub-resp').textContent(), /Ответственный/)
      await d1.locator('.dcr-resp-fdrop .fdrop-trigger').click()
      // Петров (снабжение), Сметанин (сметный отдел) и Стендов (администратор) есть в справочнике, но не в отделе.
      assert.deepEqual(await pickerOptions(page), ['Не назначен', 'Анисимова Мария Сергеевна', 'Удорожаев Иван Петрович'])
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Анисимова' }).click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').submission_resp_user_id === 'ud-2')
      const saved = await page.evaluate(() => {
        const r = window.__fakeDb.dc_requests.find(x => x.id === 'd1')
        return [r.submission_resp_user_id, r.submission_resp_name]
      })
      assert.deepEqual(saved, ['ud-2', 'Анисимова Мария Сергеевна'])
      assert.match(await d1.locator('.dcr-sub-resp').textContent(), /Анисимова М\.\s*С\./)
      const audit = await page.evaluate(() => window.__fakeDb.dc_request_audit_log
        .filter(e => e.dc_request_id === 'd1').map(e => e.description))
      assert.deepEqual(audit, ['Ответственный за статус ОКС: — → Анисимова Мария Сергеевна'])

      await d4.locator('.dcr-resp-fdrop .fdrop-trigger').click()
      assert.deepEqual(await pickerOptions(page),
        ['Не назначен', 'Анисимова Мария Сергеевна', 'Удорожаев Иван Петрович', 'Сметанин Олег Олегович · не в отделе'])
      await page.keyboard.press('Escape')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('фильтр — нажатием на название «Статус ОКС»: по сотруднику и «Не назначен», сброс — крестиком', async () => {
    const { page, errors, close } = await open('&dcSubResp=1')
    try {
      const all = await visibleIds(page)
      assert.deepEqual([...all].sort(), ['d1', 'd2', 'd3', 'd4', 'd5'])
      const th = page.locator('.dcr-table thead th', { hasText: 'Статус ОКС' })
      // Отдельной плашки «Ответственный» нет: кнопка фильтра — само название столбца.
      const title = th.locator('.dcr-th-fdrop .fdrop-trigger')
      assert.equal((await th.innerText()).trim(), 'Статус ОКС')
      assert.equal(await th.locator('.fdrop-trigger').count(), 1)
      assert.match(await title.getAttribute('title'), /отобрать заявки по ответственному/)
      await title.click()
      const options = await panelOptions(page)
      assert.deepEqual(options.map(o => o.trim()), [
        'Не назначен (3)', 'Анисимова Мария Сергеевна (0)', 'Сметанин Олег Олегович (1)', 'Удорожаев Иван Петрович (1)',
      ])
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Удорожаев' }).click()
      await page.keyboard.press('Escape')
      assert.deepEqual(await visibleIds(page), ['d2'])
      assert.equal(await th.evaluate(el => el.classList.contains('dcr-th-filtered')), true)
      // Выбран — под названием кто выбран (Фамилия И. О., полное ФИО — в подсказке).
      assert.match(await th.locator('.dcr-th-sub-chosen').innerText(), /Удорожаев И\.\s*П\./)
      assert.match(await title.getAttribute('title'), /Удорожаев Иван Петрович/)

      await th.locator('.dcr-th-sub-clear').click()
      assert.deepEqual(await visibleIds(page), all)
      assert.equal(await th.locator('.dcr-th-sub-chosen').count(), 0)

      await title.click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Не назначен' }).click()
      await page.keyboard.press('Escape')
      assert.deepEqual((await visibleIds(page)).sort(), all.filter(id => id !== 'd2' && id !== 'd4').sort())
      // Общая кнопка «Сбросить» в панели снимает и этот фильтр.
      await page.locator('.dcr-filter-clear').click()
      assert.deepEqual(await visibleIds(page), all)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('не «Отдел по удорожанию» (администратор, без права правки) — только ФИО назначенного; фильтр — у всех', async () => {
    for (const extra of ['', '&canEdit=0']) {
      const { page, errors, close } = await open(`&dcSubResp=1${extra}`)
      try {
        assert.equal(await page.locator('.dcr-table .dcr-resp-fdrop').count(), 0, extra)
        assert.match(await rowOf(page, 'd2').locator('.dcr-sub-resp').textContent(), /Удорожаев И\.\s*П\./)
        assert.equal(await rowOf(page, 'd1').locator('.dcr-sub-resp').count(), 0)
        assert.equal(await page.locator('.dcr-table thead .dcr-th-fdrop').count(), 1)
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  })

  it('сменил статус ОКС — сам стал ответственным: id и ФИО из справочника, в журнал — оба изменения', async () => {
    const { page, errors, close } = await open('&dcSubResp=1&asRole=udorojanie&asUser=ud-2')
    try {
      const saved = (id) => page.evaluate((rid) => {
        const r = window.__fakeDb.dc_requests.find(x => x.id === rid)
        return [r.submission_check, r.submission_resp_user_id, r.submission_resp_name]
      }, id)
      // d1 — без ответственного, d2 — у Удорожаева: оба переходят к Анисимовой, сменившей статус.
      for (const [id, prev] of [['d1', '—'], ['d2', 'Удорожаев Иван Петрович']]) {
        const tr = rowOf(page, id)
        await tr.locator('select[aria-label="Статус ОКС"]').selectOption('incomplete')
        await page.waitForFunction((rid) => window.__fakeDb.dc_requests.find(x => x.id === rid).submission_resp_user_id === 'ud-2', id)
        assert.deepEqual(await saved(id), ['incomplete', 'ud-2', 'Анисимова Мария Сергеевна'])
        assert.match(await tr.locator('.dcr-sub-resp').textContent(), /Анисимова М\.\s*С\./)
        // Журнал пишется после ответа базы — ждём обе записи.
        await page.waitForFunction((rid) => window.__fakeDb.dc_request_audit_log
          .filter(e => e.dc_request_id === rid && e.field_name === 'submission_resp_user_id').length === 1, id)
        const audit = await page.evaluate((rid) => window.__fakeDb.dc_request_audit_log
          .filter(e => e.dc_request_id === rid).map(e => e.description), id)
        assert.ok(audit.includes(`Ответственный за статус ОКС: ${prev} → Анисимова Мария Сергеевна`), audit.join(' | '))
        assert.ok(audit.some(a => a.startsWith('Статус ОКС: ')), audit.join(' | '))
      }
      // Комментарий ответственного не меняет; уже ответственный — повторной записи в журнал нет.
      const d2 = rowOf(page, 'd2')
      await d2.locator('select[aria-label="Статус ОКС"]').selectOption('accepted')
      await page.waitForFunction(() => window.__fakeDb.dc_request_audit_log
        .some(e => e.dc_request_id === 'd2' && e.description?.includes('Принято в работу')))
      const respLog = await page.evaluate(() => window.__fakeDb.dc_request_audit_log
        .filter(e => e.dc_request_id === 'd2' && e.field_name === 'submission_resp_user_id').length)
      assert.equal(respLog, 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
