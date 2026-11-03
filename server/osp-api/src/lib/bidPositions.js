// Позиции ВОР для кабинета подрядчика — заранее, на сервере (миграция 20261204_contractor_self_access).
//
// Подрядчику, зарегистрировавшемуся на сайте, файлы не отдаются: в книге Excel могут быть скрытые листы, служебные колонки
// и что угодно ещё, а для расценки нужны только наименование, ед. изм., объём, структура и особые условия. Служба разбирает
// файлы ВОР тем же кодом, что страница кабинета (shared/bidVor.js), и кладёт результат в закрытую схему; читает его только
// функция bid_positions, с проверкой доступа к тендеру.
//
// Какие файлы: ВОР идущих тендеров и тех, где уже есть заявка или цены с сайта. Новый файл появляется у подрядчика в течение
// такта. Файл не разобрался — запись с причиной, повтор только при новой версии разбора; сбой связи с хранилищем — повтор в
// следующий проход. Бережно к серверу — как src/lib/supplyImport.js: отдельный процесс, потолок памяти, предел файлов и
// времени за проход.
import { fileURLToPath } from 'node:url'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { parseInChild } from './supplyImport.js'

// Меняется вместе с разбором (shared/bidVor.js): файлы разберутся заново.
export const BID_PARSER_VERSION = 'bid:1'
export const BID_POSITIONS_DEFAULTS = {
  intervalMs: 10 * 60_000,
  firstDelayMs: 120_000,
  maxFilesPerRun: 40,
  maxRunMs: 6 * 60_000,
  maxFileBytes: 25 * 1024 * 1024,
  parseTimeoutMs: 120_000,
  parseHeapMb: 192,
  downloadTimeoutMs: 60_000,
  maxPositions: 20_000,
  maxStructureRows: 60_000,
}
const VOR_CATEGORIES = ['vor_statement', 'vor']
const CHILD = fileURLToPath(new URL('./bidParseChild.js', import.meta.url))
const isNotFound = (e) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404

const DUE_SQL = `
select d.id, d.owner_id as tender_id, d.s3_key
from public.s3_documents d
join public.tenders t on t.id = d.owner_id and t.deleted_at is null
left join osp_private.bid_vor_files f on f.s3_document_id = d.id
where d.owner_type = 'tender' and d.doc_category = any($1::text[])
  and d.file_name ~* '\\.(xlsx|xlsm|xls)$'
  and (f.s3_document_id is null or f.source_version <> $2)
  and (public.bid_tender_open(t.id)
       or exists (select 1 from public.tender_bid_requests r where r.tender_id = t.id)
       or exists (select 1 from public.tender_bid_rates b where b.tender_id = t.id))
order by t.tender_end_date nulls last, d.id
limit $3`

// Только то, что нужно для расценки: лишнее из разбора в базу не идёт.
export function positionsPayload(result, { maxPositions = BID_POSITIONS_DEFAULTS.maxPositions, maxStructureRows = BID_POSITIONS_DEFAULTS.maxStructureRows } = {}) {
  const positions = [...(result.materials || []), ...(result.works || [])]
    .map(({ kind, key, itemKey, unitKey, name, unit, volume, rows }) => ({ kind, key, itemKey, unitKey, name, unit, volume, rows }))
  const structure = (result.structure || [])
    .map(({ type, num, code, name, unit, volume }) => ({ type, num, code, name, unit, volume }))
  if (positions.length > maxPositions || structure.length > maxStructureRows) return { error: 'too_many' }
  return { positions, structure, conditions: result.conditions || [] }
}

export function createBidPositions({ db, s3, bucket, log = console, parse = parseInChild, options = {} }) {
  const o = { ...BID_POSITIONS_DEFAULTS, ...options }
  let running = null
  let idle = false

  async function download(doc) {
    const signal = () => ({ abortSignal: AbortSignal.timeout(o.downloadTimeoutMs) })
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: doc.s3_key }), signal())
    if (Number(head.ContentLength) > o.maxFileBytes) return { error: 'too_large' }
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: doc.s3_key }), signal())
    return { bytes: await res.Body.transformToByteArray() }
  }

  const save = (doc, { status, error = null, positions = [], structure = [], conditions = [] }) => db.write(null, (tx) => tx.query(`
    insert into osp_private.bid_vor_files (s3_document_id, tender_id, source_version, status, error, positions, structure, conditions, parsed_at)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now())
    on conflict (s3_document_id) do update set tender_id = excluded.tender_id, source_version = excluded.source_version, status = excluded.status,
      error = excluded.error, positions = excluded.positions, structure = excluded.structure, conditions = excluded.conditions, parsed_at = excluded.parsed_at`,
  [doc.id, doc.tender_id, BID_PARSER_VERSION, status, error, JSON.stringify(positions), JSON.stringify(structure), JSON.stringify(conditions)]),
  { statementTimeoutMs: 60_000 })

  async function processFile(doc) {
    let got
    try {
      got = await download(doc)
    } catch (err) {
      if (isNotFound(err)) got = { error: 'missing' }
      else throw err // связь с хранилищем — следующий проход
    }
    if (got.error) { await save(doc, { status: 'error', error: got.error }); return 'failed' }
    const parsed = await parse(got.bytes, null, { timeoutMs: o.parseTimeoutMs, heapMb: o.parseHeapMb, childFile: CHILD })
    if (parsed?.error) { await save(doc, { status: 'error', error: String(parsed.error).slice(0, 40) }); return 'failed' }
    const payload = positionsPayload(parsed, o)
    if (payload.error) { await save(doc, { status: 'error', error: payload.error }); return 'failed' }
    await save(doc, { status: 'ok', ...payload })
    return 'ok'
  }

  async function runPass() {
    let due
    try {
      due = await db.read(null, async (tx) => (await tx.query(DUE_SQL, [VOR_CATEGORIES, BID_PARSER_VERSION, o.maxFilesPerRun])).rows)
    } catch (err) {
      if (err?.code === '42P01' || err?.code === '42883' || err?.code === '3F000') {
        if (!idle) log.warn({ code: err.code }, 'bid positions: миграция 20261204 не применена')
        idle = true
        return { ok: 0, failed: 0, retry: 0 }
      }
      throw err
    }
    idle = false
    const stats = { ok: 0, failed: 0, retry: 0 }
    const deadline = Date.now() + o.maxRunMs
    for (const doc of due) {
      if (Date.now() > deadline) break
      try {
        stats[await processFile(doc)] += 1
      } catch (err) {
        stats.retry += 1
        log.warn({ name: err?.name, code: err?.code }, 'bid positions: файл — в следующий проход')
      }
    }
    return stats
  }

  function runOnce() {
    running ??= runPass().finally(() => { running = null })
    return running
  }

  function start({ isReadOnly = () => false } = {}) {
    const tick = () => {
      if (isReadOnly()) return
      runOnce().then((s) => { if (s.ok || s.failed) log.info(s, 'bid positions') })
        .catch((err) => log.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'bid positions'))
    }
    const first = setTimeout(tick, o.firstDelayMs)
    const timer = setInterval(tick, o.intervalMs)
    first.unref?.()
    timer.unref?.()
    return async () => {
      clearTimeout(first)
      clearInterval(timer)
      await running?.catch(() => {})
    }
  }

  return { runOnce, start }
}
