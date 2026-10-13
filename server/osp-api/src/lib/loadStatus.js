// Какая копия данных лежит в базе, с которой работает сервер: репетиция переноса или рабочая.
//
// Отметку ставит загрузчик (migration/target/load.sh --status rehearsal | final) в osp_meta.load_log —
// вручную её не задают, поэтому «забыть включить защиту» нельзя. Зачем она серверу: у репетиционной
// копии общие с рабочим порталом хранилище файлов и вход. Строки репетиции потом стираются, а удалённый
// из хранилища файл и удалённая учётка входа — настоящие. Пока отметка не «final», сервер таких
// действий не делает (src/routes/s3Presign.js, beforeGateway в src/app.js).
//
// Отметка не читается (нет подключения, нет таблицы, сбой) — 'unknown': считаем, что это репетиция.
//
//   const loadStatus = createLoadStatus({ db })
//   const { status, loadedAt } = await loadStatus.current()   // 'final' | 'rehearsal' | 'unknown'
export const LOAD_STATUS_TTL_MS = 30_000
// Последняя загрузка. Этот же текст выполняется на настоящей базе в tests/backup/target-single-owner.test.mjs.
export const LOAD_STATUS_SQL = 'select status, finished_at from osp_meta.load_log order by id desc limit 1'
const UNKNOWN = Object.freeze({ status: 'unknown', loadedAt: null })

export function createLoadStatus({ db, ttlMs = LOAD_STATUS_TTL_MS, now = Date.now, logger = null }) {
  let cached = null
  let pending = null

  const read = async () => {
    if (!db) return UNKNOWN
    try {
      const rows = await db.read(null, async (tx) =>
        (await tx.query(LOAD_STATUS_SQL)).rows)
      const row = rows[0]
      // Загрузка не завершена (finished_at пуст) — данные ещё не те, на которые можно полагаться.
      if (!row || !row.finished_at) return UNKNOWN
      const loadedAt = new Date(row.finished_at)
      if (Number.isNaN(loadedAt.getTime())) return UNKNOWN
      if (row.status === 'final') return { status: 'final', loadedAt }
      if (row.status === 'rehearsal') return { status: 'rehearsal', loadedAt }
      return UNKNOWN
    } catch (err) {
      logger?.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'load status')
      return UNKNOWN
    }
  }

  return {
    // Память короткая: после настоящей загрузки сервер перезапускают, но и без перезапуска он увидит
    // новую отметку в пределах ttlMs. Неудачное чтение не запоминается — следующий запрос спросит снова.
    async current() {
      if (cached && now() - cached.at < ttlMs) return cached.value
      pending ??= read().finally(() => { pending = null })
      const value = await pending
      if (value !== UNKNOWN) cached = { at: now(), value }
      return value
    },
  }
}

// Можно ли серверу менять то, что у репетиции общее с рабочим порталом (хранилище, учётки входа).
export const isFinalLoad = (state) => state?.status === 'final'

// Документ создан после загрузки копии — то есть в самой репетиции, а не пришёл с рабочими данными.
// Нет любой из двух дат или они не разбираются — считаем, что это рабочий документ.
export function createdAfterLoad(createdAt, loadedAt) {
  const created = createdAt ? new Date(createdAt).getTime() : NaN
  const loaded = loadedAt ? new Date(loadedAt).getTime() : NaN
  return Number.isFinite(created) && Number.isFinite(loaded) && created > loaded
}
