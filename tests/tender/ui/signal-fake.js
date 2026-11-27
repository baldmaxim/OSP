// Подмена /api/signal/* для стенда (интеграция с SIGNAL, раздел 7 спецификации): ответы сервера сверки из памяти страницы.
// Подключается из seed.js и включается параметром ?signal=… (без него window.fetch не трогается):
//   signal=1       — сервер сверки включён; signalEdit=0 — у человека только просмотр (canEdit: false);
//                    signalConfirm=0 — адрес папок Signal не настроен (confirmAvailable: false);
//   signal=off     — сервер отвечает { enabled: false } (выключено); signal=missing — маршрутов нет (404, старый сервер);
//   signal=down    — метки и окно читаются, а сверка по снимку (/match) и решения отвечают 503;
//   signal=slow    — /match отвечает через signalDelay мс (по умолчанию 4500): дольше, чем ждёт браузер;
//   signalDupe=1   — /match повторяет каждую строку ответа дважды; signalLatency=N — задержка каждого ответа, мс;
//   signalStale=1  — данные Signal устарели: status.stale = true, status.dataAt и dataAt меток — 21.11.2026 05:30 UTC (В-7);
//   signalExtra=1  — ещё состояния волны исправлений (см. ниже): accepted, мягкое предупреждение корпуса, файл не виден,
//                    ДС/вид/сторона противоречат, недоступна, нет объекта (seed.js ставит им ссылки);
//   signalPending=1 — как у настоящего сервера: ссылку договора сменили после расчёта — состояние «не сверялась» (unverified:pending),
//                    пока /match не пересчитает; без него стенд отдаёт прежнее состояние (карточка и администрирование на это не рассчитаны).
// Помехи по запросу (включает тест через page.evaluate): lose(re) — следующий запрос, подходящий под «МЕТОД /путь», сервер
// выполнит, а ответ до страницы не дойдёт (сеть оборвалась: fetch отклоняется, состояние уже изменено); hold(re) — ответ на
// следующий такой запрос считается сразу (снимок состояния на этот момент), но страница получит его только после release().
// Состояние — window.__signal: state (Map id → запись), calls (журнал запросов с телом), aliases, bump(id) — «другой человек
// изменил состояние» (версия растёт — окно устарело), set(id, запись), routes — маршруты (массив { method, re, run }): P5b
// и другие стенды добавляют свои. Данные договоров берутся из window.__fakeDb.contracts в момент запроса.
//
// Сценарий по умолчанию (contracts=30 с contractsPaths=1; ссылки Signal у ctr-5, ctr-7, ctr-11 ставит seed.js):
//   ctr-1  сверено (ссылка есть)                       ctr-6  противоречие: ДС чужого ДП (под сверенным ctr-5)
//   ctr-2  предложено две папки (в первой нет           ctr-7  папка удалена в Signal (missing:deleted)
//          object_name — флажок «Запомнить…»)          ctr-8  предложена одна папка (есть object_name)
//   ctr-3  ДС ctr-2: папка с флагом building_mismatch ctr-10 нет ссылки, предложений нет (none)
//          (подтвердить можно, с предупреждением)
//   ctr-4  папка не видна (attention), есть другая     ctr-11 ссылка не сверялась (unverified)
//   ctr-5  сверено (под ним ДС ctr-6)                  остальные — без метки, значок как без Signal.
// С signalExtra=1: ctr-9 (ДС ctr-8) conflict:ds_mismatch; ctr-12 (ДС ctr-11) accepted:number_not_found; ctr-14 attention:building_mismatch
// (текущая папка, подтвердить можно); ctr-15 (ДС ctr-14) attention:file_not_visible; ctr-17 conflict:number_mismatch (у него
// кандидат, который сервер отклоняет 409 hard_conflict); ctr-19 conflict:foreign_party; ctr-20 unverified:unavailable; ctr-21 (ДС
// ctr-20) unverified:no_object; ctr-22 attention:kind_mismatch (текущая папка допсоглашения, подтвердить можно); ctr-24 (ДС ctr-23)
// предложена папка с флагом kind_mismatch. В «Сверке Signal» — 13 документов.
// Кандидат со свойством refuse: 'hard_conflict' сервер при подтверждении отклоняет 409 hard_conflict (ctr-17: вторая папка).
// Договор без записи (создан формой или импортом) /match раскладывает по номеру: «ПРЕД…» — предложена папка, «ПРОТ…» —
// противоречие, «ВНИМ…» — папка не видна, «СВЕР…» — сверено, «ПРИН…» — ссылка принята без номера, «ОЖИД…» — ждёт обработки,
// иначе — нет ссылки.
const params = new URLSearchParams(window.location.search)
const MODE = params.get('signal')

const STALE = params.get('signalStale') === '1'
// Дата данных Signal: свежая или (signalStale=1) устаревшая — её отдают status, marks, /contracts/:id и подсказки значков.
const DATA_AT = STALE ? '2026-11-21T05:30:00.000Z' : '2026-11-23T11:00:00.000Z'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const folder = (n, path, files = 7) => ({ nodeId: uuid(n), path, files })
const urlOf = (node) => `https://signal.su10.ru/folder/${node.nodeId}`
const ROOT = 'Альфа / Северный квартал'

const EXTRA_ON = params.get('signalExtra') === '1'
const SCENARIO = () => ({
  'ctr-1': { state: 'verified', reason: 'confirmed', node: folder(1, `${ROOT} / корп.1 / ДП 1-26`) },
  'ctr-2': {
    state: 'suggested', reason: 'candidates',
    candidates: [
      { node: folder(2, `${ROOT} / корп.2 / ДП 2-26`), reasons: ['number', 'features'], flags: [] },
      { node: folder(22, `${ROOT} / корп.2 / Архив / 2-26`), reasons: ['name_similar'], flags: ['similar'] },
    ],
  },
  'ctr-3': { state: 'suggested', reason: 'candidates', candidates: [{ node: folder(3, `${ROOT} / корп.2 / ДП 2-26 / ДС 3-26`), reasons: ['ds_number'], flags: ['building_mismatch'] }] },
  'ctr-4': {
    state: 'attention', reason: 'not_visible', node: folder(4, `${ROOT} / корп.3 / ДП 4-26`),
    candidates: [{ node: folder(44, `${ROOT} / корп.3 / ДП 4-26 (новая)`), reasons: ['number', 'object_name'], flags: [] }],
  },
  'ctr-5': { state: 'verified', reason: 'existing_url', node: folder(5, `${ROOT} / корп.4 / ДП 5-26`) },
  'ctr-6': { state: 'conflict', reason: 'foreign_dp', node: folder(6, `${ROOT} / корп.7 / ДП 77-26 / ДС 6-26`) },
  'ctr-7': { state: 'missing', reason: 'deleted', node: folder(7, `${ROOT} / корп.5 / ДП 7-26`) },
  'ctr-8': { state: 'suggested', reason: 'candidates', candidates: [{ node: folder(8, `${ROOT} / корп.6 / ДП 8-26`), reasons: ['number', 'object_name'], flags: [] }] },
  'ctr-10': { state: 'none', reason: 'none' },
  'ctr-11': { state: 'unverified', reason: 'unavailable' },
  ...(EXTRA_ON ? EXTRA() : {}),
})

// signalExtra=1: состояния волны исправлений (spec §1).
const EXTRA = () => ({
  'ctr-9': { state: 'conflict', reason: 'ds_mismatch', node: folder(9, `${ROOT} / корп.6 / ДП 8-26 / ДС 99-26`) },
  'ctr-12': { state: 'accepted', reason: 'number_not_found', node: folder(12, `${ROOT} / корп.7 / Договоры подряда / Альфа`) },
  'ctr-14': { state: 'attention', reason: 'building_mismatch', node: folder(14, `${ROOT} / корп.9 / ДП 14-26`) },
  'ctr-15': { state: 'attention', reason: 'file_not_visible', node: folder(15, `${ROOT} / корп.9 / ДП 14-26 / ДС 15-26`) },
  'ctr-17': {
    state: 'conflict', reason: 'number_mismatch', node: folder(17, `${ROOT} / корп.8 / ДП 91-26`),
    candidates: [{ node: folder(117, `${ROOT} / корп.8 / ДП 17-26 (черновик)`), reasons: ['number'], flags: [], refuse: 'hard_conflict' }],
  },
  'ctr-19': { state: 'conflict', reason: 'foreign_party', node: folder(19, `${ROOT} / корп.8 / ДП 19-26 / Другая организация`) },
  'ctr-20': { state: 'unverified', reason: 'unavailable' },
  'ctr-21': { state: 'unverified', reason: 'no_object' },
  'ctr-22': { state: 'attention', reason: 'kind_mismatch', node: folder(22, `${ROOT} / корп.8 / ДП 22-26 / ДС 1`) },
  'ctr-24': { state: 'suggested', reason: 'candidates', candidates: [{ node: folder(24, `${ROOT} / корп.8 / ДП 23-26 / ДС 24-26`), reasons: ['ds_number'], flags: ['kind_mismatch'] }] },
})

// Все папки стенда — для «Другая папка…» и разбора nodeId.
const POOL = () => {
  const out = new Map()
  for (const e of Object.values(SCENARIO())) {
    if (e.node) out.set(e.node.nodeId, e.node)
    for (const c of e.candidates || []) out.set(c.node.nodeId, c.node)
  }
  for (const [n, p] of [[91, `${ROOT} / корп.1 / Входящие`], [92, `${ROOT} / корп.2 / Входящие`], [93, `${ROOT} / Общие документы`]]) out.set(uuid(n), folder(n, p, 3))
  return out
}

const ruDate = (iso) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })
const ruDateTime = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '')
const GENERAL = {
  object_mismatch: 'объект папки не совпадает с объектом договора', number_mismatch: 'номер в папке не совпадает', foreign_dp: 'ДС относится к другому договору',
  ambiguous: 'в названии папки несколько номеров', ds_mismatch: 'номер ДС не совпал с номером в названии папки',
  foreign_party: 'в названии папки ИНН другой организации',
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })
const fail = (status, code, error) => json(status, { error, code })
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (!ms) { resolve(); return }
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Запрос прерван', 'AbortError')) })
})

function install() {
  const EDIT = params.get('signalEdit') !== '0'
  const CONFIRM = params.get('signalConfirm') !== '0'
  const LATENCY = Number(params.get('signalLatency') || 0)
  const state = new Map()
  const api = window.__signal = {
    state, calls: [], aliases: [], dataAt: DATA_AT, generation: 7,
    // Чужое изменение: версия состояния растёт, окно с прежней версией получит 409.
    bump(id) { const e = entry(id); e.stateVersion++ },
    lose(re) { api.losing.push(new RegExp(re)) },
    hold(re) { api.holds.push({ re: new RegExp(re), passed: false }) },
    release() { for (const h of api.held) h.release() },
    losing: [], holds: [], held: [],
    set(id, patch) { Object.assign(entry(id), patch) },
    routes: [],
  }
  const db = () => window.__fakeDb
  const contractOf = (id) => (db().contracts || []).find((c) => c.id === id)
  const touch = () => window.__fakeTouch?.('contracts')

  // Запись состояния: из сценария или пустая; версия — 1.
  const scenario = SCENARIO()
  function entry(id) {
    if (!state.has(id)) state.set(id, { stateVersion: 1, revision: 7, link: linkOfContract(id), state: 'none', reason: 'none', candidates: [], ...structuredClone(scenario[id] || {}) })
    const e = state.get(id)
    e.candidates = (e.candidates || []).map((c) => ({ status: 'open', ...c }))
    return e
  }
  // Что видно в метках: договоры сценария и всё, что сервер уже сверял или решал.
  const marked = () => [...new Set([...Object.keys(scenario), ...state.keys()])].filter((id) => contractOf(id)).sort()
  const openCands = (e) => (e.candidates || []).filter((c) => c.status === 'open')
  // Подсказка значка — как у сервера (spec §5.2): дата — данные Signal (dataAt метки), не дата пересчёта; путь — видимой папки.
  const dataAtOf = (e) => e.dataAt || DATA_AT
  const tipOf = (id, e) => {
    const link = contractOf(id)?.signal_link
    const at = ` · данные на ${ruDate(dataAtOf(e))}`
    const where = e.node?.path ? ` · ${e.node.path}` : ''
    switch (e.state) {
      case 'suggested': return EDIT && openCands(e)[0] ? `Signal: предложена папка ${openCands(e)[0].node.path}` : 'Signal: предложена папка'
      case 'verified': return `Signal: сверено${at}${where}`
      case 'accepted': return `Signal: ссылка принята, номер в папке не найден${at}${where}`
      case 'unverified':
        if (e.reason === 'unavailable') return 'Signal: папка недоступна для сверки'
        if (e.reason === 'no_object') return 'Signal: у договора не указан объект'
        return e.reason === 'pending' || !link ? 'Signal: ссылка не сверялась' : `Signal: ссылка не сверялась — данные на ${ruDateTime(dataAtOf(e))}`
      case 'attention':
        if (e.reason === 'building_mismatch') return 'Signal: корпус, очередь или секция не совпали — проверьте'
        if (e.reason === 'kind_mismatch') return 'Signal: папка относится к допсоглашению — проверьте'
        return e.reason === 'file_not_visible' ? 'Signal: файл не виден в Signal' : 'Signal: папка не видна в Signal'
      case 'missing': return 'Signal: файл удалён в Signal'
      case 'conflict': return `Signal: противоречие — ${GENERAL[e.reason] || 'проверьте'}`
      default: return e.reason === 'no_object' ? 'Signal: у договора не указан объект' : 'Signal: ссылки нет'
    }
  }

  // signalPending=1: ссылку договора сменили после расчёта — как у сервера, состояние «не сверялась», пока не пересчитано.
  const PENDING_ON_EDIT = params.get('signalPending') === '1'
  const linkOfContract = (id) => (contractOf(id)?.signal_link || null)
  const shown = (id, e) => {
    if (!PENDING_ON_EDIT || !('link' in e) || e.link === linkOfContract(id)) return e
    return { ...e, state: linkOfContract(id) ? 'unverified' : 'none', reason: linkOfContract(id) ? 'pending' : 'none', node: null }
  }

  // Договор без записи раскладывается по номеру (см. шапку).
  function classify(id) {
    const c = contractOf(id)
    if (!c || state.has(id) || scenario[id]) return entry(id)
    const n = String(c.contract_number || '')
    const e = entry(id)
    const seed = Number(String(n).replace(/\D/g, '').slice(-3) || 0) + 100
    if (/^ПРЕД/.test(n)) Object.assign(e, { state: 'suggested', reason: 'candidates', candidates: [{ status: 'open', node: folder(500 + seed, `${ROOT} / корп.9 / ДП ${n}`), reasons: ['number', 'object_name'], flags: [] }] })
    else if (/^ПРОТ/.test(n)) Object.assign(e, { state: 'conflict', reason: 'object_mismatch', node: folder(600 + seed, `${ROOT} / корп.8 / ДП ${n}`) })
    else if (/^ВНИМ/.test(n)) Object.assign(e, { state: 'attention', reason: 'not_visible', node: folder(700 + seed, `${ROOT} / корп.8 / ДП ${n}`) })
    else if (/^СВЕР/.test(n)) Object.assign(e, { state: 'verified', reason: 'existing_url', node: folder(800 + seed, `${ROOT} / корп.1 / ДП ${n}`) })
    else if (/^ОЖИД/.test(n)) Object.assign(e, { state: 'unverified', reason: 'pending' })
    else if (/^ПРИН/.test(n)) Object.assign(e, { state: 'accepted', reason: 'number_not_found', node: folder(1100 + seed, `${ROOT} / корп.1 / Договоры / ${n}`) })
    else if (/conflict/.test(String(c.signal_link || ''))) Object.assign(e, { state: 'conflict', reason: 'object_mismatch', node: folder(900 + seed, `${ROOT} / корп.8 / ДП ${n}`) })
    return e
  }

  // Пересчёт по снимку (/match). signalPending=1: ссылка сменилась после расчёта — состояние считается заново по новой ссылке
  // («conflict» в адресе — противоречие, иначе ссылка принята без номера в папке; пустая — «ссылки нет»).
  function recompute(id) {
    const e = classify(id)
    if (PENDING_ON_EDIT && 'link' in e && e.link !== linkOfContract(id)) {
      const link = linkOfContract(id)
      e.link = link
      if (!link) Object.assign(e, { state: 'none', reason: 'none', node: null })
      else if (/conflict/.test(link)) Object.assign(e, { state: 'conflict', reason: 'object_mismatch', node: folder(950 + (e.stateVersion || 0), `${ROOT} / корп.8 / Новая ссылка`) })
      else Object.assign(e, { state: 'accepted', reason: 'number_not_found', node: folder(960 + (e.stateVersion || 0), `${ROOT} / корп.1 / Новая ссылка`) })
    }
    return e
  }

  const files = (node) => Array.from({ length: Math.min(node.files ?? 7, 7) }, (_, i) => ({
    nodeId: uuid(1000 + i), kind: 'item', name: `Файл ${i + 1}.pdf`, version: 1 + (i % 3), modifiedAt: `2026-11-${String(12 - i).padStart(2, '0')}T09:00:00.000Z`, url: null,
  }))

  const route = (method, re, run) => api.routes.push({ method, re, run })
  const ok = (data) => json(200, data)
  const mutating = () => (MODE === 'down' ? fail(503, 'signal_unavailable', 'Сверка Signal временно недоступна') : null)

  route('GET', /^\/api\/signal\/status$/, () => {
    if (MODE === 'off') return ok({ enabled: false })
    return ok({ enabled: true, dataAt: DATA_AT, stale: STALE, staleHours: STALE ? 3 : null, generation: api.generation, canView: true, canEdit: EDIT, isAdmin: false, confirmAvailable: CONFIRM, fileLinks: false })
  })
  route('GET', /^\/api\/signal\/marks$/, ({ query }) => {
    const ids = marked().filter((id) => !query.get('after') || id > query.get('after'))
    const limit = Math.min(1000, Number(query.get('limit') || 500))
    const page = ids.slice(0, limit)
    return ok({
      items: page.map((id) => { const e = shown(id, entry(id)); return { id, state: e.state, reason: e.reason, pending: e.reason === 'pending', tip: tipOf(id, e), hasCandidate: openCands(e).length > 0, dataAt: dataAtOf(e) } }),
      next: ids.length > limit ? page[page.length - 1] : null, dataAt: DATA_AT,
    })
  })
  route('GET', /^\/api\/signal\/contracts\/([^/]+)$/, ({ match }) => {
    const down = MODE === 'down' ? fail(503, 'signal_unavailable', 'Сверка Signal временно недоступна') : null
    if (down) return down
    const id = decodeURIComponent(match[1])
    const c = contractOf(id)
    if (!c) return fail(404, 'not_found', 'Договор не найден')
    const e = shown(id, entry(id))
    return ok({
      state: e.state, reason: e.reason, pending: e.reason === 'pending', stateVersion: e.stateVersion, revision: e.revision, signalLink: c.signal_link || null, dataAt: dataAtOf(e),
      node: e.node ? { nodeId: e.node.nodeId, path: e.node.path, observed: !(e.state === 'attention' && e.reason === 'not_visible'), modifiedAt: '2026-11-12T09:00:00.000Z' } : null,
      files: e.node ? files(e.node) : [], more: false,
      ...(EDIT ? { candidates: (e.candidates || []).map((x) => ({ nodeId: x.node.nodeId, path: x.node.path, score: 90, reasons: x.reasons, flags: x.flags, status: x.status })) } : {}),
      canEdit: EDIT, confirmAvailable: CONFIRM,
    })
  })
  route('GET', /^\/api\/signal\/folders$/, ({ query }) => {
    const down = mutating()
    if (down) return down
    if (!EDIT) return fail(403, 'forbidden', 'Недостаточно прав')
    const q = String(query.get('q') || '').toLowerCase()
    const items = [...POOL().values()].filter((f) => !q || f.path.toLowerCase().includes(q)).map(({ nodeId, path, files: n }) => ({ nodeId, path, files: n }))
    return ok({ items: items.slice(0, 100), next: null })
  })
  route('POST', /^\/api\/signal\/match$/, async ({ body, signal: abort }) => {
    const down = mutating()
    if (down) return down
    const ids = body.contractIds
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || new Set(ids).size !== ids.length) return fail(400, 'invalid', 'Неверный запрос')
    if (!EDIT || ids.some((id) => !contractOf(id))) return fail(403, 'forbidden', 'Недостаточно прав')
    const items = ids.map((id) => {
      const e = recompute(id)
      const first = openCands(e)[0]
      const node = e.node || first?.node
      return { id, state: e.state, reason: e.reason, ...(node ? { nodeId: node.nodeId, path: node.path } : {}), hasCandidate: openCands(e).length > 0 }
    })
    if (MODE === 'slow') await sleep(Number(params.get('signalDelay') || 4500), abort)
    return ok({ dataAt: DATA_AT, items: params.get('signalDupe') === '1' ? [...items, ...items] : items })
  })

  // Решения человека: CAS по ссылке и версии, идемпотентность по ключу, одна «транзакция».
  const decide = (kind) => ({ match, body }) => {
    const down = mutating()
    if (down) return down
    if (!EDIT) return fail(403, 'forbidden', 'Недостаточно прав')
    const id = decodeURIComponent(match[1])
    const c = contractOf(id)
    if (!c) return fail(404, 'not_found', 'Договор не найден')
    const e = entry(id)
    if (e.lastKey && e.lastKey === body.idempotencyKey) return ok(e.lastResult)
    if (body.expectedStateVersion !== e.stateVersion || (body.expectedSignalLink || '') !== (c.signal_link || '')) {
      return fail(409, 'stale_state', 'Данные изменились — откройте сверку заново')
    }
    const finish = (result) => { e.stateVersion++; result.stateVersion = e.stateVersion; e.lastKey = body.idempotencyKey; e.lastResult = result; touch(); return ok(result) }
    if (kind === 'unlink') {
      c.signal_link = null
      Object.assign(e, { state: 'none', reason: 'unlinked', node: null, link: null })
      return finish({ state: 'none' })
    }
    const node = POOL().get(body.nodeId) || [...state.values()].flatMap((x) => [x.node, ...(x.candidates || []).map((k) => k.node)]).find((n) => n?.nodeId === body.nodeId)
    if (!node) return fail(422, 'node_unavailable', 'Папка вне доступного объекта')
    if (kind === 'reject') {
      const cand = (e.candidates || []).find((x) => x.node.nodeId === node.nodeId)
      if (cand) cand.status = 'rejected'
      const left = openCands(e).length > 0
      if (!left && !c.signal_link) Object.assign(e, { state: 'none', reason: 'none' })
      else if (left && !c.signal_link) e.state = 'suggested'
      return finish({ state: e.state })
    }
    if (!CONFIRM) return fail(409, 'confirm_unavailable', 'Сверка Signal не включена')
    const cand = (e.candidates || []).find((x) => x.node.nodeId === node.nodeId)
    if (cand?.refuse === 'hard_conflict' || (e.state === 'conflict' && e.node?.nodeId === node.nodeId)) {
      return fail(409, 'hard_conflict', 'Папка противоречит данным договора — подтвердить нельзя')
    }
    // Текущую папку подтверждают, только если она «сверено», «принята» или с мягким предупреждением корпуса.
    const sameNode = e.node?.nodeId === node.nodeId
    const softCurrent = e.state === 'attention' && ['building_mismatch', 'kind_mismatch'].includes(e.reason)
    if (sameNode && !cand && !['verified', 'accepted'].includes(e.state) && !softCurrent) {
      return fail(409, 'confirm_unavailable', 'Подтвердить эту папку сейчас нельзя')
    }
    if (c.signal_link && !sameNode && c.signal_link !== urlOf(node) && !body.replace) return fail(409, 'replace_required', 'У договора уже есть другая ссылка — нажмите «Заменить»')
    if (body.rememberAlias) api.aliases.push({ id: `al-${api.aliases.length + 1}`, text: body.rememberAlias, contractId: id })
    const warning = (cand?.flags || []).find((f) => ['building_mismatch', 'kind_mismatch'].includes(f)) || (sameNode && softCurrent ? e.reason : null)
    if (!sameNode) c.signal_link = urlOf(node)
    Object.assign(e, { state: 'verified', reason: 'confirmed', node, candidates: [], link: c.signal_link })
    return finish({ state: 'verified', reason: 'confirmed', signalLink: c.signal_link, warning })
  }
  route('POST', /^\/api\/signal\/contracts\/([^/]+)\/confirm$/, decide('confirm'))
  route('POST', /^\/api\/signal\/contracts\/([^/]+)\/reject$/, decide('reject'))
  route('POST', /^\/api\/signal\/contracts\/([^/]+)\/unlink$/, decide('unlink'))

  route('GET', /^\/api\/signal\/aliases$/, () => ok({ items: api.aliases.map((a) => ({ id: a.id, text: a.text, objectId: null, objectName: '', author: 'Тест', createdAt: DATA_AT })) }))

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const href = String(input?.url || input)
    let url
    try { url = new URL(href, window.location.origin) } catch { return realFetch(input, init) }
    if (!url.pathname.startsWith('/api/signal/')) return realFetch(input, init)
    if (MODE === 'missing') return json(404, { error: 'Not found' })
    const method = String(init.method || 'GET').toUpperCase()
    let body = null
    try { body = init.body ? JSON.parse(init.body) : null } catch { /* не JSON */ }
    api.calls.push({ method, path: url.pathname, query: url.search, body })
    await sleep(LATENCY, init.signal)
    for (const r of api.routes) {
      const m = r.method === method && r.re.exec(url.pathname)
      if (!m) continue
      const res = await r.run({ match: m, query: url.searchParams, body: body || {}, signal: init.signal })
      const label = `${method} ${url.pathname}`
      const hold = api.holds.findIndex((h) => h.re.test(label))
      if (hold >= 0) {
        const [h] = api.holds.splice(hold, 1)
        const gate = new Promise((resolve) => { h.release = resolve })
        api.held.push(h)
        await gate
        h.passed = true
      }
      const lost = api.losing.findIndex((re) => re.test(label))
      if (lost >= 0) { api.losing.splice(lost, 1); throw new TypeError('Failed to fetch') }
      return res
    }
    return json(404, { error: 'Not found' })
  }
}

if (MODE) install()
