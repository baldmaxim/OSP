// «Заявки на ДС»: «Статус ОКС» — дело «Отдела по удорожанию» (миграция 20261118, обе базы; решение пользователя
// 30.10.2026). Статус ОКС, комментарий и ответственного меняет только сотрудник отдела (роль udoroj… или «удорож» в
// названии), остальным база отвечает 42501; сменивший статус сам становится ответственным. Тела миграций обеих баз
// совпадают; откат возвращает поведение 20261108. Временный PostgreSQL (локальный или Docker); страница — в
// dc-request-submission.test.mjs и dc-request-submission-resp.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { REPO as ROOT } from './lib/stand.mjs'

const file = (p) => path.join(ROOT, p)
const BASE = file('supabase/migrations/20261108_dc_request_submission_check.sql')
const RESP = file('supabase/migrations/20261117_dc_request_submission_responsible.sql')
const SUPABASE = file('supabase/migrations/20261118_dc_request_submission_access.sql')
const YANDEX = file('migration/yandex/20261118_dc_request_submission_access.sql')
const YANDEX_CHECK = file('migration/yandex/20261118_dc_request_submission_access.check.sql')
const PROD_CHECK = file('migration/backup/checks/20261118.sql')
const ROLLBACK = file('migration/rollback/20261118_dc_request_submission_access_rollback.sql')

describe('Статус ОКС — только «Отдел по удорожанию»: файлы миграции', () => {
  it('миграции Supabase и базы Яндекса делают одно и то же', () => {
    const body = (f) => fs.readFileSync(f, 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '10s');\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    assert.equal(body(YANDEX), body(SUPABASE))
  })

  it('миграция — в списке кандидатов проверки прав', () => {
    assert.match(fs.readFileSync(file('tests/db/baseline/candidate-migrations.txt'), 'utf8'),
      /^20261118_dc_request_submission_access\.sql$/m)
  })
})

// Окружение Supabase в минимуме (как в dc-request-submission.test.mjs): роли, auth.uid() из токена, своя строка
// user_roles (с ролью и почтой), справочник ролей roles, заявки с правилом «сотрудник — всё».
const BOOTSTRAP = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
GRANT USAGE ON SCHEMA auth, public TO authenticated;
CREATE TABLE public.user_roles (user_id uuid PRIMARY KEY, role text, full_name text, email text);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_roles_select_self ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.user_roles TO authenticated;
CREATE TABLE public.roles (key text PRIMARY KEY, label text NOT NULL);
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_select_auth ON public.roles FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.roles TO authenticated;
INSERT INTO public.roles VALUES ('udorojanie', 'Отдел по удорожанию'), ('cost_dept', 'Отдел по удорожанию (филиал)'),
  ('admin', 'Администратор'), ('lawyer', 'Юрист');
CREATE TABLE public.dc_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ds_number text, status text DEFAULT 'contract_check', updated_at timestamptz
);
ALTER TABLE public.dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dc_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dc_requests_all ON public.dc_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.dc_requests TO authenticated;
INSERT INTO public.dc_requests (ds_number) VALUES ('r-1'), ('r-2'), ('r-3');
`
const COST = '44444444-4444-4444-8444-444444444444'       // «Отдел по удорожанию», ключ udorojanie
const COST_LABEL = '55555555-5555-4555-8555-555555555555' // свой ключ, но «удорож» в названии роли
const COST_MAIL = '66666666-6666-4666-8666-666666666666'  // из отдела, ФИО не заполнено — почта
const ADMIN = '77777777-7777-4777-8777-777777777777'
const LAWYER = '22222222-2222-4222-8222-222222222222'

describe('Статус ОКС в базе: менять может только «Отдел по удорожанию», ответственный — кто поставил', { skip: pgAvailable() ? false : 'нет PostgreSQL (initdb/pg_ctl или Docker)', timeout: 300000 }, () => {
  let db
  const row = (ds) => JSON.parse(db.exec(`SELECT row_to_json(r) FROM (SELECT submission_check AS "check",
    submission_comment AS comment, submission_by AS by, submission_by_name AS by_name, submission_at IS NOT NULL AS stamped,
    submission_resp_user_id AS resp, submission_resp_name AS resp_name, status FROM public.dc_requests WHERE ds_number = '${ds}') r;`).trim())
  const lines = (out) => out.split('\n').filter(Boolean)
  const denied = (res) => {
    assert.equal(res.ok, false, 'база должна отказать')
    assert.match(res.error, /Статус ОКС меняет только отдел по удорожанию/)
  }

  before(() => {
    db = new TestDatabase()
    db.start()
    db.exec(BOOTSTRAP)
    db.exec(`INSERT INTO public.user_roles VALUES
      ('${COST}', 'udorojanie', ' Удорожаев Иван Петрович ', 'u1@example.invalid'),
      ('${COST_LABEL}', 'cost_dept', 'Филиалова Ольга Игоревна', 'u2@example.invalid'),
      ('${COST_MAIL}', 'udorojanie', '  ', 'u3@example.invalid'),
      ('${ADMIN}', 'admin', 'Админов Алексей Алексеевич', 'a@example.invalid'),
      ('${LAWYER}', 'lawyer', 'Юристов Юрий Юрьевич', 'l@example.invalid');`)
    db.applyFile(BASE)
    db.applyFile(RESP)
  })
  after(() => db?.stop())

  it('проверка прода до миграции — FAIL, а не ошибка; после — только OK', () => {
    const out = lines(db.exec(fs.readFileSync(PROD_CHECK, 'utf8')))
    assert.ok(out.every(l => /^(OK|FAIL) /.test(l)), out.join('\n'))
    assert.ok(out.some(l => l.startsWith('FAIL ')), out.join('\n'))
    db.applyFile(SUPABASE)
    for (const f of [PROD_CHECK, YANDEX_CHECK]) {
      const res = lines(db.exec(fs.readFileSync(f, 'utf8')))
      assert.ok(res.length >= 6 && res.every(l => l.startsWith('OK ')), `${path.basename(f)}:\n${res.join('\n')}`)
    }
  })

  it('сотрудник отдела ставит статус — подпись и он же ответственный (ФИО из user_roles)', () => {
    db.asUser(COST, `UPDATE public.dc_requests SET submission_check = 'submitted' WHERE ds_number = 'r-1';`)
    assert.deepEqual(row('r-1'), {
      check: 'submitted', comment: null, by: COST, by_name: 'Удорожаев Иван Петрович', stamped: true,
      resp: COST, resp_name: 'Удорожаев Иван Петрович', status: 'contract_check',
    })
    // Роль со своим ключом, но «удорож» в названии — тоже отдел; ответственный переходит к поставившему статус.
    db.asUser(COST_LABEL, `UPDATE public.dc_requests SET submission_check = 'accepted' WHERE ds_number = 'r-1';`)
    assert.deepEqual([row('r-1').check, row('r-1').resp, row('r-1').resp_name], ['accepted', COST_LABEL, 'Филиалова Ольга Игоревна'])
    // ФИО не заполнено — в ответственном почта (как в справочнике сотрудников), в подписи — без имени.
    db.asUser(COST_MAIL, `UPDATE public.dc_requests SET submission_check = 'incomplete' WHERE ds_number = 'r-1';`)
    assert.deepEqual([row('r-1').by_name, row('r-1').resp, row('r-1').resp_name], [null, COST_MAIL, 'u3@example.invalid'])
  })

  it('ответственного со страницы при смене статуса не подменить', () => {
    db.asUser(COST, `UPDATE public.dc_requests SET submission_check = 'not_submitted',
      submission_resp_user_id = '${COST_LABEL}', submission_resp_name = 'Кто-то' WHERE ds_number = 'r-2';`)
    assert.deepEqual([row('r-2').resp, row('r-2').resp_name], [COST, 'Удорожаев Иван Петрович'])
  })

  it('комментарий и передачу коллеге отдел правит без смены подписи', () => {
    const before = row('r-2')
    db.asUser(COST_LABEL, `UPDATE public.dc_requests SET submission_comment = 'Причина: вне договора' WHERE ds_number = 'r-2';`)
    db.asUser(COST, `UPDATE public.dc_requests SET submission_resp_user_id = '${COST_LABEL}',
      submission_resp_name = 'Филиалова Ольга Игоревна' WHERE ds_number = 'r-2';`)
    assert.deepEqual(row('r-2'), {
      ...before, comment: 'Причина: вне договора', resp: COST_LABEL, resp_name: 'Филиалова Ольга Игоревна',
    })
  })

  it('администратор и другие роли статус, комментарий и ответственного не меняют — 42501', () => {
    const before = row('r-2')
    denied(db.tryAsUser(ADMIN, `UPDATE public.dc_requests SET submission_check = 'submitted' WHERE ds_number = 'r-2';`))
    denied(db.tryAsUser(LAWYER, `UPDATE public.dc_requests SET submission_comment = 'письмо' WHERE ds_number = 'r-2';`))
    denied(db.tryAsUser(LAWYER, `UPDATE public.dc_requests SET submission_resp_user_id = '${LAWYER}',
      submission_resp_name = 'Юристов Юрий Юрьевич' WHERE ds_number = 'r-2';`))
    denied(db.tryAsUser(ADMIN, `UPDATE public.dc_requests SET submission_resp_user_id = NULL, submission_resp_name = NULL
      WHERE ds_number = 'r-2';`))
    const res = db.tryAsUser(ADMIN, `UPDATE public.dc_requests SET submission_check = 'submitted' WHERE ds_number = 'r-2';`)
    assert.match(res.error, /42501|Статус ОКС/)
    assert.deepEqual(row('r-2'), before)
  })

  it('прочие поля заявки — как раньше, любой сотрудник; то же значение статуса ОКС — не правка', () => {
    db.asUser(LAWYER, `UPDATE public.dc_requests SET status = 'in_work', ds_number = 'r-2' WHERE ds_number = 'r-2';`)
    assert.equal(row('r-2').status, 'in_work')
    // Форма и выгрузка могут прислать те же значения — это не смена.
    const same = row('r-2')
    db.asUser(LAWYER, `UPDATE public.dc_requests SET submission_check = '${same.check}', submission_comment = '${same.comment}'
      WHERE ds_number = 'r-2';`)
    // Подпись запросом не подменить: молча остаётся прежней (как в 20261108), не ошибка.
    db.asUser(LAWYER, `UPDATE public.dc_requests SET submission_by_name = 'Кто-то', submission_at = NULL WHERE ds_number = 'r-2';`)
    assert.deepEqual(row('r-2'), same)
  })

  it('новая заявка: «Не проверено» — любой сотрудник; сразу со статусом — только отдел, он же ответственный', () => {
    db.asUser(LAWYER, `INSERT INTO public.dc_requests (ds_number) VALUES ('n-1');`)
    assert.deepEqual([row('n-1').check, row('n-1').resp, row('n-1').stamped], ['not_checked', null, false])
    denied(db.tryAsUser(ADMIN, `INSERT INTO public.dc_requests (ds_number, submission_check) VALUES ('n-2', 'accepted');`))
    denied(db.tryAsUser(LAWYER, `INSERT INTO public.dc_requests (ds_number, submission_comment) VALUES ('n-2', 'письмо');`))
    db.asUser(COST, `INSERT INTO public.dc_requests (ds_number, submission_check) VALUES ('n-3', 'accepted');`)
    assert.deepEqual([row('n-3').by, row('n-3').resp, row('n-3').resp_name], [COST, COST, 'Удорожаев Иван Петрович'])
  })

  it('служебная операция без вошедшего — без проверки; ответственный не трогается', () => {
    db.exec(`UPDATE public.dc_requests SET submission_check = 'submitted' WHERE ds_number = 'r-3';`)
    assert.deepEqual([row('r-3').check, row('r-3').by, row('r-3').resp, row('r-3').stamped], ['submitted', null, null, true])
  })

  it('повтор миграции (и вариант базы Яндекса поверх) ничего не меняет', () => {
    const before = [row('r-1'), row('r-2'), row('n-3')]
    db.applyFile(SUPABASE)
    db.applyFile(YANDEX)
    assert.deepEqual([row('r-1'), row('r-2'), row('n-3')], before)
    denied(db.tryAsUser(ADMIN, `UPDATE public.dc_requests SET submission_check = 'accepted' WHERE ds_number = 'r-1';`))
  })

  it('откат: как после 20261108 — менять может любой сотрудник, ответственный сам не ставится; данные на месте', () => {
    const before = row('r-2')
    db.applyFile(ROLLBACK)
    assert.deepEqual(row('r-2'), before)
    db.asUser(ADMIN, `UPDATE public.dc_requests SET submission_check = 'accepted' WHERE ds_number = 'r-2';`)
    assert.deepEqual([row('r-2').check, row('r-2').by_name, row('r-2').resp], ['accepted', 'Админов Алексей Алексеевич', COST_LABEL])
    const out = lines(db.exec(fs.readFileSync(PROD_CHECK, 'utf8')))
    assert.ok(out.some(l => l.startsWith('FAIL ')), out.join('\n'))
    db.applyFile(SUPABASE)
    denied(db.tryAsUser(ADMIN, `UPDATE public.dc_requests SET submission_check = 'submitted' WHERE ds_number = 'r-2';`))
  })
})
