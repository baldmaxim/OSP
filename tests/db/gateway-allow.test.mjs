// Список разрешённого у шлюза данных (server/osp-api/src/data/allow.json) = выдача прав прода на
// момент переноса: последняя копия прода плюс миграции-кандидаты (они применяются на проде до финальной
// копии). В базе Яндекса одна учётка, и «кому какие таблицы можно вообще» решает только этот список.
//
// Зачем тест: список — файл в репозитории, а права прода меняются миграциями. Миграция добавила
// представление или функцию, а список не пересобрали — после переноса портал их не увидит (так публичная
// страница тендеров осталась бы пустой: шлюз ответил бы, что представления public_open_tenders нет).
// Расхождение чинится командой: node scripts/build-db-allow.mjs
// Поверх прав копии — явные разрешения миграций базы нового портала (migration/yandex, «-- osp:allow …»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, latestVerifiedCopy, startCopy } from './lib/stand.mjs'
import { applyCandidates, readGrants, buildAllow, applyAnnotations, parseAllowAnnotations, yandexAllowAnnotations } from '../../scripts/build-db-allow.mjs'

const skip = skipReason({ needCopy: true })
const ALLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json'), 'utf8'))

describe('Список шлюза данных против прав прода с миграциями-кандидатами', { skip, timeout: 30 * 60 * 1000 }, () => {
  let db
  let expected
  before(() => {
    db = startCopy(latestVerifiedCopy())
    applyCandidates(db.port)
    expected = applyAnnotations(buildAllow(readGrants(db.port)))
  })
  after(() => db?.stop())

  it('таблицы, представления и действия — те же, что выдано на проде анониму и вошедшему', () => {
    const names = new Set([...Object.keys(expected.tables), ...Object.keys(ALLOW.tables)])
    const differ = [...names].sort().filter((t) => JSON.stringify(expected.tables[t] ?? null) !== JSON.stringify(ALLOW.tables[t] ?? null))
      .map((t) => `${t}: на проде ${JSON.stringify(expected.tables[t] ?? null)}, в списке ${JSON.stringify(ALLOW.tables[t] ?? null)}`)
    assert.deepEqual(differ, [], `Список шлюза отстал от прав прода (node scripts/build-db-allow.mjs):\n${differ.join('\n')}`)
    assert.ok(Object.keys(ALLOW.tables).length > 50, 'сравнение не пустое')
  })

  it('функции — те же; анониму не выдана ни одна', () => {
    const names = new Set([...Object.keys(expected.rpc), ...Object.keys(ALLOW.rpc)])
    const differ = [...names].sort().filter((f) => JSON.stringify(expected.rpc[f] ?? null) !== JSON.stringify(ALLOW.rpc[f] ?? null))
      .map((f) => `${f}: на проде ${JSON.stringify(expected.rpc[f] ?? null)}, в списке ${JSON.stringify(ALLOW.rpc[f] ?? null)}`)
    assert.deepEqual(differ, [], `Список шлюза отстал от прав прода (node scripts/build-db-allow.mjs):\n${differ.join('\n')}`)
    assert.ok(Object.values(ALLOW.rpc).every((roles) => !roles.includes('anon')))
  })

  it('всё, к чему обращается портал без входа, в списке есть', () => {
    // Публичная страница тендеров: представление из миграции-кандидата и прежний запрос — пока
    // миграция не применена. Отсутствие строки в списке шлюз выдаёт за «представления нет».
    const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'PublicTendersPage.jsx'), 'utf8')
    const read = [...page.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1])
    assert.ok(read.length > 0, 'страница читает данные')
    for (const t of new Set(read)) {
      // Таблица после миграции гостю закрыта — её в списке для анонима может не быть; представление обязано.
      if (t === 'public_open_tenders') assert.deepEqual(ALLOW.tables[t]?.anon, ['select'], t)
      else assert.ok(Object.hasOwn(ALLOW.tables, t), `${t} нет в списке шлюза`)
    }
  })
})

// Без Docker и копии: разрешения миграций базы нового портала разбираются строго и все уже в списке.
describe('Разрешения шлюза из миграций базы нового портала (migration/yandex)', () => {
  it('строки «-- osp:allow» разбираются; ошибочные — отказ, а не молчаливый пропуск', () => {
    const sql = [
      '-- osp:allow table tags authenticated=update,select anon=select',
      '  --osp:allow rpc tag_count authenticated',
      '-- osp:allow table old_table none',
      '-- обычный комментарий про osp:allow не в начале',
    ].join('\n')
    assert.deepEqual(parseAllowAnnotations(sql), [
      { kind: 'table', name: 'tags', entry: { anon: ['select'], authenticated: ['select', 'update'] } },
      { kind: 'rpc', name: 'tag_count', entry: ['authenticated'] },
      { kind: 'table', name: 'old_table', entry: null },
    ])
    for (const bad of ['-- osp:allow table tags anon=insert', '-- osp:allow rpc f anon', '-- osp:allow table tags owner=select',
      '-- osp:allow table Tags authenticated=select', '-- osp:allow view tags authenticated=select', '-- osp:allow table tags',
      '-- osp:allow table tags authenticated=drop']) {
      assert.throws(() => parseAllowAnnotations(bad), /osp:allow|роль|анониму|функции/, bad)
    }
    const merged = applyAnnotations({ tables: { old_table: { authenticated: ['select'] }, keep: { anon: ['select'] } }, rpc: {} },
      parseAllowAnnotations(sql))
    assert.deepEqual(merged, { tables: { keep: { anon: ['select'] }, tags: { anon: ['select'], authenticated: ['select', 'update'] } },
      rpc: { tag_count: ['authenticated'] } })
  })

  it('каждое разрешение миграций уже в allow.json (иначе: node scripts/build-db-allow.mjs)', () => {
    for (const { kind, name, entry } of yandexAllowAnnotations()) {
      const have = (kind === 'table' ? ALLOW.tables : ALLOW.rpc)[name]
      assert.deepEqual(have ?? null, entry, `${kind} ${name}`)
    }
  })
})
