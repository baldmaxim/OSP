// Очередь писем регистрации и восстановления пароля (osp_auth.mail_outbox).
//
// Письмо ставится в очередь в той же транзакции, что и заявка, а отправляется отдельным тактом. Поэтому:
//   • ответ маршрута не зависит от того, есть ли учётка и работает ли почтовый сервер: по времени ответа адрес не проверить;
//   • заявка без письма и письмо без заявки невозможны;
//   • ссылка лежит в базе зашифрованной ключом сервера (OSP_AUTH_KEYS), после отправки строка удаляется.
// Письма — только текстом, без HTML. В журнал службы не попадают ни адреса, ни содержимое: только вид письма и код ошибки.
// Стандарт контура: поставщик — за SMTP (Yandex Cloud Postbox или другой), код от него не зависит.
const AAD = 'osp-mail'

export const OUTBOX_DEFAULTS = { tickMs: 15_000, batch: 20, maxAttempts: 8, sendTimeoutMs: 30_000 }

// Настоящий транспорт: загружается, только когда регистрация включена. TLS не ниже 1.2; порт 465 — сразу TLS, остальные —
// обязательный STARTTLS (без него письмо со ссылкой не уйдёт открытым текстом).
export async function createSmtpTransport(url) {
  const nodemailer = (await import('nodemailer')).default
  const secure = new URL(url).protocol === 'smtps:'
  return nodemailer.createTransport(url, {
    requireTLS: !secure,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
}

export function createMailOutbox({ db, box, transport, from, replyTo = '', log = console, isReadOnly = () => false, options = {} }) {
  const o = { ...OUTBOX_DEFAULTS, ...options }
  let running = null
  let idleTables = false

  // Отметка транзакции — 'auth': вызывающий её уже поставил.
  async function enqueue(tx, { kind, to, subject, text }) {
    const payload = box.encrypt(JSON.stringify({ to, subject, text }), AAD)
    await tx.query('insert into osp_auth.mail_outbox (kind, payload) values ($1, $2)', [kind, payload])
  }

  async function due() {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const { rows } = await tx.query(`select id, kind, payload, attempts from osp_auth.mail_outbox
        where not_before <= now() order by id limit $1`, [o.batch])
      return rows
    })
  }

  const finish = (id) => db.write(null, async (tx) => {
    await tx.mark('auth')
    await tx.query('delete from osp_auth.mail_outbox where id = $1', [id])
  })

  // Следующая попытка — через 1, 2, 4… минуты, не реже раза в час.
  const retryLater = (id, attempts) => db.write(null, async (tx) => {
    await tx.mark('auth')
    await tx.query(`update osp_auth.mail_outbox set attempts = $2,
        not_before = now() + least(interval '60 minutes', interval '1 minute' * power(2, $2::int - 1)) where id = $1`, [id, attempts])
  })

  async function drainOnce() {
    let rows
    try {
      rows = await due()
    } catch (err) {
      if (err?.code === '42P01') {
        if (!idleTables) log.warn({ code: err.code }, 'mail outbox: нет таблиц регистрации — миграция 20261203 не применена')
        idleTables = true
        return { sent: 0, failed: 0 }
      }
      throw err
    }
    idleTables = false
    let sent = 0
    let failed = 0
    for (const row of rows) {
      let mail
      try {
        mail = JSON.parse(box.decrypt(row.payload, AAD))
      } catch (err) {
        // Ключ сменили или строка повреждена: отправить её уже нельзя никогда.
        log.error({ kind: row.kind, code: err?.code || 'decrypt' }, 'mail outbox: письмо не расшифровывается, удалено')
        await finish(row.id)
        failed += 1
        continue
      }
      try {
        await Promise.race([
          transport.sendMail({ from, to: mail.to, ...(replyTo ? { replyTo } : {}), subject: mail.subject, text: mail.text }),
          new Promise((_, reject) => { const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), o.sendTimeoutMs); t.unref?.() }),
        ])
        await finish(row.id)
        sent += 1
      } catch (err) {
        failed += 1
        const attempts = row.attempts + 1
        const code = String(err?.responseCode || err?.code || 'send')
        // Отказ получателя (5xx) не лечится повтором, сетевой сбой и отказ сервера — лечатся.
        if (attempts >= o.maxAttempts || (err?.responseCode >= 500 && err?.responseCode < 600)) {
          log.error({ kind: row.kind, code, attempts }, 'mail outbox: письмо не отправлено, попытки закончились')
          await finish(row.id)
        } else {
          log.warn({ kind: row.kind, code, attempts }, 'mail outbox: повтор позже')
          await retryLater(row.id, attempts)
        }
      }
    }
    return { sent, failed }
  }

  function drain() {
    running ??= drainOnce().finally(() => { running = null })
    return running
  }

  function start() {
    const timer = setInterval(() => {
      if (isReadOnly()) return
      drain().catch((err) => log.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'mail outbox'))
    }, o.tickMs)
    timer.unref?.()
    return async () => {
      clearInterval(timer)
      await running?.catch(() => {})
    }
  }

  return { enqueue, drain, start }
}
