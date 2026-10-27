// «Заявки на ДС»: столбцы «Статус ОКС» (подаётся ли ДС заказчику) и «Комментарий» перед «Действиями» — миграция 20261108, обе базы.
// У всех заявок по умолчанию «Не проверено»; кто и когда сменил проверку, ставит триггер базы (ФИО — из user_roles,
// со страницы не подменить), правка одного комментария подпись не меняет. Тела миграций обеих баз совпадают.
// Триггер и проверки миграции — на временном PostgreSQL (локальный или Docker); реестр — в Chromium, стенд
// tests/tender/ui (route=/dc-requests&dcStats=1&dcSubmission=1).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import {
  SUBMISSION_DEFAULT, SUBMISSION_OPTIONS, hasSubmissionColumns, submissionNeedsComment,
} from '../../src/utils/dcRequestOptions.js'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const SUPABASE = path.join(ROOT, 'supabase/migrations/20261108_dc_request_submission_check.sql')
const YANDEX = path.join(ROOT, 'migration/yandex/20261108_dc_request_submission_check.sql')
const YANDEX_CHECK = path.join(ROOT, 'migration/yandex/20261108_dc_request_submission_check.check.sql')
const PROD_CHECK = path.join(ROOT, 'migration/backup/checks/20261108.sql')

describe('Заявки на ДС: варианты проверки', () => {
  it('пять вариантов, по умолчанию «Не проверено»; те же, что в ограничении базы', () => {
    assert.deepEqual(SUBMISSION_OPTIONS.map(o => o.label), [
      'Подано заказчику', 'Принято в работу (будет подаваться)', 'Не будет подаваться', 'Неполный комплект', 'Не проверено',
    ])
    assert.equal(SUBMISSION_DEFAULT, 'not_checked')
    const sql = fs.readFileSync(SUPABASE, 'utf8')
    const allowed = /CHECK \(submission_check IN \(([^)]*)\)\)/.exec(sql)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1))
    assert.deepEqual([...allowed].sort(), SUBMISSION_OPTIONS.map(o => o.value).sort())
    assert.match(sql, /submission_check text NOT NULL DEFAULT 'not_checked'/)
  })

  it('пояснение нужно у всех вариантов, кроме «Не проверено», и только пока комментария нет', () => {
    assert.equal(submissionNeedsComment({ submission_check: 'not_checked' }), false)
    assert.equal(submissionNeedsComment({}), false, 'колонки нет — как «Не проверено»')
    for (const value of ['submitted', 'accepted', 'not_submitted', 'incomplete']) {
      assert.equal(submissionNeedsComment({ submission_check: value, submission_comment: null }), true, value)
      assert.equal(submissionNeedsComment({ submission_check: value, submission_comment: '  ' }), true, value)
      assert.equal(submissionNeedsComment({ submission_check: value, submission_comment: 'Письмо № 1' }), false, value)
    }
  })

  it('столбцы — только когда в базе есть колонки', () => {
    assert.equal(hasSubmissionColumns([{ id: 'a' }]), false)
    assert.equal(hasSubmissionColumns([{ id: 'a', submission_check: 'not_checked' }]), true)
    assert.equal(hasSubmissionColumns([]), false)
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

// Окружение Supabase в минимуме: роли, auth.uid() из токена, user_roles со своей строкой для вошедшего (как
// user_roles_select_self_or_admin), заявки с правилом «сотрудник — всё» (проверка прав не в этой миграции).
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
const ESTIMATOR = '11111111-1111-4111-8111-111111111111'
const LAWYER = '22222222-2222-4222-8222-222222222222'
const NO_NAME = '33333333-3333-4333-8333-333333333333'

describe('Статус ОКС заявки на ДС в базе: подпись ставит триггер', { skip: pgAvailable() ? false : 'нет PostgreSQL (initdb/pg_ctl или Docker)', timeout: 300000 }, () => {
  let db
  const row = (ds) => JSON.parse(db.exec(`SELECT row_to_json(r) FROM (SELECT submission_check, submission_comment,
    submission_by, submission_by_name, submission_at IS NOT NULL AS stamped FROM public.dc_requests WHERE ds_number = '${ds}') r;`).trim())
  const lines = (out) => out.split('\n').filter(Boolean)

  before(() => {
    db = new TestDatabase()
    db.start()
    db.exec(BOOTSTRAP)
    db.exec(`INSERT INTO public.user_roles VALUES ('${ESTIMATOR}', '  Сметчикова Анна Петровна '), ('${LAWYER}', 'Юристов Юрий Юрьевич'),
      ('${NO_NAME}', '  ');`)
  })
  after(() => db?.stop())

  it('проверка прода до миграции — FAIL, а не ошибка', () => {
    const out = lines(db.exec(fs.readFileSync(PROD_CHECK, 'utf8')))
    assert.ok(out.every(l => /^(OK|FAIL) /.test(l)), out.join('\n'))
    assert.ok(out.some(l => l.startsWith('FAIL ')), out.join('\n'))
  })

  it('прежние заявки — «Не проверено» без подписи; проверки миграции — только OK', () => {
    db.applyFile(SUPABASE)
    assert.deepEqual(row('old-1'), {
      submission_check: 'not_checked', submission_comment: null, submission_by: null, submission_by_name: null, stamped: false,
    })
    for (const file of [PROD_CHECK, YANDEX_CHECK]) {
      const out = lines(db.exec(fs.readFileSync(file, 'utf8')))
      assert.ok(out.length >= 7 && out.every(l => l.startsWith('OK ')), `${path.basename(file)}:\n${out.join('\n')}`)
    }
  })

  it('смена проверки — вошедший и его ФИО из user_roles; комментарий подпись не меняет', () => {
    db.asUser(ESTIMATOR, `UPDATE public.dc_requests SET submission_check = 'submitted' WHERE ds_number = 'old-1';`)
    assert.deepEqual(row('old-1'), {
      submission_check: 'submitted', submission_comment: null, submission_by: ESTIMATOR,
      submission_by_name: 'Сметчикова Анна Петровна', stamped: true,
    })
    db.asUser(LAWYER, `UPDATE public.dc_requests SET submission_comment = 'Письмо № 45 от 27.10' WHERE ds_number = 'old-1';`)
    assert.equal(row('old-1').submission_by_name, 'Сметчикова Анна Петровна')
    assert.equal(row('old-1').submission_comment, 'Письмо № 45 от 27.10')
    db.asUser(LAWYER, `UPDATE public.dc_requests SET status = 'in_work' WHERE ds_number = 'old-1';`)
    assert.equal(row('old-1').submission_by, ESTIMATOR, 'правка других полей подпись не трогает')
  })

  it('подпись запросом не подменить — ни без смены проверки, ни вместе с ней', () => {
    db.asUser(LAWYER, `UPDATE public.dc_requests SET submission_by_name = 'Кто-то', submission_by = NULL, submission_at = NULL
      WHERE ds_number = 'old-1';`)
    assert.deepEqual([row('old-1').submission_by, row('old-1').submission_by_name, row('old-1').stamped],
      [ESTIMATOR, 'Сметчикова Анна Петровна', true])
    db.asUser(LAWYER, `UPDATE public.dc_requests SET submission_check = 'incomplete', submission_by_name = 'Кто-то'
      WHERE ds_number = 'old-1';`)
    assert.deepEqual([row('old-1').submission_by, row('old-1').submission_by_name], [LAWYER, 'Юристов Юрий Юрьевич'])
    db.asUser(NO_NAME, `UPDATE public.dc_requests SET submission_check = 'not_checked' WHERE ds_number = 'old-1';`)
    assert.deepEqual([row('old-1').submission_check, row('old-1').submission_by, row('old-1').submission_by_name, row('old-1').stamped],
      ['not_checked', NO_NAME, null, true], 'возврат к «Не проверено» — тоже смена; пустое ФИО — без имени')
  })

  it('новая заявка — «Не проверено» без подписи; сразу с проверкой — с подписью', () => {
    db.asUser(ESTIMATOR, `INSERT INTO public.dc_requests (ds_number, submission_by_name) VALUES ('new-1', 'Кто-то');`)
    assert.deepEqual([row('new-1').submission_check, row('new-1').submission_by_name, row('new-1').stamped], ['not_checked', null, false])
    db.asUser(LAWYER, `INSERT INTO public.dc_requests (ds_number, submission_check) VALUES ('new-2', 'accepted');`)
    assert.deepEqual([row('new-2').submission_by, row('new-2').submission_by_name], [LAWYER, 'Юристов Юрий Юрьевич'])
  })

  it('чужой вариант и комментарий длиннее 2000 символов база не принимает', () => {
    const bad = db.tryAsUser(LAWYER, `UPDATE public.dc_requests SET submission_check = 'approved' WHERE ds_number = 'old-2';`)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /dc_requests_submission_check_check/)
    const long = db.tryAsUser(LAWYER, `UPDATE public.dc_requests SET submission_comment = repeat('я', 2001) WHERE ds_number = 'old-2';`)
    assert.equal(long.ok, false)
    assert.match(long.error, /dc_requests_submission_comment_check/)
    assert.equal(row('old-2').submission_check, 'not_checked')
  })

  it('повтор миграции (и вариант базы Яндекса поверх) ничего не меняет', () => {
    const before = row('new-2')
    db.applyFile(SUPABASE)
    db.applyFile(YANDEX)
    assert.deepEqual(row('new-2'), before)
  })
})

describe('Реестр заявок на ДС: «Статус ОКС» и «Комментарий»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=10&shell=1${extra}`)
    await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const headers = (page) => page.locator('.dcr-table thead th').allTextContents()
  const rowOf = (page, ds) => page.locator('.dcr-table tbody tr', { hasText: `ДС-${ds}` })
  const dbRow = (page, id) => page.evaluate((rid) => {
    const r = window.__fakeDb.dc_requests.find(x => x.id === rid)
    return { check: r.submission_check, comment: r.submission_comment, by: r.submission_by_name }
  }, id)
  const today = () => {
    const d = new Date()
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
  }

  it('без колонок в базе столбцов нет', async () => {
    const { page, errors, close } = await open()
    try {
      const th = await headers(page)
      assert.ok(!th.includes('Статус ОКС') && !th.includes('Комментарий'), th.join(' | '))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('по умолчанию «Не проверено» без подписи; смена — подпись из ответа базы, комментарий подсвечен', async () => {
    const { page, errors, close } = await open('&dcSubmission=1')
    try {
      const th = await headers(page)
      // Оба столбца — перед последним («Действия»), сразу после «Документов».
      assert.deepEqual(th.slice(-4), ['Документы', 'Статус ОКС', 'Комментарий', 'Действия'], th.join(' | '))

      const d1 = rowOf(page, 'd1')
      assert.equal(await d1.locator('select[aria-label="Статус ОКС"]').inputValue(), 'not_checked')
      assert.equal((await d1.locator('.dcr-sub-select').textContent()).trim(), 'Не проверено')
      assert.equal(await d1.locator('.dcr-sub-meta').count(), 0)
      assert.equal(await d1.locator('textarea.dcr-sub-comment.is-missing').count(), 0)

      const d2 = rowOf(page, 'd2')
      assert.equal((await d2.locator('.dcr-sub-select').textContent()).trim(), 'Подано заказчику')
      assert.match(await d2.locator('.dcr-sub-meta').textContent(), /Юристов Ю\.\s*Ю\./)
      assert.equal(await d2.locator('textarea.dcr-sub-comment').inputValue(), 'Письмо № 123')

      await d1.locator('select[aria-label="Статус ОКС"]').selectOption('accepted')
      await d1.locator('.dcr-sub-meta').waitFor()
      const meta = await d1.locator('.dcr-sub-meta').textContent()
      assert.match(meta, /Сметчикова А\.\s*П\./, 'ФИО — из ответа базы, а не «Тест» со страницы')
      assert.ok(meta.includes(today()), meta)
      const comment = d1.locator('textarea.dcr-sub-comment')
      assert.equal(await comment.getAttribute('placeholder'), 'Срок подачи')
      assert.equal(await d1.locator('textarea.dcr-sub-comment.is-missing').count(), 1)
      assert.deepEqual(await dbRow(page, 'd1'), { check: 'accepted', comment: null, by: 'Сметчикова Анна Петровна' })
      const audit = await page.evaluate(() => window.__fakeDb.dc_request_audit_log
        .filter(e => e.dc_request_id === 'd1').map(e => e.description))
      assert.deepEqual(audit, ['Статус ОКС: Не проверено → Принято в работу (будет подаваться)'])

      await comment.fill('  Подадим до 15.11  ')
      await comment.press('Tab')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').submission_comment != null)
      assert.deepEqual(await dbRow(page, 'd1'), { check: 'accepted', comment: 'Подадим до 15.11', by: 'Сметчикова Анна Петровна' })
      await page.waitForFunction(() => !document.querySelector('.dcr-table textarea.dcr-sub-comment.is-missing'))
      assert.equal(await comment.inputValue(), 'Подадим до 15.11')

      // Esc — правка отменяется, в базу ничего не уходит.
      await comment.fill('черновик')
      await comment.press('Escape')
      assert.equal(await comment.inputValue(), 'Подадим до 15.11')
      await page.waitForTimeout(100)
      assert.equal((await dbRow(page, 'd1')).comment, 'Подадим до 15.11')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('в «Удаленных» — только просмотр', async () => {
    const { page, errors, close } = await open('&dcSubmission=1')
    try {
      await page.locator('.status-tab', { hasText: 'Удаленные' }).click()
      const d6 = rowOf(page, 'd6')
      await d6.waitFor()
      assert.equal(await d6.locator('select[aria-label="Статус ОКС"]').count(), 0)
      assert.equal(await d6.locator('textarea').count(), 0)
      assert.equal((await d6.locator('.dcr-sub-tag').textContent()).trim(), 'Не проверено')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
