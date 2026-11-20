// «История» договоров и ДС: «Создание» у каждого документа (миграция 20270222, только база Яндекса). На проде 19.11.2026 у 1652 из
// 1814 документов «Создания» не было: загрузки пакетом (импорт, внешние загрузки — 30.10 разом 1121), документы до появления
// «Истории», одиночные и два договора 17.11, у которых событие не записалось (автор — в журнале базы).
// Копия прода как база Яндекса (одна учётка, настоящий migrate.sh с проверкой прав и .check.sql): у каждого документа есть
// «Создание»; восстановленная запись — с датой создания документа, основанием и текстом, без придуманного автора; загрузки
// 14.09 и 16.09 описаны временем по Москве, числом и диапазоном ID; повтор ничего не добавляет; автор из журнала базы; откат
// убирает только восстановленное. Нужны Docker, psql и проверенная копия прода. Без базы — tests/contracts/contract-created-history.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20270222_contract_created_history'
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const PROD_CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270222.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

describe('«Создание» в «Истории» договоров и ДС — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text, opts = {}) => db.sql(text, { appName: 'osp:internal', ...opts })
  const restoredCount = () => Number(internal(`select count(*) from public.contract_audit_log where new_value ->> 'restored' = '20270222'`))
  const otherRows = () => internal(`select count(*) || ':' || coalesce(md5(string_agg(id::text || event_type || coalesce(description, '') || changed_at::text, ',' order by id)), '')
                                      from public.contract_audit_log where new_value ->> 'restored' is distinct from '20270222'`)
  const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length
  const restoredOf = (displayId) => internal(`select l.new_value ->> 'basis' || '|' || l.description || '|' || (l.changed_at = c.created_at)::text
      || '|' || coalesce(l.changed_by_name, '-') || '|' || coalesce(l.changed_by_role, '-') || '|' || coalesce(l.changed_by::text, '-')
    from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
    where c.display_id = ${displayId} and l.new_value ->> 'restored' = '20270222'`)
  let firstCount = 0
  let others = ''

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-created-hist-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    firstCount = restoredCount()
    others = otherRows()
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции и проверка для прода на копии: все OK', () => {
    for (const file of [YANDEX_CHECK, PROD_CHECK]) {
      const out = internal(fs.readFileSync(file, 'utf8'))
      assert.doesNotMatch(out, /^FAIL/m, out)
      assert.equal(okLines(out), 7, out)
    }
    assert.ok(firstCount > 200, `восстановлено ${firstCount}`)
  })

  it('у каждого документа одно «Создание»: форма или восстановленное, не оба', () => {
    assert.equal(internal(`select count(*) from public.contracts c
      where (select count(*) from public.contract_audit_log l where l.contract_id = c.id and l.event_type = 'created'
               and l.new_value ->> 'restored' = '20270222') > 0
        and exists (select 1 from public.contract_audit_log l where l.contract_id = c.id and l.event_type = 'created'
                      and l.new_value ->> 'restored' is distinct from '20270222')`), '0')
  })

  it('загрузки 14.09 и 16.09: время по Москве, число документов, диапазон ID; автор пустой, дата — создания документа', () => {
    const [basis, text, sameTime, who, role, by] = restoredOf(100).split('|')
    assert.equal(basis, 'batch')
    assert.match(text, /^Создан договор № .+\. Документ появился в реестре в составе загрузки 14\.09\.2026 в 10:55 \(МСК\): 135 документов \(ID 99–233\)\. Кто загружал — не записано: автора создания база записывает с \d\d\.\d\d\.\d{4}\. Запись восстановлена \d\d\.\d\d\.\d{4} по данным базы\.$/)
    assert.deepEqual([sameTime, who, role, by], ['true', '-', '-', '-'])
    // 16.09: два захода с разницей в две минуты — одна загрузка.
    assert.match(restoredOf(300), /^batch\|.*загрузки 16\.09\.2026 с 16:52 по 16:54 \(МСК\): 26 документов \(ID 294–319\)\./)
  })

  it('документ раньше первой записи «Истории» и одиночный — без автора, с понятным основанием', () => {
    assert.match(restoredOf(1), /^before_history\|Создан договор № .+\. Документ создан до появления «Истории» \(первая запись в ней — 04\.07\.2026 \d\d:\d\d МСК\), кто создал — не записано\./)
    assert.match(restoredOf(98), /^single\|Создан договор № .+\. Событие создания в «Историю» не записано, кто создал — неизвестно: автора создания база записывает с /)
    assert.match(restoredOf(98), /\|true\|-\|-\|-$/)
  })

  it('повтор миграции ничего не добавляет и не трогает другие записи истории', () => {
    internal(null, { file: YANDEX })
    assert.equal(restoredCount(), firstCount)
    assert.equal(otherRows(), others)
  })

  it('автор есть в журнале базы — он и указан; откат убирает только восстановленное, повтор отката безопасен', () => {
    internal(null, { file: ROLLBACK })
    assert.equal(restoredCount(), 0)
    assert.equal(otherRows(), others)
    // Строку договора 98 «создал» пользователь — как пишет журнал базы с 11.11.2026.
    const user = internal(`select user_id || '|' || full_name || '|' || role from public.user_roles
                           where nullif(btrim(full_name), '') is not null and role is not null order by user_id limit 1`)
    const [uid, name, role] = user.split('|')
    internal(`insert into osp_private.data_audit_log (at, table_name, row_id, op, actor, actor_name, actor_role, changes)
              select now(), 'contracts', id, 'INSERT', '${uid}', '${name.replaceAll("'", "''")}', '${role}', '{}'::jsonb
              from public.contracts where display_id = 98`)
    internal(null, { file: YANDEX })
    assert.equal(restoredCount(), firstCount)
    const [basis, text, sameTime, who, whoRole, by] = restoredOf(98).split('|')
    assert.equal(basis, 'journal')
    assert.match(text, /^Создан договор № .+\. При создании событие в «Историю» не записалось; автор — по журналу базы\. Запись восстановлена \d\d\.\d\d\.\d{4}\.$/)
    assert.deepEqual([sameTime, who, whoRole, by], ['true', name, role, uid])
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    internal(null, { file: ROLLBACK })
    internal(null, { file: ROLLBACK })
    assert.equal(restoredCount(), 0)
    assert.equal(otherRows(), others)
    assert.match(internal(fs.readFileSync(PROD_CHECK, 'utf8')), /^FAIL у каждого договора и ДС в «Истории» есть «Создание»$/m)
  })
})
