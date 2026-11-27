// «Сверка договоров с Signal» — 20 маршрутов /api/signal/* (раздел 7 спецификации интеграции, волна исправлений §5). Данные — снимок папок Signal
// в нашей базе (osp_private.signal_*, migration/yandex/20270228_signal_integration.sql); в Signal ходит только обход
// (src/lib/signalSync.js) и добавление корня (маршрут 12, чтение дерева проекта). Браузер получает метки, окно сверки и
// результат решений человека; чужие имена, пути и идентификаторы узлов в ответы не попадают.
//
//   GET    /api/signal/status                      — включено ли, права, «данные на …»; админу — корни и последние прогоны;
//   GET    /api/signal/marks                       — значки реестра страницами (по умолчанию 500);
//   GET    /api/signal/contracts/:id               — окно сверки: состояние, связанная папка, файлы, предложения (при правке);
//   GET    /api/signal/folders                     — поиск папки объекта договора (при правке);
//   POST   /api/signal/match                       — сверка 1–200 договоров по готовому снимку (в Signal не ходит, ссылку не меняет);
//   POST   /api/signal/contracts/:id/{confirm,reject,unlink} — решения человека (одна транзакция в базе, CAS и ключ повтора);
//   GET/POST/DELETE /api/signal/aliases[/:id]      — другие названия объекта в именах папок (список — сотруднику с правкой: свои, админу: все);
//   POST   /api/signal/sources, PATCH …/sources/:id, POST …/bindings (objectId: null — «Снять»), POST …/bindings/preview, POST …/sync,
//   GET    …/runs, …/unassigned, …/tree, …/bindings — администратор.
//
// Права. На маршруте — config.access (сотрудник, суперадминистратор или администратор, подрядчик — 403); решает база: каждая функция osp_private.signal_*
// сама проверяет osp_can('contracts', …), охват объектов и (для узлов) границу объекта. Договор вне охвата — 404 без деталей.
// Выключено (SIGNAL_SYNC≠1, нет схемы) — status отвечает { enabled: false }, остальное — 503 signal_disabled. Мутации при барьере
// записи — 503 OSP_READONLY. Ответы — Cache-Control: private, no-store.
import { z } from 'zod'
import { access, REQUIREMENTS } from '../lib/access.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'
import { SignalError, redact } from '../lib/signalClient.js'
import { buildSignalUrl, contractContextKey, contractFingerprint, evaluateNode, nodeKeyOf, nodeQueryFor, parseSignalUrl } from '../lib/signalMatch.js'
import { normMatchName } from '../shared/matchName.js'
import { codeKey } from '../shared/contractNumbering.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = z.string().regex(UUID_RE).transform((v) => v.toLowerCase())
const digits = z.string().regex(/^\d{1,15}$/).transform(Number)
// Идентификаторы корней и прогонов — bigint базы: наружу числом, принимаем число или строку из цифр.
const bigId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digits.refine((n) => n > 0)])
const intParam = (min, max, fallback) => z.string().regex(/^\d{1,6}$/).transform(Number).refine((n) => n >= min && n <= max).optional().transform((n) => n ?? fallback)

const EMPTY_BODY = z.object({})
const MATCH_BODY = z.object({ contractIds: z.array(uuid).min(1).max(200).refine((a) => new Set(a).size === a.length) })
const CONFIRM_BODY = z.object({
  nodeId: uuid,
  replace: z.boolean(),
  rememberAlias: z.string().trim().max(120).nullable().optional(),
  expectedSignalLink: z.string().max(2000).nullable(),
  expectedStateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // ревизия строки очереди, как её видело окно (card.revision); нет — «окно строки не видело» (0)
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  idempotencyKey: uuid,
})
const REJECT_BODY = z.object({
  nodeId: uuid,
  note: z.string().trim().max(300).nullable().optional(),
  expectedStateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: uuid,
})
const UNLINK_BODY = z.object({
  expectedSignalLink: z.string().min(1).max(2000),
  expectedStateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  idempotencyKey: uuid,
})
const ALIAS_BODY = z.object({ objectId: uuid, text: z.string().trim().min(2).max(120) })
const SOURCE_BODY = z.object({ url: z.string().trim().min(1).max(2000), objectIds: z.array(uuid).max(20) })
const SOURCE_PATCH = z.object({ enabled: z.boolean().optional(), objectIds: z.array(uuid).max(20).optional() })
  .refine((b) => b.enabled !== undefined || b.objectIds !== undefined)
const BINDING_BODY = z.object({ sourceId: bigId, nodeId: uuid, objectId: uuid.nullable() }) // objectId: null — «Снять»
const PREVIEW_BODY = z.object({ sourceId: bigId, nodeId: uuid, objectId: uuid.nullable() })

// Сотрудник, а также суперадминистратор без строки user_roles (решение 24.11.2026: REQUIREMENTS.employeeOrSuperadmin, access.js);
// подрядчик и заблокированный — отказ. Что можно по существу, решает база (osp_can / is_admin и охват объектов).
const EMPLOYEE = { require: 'employeeOrSuperadmin', deny: 'Только для сотрудников' }
const ADMIN = { require: 'admin', deny: 'Только администратор' }
const withRate = (base, limiter) => ({ ...base, rate: { limiter, deny: 'Слишком часто — повторите через минуту' } })

const T = {
  disabled: 'Сверка Signal не включена',
  invalid: 'Неверный запрос',
  forbidden: 'Недостаточно прав',
  notFound: 'Не найдено',
  stale: 'Данные изменились — откройте сверку заново',
  replace: 'У договора уже есть другая ссылка — нажмите «Заменить»',
  aliasTaken: 'Название уже используется',
  outside: 'Папка вне доступного объекта',
  unassigned: 'Для папки не назначен объект — обратитесь к администратору',
  hardConflict: 'Папка противоречит данным договора — подтвердить нельзя',
  confirmNo: 'Подтвердить эту папку сейчас нельзя',
  confirmNoUrl: 'Подтверждение недоступно: адрес папок Signal на сервере не настроен',
  notConfigured: 'Подключение к Signal не настроено на сервере',
  busy: 'Обход уже идёт — дождитесь его завершения',
  noSources: 'Нет включённых корней — добавьте корень',
  unavailable: 'Signal временно недоступен — повторите позже',
}

// Ошибки функций базы (ERRCODE SGxxx, MESSAGE — машинный код) → ответ без имён и путей.
const SQL_ERRORS = {
  forbidden: [403, 'forbidden', T.forbidden],
  not_found: [404, 'not_found', T.notFound],
  stale_state: [409, 'stale_state', T.stale],
  replace_required: [409, 'replace_required', T.replace],
  alias_taken: [409, 'alias_taken', T.aliasTaken],
  busy: [409, 'busy', 'Такой корень уже добавлен'],
  hard_conflict: [409, 'hard_conflict', T.hardConflict],
  invalid: [422, 'invalid', 'Неверные данные'],
  node_unavailable: [422, 'node_unavailable', T.outside],
  object_unassigned: [422, 'object_unassigned', T.unassigned],
}
const SG_FALLBACK = { SG403: 'forbidden', SG404: 'not_found', SG409: 'stale_state', SG422: 'invalid' }

function sqlProblem(err) {
  const code = String(err?.code || '')
  if (!/^SG(403|404|409|422)$/.test(code)) return null
  const entry = SQL_ERRORS[String(err.message)] || SQL_ERRORS[SG_FALLBACK[code]]
  return { status: entry[0], code: entry[1], error: entry[2] }
}

// Общая причина противоречия — без имён и путей.
const CONFLICT_TEXT = {
  object_mismatch: 'объект папки не совпадает с объектом договора',
  number_mismatch: 'номер в названии папки не совпал с номером договора',
  foreign_dp: 'ДС относится к другому договору',
  ambiguous: 'в названии папки несколько номеров договоров',
  ds_mismatch: 'номер ДС не совпал с номером в названии папки',
  foreign_party: 'в названии папки ИНН другой организации',
}

const MSK = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
// Время в ответах — ISO в UTC с миллисекундами (база отдаёт микросекунды и смещение).
const iso = (value) => {
  const t = value ? new Date(value) : null
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null
}
function moscow(value, withTime) {
  const t = value ? new Date(value) : null
  if (!t || Number.isNaN(t.getTime())) return ''
  const p = Object.fromEntries(MSK.formatToParts(t).map((x) => [x.type, x.value]))
  return `${p.day}.${p.month}.${p.year}${withTime ? ` ${p.hour}:${p.minute}` : ''}`
}

// «Данные устарели» (В-7): порог в рабочее время (пн–пт 08:00–20:00 по Москве, UTC+3 без перехода) и вне его — разный.
export const SIGNAL_STALE_DEFAULTS = Object.freeze({ workHours: 3, offHours: 36 })
const MSK_OFFSET_MS = 3 * 3_600_000
export function isWorkTime(now) {
  const t = new Date(new Date(now).getTime() + MSK_OFFSET_MS)
  const day = t.getUTCDay()
  const hour = t.getUTCHours()
  return day >= 1 && day <= 5 && hour >= 8 && hour < 20
}
// dataAt — дата данных (ISO); нет даты — «не устарели» (данных ещё нет, об этом говорят значки). → { stale, staleHours }
export function staleStatus(dataAt, now, { workHours = SIGNAL_STALE_DEFAULTS.workHours, offHours = SIGNAL_STALE_DEFAULTS.offHours } = {}) {
  const staleHours = isWorkTime(now) ? workHours : offHours
  const at = dataAt ? new Date(dataAt).getTime() : NaN
  const stale = Number.isFinite(at) && new Date(now).getTime() - at > staleHours * 3_600_000
  return { stale, staleHours }
}

// Состояние, как его показывает портал: договор ждёт пересчёта (в очереди ревизия новее обработанной) — «не сверялась» при
// непустой ссылке, иначе «ссылки нет» (раздел 3 спецификации).
export function shownState({ state, reason, pending, hasLink }) {
  if (pending || !state) return hasLink ? { state: 'unverified', reason: 'pending', pending: true } : { state: 'none', reason: 'none', pending: true }
  return { state, reason: reason || null, pending: false }
}

// Подсказка значка (раздел 8, §1 волны исправлений). Путь — только видимого узла от границы объекта; путь предложенной папки —
// только при праве правки (SQL его иначе не даёт). «Данные на …» — дата данных корня узла (dataAt), не дата пересчёта.
const UNVERIFIED_TIPS = {
  unsupported_url: 'Signal: формат ссылки не поддерживается',
  unavailable: 'Signal: папка недоступна для сверки',
  no_snapshot: 'Signal: данных Signal ещё нет — ссылка не сверялась',
  not_observed: 'Signal: папка не найдена в последнем обходе — ссылка не сверялась',
  no_object: 'Signal: у договора не указан объект',
}
const ATTENTION_TIPS = {
  not_visible: 'Signal: папка не видна в Signal',
  file_not_visible: 'Signal: файл не виден в Signal',
  building_mismatch: 'Signal: корпус, очередь или секция не совпали — проверьте',
  kind_mismatch: 'Signal: папка относится к допсоглашению — проверьте',
}
export function tipFor({ state, reason, pending, path, candidatePath, dataAt }) {
  const when = dataAt ? ` · данные на ${moscow(dataAt, false)}` : '' // ДД.ММ.ГГГГ по Москве
  const where = path ? ` · ${path}` : ''
  switch (state) {
    case 'suggested': return candidatePath ? `Signal: предложена папка ${candidatePath}` : 'Signal: предложена папка'
    case 'verified': return `Signal: сверено${when}${where}`
    case 'accepted': return `Signal: ссылка принята, номер в папке не найден${when}${where}`
    case 'unverified':
      if (pending || reason === 'pending') return 'Signal: ссылка не сверялась'
      return UNVERIFIED_TIPS[reason] || (dataAt ? `Signal: ссылка не сверялась — данные на ${moscow(dataAt, true)}` : 'Signal: ссылка не сверялась')
    case 'attention': return ATTENTION_TIPS[reason] || 'Signal: папка не видна в Signal'
    case 'missing': return 'Signal: файл удалён в Signal'
    case 'conflict': return `Signal: противоречие — ${CONFLICT_TEXT[reason] || 'проверьте данные договора'}`
    default: return reason === 'no_object' ? UNVERIFIED_TIPS.no_object : 'Signal: ссылки нет'
  }
}

// Причины, при которых узел договору не виден: решает база (signal_confirm → node_unavailable / object_unassigned, 422 без деталей).
const HIDDEN_REASONS = new Set(['unavailable', 'no_object', 'no_snapshot'])

// Другое название объекта не должно совпадать с именем или кодом другого объекта (иначе папки чужого объекта «притянулись» бы).
function clashesWithOtherObject(key, objects, ownId) {
  for (const o of objects || []) {
    if (!o || o.id === ownId) continue
    if (normMatchName(o.name) === key || normMatchName(o.code) === key) return true
    const ck = codeKey(o.code)
    if (ck && String(ck).toLowerCase() === key) return true
  }
  return false
}

export function registerSignal(app, ctx) {
  const { db, isReadOnly, signal, isSuperadmin } = ctx
  const cfg = signal?.config || {}
  const jobs = signal?.jobs
  const sync = signal?.sync
  const api = signal?.api
  const capability = signal?.capability
  const formats = Array.isArray(cfg.urlFormats) ? cfg.urlFormats : []
  const secrets = [cfg.clientSecret, cfg.clientId]

  const on = () => Boolean(signal && db && capability?.active())
  const off = (reply) => reply.code(503).send({ error: T.disabled, code: 'signal_disabled' })
  const readOnly = (reply) => (isReadOnly() ? reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE }) : null)
  const bad = (reply) => reply.code(400).send({ error: T.invalid, code: 'invalid' })
  const problem = (reply, status, code, error) => reply.code(status).send({ error, code })
  const whoOf = (request) => request.auth.who

  // Маршрут: права из access, заголовок «не кешировать», ошибки базы SGxxx → ответ.
  const route = ({ method, url, access: declared, body, handler }) => app.route({
    method, url,
    config: { access: declared, ...(body ? { body } : {}) },
    onSend: async (request, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload },
    handler: async (request, reply) => {
      try {
        const out = await handler(request, reply)
        return reply.sent ? reply : out
      } catch (err) {
        const p = sqlProblem(err)
        if (p) return problem(reply, p.status, p.code, p.error)
        throw err
      }
    },
  })

  const fn = (name, args, tx) => tx.query(`select osp_private.${name}(${args.map((a, i) => `$${i + 1}::${a.type}`).join(', ')}) as r`, args.map((a) => a.v))
  const a = (v, type) => ({ v, type })
  const readFn = (who, name, args) => db.read(who, async (tx) => (await fn(name, args, tx)).rows[0].r)
  const writeFn = (who, name, args) => db.write(who, async (tx) => (await fn(name, args, tx)).rows[0].r)

  // Вправе ли вошедший (kind: view | edit | admin) и виден ли ему договор. Нет права — SG403 (→ 403), нет договора в охвате — false.
  const authorize = (who, kind, contractId) => db.read(who, async (tx) => {
    await tx.query('select osp_private.signal_require($1::text)', [kind])
    if (!contractId) return true
    return (await tx.query('select osp_private.signal_contract_ok($1::uuid) as ok', [contractId])).rows[0].ok === true
  })

  // Шаблон адреса задан и годен: проверка — пробной сборкой на синтетических идентификаторах.
  const PROBE = '00000000-0000-4000-8000-000000000001'
  const buildTemplateOk = (template, kind) => Boolean(template) && Boolean(buildSignalUrl(template, { projectId: PROBE, nodeId: PROBE, kind }))

  const parse = (schema, value) => {
    const r = schema.safeParse(value)
    return r.success ? r.data : null
  }

  // ── 1. status ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Часы — подменяемые только тестом (config.signal.now); в службе — Date.now.
  const clockNow = () => new Date(typeof cfg.now === 'function' ? cfg.now() : Date.now())
  const staleOpts = { workHours: cfg.staleWorkHours ?? SIGNAL_STALE_DEFAULTS.workHours, offHours: cfg.staleOffHours ?? SIGNAL_STALE_DEFAULTS.offHours }
  // Администратор для ответа «выключено»: схемы в базе может не быть, поэтому — по роли вошедшего (как REQUIREMENTS.admin на маршрутах).
  const adminByRole = async (request) => {
    try { return Boolean(await REQUIREMENTS.admin(request.auth.roleRow, { auth: request.auth, isSuperadmin })) } catch { return false }
  }
  // Почему выключено: not_enabled (SIGNAL_SYNC≠1) | config_invalid | no_schema | db_error. Только администратору.
  const disabledStatus = async (request) => {
    if (!(await adminByRole(request))) return { enabled: false }
    const reason = !signal ? 'not_enabled' : capability?.reason?.() || 'db_error'
    return { enabled: false, disabledReason: reason, configErrors: reason === 'config_invalid' ? [...(cfg.configErrors || [])] : [] }
  }

  route({
    method: 'GET', url: '/api/signal/status', access: access.user(EMPLOYEE),
    handler: async (request) => {
      if (!on()) return disabledStatus(request)
      const who = whoOf(request)
      const flags = await readFn(who, 'signal_user_flags', [])
      if (!flags?.canView) return { enabled: false }
      const meta = await capability.meta()
      const now = clockNow()
      const dataAt = meta.dataAt ?? meta.publishedAt
      const { stale, staleHours } = staleStatus(dataAt, now, staleOpts)
      const out = {
        enabled: true, dataAt, stale, staleHours, generation: meta.generation, canView: true, canEdit: Boolean(flags.canEdit),
        isAdmin: Boolean(flags.isAdmin), confirmAvailable: buildTemplateOk(cfg.uiFolderUrl, 'folder'), fileLinks: buildTemplateOk(cfg.uiFileUrl, 'item'),
      }
      if (flags.isAdmin) {
        const st = await readFn(who, 'signal_admin_state', [])
        out.connection = api?.configured ? 'configured' : 'not_configured'
        out.dayMode = sync?.config?.dayMode || cfg.dayMode || 'full'
        out.sources = (st?.sources || []).map((s) => ({
          id: s.id, projectName: s.projectName, rootPath: s.rootPath, enabled: s.enabled, ready: s.ready, objects: s.objects || [],
          lastOkAt: iso(s.lastOkAt), lastNightOkAt: iso(s.lastNightOkAt), lastError: s.lastError, folders: s.folders, items: s.items,
          status: s.status || 'ok', failedSince: iso(s.failedSince), problems: Number(s.problems || 0),
        }))
        out.lastRuns = (st?.lastRuns || []).map(runOf)
        const run = st?.running
        out.running = run ? { runId: Number(run.runId), startedAt: iso(run.startedAt), heartbeatAt: iso(run.heartbeatAt), stuck: Boolean(run.stuck) } : null
        // Отложенный прогон, который ещё можно принять (accept-held): номер и поколение для команды, С-50.
        const held = st?.lastHeld
        out.held = held?.acceptable ? { runId: Number(held.id), generation: Number(held.generation ?? meta.generation) } : null
        out.alerts = alertsOf({ sources: out.sources, running: out.running, held: out.held, heldSince: held ? iso(held.finishedAt ?? held.startedAt) : null, stale, dataAt })
      }
      return out
    },
  })

  // Оповещения администратору (В-5): сбойный корень, отложенный прогон, не отвечающий прогон, устаревшие данные.
  function alertsOf({ sources, running, held, heldSince, stale, dataAt }) {
    const alerts = []
    for (const s of sources) if (s.status === 'failed') alerts.push({ kind: 'root_failed', sourceId: s.id, since: s.failedSince })
    if (held) alerts.push({ kind: 'run_held', runId: held.runId, since: heldSince })
    if (running?.stuck) alerts.push({ kind: 'run_stuck', runId: running.runId, since: running.heartbeatAt })
    if (stale) alerts.push({ kind: 'data_stale', since: iso(dataAt) })
    return alerts
  }

  const runOf = (r) => ({
    id: r.id, kind: r.kind, mode: r.mode, status: r.status, reason: r.reason, initiator: r.initiator,
    startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), stats: r.stats,
  })

  // ── 2. marks ───────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'GET', url: '/api/signal/marks', access: access.user(EMPLOYEE),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const q = parse(z.object({ after: uuid.optional(), limit: intParam(1, 1000, 500) }), request.query || {})
      if (!q) return bad(reply)
      const r = await readFn(whoOf(request), 'signal_marks', [a(q.after ?? null, 'uuid'), a(q.limit, 'int')])
      return {
        items: (r.items || []).map((m) => {
          const s = shownState({ state: m.state, reason: m.reason, pending: m.pending, hasLink: m.hasLink })
          // Дата данных значка — корня его узла (иначе дата последней публикации): «данные на …» в подсказке и dataAt у фронта.
          const dataAt = m.dataAt ?? r.dataAt
          return {
            id: m.id, state: s.state, reason: s.reason, pending: s.pending, hasCandidate: Number(m.candidates || 0) > 0,
            tip: tipFor({ ...s, path: m.path, candidatePath: m.candidatePath, dataAt }), dataAt: iso(dataAt),
          }
        }),
        next: r.next ?? null,
        dataAt: iso(r.dataAt),
      }
    },
  })

  // ── 3. contract card ───────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'GET', url: '/api/signal/contracts/:id', access: access.user(EMPLOYEE),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const p = parse(z.object({ id: uuid }), request.params)
      const q = parse(z.object({ nodeId: uuid.optional() }), request.query || {})
      if (!p || !q) return bad(reply)
      const r = await readFn(whoOf(request), 'signal_contract_view', [a(p.id, 'uuid'), a(q.nodeId ?? null, 'uuid'), a(200, 'int')])
      const hasLink = String(r.signalLink ?? '').trim() !== ''
      const s = shownState({ state: r.state, reason: r.reason, pending: r.pending, hasLink })
      const projectId = r.node?.projectId
      const out = {
        state: s.state, reason: s.reason, pending: s.pending, stateVersion: Number(r.stateVersion || 0), signalLink: r.signalLink ?? null,
        // ревизия строки очереди на момент чтения (null — строки нет): окно возвращает её в confirm / unlink как expectedRevision (С-18)
        revision: r.revision === null || r.revision === undefined ? null : Number(r.revision),
        dataAt: iso(r.dataAt),
        node: r.node ? { nodeId: r.node.nodeId, kind: r.node.kind ?? null, path: r.node.path, observed: Boolean(r.node.observed), modifiedAt: iso(r.node.modifiedAt) } : null,
        files: (r.files || []).map((f) => ({
          nodeId: f.nodeId, kind: f.kind, name: f.name, version: f.version ?? null, modifiedAt: iso(f.modifiedAt), deleted: Boolean(f.deleted),
          url: f.kind === 'item' && !f.deleted && cfg.uiFileUrl && projectId
            ? buildSignalUrl(cfg.uiFileUrl, { projectId, nodeId: f.nodeId, kind: 'item' }) : null,
        })),
        more: Boolean(r.more),
        canEdit: Boolean(r.canEdit),
        confirmAvailable: buildTemplateOk(cfg.uiFolderUrl, 'folder'),
      }
      if (r.canEdit) {
        out.candidates = (r.candidates || []).map((c) => ({
          nodeId: c.nodeId, path: c.path, score: c.score, reasons: c.reasons || [], flags: c.flags || [], status: c.status,
          prevStatus: c.prevStatus ?? null, prevDecidedAt: iso(c.prevDecidedAt),
        }))
      }
      return out
    },
  })

  // ── 4. folders ─────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'GET', url: '/api/signal/folders', access: access.user(EMPLOYEE),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const q = parse(z.object({
        contractId: uuid, q: z.string().max(100).optional(), after: z.string().max(8100).optional(), limit: intParam(1, 100, 50),
      }), request.query || {})
      if (!q) return bad(reply)
      const r = await readFn(whoOf(request), 'signal_folders_search', [a(q.contractId, 'uuid'), a(q.q ?? '', 'text'), a(q.after ?? null, 'text'), a(q.limit, 'int')])
      return { items: (r.items || []).map((f) => ({ nodeId: f.nodeId, path: f.path, files: Number(f.files || 0) })), next: r.next ?? null }
    },
  })

  // ── 5. match ───────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'POST', url: '/api/signal/match', access: access.user(withRate(EMPLOYEE, 'signalMatch')), body: MATCH_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const held = readOnly(reply)
      if (held) return held
      const ids = request.body.contractIds
      // Любой договор без права правки или вне охвата — отказ на весь запрос, ничего не считается.
      const allowed = await db.read(whoOf(request), async (tx) => {
        await tx.query("select osp_private.signal_require('edit')")
        return (await tx.query('select x.id from unnest($1::uuid[]) x(id) where osp_private.signal_contract_ok(x.id)', [ids])).rows.length
      })
      if (allowed !== ids.length) return problem(reply, 403, 'forbidden', T.forbidden)
      const res = await jobs.processContracts(ids)
      const meta = await capability.meta()
      return {
        dataAt: meta.publishedAt,
        items: res.results.map((r) => {
          const top = r.candidates[0]
          const node = r.nodeId ? { nodeId: r.nodeId, path: r.path } : r.state === 'suggested' && top ? { nodeId: top.nodeId, path: top.path } : null
          return { id: r.id, state: r.state, reason: r.reason, ...(node ? { nodeId: node.nodeId, path: node.path } : {}), hasCandidate: r.candidates.length > 0 }
        }),
      }
    },
  })

  // Вход сопоставителя для одного договора (по снимку в базе): { contract, objects, generation, nodes }.
  async function inputFor(contractId, extraNodeIds = []) {
    const loaded = await jobs.store.load([contractId])
    const contract = (loaded?.contracts || [])[0]
    if (!contract) return null
    const q = nodeQueryFor(contract, { formats })
    const found = await jobs.store.nodes({ nodeIds: [...new Set([...extraNodeIds, ...q.nodeIds])] }, 2000)
    return { contract, objects: loaded.objects || [], generation: Number(found.generation), nodes: found.nodes || [] }
  }

  // Общий разбор «решения человека» по договору: готовность, барьер, права и охват (404 без деталей). true — ответ уже отправлен.
  // Ответ (reply) из асинхронной функции не возвращается: Fastify подождал бы его отправки, и вызывающий получил бы undefined.
  async function decisionRefused(request, reply, contractId) {
    if (!on()) { off(reply); return true }
    if (isReadOnly()) { readOnly(reply); return true }
    const ok = await authorize(whoOf(request), 'edit', contractId)
    if (!ok) { problem(reply, 404, 'not_found', T.notFound); return true }
    return false
  }

  // ── 6. confirm ─────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'POST', url: '/api/signal/contracts/:id/confirm', access: access.user(withRate(EMPLOYEE, 'signalWrite')), body: CONFIRM_BODY,
    handler: async (request, reply) => {
      const p = parse(z.object({ id: uuid }), request.params)
      if (!p) return bad(reply)
      if (await decisionRefused(request, reply, p.id)) return reply
      const b = request.body
      if (!buildTemplateOk(cfg.uiFolderUrl, 'folder')) return problem(reply, 409, 'confirm_unavailable', T.confirmNoUrl)

      const input = await inputFor(p.id, [b.nodeId])
      if (!input) return problem(reply, 404, 'not_found', T.notFound)
      const node = input.nodes.find((n) => n.nodeId === b.nodeId)
      if (!node || node.kind !== 'folder') return problem(reply, 422, 'node_unavailable', T.outside)
      const verdict = evaluateNode({ ...input.contract, nodes: input.nodes, objects: input.objects }, b.nodeId, { generation: input.generation })
      // Жёсткое противоречие — 409 hard_conflict (то же правило повторяет база). Подтверждаемо: verified, accepted и мягкие
      // attention:building_mismatch / kind_mismatch (ответ несёт warning).
      if (verdict.state === 'conflict') return problem(reply, 409, 'hard_conflict', T.hardConflict)
      // Скрытые причины (узел не виден договору, нет объекта…) оставляем базе: её ответ — 422 без деталей. Прочее неподтверждаемое — отказ здесь.
      if (!verdict.confirmable && !HIDDEN_REASONS.has(verdict.reason)) return problem(reply, 409, 'confirm_unavailable', T.confirmNo)
      const built = buildSignalUrl(cfg.uiFolderUrl, { projectId: node.projectId, nodeId: b.nodeId, kind: 'folder' })
      if (!built) return problem(reply, 409, 'confirm_unavailable', T.confirmNoUrl)
      // База сравнивает ссылки строками. Подтверждение ТЕКУЩЕЙ папки (accepted, мягкие предупреждения — без выбора кандидата): nodeId —
      // узел, разобранный из текущей ссылки договора (любой допустимый вид: другой шаблон из SIGNAL_URL_FORMATS, uuid в верхнем
      // регистре, лишние query/fragment) — это не замена: передаём ссылку как есть, она не меняется и «Заменить» не нужно. Клиент, не
      // видевший эту ссылку, получает от базы stale_state. Любая другая папка — адрес по шаблону SIGNAL_UI_FOLDER_URL (replace_required).
      const current = String(input.contract.signalLink ?? '').trim()
      let url = built
      if (current) {
        const same = parseSignalUrl(current, formats)
        if (same.ok && same.kind === 'folder' && same.projectId === String(node.projectId).toLowerCase() && same.nodeId === b.nodeId) url = current
      }

      let aliasText = null
      let aliasKey = null
      if (b.rememberAlias) {
        aliasText = b.rememberAlias
        aliasKey = normMatchName(aliasText)
        if (aliasText.length < 2 || aliasKey.length < 2) return problem(reply, 422, 'invalid', 'Название слишком короткое')
        if (clashesWithOtherObject(aliasKey, input.objects, input.contract.objectId)) return problem(reply, 409, 'alias_taken', T.aliasTaken)
      }
      const fingerprint = contractFingerprint({ ...input.contract, signalLink: url })
      const r = await writeFn(whoOf(request), 'signal_confirm', [
        a(p.id, 'uuid'), a(b.nodeId, 'uuid'), a(url, 'text'), a(b.replace, 'boolean'), a(aliasText, 'text'), a(aliasKey, 'text'), a(fingerprint, 'text'),
        a(b.expectedSignalLink ?? null, 'text'), a(b.expectedStateVersion, 'bigint'), a(b.idempotencyKey, 'text'), a(b.expectedRevision ?? 0, 'bigint'),
      ])
      return { state: r.state, reason: r.reason, stateVersion: Number(r.stateVersion), signalLink: r.signalLink ?? null, warning: verdict.warning ?? null }
    },
  })

  // ── 7. reject ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Отказ привязан к «виду» папки (nodeKey, С-53): переименованная или заменённая по смыслу папка с тем же id предложится снова.
  route({
    method: 'POST', url: '/api/signal/contracts/:id/reject', access: access.user(withRate(EMPLOYEE, 'signalWrite')), body: REJECT_BODY,
    handler: async (request, reply) => {
      const p = parse(z.object({ id: uuid }), request.params)
      if (!p) return bad(reply)
      if (await decisionRefused(request, reply, p.id)) return reply
      const b = request.body
      const input = await inputFor(p.id, [b.nodeId])
      if (!input) return problem(reply, 404, 'not_found', T.notFound)
      const node = input.nodes.find((n) => n.nodeId === b.nodeId)
      const r = await writeFn(whoOf(request), 'signal_reject', [
        a(p.id, 'uuid'), a(b.nodeId, 'uuid'), a(b.note ?? null, 'text'), a(contractContextKey(input.contract), 'text'), a(b.expectedStateVersion, 'bigint'),
        a(b.idempotencyKey, 'text'), a(node ? nodeKeyOf(node) : null, 'text'),
      ])
      return { state: r.state, reason: r.reason ?? null, stateVersion: Number(r.stateVersion) }
    },
  })

  // ── 8. unlink ──────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'POST', url: '/api/signal/contracts/:id/unlink', access: access.user(withRate(EMPLOYEE, 'signalWrite')), body: UNLINK_BODY,
    handler: async (request, reply) => {
      const p = parse(z.object({ id: uuid }), request.params)
      if (!p) return bad(reply)
      if (await decisionRefused(request, reply, p.id)) return reply
      const b = request.body
      const input = await inputFor(p.id)
      if (!input) return problem(reply, 404, 'not_found', T.notFound)
      // Вид отвязанной папки: пара «договор — эта папка» не предлагается снова, пока папка та же (nodeKey) и контекст договора тот же.
      const linked = parseSignalUrl(String(input.contract.signalLink ?? ''), formats)
      const node = linked.ok ? input.nodes.find((n) => n.nodeId === linked.nodeId) : null
      const r = await writeFn(whoOf(request), 'signal_unlink', [
        a(p.id, 'uuid'), a(contractContextKey(input.contract), 'text'), a(b.expectedSignalLink, 'text'), a(b.expectedStateVersion, 'bigint'), a(b.idempotencyKey, 'text'),
        a(b.expectedRevision ?? 0, 'bigint'), a(node ? nodeKeyOf(node) : null, 'text'),
      ])
      return { state: r.state, reason: r.reason ?? null, stateVersion: Number(r.stateVersion) }
    },
  })

  // ── 9–11. aliases ──────────────────────────────────────────────────────────────────────────────────────────────────
  // Сотруднику с правкой — только свои названия в его охвате (С-2), администратору — все (conflict — название совпало с названием или
  // кодом другого объекта и сверкой не используется; mine — своё). Что можно, решает база: просмотру — 403.
  route({
    method: 'GET', url: '/api/signal/aliases', access: access.user(EMPLOYEE),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const r = await readFn(whoOf(request), 'signal_alias_list', [])
      return {
        items: (r.items || []).map((x) => ({
          id: x.id, text: x.text, objectId: x.objectId, objectName: x.objectName, author: x.author ?? null, createdAt: iso(x.createdAt),
          conflict: Boolean(x.conflict), mine: Boolean(x.mine),
        })),
      }
    },
  })

  route({
    method: 'POST', url: '/api/signal/aliases', access: access.user(withRate(EMPLOYEE, 'signalWrite')), body: ALIAS_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const held = readOnly(reply)
      if (held) return held
      const { objectId, text } = request.body
      // Право правки и охват объекта — до проверки названий: чужие названия объектов сначала не раскрываются.
      const scope = await db.read(whoOf(request), async (tx) => {
        await tx.query("select osp_private.signal_require('edit')")
        return (await tx.query('select public.osp_object_scope() as s')).rows[0].s
      })
      if (Array.isArray(scope) && !scope.includes(objectId)) return problem(reply, 403, 'forbidden', T.forbidden)
      const key = normMatchName(text)
      if (key.length < 2) return problem(reply, 422, 'invalid', 'Название слишком короткое')
      const loaded = await jobs.store.load([])
      if (clashesWithOtherObject(key, loaded?.objects, objectId)) return problem(reply, 409, 'alias_taken', T.aliasTaken)
      const r = await writeFn(whoOf(request), 'signal_alias_create', [a(objectId, 'uuid'), a(text, 'text'), a(key, 'text')])
      return { id: r.id }
    },
  })

  route({
    method: 'DELETE', url: '/api/signal/aliases/:id', access: access.user(withRate(EMPLOYEE, 'signalWrite')), body: EMPTY_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const held = readOnly(reply)
      if (held) return held
      const p = parse(z.object({ id: digits.refine((n) => n > 0) }), request.params)
      if (!p) return bad(reply)
      await writeFn(whoOf(request), 'signal_alias_delete', [a(p.id, 'bigint')])
      return { ok: true }
    },
  })

  // ── 12. sources: добавить корень ───────────────────────────────────────────────────────────────────────────────────
  // Ссылка разбирается, не запрашивается; в Signal идёт чтение дерева проекта (и списка проектов за названием) — без открытой
  // транзакции базы. Корень не должен быть предком или потомком уже добавленного корня того же проекта.
  function upstream(reply, err) {
    if (err instanceof SignalError) {
      if (err.code === 'not_configured') return problem(reply, 409, 'not_configured', T.notConfigured)
      if (err.code === 'http' && err.status === 404) return problem(reply, 422, 'invalid', 'Проект не найден в Signal или нет доступа')
      app.log.warn({ code: err.code, status: err.status, msg: redact(err.message, secrets).slice(0, 200) }, 'signal source check')
      return problem(reply, 503, 'signal_unavailable', T.unavailable)
    }
    throw err
  }

  route({
    method: 'POST', url: '/api/signal/sources', access: access.user(withRate(ADMIN, 'signalWrite')), body: SOURCE_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const held = readOnly(reply)
      if (held) return held
      const who = whoOf(request)
      const { url, objectIds } = request.body
      const state = await readFn(who, 'signal_admin_state', []) // права администратора проверяет и база
      if (!api?.configured) return problem(reply, 409, 'not_configured', T.notConfigured)
      const parsed = parseSignalUrl(url, formats)
      if (!parsed.ok) {
        return problem(reply, 422, 'invalid', parsed.reason === 'empty' ? 'Укажите ссылку на папку Signal'
          : formats.length ? 'Формат ссылки не поддерживается' : 'Форматы ссылок Signal на сервере не настроены')
      }
      if (parsed.kind !== 'folder') return problem(reply, 422, 'invalid', 'Ссылка ведёт не на папку')
      const existing = (state?.sources || []).filter((s) => String(s.projectId).toLowerCase() === parsed.projectId)
      if (existing.some((s) => String(s.folderId).toLowerCase() === parsed.nodeId)) return problem(reply, 409, 'busy', 'Такой корень уже добавлен')

      let tree
      let projectName = null
      try {
        tree = await api.getFolderTree(parsed.projectId)
        const root = tree.find((n) => n.nodeId === parsed.nodeId)
        if (!root) return problem(reply, 422, 'invalid', 'Папка не найдена в проекте Signal или нет доступа')
        for (const s of existing) {
          const other = tree.find((n) => n.nodeId === String(s.folderId).toLowerCase())
          if (other && (root.pathIds.includes(other.nodeId) || other.pathIds.includes(root.nodeId))) {
            return problem(reply, 409, 'overlap', 'Папка пересекается с уже добавленным корнем — выберите другую')
          }
        }
        for (let skip = 0; skip < 20_000; skip += 100) {
          const page = await api.listProjects({ skip, take: 100 })
          const hit = page.find((x) => x.id === parsed.projectId)
          if (hit) { projectName = hit.name; break }
          if (page.length < 100) break
        }
        const r = await writeFn(who, 'signal_source_add', [a(parsed.projectId, 'uuid'), a(parsed.nodeId, 'uuid'), a(projectName, 'text'), a(root.path, 'text'), a(objectIds, 'uuid[]')])
        return { id: r.id, projectName: r.projectName ?? null, rootPath: r.rootPath ?? null }
      } catch (err) {
        return upstream(reply, err)
      } finally {
        tree = null
      }
    },
  })

  // ── 13. sources/:id ────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'PATCH', url: '/api/signal/sources/:id', access: access.user(withRate(ADMIN, 'signalWrite')), body: SOURCE_PATCH,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const held = readOnly(reply)
      if (held) return held
      const p = parse(z.object({ id: digits.refine((n) => n > 0) }), request.params)
      if (!p) return bad(reply)
      const b = request.body
      await writeFn(whoOf(request), 'signal_source_update', [a(p.id, 'bigint'), a(b.enabled ?? null, 'boolean'), a(b.objectIds ?? null, 'uuid[]')])
      return { ok: true }
    },
  })

  // ── 14. sync ───────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'POST', url: '/api/signal/sync', access: access.user(withRate(ADMIN, 'signalSync')), body: EMPTY_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const who = whoOf(request)
      await authorize(who, 'admin', null)
      const r = await sync.runNow({ initiator: 'admin', startedBy: who.userId })
      if (r.started) {
        r.done?.catch?.(() => {})
        return reply.code(202).send({ runId: r.runId })
      }
      if (r.readOnly) return problem(reply, 503, READONLY_CODE, READONLY_TEXT)
      if (r.notConfigured) return problem(reply, 409, 'not_configured', T.notConfigured)
      if (r.noSources) return problem(reply, 409, 'no_sources', T.noSources)
      if (r.busy) return problem(reply, 409, 'busy', T.busy)
      return problem(reply, 503, 'signal_unavailable', T.unavailable)
    },
  })

  // ── 15. runs ───────────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'GET', url: '/api/signal/runs', access: access.user(ADMIN),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const q = parse(z.object({ limit: intParam(1, 20, 20) }), request.query || {})
      if (!q) return bad(reply)
      const r = await readFn(whoOf(request), 'signal_runs', [a(q.limit, 'int')])
      return { items: (r.items || []).map(runOf) }
    },
  })

  // ── 16. unassigned ─────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'GET', url: '/api/signal/unassigned', access: access.user(ADMIN),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const q = parse(z.object({ sourceId: digits.refine((n) => n > 0), after: z.string().max(8100).optional(), limit: intParam(1, 100, 50) }), request.query || {})
      if (!q) return bad(reply)
      const r = await readFn(whoOf(request), 'signal_unassigned', [a(q.sourceId, 'bigint'), a(q.after ?? null, 'text'), a(q.limit, 'int')])
      return { items: (r.items || []).map((x) => ({ nodeId: x.nodeId, path: x.path, items: Number(x.items || 0) })), next: r.next ?? null }
    },
  })

  // ── 17. bindings ───────────────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'POST', url: '/api/signal/bindings', access: access.user(withRate(ADMIN, 'signalWrite')), body: BINDING_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const held = readOnly(reply)
      if (held) return held
      const b = request.body
      await writeFn(whoOf(request), 'signal_binding_set', [a(Number(b.sourceId), 'bigint'), a(b.nodeId, 'uuid'), a(b.objectId ?? null, 'uuid')])
      return { ok: true }
    },
  })

  // ── 18. tree ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // Дерево папок корня для разметки любой глубины (В-6): дети папки (без q) или поиск по корню (q ≤ 100 знаков). Администратор
  // видит полные имена и пути; наблюдаемые в последнем обходе папки.
  route({
    method: 'GET', url: '/api/signal/tree', access: access.user(ADMIN),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const q = parse(z.object({
        sourceId: digits.refine((n) => n > 0), parentId: uuid.optional(), q: z.string().max(100).optional(), after: z.string().max(8100).optional(),
        limit: intParam(1, 100, 100),
      }), request.query || {})
      if (!q) return bad(reply)
      const text = q.q?.trim() ? q.q.trim() : null
      const r = await readFn(whoOf(request), 'signal_tree', [a(q.sourceId, 'bigint'), a(q.parentId ?? null, 'uuid'), a(text, 'text'), a(q.after ?? null, 'text'), a(q.limit, 'int')])
      return {
        items: (r.items || []).map((x) => ({
          nodeId: x.nodeId, name: x.name, path: x.path, depth: Number(x.depth || 0), objectId: x.objectId ?? null, objectName: x.objectName ?? null,
          bound: Boolean(x.bound), boundObjectId: x.boundObjectId ?? null, hasChildren: Boolean(x.hasChildren), items: Number(x.items || 0), problem: x.problem ?? null,
        })),
        next: r.next ?? null,
      }
    },
  })

  // ── 19. bindings (список) ──────────────────────────────────────────────────────────────────────────────────────────
  route({
    method: 'GET', url: '/api/signal/bindings', access: access.user(ADMIN),
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const q = parse(z.object({ sourceId: digits.refine((n) => n > 0) }), request.query || {})
      if (!q) return bad(reply)
      const r = await readFn(whoOf(request), 'signal_bindings_list', [a(q.sourceId, 'bigint')])
      return {
        rootObjects: (r.rootObjects || []).map((o) => ({ objectId: o.objectId, objectName: o.objectName })),
        items: (r.items || []).map((x) => ({
          nodeId: x.nodeId, path: x.path, objectId: x.objectId, objectName: x.objectName, createdAt: iso(x.createdAt), observed: Boolean(x.observed),
        })),
      }
    },
  })

  // ── 20. bindings/preview ───────────────────────────────────────────────────────────────────────────────────────────
  // Что изменится от привязки поддерева к объекту (читает, не пишет): предупреждения «внутри есть номера договоров другого объекта»
  // и число затронутых папок и файлов. Привязка — POST /api/signal/bindings (objectId: null — «Снять»).
  route({
    method: 'POST', url: '/api/signal/bindings/preview', access: access.user(ADMIN), body: PREVIEW_BODY,
    handler: async (request, reply) => {
      if (!on()) return off(reply)
      const b = request.body
      const r = await readFn(whoOf(request), 'signal_binding_preview', [a(Number(b.sourceId), 'bigint'), a(b.nodeId, 'uuid'), a(b.objectId ?? null, 'uuid')])
      return {
        warnings: (r.warnings || []).map((w) => ({ objectId: w.objectId, objectName: w.objectName, folders: Number(w.folders || 0) })),
        affected: { folders: Number(r.affected?.folders || 0), items: Number(r.affected?.items || 0) },
      }
    },
  })
}
