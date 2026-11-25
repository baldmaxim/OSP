// Надстройка над signal-fake.js (P5a) для карточки договора: состояния «Пути к Signal» у договоров ctr-13…ctr-30 и дерево файлов
// папок (подпапки, версии, даты, ссылки «↗»). Подключается из signal-stand-main.jsx после seed.js; без ?signal=… ничего не делает.
//   sigFileLinks=0 — адрес файла в Signal не настроен (fileLinks: false, у файлов url: null);
//   sigMore=1      — у папки ctr-16 показаны не все файлы (more: true);
//   sigSubFail=1   — раскрытие подпапки отвечает 503 (сбой сервиса).
// Пути папок — как у настоящего сервера после С-21: от границы объекта («корп.1 / ДП 16-26»), без имени проекта, корня и папок
// выше границы. Договор → состояние (ссылка Signal у всех, кроме ctr-23 и ctr-25):
//   ctr-16 сверено, папка с файлами и подпапками   ctr-17 ссылка не сверялась (папка не видна в обходе)   ctr-19 противоречие (номер)
//   ctr-20 папка не видна                          ctr-22 файл удалён в Signal   ctr-23 предложена папка (ссылки нет)
//   ctr-25 ссылки нет, предложений нет             ctr-26 сверено (папка без файлов; отвязка с устаревшей версией)
//   ctr-28 ссылка ждёт сверки (pending)            ctr-29 сверено, ссылка — не адрес сайта (путь)
// Состояния волны исправлений (spec §1): ctr-13 ссылка принята, номер в папке не найден (accepted); ctr-14 корпус, очередь или секция
// не совпали (attention); ctr-18 (ДС) файл не виден в Signal; ctr-21 (ДС) папка допсоглашения (attention:kind_mismatch); ctr-24 (ДС)
// папка недоступна для сверки; ctr-27 (ДС) у договора не указан объект; ctr-30 (ДС) противоречие: номер ДС не совпал.
const params = new URLSearchParams(window.location.search)
const api = window.__signal

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const folder = (n, path) => ({ nodeId: uuid(n), path, files: 4 })
const linkOf = (n) => `https://signal.su10.ru/folder/${uuid(n)}`
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })

const item = (n, name, version, modifiedAt, extra = {}) => ({ nodeId: uuid(n), kind: 'item', name, version, modifiedAt, itemType: 'file', deleted: false, ...extra })
const sub = (n, name) => ({ nodeId: uuid(n), kind: 'folder', name, version: null, modifiedAt: null, itemType: null, deleted: false })
const LONG = 'Приложение_№3_Ведомость_объёмов_работ_по_устройству_фасада_корпус_1_редакция_от_12.11.2026_подписано_обеими_сторонами.pdf'

// Дерево файлов: nodeId папки → { path, files }.
const TREE = new Map([
  [uuid(3016), { path: 'корп.1 / ДП 16-26', files: [
    sub(3101, 'Приложения'),
    item(3102, 'ДП_16-26.pdf', 3, '2026-11-12T09:00:00.000Z'),
    item(3103, 'ДС1_16-26.pdf', 1, '2026-10-02T09:00:00.000Z'),
    item(3104, 'Приложение_ВОР.xlsx', 2, '2026-09-28T09:00:00.000Z'),
    item(3105, LONG, 1, '2026-11-12T10:00:00.000Z'),
    item(3106, 'Старый проект.docx', 1, '2026-08-01T09:00:00.000Z', { deleted: true }),
  ] }],
  [uuid(3101), { path: 'корп.1 / ДП 16-26 / Приложения', files: [
    item(3201, 'Приложение 1 Календарный план.pdf', 1, '2026-09-15T09:00:00.000Z'),
    sub(3202, 'Архив'),
  ] }],
  [uuid(3202), { path: 'корп.1 / ДП 16-26 / Приложения / Архив', files: [
    item(3301, 'Архивная версия плана.pdf', 4, '2026-07-04T09:00:00.000Z'),
  ] }],
  [uuid(3026), { path: 'корп.2 / ДП 26-26', files: [] }],
])

if (api && params.get('signal')) {
  const withUrl = (files) => files.map((f) => ({ ...f, url: params.get('sigFileLinks') === '0' || f.deleted ? null : `https://signal.su10.ru/file/${f.nodeId}` }))
  const contracts = () => window.__fakeDb?.contracts || []

  // Состояния договоров. Ссылку кладём в «базу» стенда, состояние — в «сервер» сверки (api.set).
  const place = (id, link, patch) => {
    const c = contracts().find((x) => x.id === id)
    if (!c) return
    c.signal_link = link
    api.set(id, patch)
  }
  const node16 = folder(3016, TREE.get(uuid(3016)).path)
  place('ctr-16', linkOf(3016), { state: 'verified', reason: 'confirmed', node: node16 })
  place('ctr-17', linkOf(3017), { state: 'unverified', reason: 'not_observed', node: null })
  place('ctr-19', linkOf(3019), { state: 'conflict', reason: 'number_mismatch', node: folder(3019, 'корп.4 / ДП 91-26') })
  place('ctr-20', linkOf(3020), { state: 'attention', reason: 'not_visible', node: folder(3020, 'корп.3 / ДП 20-26') })
  place('ctr-22', linkOf(3022), { state: 'missing', reason: 'deleted', node: folder(3022, 'корп.5 / ДП 22-26') })
  place('ctr-23', null, { state: 'suggested', reason: 'none', node: null,
    candidates: [{ status: 'open', node: folder(3023, 'корп.6 / ДП 23-26'), reasons: ['number', 'object'], flags: [] }] })
  place('ctr-25', null, { state: 'none', reason: 'none', node: null })
  place('ctr-26', linkOf(3026), { state: 'verified', reason: 'existing_url', node: folder(3026, TREE.get(uuid(3026)).path) })
  place('ctr-28', linkOf(3028), { state: 'unverified', reason: 'pending', node: null })
  // Состояния волны исправлений.
  place('ctr-13', linkOf(3013), { state: 'accepted', reason: 'number_not_found', node: folder(3013, 'корп.7 / Договоры подряда / Альфа') })
  place('ctr-14', linkOf(3014), { state: 'attention', reason: 'building_mismatch', node: folder(3014, 'корп.9 / ДП 14-26') })
  place('ctr-18', linkOf(3018), { state: 'attention', reason: 'file_not_visible', node: folder(3018, 'корп.9 / ДП 14-26 / ДС 18-26.pdf') })
  place('ctr-21', linkOf(3021), { state: 'attention', reason: 'kind_mismatch', node: folder(3021, 'корп.8 / ДП 17-26 / ДС 1') })
  place('ctr-24', linkOf(3024), { state: 'unverified', reason: 'unavailable', node: null })
  place('ctr-27', linkOf(3027), { state: 'unverified', reason: 'no_object', node: null })
  place('ctr-30', linkOf(3030), { state: 'conflict', reason: 'ds_mismatch', node: folder(3030, 'корп.6 / ДП 8-26 / ДС 99-26') })
  place('ctr-29', '\\\\su10-fs\\Договоры\\Северный\\29-26', { state: 'verified', reason: 'existing_url', node: folder(3029, 'корп.7 / ДП 29-26') })

  // Надстройка над маршрутами P5a: файлы папки из дерева, раскрытие подпапки (?nodeId=), fileLinks в состоянии сервера.
  const wrap = (method, sample, fn) => {
    const r = api.routes.find((x) => x.method === method && x.re.test(sample))
    if (!r) return
    const orig = r.run
    r.run = (ctx) => fn(ctx, orig)
  }
  wrap('GET', '/api/signal/status', async (ctx, orig) => {
    const res = await orig(ctx)
    const d = await res.json()
    return json(res.status, d.enabled ? { ...d, fileLinks: params.get('sigFileLinks') !== '0' } : d)
  })
  wrap('GET', '/api/signal/contracts/x', async (ctx, orig) => {
    const nodeId = ctx.query.get('nodeId')
    const res = await orig({ ...ctx, query: new URLSearchParams() })
    if (!res.ok) return res
    const d = await res.json()
    if (nodeId) {
      if (params.get('sigSubFail') === '1') return json(503, { error: 'Сверка Signal временно недоступна', code: 'signal_unavailable' })
      const t = TREE.get(nodeId)
      if (!t) return json(403, { error: 'Недостаточно прав', code: 'forbidden' })
      return json(200, { ...d, node: { nodeId, kind: 'folder', path: t.path, observed: true, modifiedAt: '2026-11-12T09:00:00.000Z' }, files: withUrl(t.files), more: false })
    }
    const t = d.node ? TREE.get(d.node.nodeId) : null
    if (!t) return json(200, d)
    return json(200, { ...d, files: withUrl(t.files), more: params.get('sigMore') === '1' && d.node.nodeId === uuid(3016) })
  })
}
