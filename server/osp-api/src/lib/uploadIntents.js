// Незавершённые загрузки файлов (миграция 20270120, osp_private.s3_upload_intents).
//
// Ссылку на загрузку (PUT в хранилище) служба выдаёт до того, как файл появится в базе: подтверждение (confirm) пишет строку.
// Без учёта загрузку без подтверждения можно повторять бесконечно и забить бакет. Поэтому:
//   • выданный ключ записывается; у пользователя за час — не больше MAX_OPEN незавершённых и MAX_BYTES заявленного;
//   • подтверждение снимает запись;
//   • уборка (cleanup, по такту службы) удаляет объекты, ссылку на которые выдали больше часа назад, а строки файла нет.
//     Удаляются только ключи из этой таблицы — чужие объекты бакета (прежний портал) не трогаются.
// Таблицы нет (база раньше миграции) — без учёта, как раньше. Служебные операции идут с пропуском (src/lib/db.js).
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

export const INTENT_MAX_OPEN = 20
export const INTENT_MAX_BYTES = 2 * 1024 ** 3
export const INTENT_TTL_MS = 60 * 60 * 1000
const MISSING_TABLE = new Set(['42P01', '3F000'])

export function createUploadIntents({ db }) {
  async function note(s3Key, userId, size) {
    if (!db) return null
    try {
      return await db.write(null, async (tx) => {
        const { rows } = await tx.query(
          `select count(*)::int as n, coalesce(sum(size_bytes), 0)::bigint as bytes from osp_private.s3_upload_intents
            where user_id = $1 and created_at > now() - interval '1 hour' and s3_key <> $2`, [userId, s3Key])
        if (rows[0].n >= INTENT_MAX_OPEN) return 'Слишком много незавершённых загрузок — подождите, пока они закончатся'
        if (Number(rows[0].bytes) + size > INTENT_MAX_BYTES) return 'Слишком большой объём незавершённых загрузок — подождите'
        await tx.query(`insert into osp_private.s3_upload_intents (s3_key, user_id, size_bytes) values ($1, $2, $3)
          on conflict (s3_key) do nothing`, [s3Key, userId, size])
        return null
      })
    } catch (err) {
      if (MISSING_TABLE.has(String(err?.code || ''))) return null
      throw err
    }
  }

  async function drop(s3Key) {
    if (!db) return
    try {
      await db.write(null, (tx) => tx.query('delete from osp_private.s3_upload_intents where s3_key = $1', [s3Key]))
    } catch (err) {
      if (!MISSING_TABLE.has(String(err?.code || ''))) throw err
    }
  }

  return { note, drop }
}

// Уборка: записи старше часа. Ключ стал файлом (строка s3_documents или tender_bid_files) — снимается только запись; нет —
// удаляется и объект. → { checked, removed } | { skipped: true }.
export async function cleanupUploadIntents({ db, s3, bucket, log, now = Date.now, batch = 200 }) {
  if (!db || !s3 || !bucket) return { skipped: true }
  let rows
  try {
    rows = await db.read(null, async (tx) => {
      // Файлы подрядчика (tender_bid_files, 20270113) — только если таблица есть: иначе запрос не разберётся.
      const bids = (await tx.query(`select to_regclass('public.tender_bid_files') is not null as ok`)).rows[0].ok
      const bidCheck = bids ? 'or exists (select 1 from public.tender_bid_files b where b.s3_key = i.s3_key)' : ''
      return (await tx.query(
        `select i.s3_key, (exists (select 1 from public.s3_documents d where d.s3_key = i.s3_key) ${bidCheck}) as confirmed
           from osp_private.s3_upload_intents i where i.created_at < $1 order by i.created_at limit $2`,
        [new Date(now() - INTENT_TTL_MS), batch])).rows
    })
  } catch (err) {
    if (MISSING_TABLE.has(String(err?.code || ''))) return { skipped: true }
    throw err
  }
  let removed = 0
  for (const r of rows) {
    if (!r.confirmed) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: r.s3_key }))
        removed += 1
      } catch (e) {
        log?.warn({ msg: String(e?.message || e).slice(0, 120) }, 's3 upload intent: object not removed')
        continue
      }
    }
    await db.write(null, (tx) => tx.query('delete from osp_private.s3_upload_intents where s3_key = $1', [r.s3_key]))
  }
  return { checked: rows.length, removed }
}
