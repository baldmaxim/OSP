// «Реестр по договорам» × SIGNAL: чистые функции подписей и итогов (src/utils/signalReview.js) и клиент /api/signal/*
// (src/api/signalClient.js, fetch — подставной). Окно, значок и фильтр в браузере — tests/tender/contracts-signal.test.mjs,
// итог импорта — contracts-import-signal.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_FLAG_TEXT, CANDIDATE_REASON_TEXT, REASON_TEXT, REVIEW_STATES, SIGNAL_STATES, STATE_LABEL, STATE_SHORT, candidateFlagText,
  attemptKeys, candidateReasonText, isUnconfirmable, markFromMatch, markLook, markTitle, matchNotice, reasonText, signalReviewIds, suggestsAlias,
  summarizeMatch, summaryLine, summaryTitle,
} from '../../src/utils/signalReview.js'
import { MATCH_FLAGS, MATCH_REASONS, REASONS, STATES, STATE_REASONS } from '../../server/osp-api/src/lib/signalMatch.js'
import { SIGNAL_DISABLED, SignalApiError, createSignalClient, newIdempotencyKey } from '../../src/api/signalClient.js'

describe('значок и подписи', () => {
  it('вид значка: предложение — красный с точкой, противоречие / не видна / удалён — жёлтый, остальное — как без Signal', () => {
    assert.equal(markLook(null), 'plain')
    assert.equal(markLook({ state: 'suggested' }), 'suggest')
    for (const state of ['conflict', 'attention', 'missing']) assert.equal(markLook({ state }), 'warn', state)
    for (const state of ['none', 'verified', 'unverified', 'нет такого']) assert.equal(markLook({ state }), 'plain', state)
    assert.deepEqual(REVIEW_STATES, ['suggested', 'conflict', 'attention', 'missing'])
  })

  it('подпись: подсказка сервера или подпись состояния; ссылка — второй строкой; призыв — по праву', () => {
    assert.equal(markTitle({ state: 'suggested', tip: 'Signal: предложена папка А / Б' }, { canReview: true }), 'Signal: предложена папка А / Б — нажмите, чтобы сверить')
    assert.equal(markTitle({ state: 'attention' }, { link: 'https://x.invalid/f', canReview: true }), 'Signal: папка не видна в Signal — нажмите, чтобы сверить\nhttps://x.invalid/f')
    assert.equal(markTitle({ state: 'none', tip: '' }, { canAdd: true }), 'Signal: ссылки нет — нажмите, чтобы указать')
    assert.equal(markTitle({ state: 'none' }, {}), 'Signal: ссылки нет')
    assert.equal(markTitle({ state: 'verified', tip: 'Signal: сверено' }, { link: 'https://x.invalid/f', canAdd: true }), 'Signal: сверено\nhttps://x.invalid/f')
    assert.equal(markTitle({ state: 'неизвестное' }, {}), 'Signal')
    for (const state of Object.keys(STATE_LABEL)) assert.ok(STATE_LABEL[state].startsWith('Signal: '), state)
  })

  it('«Слово «удалена» не используется» для папок: только «не видна»; файл — «удалён»', () => {
    assert.ok(!/удалена/.test(Object.values(STATE_LABEL).join(' ')))
    assert.equal(STATE_LABEL.attention, 'Signal: папка не видна в Signal')
    assert.equal(STATE_LABEL.missing, 'Signal: файл удалён в Signal')
  })

  it('причины: общий текст без имён, неизвестные коды не ломают разбор', () => {
    assert.equal(reasonText('foreign_dp'), 'папка относится к другому договору')
    assert.equal(reasonText('что-то новое'), '')
    assert.equal(candidateReasonText('number'), 'номер совпал')
    assert.equal(candidateReasonText('новое'), 'совпал признак')
    assert.equal(candidateFlagText('новое'), 'нужна проверка')
    assert.equal(candidateFlagText('previously_rejected'), 'уже отклоняли при прежних реквизитах')
    assert.equal(candidateFlagText('previously_unlinked'), 'уже отвязывали при прежних реквизитах')
    assert.equal(reasonText('none'), 'ссылки нет')
  })

  it('синоним предлагается, когда в причинах кандидата нет object_name; family_unknown подтвердить нельзя', () => {
    assert.equal(suggestsAlias({ reasons: ['number', 'features'] }), true)
    assert.equal(suggestsAlias({ reasons: [] }), true)
    assert.equal(suggestsAlias({ reasons: ['number', 'object_name'] }), false)
    assert.equal(suggestsAlias(null), false)
    assert.equal(isUnconfirmable({ flags: ['similar', 'family_unknown'] }), true)
    assert.equal(isUnconfirmable({ flags: ['similar'] }), false)
    assert.equal(isUnconfirmable({}), false)
  })
})

// Сторож: тексты окна и значка покрывают коды сопоставителя сервера — новый код без подписи ронял бы этот тест, а не показывал
// человеку «совпал признак» вместо причины.
describe('подписи покрывают коды сопоставителя (server/osp-api/src/lib/signalMatch.js)', () => {
  const keys = (o) => Object.keys(o).sort()
  const filled = (o) => Object.entries(o).every(([, v]) => typeof v === 'string' && v.trim().length > 0)

  it('причины состояний (REASONS) — ровно ключи REASON_TEXT', () => {
    assert.deepEqual(keys(REASON_TEXT), keys(REASONS))
    assert.ok(filled(REASON_TEXT))
    for (const reasons of Object.values(STATE_REASONS)) for (const r of reasons) assert.ok(REASON_TEXT[r], `STATE_REASONS: ${r}`)
  })

  it('причины и флаги кандидата (MATCH_REASONS, MATCH_FLAGS) — ровно ключи таблиц окна', () => {
    assert.deepEqual(keys(CANDIDATE_REASON_TEXT), keys(MATCH_REASONS))
    assert.deepEqual(keys(CANDIDATE_FLAG_TEXT), keys(MATCH_FLAGS))
    assert.ok(filled(CANDIDATE_REASON_TEXT) && filled(CANDIDATE_FLAG_TEXT))
    for (const code of Object.keys(MATCH_REASONS)) assert.notEqual(candidateReasonText(code), 'совпал признак', code)
    for (const code of Object.keys(MATCH_FLAGS)) assert.notEqual(candidateFlagText(code), 'нужна проверка', code)
  })

  it('состояния (STATES) — ровно ключи подписей значка и итога импорта', () => {
    assert.deepEqual(keys(STATE_LABEL), keys(STATES))
    assert.deepEqual(keys(STATE_SHORT), keys(STATES))
    assert.deepEqual([...SIGNAL_STATES].sort(), keys(STATES))
  })
})

describe('фильтр «Сверка Signal»: набор id', () => {
  it('предложение, противоречие, не видна, удалён; «ожидает» и прочие — нет; Map и массив', () => {
    const items = [
      { id: 'a', state: 'suggested' }, { id: 'b', state: 'conflict' }, { id: 'c', state: 'attention' }, { id: 'd', state: 'missing' },
      { id: 'e', state: 'verified' }, { id: 'f', state: 'unverified' }, { id: 'g', state: 'none' }, { id: 'h', state: 'suggested', pending: true }, { state: 'suggested' },
    ]
    assert.deepEqual([...signalReviewIds(items)], ['a', 'b', 'c', 'd'])
    assert.deepEqual([...signalReviewIds(new Map(items.filter((i) => i.id).map((i) => [i.id, i])))], ['a', 'b', 'c', 'd'])
  })
})

describe('сообщение после сохранения (Р8)', () => {
  it('папка найдена — с путём; без пути — без него; противоречие — общая причина; остальное — ничего', () => {
    assert.deepEqual(matchNotice({ id: 'x', state: 'suggested', path: 'А / Б' }), { kind: 'found', text: 'Найдена папка в Signal: А / Б' })
    assert.deepEqual(matchNotice({ id: 'x', state: 'suggested' }), { kind: 'found', text: 'Найдена папка в Signal' })
    assert.deepEqual(matchNotice({ id: 'x', state: 'conflict', reason: 'building_mismatch' }), { kind: 'warn', text: 'Signal: корпус или очередь в папке не совпадают с договором — проверьте' })
    assert.equal(matchNotice({ id: 'x', state: 'attention', reason: 'not_visible' }).text, 'Signal: папка не видна в Signal — проверьте')
    assert.equal(matchNotice({ id: 'x', state: 'missing', reason: '???' }).text, 'Signal: файл удалён в Signal — проверьте', 'нет текста причины — подпись состояния')
    for (const state of ['none', 'verified', 'unverified']) assert.equal(matchNotice({ id: 'x', state }), null, state)
    assert.equal(matchNotice(null), null)
  })

  it('метка из ответа /match — состояние сразу, подсказки до загрузки меток нет', () => {
    assert.deepEqual(markFromMatch({ id: 'x', state: 'suggested', reason: 'none', hasCandidate: true, path: 'А' }),
      { id: 'x', state: 'suggested', reason: 'none', pending: false, tip: '', hasCandidate: true })
  })
})

describe('итог сверки импорта (Ф5): три группы по уникальным id', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const items = [
    { id: 'a', state: 'verified' }, { id: 'b', state: 'suggested' }, { id: 'c', state: 'conflict' }, { id: 'd', state: 'attention' },
    { id: 'e', state: 'unverified', reason: 'pending' }, { id: 'f', state: 'none' },
    // g не ответил; чужой id не считается
    { id: 'чужой', state: 'verified' },
  ]

  it('найдено = verified + suggested; внимание = conflict + attention + missing; ожидают = остальное и не ответившие; сумма = число id', () => {
    const s = summarizeMatch(ids, items)
    assert.deepEqual([s.found, s.attention, s.waiting, s.unanswered], [2, 2, 3, 1])
    assert.equal(s.found + s.attention + s.waiting, s.total)
    assert.equal(s.total, 7)
    assert.equal(summaryLine(s), 'Signal: сверено или найдено 2 · требуют внимания 2 · ожидают сверки 3')
    assert.equal(summaryTitle(s), 'Всего документов: 7 · сверено: 1 · предложена папка: 1 · противоречие: 1 · папка не видна: 1 · ссылка не сверена: 1 · нет ссылки: 1 · нет ответа сервера: 1')
  })

  it('повторный ответ не удваивает; повторяющиеся id считаются один раз; пусто — нули', () => {
    const s = summarizeMatch(['a', 'a', 'b'], [...items, ...items])
    assert.deepEqual([s.total, s.found, s.attention, s.waiting], [2, 2, 0, 0])
    const empty = summarizeMatch([], [])
    assert.deepEqual([empty.total, empty.found, empty.attention, empty.waiting], [0, 0, 0, 0])
    const down = summarizeMatch(ids, [])
    assert.deepEqual([down.found, down.attention, down.waiting], [0, 0, 7], 'сервер не ответил — все «ожидают», итог не выдуман')
  })
})

// ── Клиент ──────────────────────────────────────────────────────────────────────────────────────────────────────
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('ключи идемпотентности окна сверки', () => {
  it('один ключ на попытку «действие + папка»: повтор — тот же, другое действие, другая папка или reset — новый', () => {
    let n = 0
    const keys = attemptKeys(() => `key-${++n}`)
    assert.equal(keys.keyFor('confirm', 'node-a'), 'key-1')
    assert.equal(keys.keyFor('confirm', 'node-a'), 'key-1', 'повтор после ошибки сети — тот же ключ')
    assert.equal(keys.keyFor('reject', 'node-a'), 'key-2', 'другое действие по той же папке')
    assert.equal(keys.keyFor('reject', 'node-a'), 'key-2')
    assert.equal(keys.keyFor('reject', 'node-b'), 'key-3', 'другая папка')
    assert.equal(keys.keyFor('replace', 'node-b'), 'key-4', 'замена — не подтверждение')
    keys.reset()
    assert.equal(keys.keyFor('replace', 'node-b'), 'key-5', 'после успеха, оставившего окно открытым, — новый')
    assert.equal(n, 5, 'лишних ключей не создаётся')
  })
  it('у каждого окна свои ключи', () => {
    const a = attemptKeys(newIdempotencyKey)
    const b = attemptKeys(newIdempotencyKey)
    assert.notEqual(a.keyFor('confirm', 'node-a'), b.keyFor('confirm', 'node-a'))
  })
})

describe('клиент /api/signal/*', () => {
  it('status: выключено, ошибка, сеть, не JSON — { enabled: false }; включено — с правами', async () => {
    const make = (impl) => createSignalClient({ fetchImpl: impl })
    assert.deepEqual(await make(async () => reply(200, { enabled: false })).status(), SIGNAL_DISABLED)
    assert.deepEqual(await make(async () => reply(503, { code: 'signal_disabled' })).status(), SIGNAL_DISABLED)
    assert.deepEqual(await make(async () => reply(404, { error: 'Not found' })).status(), SIGNAL_DISABLED)
    assert.deepEqual(await make(async () => { throw new TypeError('network') }).status(), SIGNAL_DISABLED)
    assert.deepEqual(await make(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('<html>') } })).status(), SIGNAL_DISABLED)
    const on = await make(async () => reply(200, { enabled: true, canView: true, canEdit: true, confirmAvailable: true })).status()
    assert.deepEqual([on.enabled, on.canView, on.canEdit, on.isAdmin, on.confirmAvailable], [true, true, true, false, true])
  })

  it('allMarks: по курсору до конца; Map id → метка; повтор курсора останавливает цикл', async () => {
    const seen = []
    const pages = { undefined: { items: [{ id: 'a' }, { id: 'b' }], next: 'b', dataAt: 't1' }, b: { items: [{ id: 'c' }], next: null, dataAt: 't2' } }
    const client = createSignalClient({ fetchImpl: async (path) => { seen.push(path); return reply(200, pages[new URL(path, 'http://x').searchParams.get('after') ?? 'undefined']) } })
    const map = await client.allMarks({ limit: 2 })
    assert.deepEqual([...map.keys()], ['a', 'b', 'c'])
    assert.equal(map.dataAt, 't2')
    assert.deepEqual(seen, ['/api/signal/marks?limit=2', '/api/signal/marks?after=b&limit=2'])
    const loop = createSignalClient({ fetchImpl: async () => reply(200, { items: [{ id: 'z' }], next: 'z' }) })
    assert.deepEqual([...(await loop.allMarks()).keys()], ['z'])
  })

  it('match: порции по 200 уникальных id, ответ по одному на id, сбой порции — её id в failed, а не исключение', async () => {
    const bodies = []
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`)
    const client = createSignalClient({
      fetchImpl: async (path, init) => {
        const body = JSON.parse(init.body)
        bodies.push(body.contractIds.length)
        if (bodies.length === 2) return reply(503, { error: 'Сверка недоступна', code: 'signal_unavailable' })
        return reply(200, { dataAt: 'T', items: [...body.contractIds, ...body.contractIds, 'чужой'].map((id) => ({ id, state: 'none' })) })
      },
    })
    const res = await client.match([...ids, ...ids.slice(0, 5)])
    assert.deepEqual(bodies, [200, 200, 50])
    assert.equal(res.items.length, 250, 'две удачные порции, повторы и чужие id отброшены')
    assert.equal(res.failed.length, 200)
    assert.ok(res.error instanceof SignalApiError)
    assert.equal(res.error.status, 503)
    assert.equal(res.dataAt, 'T')
    assert.deepEqual(await client.match([]), { dataAt: null, items: [], failed: [], error: null })
  })

  it('match: таймаут порции — failed, а не зависание', async () => {
    const client = createSignalClient({
      fetchImpl: (path, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))) }),
    })
    const t0 = Date.now()
    const res = await client.match(['a'], { timeoutMs: 40 })
    assert.ok(Date.now() - t0 < 1000)
    assert.deepEqual(res.failed, ['a'])
    assert.equal(res.error.code, 'timeout')
    assert.equal(res.error.status, 0)
  })

  it('решения: тело и адрес как у сервера; 409 stale_state — isStale; текст ошибки — сервера', async () => {
    const sent = []
    const client = createSignalClient({
      fetchImpl: async (path, init) => {
        sent.push({ path, method: init.method, body: init.body && JSON.parse(init.body), headers: init.headers })
        return path.endsWith('/confirm') ? reply(409, { error: 'Данные изменились — откройте сверку заново', code: 'stale_state' }) : reply(200, { state: 'none', stateVersion: 3 })
      },
    })
    await assert.rejects(client.confirm('c/1', { nodeId: 'n' }), (e) => e instanceof SignalApiError && e.isStale && e.status === 409 && e.message === 'Данные изменились — откройте сверку заново')
    assert.deepEqual(await client.reject('c-1', { nodeId: 'n' }), { state: 'none', stateVersion: 3 })
    await client.unlink('c-1', { expectedSignalLink: 'u' })
    assert.deepEqual(sent.map((s) => [s.method, s.path]), [
      ['POST', '/api/signal/contracts/c%2F1/confirm'], ['POST', '/api/signal/contracts/c-1/reject'], ['POST', '/api/signal/contracts/c-1/unlink'],
    ])
    assert.deepEqual(sent[0].headers, { 'content-type': 'application/json' })
  })

  it('чтение: contract, folders, admin — адреса и параметры; пустые параметры не уходят', async () => {
    const paths = []
    const client = createSignalClient({ fetchImpl: async (path, init) => { paths.push(`${init.method} ${path}`); return reply(200, {}) } })
    await client.contract('c-1')
    await client.contract('c-1', { nodeId: 'n-1' })
    await client.folders('c-1', { q: 'корп 14', after: 'p', limit: 50 })
    await client.folders('c-1', { q: '' })
    await client.aliases.create('o-1', 'Синоним')
    await client.aliases.remove('a-1')
    await client.admin.sync()
    await client.admin.unassigned({ sourceId: 3, limit: 10 })
    assert.deepEqual(paths, [
      'GET /api/signal/contracts/c-1', 'GET /api/signal/contracts/c-1?nodeId=n-1',
      `GET /api/signal/folders?contractId=c-1&q=${encodeURIComponent('корп 14')}&after=p&limit=50`, 'GET /api/signal/folders?contractId=c-1',
      'POST /api/signal/aliases', 'DELETE /api/signal/aliases/a-1', 'POST /api/signal/sync', 'GET /api/signal/unassigned?sourceId=3&limit=10',
    ])
  })

  it('ключ идемпотентности — uuid; сеть пропала — status 0 и «Сервер недоступен»', async () => {
    assert.match(newIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notEqual(newIdempotencyKey(), newIdempotencyKey())
    const client = createSignalClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
    await assert.rejects(client.contract('c'), (e) => e.status === 0 && e.code === 'network' && e.message === 'Сервер недоступен')
  })
})
