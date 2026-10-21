// Позиции ВОР для расценки снабжением — заранее, на сервере (миграция 20261024_supply_import_state).
//
//   const job = createSupplyImport({ db, s3, bucket, log })
//   const stop = job.start({ isReadOnly })   // такт: первый через 90 с, далее каждые 10 минут
//   await job.runOnce()                       // один проход (тесты, ручной запуск)
//
// Раньше позиции разбирал только браузер — когда расценку открывали снабжение или тендерный отдел, — и в
// реестре «Тендеры на материалы» у тендера, которого ещё не открывали, вместо «Расценка: N из M» стояло
// «открыть». Теперь служба проходит по всем основным тендерам, у которых есть тендер на материалы, и делает то же,
// что автозагрузка страницы (одним кодом — shared/, копии src/utils): файлы ВОР из «ВОРов и РД» (лист
// «Материалы», иначе сам лист ВОР по колонке «КОД»), если ни один не дал позиций — вкладка «ВОР» карточки;
// пустые устаревшие списки убираются, цены не трогаются никогда. Итог по тендеру — tender_supply_import_state:
// ok | no_vor (ВОР нет) | issues (файл не разобрался — причины) | locked (тендер на материалы завершён) |
// pending (не успели за проход). По нему реестр показывает статус без открытия расценки, а страница не скачивает
// файл, про который служба уже знает, что он не разбирается.
//
// Бережно к серверу: разбор — в отдельном процессе (supplyParseChild.js: свой потолок памяти, низкий приоритет,
// таймаут), за проход — не больше maxFilesPerRun файлов и maxRunMs времени, файл больше maxFileBytes не
// скачивается (его разберёт браузер). Повторно файл разбирается, только если сменилась его версия или версия
// разбора; вкладка «ВОР» читается, только если сменилась её подпись. Запись — служебная операция (osp:internal)
// с проверкой версии строки: одновременная загрузка в браузере не перетирается.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { estimateVersion, fileVersion, planCleanup, planFileImports, planTabImports } from '../shared/supplyAutoImport.js'
import { positionsFromEstimate } from '../shared/vorMaterials.js'
import { VOR_PARSER_VERSION, isWorkbookFileName } from '../shared/vorFiles.js'

export const SUPPLY_IMPORT_DEFAULTS = {
  intervalMs: 10 * 60_000,
  firstDelayMs: 90_000,
  maxFilesPerRun: 40,
  maxRunMs: 6 * 60_000,
  maxFileBytes: 25 * 1024 * 1024,
  parseTimeoutMs: 120_000,
  parseHeapMb: 192,
  downloadTimeoutMs: 60_000,
}
// Категории файлов ВОР в «ВОРах и РД» (src/services/tenderVorRd.js).
export const VOR_CATEGORIES = ['vor_statement', 'vor']
// Причины из самого файла — как FILE_PROBLEMS страницы: до новой версии файла (или разбора) не повторяются, и
// страница такой файл не скачивает. Слишком большой, долгий или не влезший в память файл служба тоже не берёт
// снова до новой версии, но страница его разбирает сама (у браузера своя память). Файла нет в хранилище — тоже до
// новой версии: иначе такие файлы каждый проход съедали бы его предел и не пускали остальные. Сбой связи с
// хранилищем и записи — повтор в следующий проход.
export const FILE_PROBLEMS = new Set(['no_sheet', 'no_header', 'empty', 'broken', 'no_material_codes'])
const STICKY = new Set([...FILE_PROBLEMS, 'too_large', 'timeout', 'memory', 'missing', 'too_many'])
// Предел списка позиций в базе (tender_supply_sources.positions, миграция 20261020).
export const MAX_POSITIONS = 20000
const isNotFound = (e) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404

const CHILD = fileURLToPath(new URL('./supplyParseChild.js', import.meta.url))

// Один файл — один процесс-разборщик. Ответ — как parseVorFileBytes; свои причины: timeout, memory, parser.
export function parseInChild(bytes, saved, { timeoutMs = SUPPLY_IMPORT_DEFAULTS.parseTimeoutMs, heapMb = SUPPLY_IMPORT_DEFAULTS.parseHeapMb } = {}) {
  return new Promise((resolve) => {
    const child = fork(CHILD, [], {
      execArgv: [`--max-old-space-size=${heapMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let done = false
    let stderr = ''
    const finish = (out) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(out)
    }
    const timer = setTimeout(() => finish({ error: 'timeout', message: `разбор дольше ${Math.round(timeoutMs / 1000)} с` }), timeoutMs)
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d })
    child.once('message', (out) => finish(out && typeof out === 'object' ? out : { error: 'parser', message: 'пустой ответ разбора' }))
    child.once('error', (e) => finish({ error: 'parser', message: String(e?.message || e).slice(0, 200) }))
    // SIGKILL не от нас — система сняла разборщик по памяти контейнера.
    child.once('exit', (code, signal) => finish(signal === 'SIGKILL' || /heap|out of memory/i.test(stderr)
      ? { error: 'memory', message: 'не хватило памяти на разбор' }
      : { error: 'parser', message: `разборщик завершился (${code ?? signal})` }))
    try {
      child.send({ bytes, saved: saved || null })
    } catch (e) {
      finish({ error: 'parser', message: String(e?.message || e).slice(0, 200) })
    }
  })
}

// ── Запросы ─────────────────────────────────────────────────────────────────────────────────────────────
// Основные тендеры с тендером на материалы (у тендера на материалы без основного — он сам): файлы ВОР, списки
// позиций, прежнее состояние, закрыт ли. Всё — json из базы: время в том же виде, что отдаёт PostgREST
// странице, иначе версии файлов (file:<id>:<время>) у службы и страницы не совпали бы.
const CANDIDATES_SQL = `
with mains as (
  select distinct coalesce(m.parent_tender_id, m.id) as id
  from public.tenders m
  where m.tender_type = 'materials' and m.deleted_at is null
)
select json_build_object(
  'id', t.id,
  'locked', public.supply_rates_locked(t.id),
  'files', (select coalesce(json_agg(json_build_object('id', d.id, 'file_name', d.file_name, 's3_key', d.s3_key, 'created_at', d.created_at)), '[]'::json)
            from public.s3_documents d
            where d.owner_type = 'tender' and d.owner_id = t.id and d.doc_category = any($1::text[])),
  'sources', (select coalesce(json_agg(json_build_object('id', s.id, 'estimate_name', s.estimate_name, 'source', s.source,
                's3_document_id', s.s3_document_id, 'file_name', s.file_name, 'source_version', s.source_version,
                'row_version', s.row_version, 'column_map', s.column_map, 'positions_count', s.positions_count,
                'prior_document_ids', to_jsonb(s)->'prior_document_ids')), '[]'::json)
              from public.tender_supply_sources s where s.tender_id = t.id),
  'state', (select to_json(st) from public.tender_supply_import_state st where st.tender_id = t.id)
) as tender
from mains join public.tenders t on t.id = mains.id and t.deleted_at is null`

// Подпись вкладки «ВОР» по ВОР — как estimateSignatures страницы (число строк и время последней загрузки).
const SIGNATURES_SQL = `
select json_build_object('name', x.name, 'count', x.n, 'latest', x.latest) as sig
from (select coalesce(i.estimate_name, 'Основная смета') as name, count(*)::int as n, max(i.created_at) as latest
      from public.tender_estimate_items i where i.tender_id = $1 group by 1) x
order by x.name`

const ITEMS_SQL = `
select coalesce(json_agg(json_build_object('estimate_name', i.estimate_name, 'code', i.code, 'cost_name', i.cost_name, 'unit', i.unit,
         'material_consumption', i.material_consumption, 'is_section', i.is_section) order by i.id), '[]'::json) as items
from public.tender_estimate_items i where i.tender_id = $1`

// Прежние файлы ВОР (миграция 20261029) — через to_jsonb: до миграции колонки нет, и запрос не падает (null).
const SOURCE_COLUMNS = `id, estimate_name, source, s3_document_id, file_name, source_version, row_version, column_map, positions_count,
  to_jsonb(s)->'prior_document_ids' as prior_document_ids`

// Подпись файлов и вкладки — признак «с прошлого прохода ничего не менялось».
const filesSignature = (files) => files.map(fileVersion).sort().join(',')
const tabSignature = (sigs) => sigs.map((s) => `${s.name}=${estimateVersion(s)}`).join('|')

export function createSupplyImport({ db, s3, bucket, log = console, parse = parseInChild, options = {} }) {
  const o = { ...SUPPLY_IMPORT_DEFAULTS, ...options }
  let running = false

  async function download(doc) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: doc.s3_key }), { abortSignal: AbortSignal.timeout(o.downloadTimeoutMs) })
    if (Number(head.ContentLength) > o.maxFileBytes) {
      return { error: 'too_large', message: `файл ${Math.round(Number(head.ContentLength) / 1048576)} МБ — больше ${Math.round(o.maxFileBytes / 1048576)} МБ, его разберёт страница расценки` }
    }
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: doc.s3_key }), { abortSignal: AbortSignal.timeout(o.downloadTimeoutMs) })
    return { bytes: await res.Body.transformToByteArray() }
  }

  // Новый список позиций — вставка (уже есть — загрузил другой), прежний — по версии строки (изменили — пропуск).
  async function saveSource(tenderId, { existing, name, source, doc, sheetName, columnMap, version, positions }) {
    return db.write(null, async (tx) => {
      const values = [source, doc?.id || null, doc?.file_name || null, sheetName || null,
        columnMap ? JSON.stringify(columnMap) : null, version, JSON.stringify(positions)]
      if (existing) {
        const { rows } = await tx.query(`update public.tender_supply_sources s
            set source = $1, s3_document_id = $2, file_name = $3, sheet_name = $4, column_map = $5::jsonb,
                source_version = $6, positions = $7::jsonb
          where id = $8 and row_version = $9 returning ${SOURCE_COLUMNS}`, [...values, existing.id, existing.row_version])
        return rows[0] || null
      }
      const { rows } = await tx.query(`insert into public.tender_supply_sources as s
          (source, s3_document_id, file_name, sheet_name, column_map, source_version, positions, tender_id, estimate_name)
          values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
          on conflict (tender_id, estimate_name) do nothing returning ${SOURCE_COLUMNS}`, [...values, tenderId, name])
      return rows[0] || null
    }, { statementTimeoutMs: 60_000 })
  }

  async function reloadSources(tenderId) {
    return db.read(null, async (tx) => (await tx.query(`select ${SOURCE_COLUMNS} from public.tender_supply_sources s where tender_id = $1`, [tenderId])).rows)
  }

  async function saveState(tenderId, prev, next) {
    const same = prev && prev.status === next.status && prev.files_sig === next.files_sig && prev.tab_sig === next.tab_sig
      && prev.parser_version === next.parser_version && prev.positions_count === next.positions_count
      && JSON.stringify(prev.issues || []) === JSON.stringify(next.issues)
    if (same) return false
    await db.write(null, (tx) => tx.query(`insert into public.tender_supply_import_state
        (tender_id, status, files_sig, tab_sig, parser_version, issues, positions_count, checked_at)
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
        on conflict (tender_id) do update set status = excluded.status, files_sig = excluded.files_sig, tab_sig = excluded.tab_sig,
          parser_version = excluded.parser_version, issues = excluded.issues, positions_count = excluded.positions_count,
          checked_at = excluded.checked_at`,
    [tenderId, next.status, next.files_sig, next.tab_sig, next.parser_version, JSON.stringify(next.issues), next.positions_count]))
    return true
  }

  // Один тендер. budget — сколько файлов ещё можно разобрать и до какого времени.
  async function processTender(t, budget, stats) {
    const prev = t.state
    const files = (t.files || []).filter((f) => isWorkbookFileName(f.file_name))
    const filesSig = filesSignature(files)
    if (t.locked) {
      // Завершён: списки позиций не меняются (их не пустит и база). Статус «N из M» — по прежним спискам.
      const count = (t.sources || []).reduce((n, s) => n + (s.positions_count || 0), 0)
      if (await saveState(t.id, prev, { status: count > 0 ? 'ok' : 'locked', files_sig: prev?.files_sig ?? null, tab_sig: prev?.tab_sig ?? null,
        parser_version: prev?.parser_version ?? 0, issues: prev?.issues || [], positions_count: count })) stats.states += 1
      return
    }
    let sources = t.sources || []
    const prevIssues = Array.isArray(prev?.issues) ? prev.issues : []
    const fileIssueFor = (doc) => prevIssues.find((i) => i.doc_id === doc.id && i.version === fileVersion(doc) && i.parser === VOR_PARSER_VERSION && STICKY.has(i.kind))

    // Подпись вкладки «ВОР» нужна, если позиции могут прийти из неё или файлам нужны имена ВОР карточки.
    const { jobs: firstJobs } = planFileImports(files, sources, [])
    const needSigs = !sources.some((s) => s.source === 'vor_file') || firstJobs.some((j) => !fileIssueFor(j.doc))
    const sigs = needSigs
      ? await db.read(null, async (tx) => (await tx.query(SIGNATURES_SQL, [t.id])).rows.map((r) => r.sig))
      : null
    const cardNames = sigs ? sigs.map((s) => s.name) : []
    const tabSig = sigs ? tabSignature(sigs) : (prev?.tab_sig ?? null)

    const issues = []
    let pending = false
    let changed = false
    const { jobs } = planFileImports(files, sources, cardNames)
    for (const job of jobs) {
      const known = fileIssueFor(job.doc)
      if (known) { issues.push(known); continue }
      if (budget.files <= 0 || Date.now() > budget.until) { pending = true; continue }
      budget.files -= 1
      const base = { doc_id: job.doc.id, file_name: job.doc.file_name, version: fileVersion(job.doc), parser: VOR_PARSER_VERSION }
      let got
      try {
        got = await download(job.doc)
      } catch (e) {
        issues.push(isNotFound(e)
          ? { ...base, kind: 'missing', message: 'файла нет в хранилище' }
          : { ...base, kind: 'download', message: String(e?.name === 'TimeoutError' ? 'хранилище не ответило вовремя' : e?.message || e).slice(0, 200) })
        stats.failed += 1
        continue
      }
      if (got.error) { issues.push({ ...base, kind: got.error, message: got.message }); stats.failed += 1; continue }
      const parsed = await parse(got.bytes, job.existing?.column_map || null, { timeoutMs: o.parseTimeoutMs, heapMb: o.parseHeapMb })
      if (parsed.error) {
        issues.push({ ...base, kind: parsed.error, message: parsed.message || null, sheetNames: parsed.sheetNames || null,
          sheetName: parsed.sheetName || null, codeTried: !!parsed.codeTried })
        stats.failed += 1
        continue
      }
      if (parsed.positions.length > MAX_POSITIONS) {
        issues.push({ ...base, kind: 'too_many', message: `${parsed.positions.length} позиций — больше ${MAX_POSITIONS}` })
        stats.failed += 1
        continue
      }
      try {
        const row = await saveSource(t.id, { existing: job.existing, name: job.name, source: 'vor_file', doc: job.doc,
          sheetName: parsed.sheetName, columnMap: parsed.map, version: fileVersion(job.doc), positions: parsed.positions })
        changed = true
        if (row) stats.imported += 1
      } catch (e) {
        issues.push({ ...base, kind: 'save', message: String(e?.message || e).slice(0, 200) })
        stats.failed += 1
      }
    }
    if (changed) { sources = await reloadSources(t.id); changed = false }

    // Файлов с позициями нет — вкладка «ВОР» карточки; строки читаются, только если её подпись сменилась.
    const hasFileSource = sources.some((s) => s.source === 'vor_file')
    if (!hasFileSource && sigs && sigs.length && (tabSig !== prev?.tab_sig || prev?.parser_version !== VOR_PARSER_VERSION
        || sources.some((s) => s.source === 'vor_tab' && !String(s.source_version || '').startsWith('vor2:')))) {
      const items = await db.read(null, async (tx) => (await tx.query(ITEMS_SQL, [t.id])).rows[0].items, { statementTimeoutMs: 60_000 })
      const docs = positionsFromEstimate(items)
      const signatures = new Map(sigs.map((s) => [s.name, s]))
      for (const job of planTabImports(sources, docs, signatures)) {
        try {
          await saveSource(t.id, { existing: job.existing, name: job.name, source: 'vor_tab', doc: null, version: job.version, positions: job.positions })
          changed = true
          stats.imported += 1
        } catch (e) {
          issues.push({ kind: 'save', name: job.name, message: String(e?.message || e).slice(0, 200) })
        }
      }
    }
    if (changed) { sources = await reloadSources(t.id); changed = false }

    // Пустые устаревшие списки (из вкладки, когда появились файлы; от удалённого файла) — если цен у них нет.
    const hasFiles = sources.some((s) => s.source === 'vor_file' && s.s3_document_id)
    if (sources.some((s) => (s.source === 'vor_tab' && hasFiles) || (s.source === 'vor_file' && !s.s3_document_id))) {
      const priced = await db.read(null, async (tx) => (await tx.query(
        'select distinct estimate_name from public.tender_vor_supply_rates where tender_id = $1', [t.id])).rows)
      for (const s of planCleanup(sources, priced)) {
        await db.write(null, (tx) => tx.query('delete from public.tender_supply_sources where id = $1 and row_version = $2', [s.id, s.row_version]))
          .then(() => { changed = true }, () => {})
      }
      if (changed) sources = await reloadSources(t.id)
    }

    // Позиций нет и причин нет — ни файл, ни вкладка «ВОР» материалов не дали (или их нет вовсе).
    const positions = sources.reduce((n, s) => n + (s.positions_count || 0), 0)
    const status = positions > 0 ? 'ok' : issues.length ? 'issues' : pending ? 'pending' : 'no_vor'
    if (await saveState(t.id, prev, { status, files_sig: filesSig, tab_sig: tabSig, parser_version: VOR_PARSER_VERSION, issues, positions_count: positions })) {
      stats.states += 1
    }
  }

  async function runOnce() {
    if (running) return { skipped: 'busy' }
    running = true
    const stats = { tenders: 0, imported: 0, failed: 0, states: 0, errors: 0 }
    try {
      const list = await db.read(null, async (tx) => (await tx.query(CANDIDATES_SQL, [VOR_CATEGORIES])).rows.map((r) => r.tender),
        { statementTimeoutMs: 60_000 })
      // Сначала тендеры без состояния (их ещё не смотрели) и без позиций, затем остальные.
      list.sort((a, b) => Number(!!a.state) - Number(!!b.state) || Number((a.sources || []).length > 0) - Number((b.sources || []).length > 0))
      const budget = { files: o.maxFilesPerRun, until: Date.now() + o.maxRunMs }
      for (const t of list) {
        stats.tenders += 1
        try {
          await processTender(t, budget, stats)
        } catch (e) {
          stats.errors += 1
          log.warn?.({ tender: t.id, code: e?.code, msg: String(e?.message || e).slice(0, 160) }, 'supply import: tender')
        }
      }
      return stats
    } finally {
      running = false
    }
  }

  function start({ isReadOnly = () => false } = {}) {
    let interval = null
    const tick = () => {
      if (isReadOnly()) return
      runOnce()
        .then((s) => { if (s.imported || s.failed || s.errors) log.info?.(s, 'supply import') })
        .catch((e) => log.warn?.({ code: e?.code, msg: String(e?.message || e).slice(0, 160) }, 'supply import'))
    }
    const first = setTimeout(() => {
      tick()
      interval = setInterval(tick, o.intervalMs)
      interval.unref?.()
    }, o.firstDelayMs)
    first.unref?.()
    return () => { clearTimeout(first); if (interval) clearInterval(interval) }
  }

  return { runOnce, start }
}
