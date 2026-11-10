// Файл связей от команды auth (server/osp-api/src/identity-cli.js, links-apply): разбор строгий, план — без записи. Проверяем:
//   • формат: шапка osp_user_id,kc_user_id,match; id — uuid; match — email | fio | partial; иное — замечание со строкой;
//   • повторы с обеих сторон, несуществующие учётки портала, partial без подтверждения — замечание;
//   • уже записанная точно так же связь — пропуск; связь с другим sub или другой учёткой — замечание (запись — только без замечаний).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'openid-client')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const K1 = 'a1111111-1111-4111-8111-111111111111'
const K2 = 'a2222222-2222-4222-8222-222222222222'
const K3 = 'a3333333-3333-4333-8333-333333333333'

describe('файл связей СУ-10 (identity-cli links-apply)', { skip }, () => {
  let parseLinksCsv
  let planLinks
  const links = (pairs = []) => ({
    bySubject: new Map(pairs.map(([u, k]) => [k, u])),
    byUser: new Map(pairs.map(([u, k]) => [u, k])),
  })

  it('разбор: шапка, uuid, match; ошибочные строки — замечание с номером строки', async () => {
    ;({ parseLinksCsv, planLinks } = await import(path.join(SERVER, 'src', 'identity-cli.js')))
    assert.throws(() => parseLinksCsv('id,kc\n'), /osp_user_id,kc_user_id,match/)
    const parsed = parseLinksCsv(`﻿osp_user_id, kc_user_id, match\r\n${A},${K1},email\n${B},${K2},FIO\nnot-a-uuid,${K3},email\n${C},${K3},guess\n\n`)
    assert.deepEqual(parsed.rows.map((r) => [r.osp, r.kc, r.match]), [[A, K1, 'email'], [B, K2, 'fio']])
    assert.deepEqual(parsed.bad, [4, 5])
  })

  it('план: новые, уже записанные так же, повторы, нет учётки, partial без подтверждения, конфликты', () => {
    const csv = [
      'osp_user_id,kc_user_id,match',
      `${A},${K1},email`, // уже записана так же — пропуск
      `${B},${K2},fio`, // новая
      `${C},${K3},partial`, // partial — только по --partial
      `${B},${K3},email`, // повтор osp и kc
    ].join('\n')
    const users = new Set([A, B, C])
    const { plan, problems } = planLinks(parseLinksCsv(csv), { users, links: links([[A, K1]]), partialAllowed: new Set() })
    assert.equal(plan.same, 1)
    assert.deepEqual(plan.insert.map((r) => r.osp), [B])
    assert.ok(problems.some((p) => /partial .* не подтверждён/.test(p)))
    assert.ok(problems.some((p) => /osp_user_id .* повторяется/.test(p)))
    assert.ok(problems.some((p) => /kc_user_id .* повторяется/.test(p)))
    // С подтверждением partial и без повтора — без замечаний.
    const ok = planLinks(parseLinksCsv(csv.split('\n').slice(0, 4).join('\n')), { users, links: links([[A, K1]]), partialAllowed: new Set([C]) })
    assert.deepEqual(ok.problems, [])
    assert.deepEqual(ok.plan.insert.map((r) => r.osp), [B, C])
  })

  it('план: учётки нет в портале; sub или учётка уже связаны с другими — замечание, а не перезапись', () => {
    const csv = ['osp_user_id,kc_user_id,match', `${A},${K2},email`, `${B},${K1},email`, `${C},${K3},email`].join('\n')
    const { plan, problems } = planLinks(parseLinksCsv(csv), { users: new Set([A, B]), links: links([[A, K1]]), partialAllowed: new Set() })
    assert.equal(plan.insert.length, 0)
    assert.ok(problems.some((p) => p.includes(`учётка ${A} уже связана`)))
    assert.ok(problems.some((p) => p.includes(`kc_user_id ${K1} уже связан с другой учёткой ${A}`)))
    assert.ok(problems.some((p) => p.includes(`учётки ${C} в портале нет`)))
  })
})
