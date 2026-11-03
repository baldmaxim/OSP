// Регистрация подрядчика на сайте без одобрения администратора (AUTH_MODE=own, OSP_CONTRACTOR_SIGNUP=1).
//
// Заявка → письмо на указанную почту → хозяин почты задаёт пароль → проверки → доступ. До этого нет ни учётки, ни контрагента.
// Пароль в заявке не принимается намеренно: иначе чужой человек подал бы заявку с почтой директора и своим паролем, директор
// подтвердил бы письмо СУ-10, и кабинет открылся бы чужому паролем. Пароль задаёт тот, кто открыл письмо.
//
// Подтверждённая заявка заканчивается одним из трёх:
//   active — учётка создана: новая компания (контрагент с пометкой registered_via='self') или почта совпала с контактом
//            компании из реестра;
//   claim  — компания уже в реестре, почта чужая: ИНН общедоступен и сам по себе ничего не доказывает, поэтому ссылка-
//            подтверждение уходит на почту из карточки компании. Учётки до подтверждения нет;
//   review — решает администратор: ЧС, связь с компанией из ЧС, нет почты в карточке, компанию создала другая регистрация
//            (первый занявший ИНН не должен решать за настоящую компанию), заблокированная учётка, прежний отказ и т. п.
//
// Гарантии (tests/osp-api/contractor-signup.test.mjs):
//   • на заявку ответ один и тот же, есть учётка с этой почтой или нет; письмо уходит отдельным тактом. Что адрес занят, узнаёт
//     только хозяин почты — письмом;
//   • для подтвердившего почту claim и review неотличимы (status: 'review'): причина проверки не раскрывается. Предел: «review»
//     по свежему ИНН значит совпадение с контактом или названием из ЧС; подбор этого ограничен подтверждением почты и лимитами;
//   • в базе — только sha256 ссылок; ссылка одноразовая и с коротким сроком; открытие ссылки ничего не меняет (её могут
//     открыть почтовые сканеры) — подтверждает запрос POST со страницы; сессии подтверждение не выдаёт: дальше вход паролем;
//   • учётка с регистрации — только подрядчик (ограничение базы) и только со своей организацией;
//   • в письме на чужой адрес — только сведения из реестра и проверенный адрес заявителя, текста заявителя нет;
//   • пароли, ссылки и введённые данные не попадают в журнал службы.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { hashPassword } from './passwords.js'
import { checkNewPassword } from './policy.js'
import { SIGNUP_CONSENT_VERSION, companyNameKey, digitsOnly, emailDomain, emailProblem, isPublicMailDomain, validateSignup } from '../../shared/contractorSignupRules.js'

export const SIGNUP_DEFAULTS = {
  confirmTtlHours: 24,
  claimTtlDays: 7,
  resetTtlHours: 1,
  // Заявок за сутки. Сверх общего предела регистрация закрывается до следующих суток: вход и работа сотрудников не страдают.
  dailyTotal: 200,
  dailyPerIp: 20,
  // Писем на один адрес за сутки: с одного адреса отправителя и всего. Первое не даёт закрыть чужому его регистрацию, второе —
  // завалить его ящик. Предела по ИНН нет намеренно: иначе чужак мог бы закрыть регистрацию чужой компании.
  dailyPerEmailIp: 3,
  dailyPerEmail: 8,
  // С одного домена (кроме общих почтовых служб) — поток выдуманных компаний с одного купленного домена.
  dailyPerDomain: 10,
  // Новых контрагентов с регистрации за сутки: сверх предела — администратору, реестр не засоряется.
  dailyNewCompanies: 50,
  // Писем по ссылке на почту компании за сутки — чтобы регистрацией нельзя было завалить чужой ящик.
  dailyClaimsPerCompany: 3,
  maxClaimAddresses: 5,
  dailyNoticesPerUser: 2,
  dailyResetsPerUser: 3,
}

export const SIGNUP_ERRORS = {
  invalidToken: { status: 400, code: 'OSP_SIGNUP_TOKEN', message: 'Ссылка устарела или уже использована' },
  closed: { status: 503, code: 'OSP_SIGNUP_CLOSED', message: 'Регистрация временно закрыта — попробуйте завтра или напишите на tender.osp@su10.ru' },
  ipLimit: { status: 429, code: 'too_many_attempts', message: 'Слишком много заявок с этого адреса — попробуйте завтра', retryAfterSec: 3600 },
  busy: { status: 503, code: 'OSP_AUTH_BUSY', message: 'Сервер занят, повторите через несколько секунд' },
  domain: { status: 400, code: 'OSP_SIGNUP_FIELD', field: 'email', message: 'Домен почты не принимает письма — проверьте адрес' },
}

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')
const fail = (key) => ({ ok: false, ...SIGNUP_ERRORS[key] })
const isUniqueViolation = (err) => err?.code === '23505'

// Принимает ли домен почту: есть MX или (по правилу SMTP) адрес домена. Нет ответа DNS — считаем, что да: остальная
// защита на месте, а сбой DNS не должен закрывать регистрацию.
export function createDomainCheck({ timeoutMs = 2500 } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  const absent = (err) => err?.code === 'ENOTFOUND' || err?.code === 'ENODATA'
  return async function domainAcceptsMail(domain) {
    try {
      return (await resolver.resolveMx(domain)).length > 0
    } catch (err) {
      if (!absent(err)) return true
    }
    try {
      return (await resolver.resolve4(domain)).length > 0
    } catch (err) {
      return !absent(err)
    }
  }
}

// Тот же ИНН в реестре, в каком бы виде его ни записали: с пробелами, вместе с КПП через «/», два ИНН в ячейке, без ведущего
// нуля после Excel. $1 — только цифры (проверено правилами), регулярное выражение строит только этот код.
const SAME_INN = `(regexp_replace(coalesce(c.inn, ''), '[^0-9]', '', 'g') = $1
    or coalesce(c.inn, '') ~ ('(^|[^0-9])0*' || ltrim($1, '0') || '([^0-9]|$)'))`

// ── Письма ──────────────────────────────────────────────────────────────────────────────────────────
const SIGN = `\n\n—\nТендерная площадка СУ-10, tender.su10.ru\nПисьмо отправлено автоматически. Вопросы — tender.osp@su10.ru`
const MAIL = {
  confirm: (link) => ({
    kind: 'signup_confirm',
    subject: 'Завершите регистрацию на тендерной площадке СУ-10',
    text: `Здравствуйте!\n\nЭтот адрес указали при регистрации подрядчика на тендерной площадке СУ-10.\nЧтобы завершить регистрацию, откройте ссылку, проверьте сведения о компании и задайте пароль:\n\n${link}\n\nСсылка действует 24 часа и срабатывает один раз.\nЕсли это были не вы, удалите письмо: без этого шага учётная запись не появится.${SIGN}`,
  }),
  exists: (link) => ({
    kind: 'signup_exists',
    subject: 'Вы уже зарегистрированы на тендерной площадке СУ-10',
    text: `Здравствуйте!\n\nС этим адресом попытались зарегистрироваться ещё раз, но учётная запись уже есть. Войти:\n\n${link}\n\nЗабыли пароль — на странице входа подрядчика есть ссылка «Забыли пароль?».\nЕсли это были не вы, ничего делать не нужно.${SIGN}`,
  }),
  waiting: () => ({
    kind: 'signup_waiting',
    subject: 'Ваша заявка на регистрацию проверяется',
    text: `Здравствуйте!\n\nЗаявка с этим адресом уже проверяется. Как только проверка закончится, мы напишем. Новая заявка не нужна.${SIGN}`,
  }),
  active: (link) => ({
    kind: 'signup_active',
    subject: 'Регистрация на тендерной площадке СУ-10 завершена',
    text: `Здравствуйте!\n\nРегистрация завершена, кабинет подрядчика открыт. Войти:\n\n${link}\n\nЕсли это были не вы, напишите на tender.osp@su10.ru.${SIGN}`,
  }),
  refused: () => ({
    kind: 'signup_refused',
    subject: 'Заявка на регистрацию не подтверждена',
    text: `Здравствуйте!\n\nЗаявку на регистрацию на тендерной площадке СУ-10 подтвердить не удалось. Вопросы — на tender.osp@su10.ru.${SIGN}`,
  }),
  // Уходит на адрес из карточки компании — там не заявитель, а тот, кто решает. Название и ИНН — из реестра, от заявителя только
  // проверенный адрес почты: его название и имя могли бы превратить письмо СУ-10 в чужой текст.
  claim: (link, email, company, inn) => ({
    kind: 'signup_claim',
    subject: 'Запрос доступа от имени вашей организации на тендерной площадке СУ-10',
    text: `Здравствуйте!\n\nЭтот адрес указан как контактный у организации «${company}», ИНН ${inn}, в реестре подрядчиков СУ-10.\nС адреса ${email} запрошен доступ в кабинет подрядчика от её имени: там видны цены и анкеты организации по тендерам.\n\nЕсли вы знаете этого человека, подтвердите запрос по ссылке. Если нет — отклоните его:\n\n${link}\n\nСсылка действует 7 дней и срабатывает один раз. Не уверены — не подтверждайте и напишите на tender.osp@su10.ru.${SIGN}`,
  }),
  // После подтверждения — всем адресам компании: один адрес мог ошибиться или быть чужим.
  claimApproved: (email, company, inn) => ({
    kind: 'signup_claim_approved',
    subject: 'Открыт доступ от имени вашей организации на тендерной площадке СУ-10',
    text: `Здравствуйте!\n\nАдресу ${email} открыт доступ в кабинет подрядчика от имени организации «${company}», ИНН ${inn}: запрос подтвердили с одного из адресов организации.\nЕсли этого делать не следовало, напишите на tender.osp@su10.ru: учётную запись заблокируют.${SIGN}`,
  }),
  review: (link) => ({
    kind: 'signup_review',
    subject: 'Заявка подрядчика ждёт решения',
    text: `Заявка на регистрацию подрядчика ждёт решения администратора: ${link}${SIGN}`,
  }),
  reset: (link) => ({
    kind: 'password_reset',
    subject: 'Восстановление пароля на тендерной площадке СУ-10',
    text: `Здравствуйте!\n\nЧтобы задать новый пароль, откройте ссылку:\n\n${link}\n\nСсылка действует час и срабатывает один раз. Если это были не вы, ничего делать не нужно: пароль останется прежним.${SIGN}`,
  }),
  passwordChanged: (link) => ({
    kind: 'password_changed',
    subject: 'Пароль изменён',
    text: `Здравствуйте!\n\nПароль вашей учётной записи только что изменён, все входы на других устройствах завершены.\nЕсли это были не вы, напишите на tender.osp@su10.ru.\n\nВойти: ${link}${SIGN}`,
  }),
}

export function createSignup({ db, box, verifier, blocklist, mail, sessions, publicOrigin, notifyEmail = '', domainAcceptsMail, log = console, options = {} }) {
  const o = { ...SIGNUP_DEFAULTS, ...options }
  const acceptsMail = domainAcceptsMail || createDomainCheck()
  const newHash = (password) => (verifier.hash ? verifier.hash(password) : hashPassword(password))
  const link = (path) => `${publicOrigin}${path}`
  const loginLink = link('/partner')

  const event = (tx, userId, kind, detail = {}) =>
    tx.query('insert into osp_auth.events (user_id, kind, detail) values ($1, $2, $3)', [userId, kind, JSON.stringify(detail)])
  const send = (tx, to, message) => mail.enqueue(tx, { ...message, to })
  const words = (s) => String(s || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)

  // Адреса из карточек компаний: { id компании → [адреса] }, только правильные. Отметка транзакции — 'internal'.
  async function companyAddresses(tx, ids) {
    const byCompany = new Map()
    if (!ids.length) return byCompany
    const { rows } = await tx.query(`select counterparty_id, email from public.counterparty_contacts
        where counterparty_id = any($1::uuid[]) and coalesce(btrim(email), '') <> ''`, [ids])
    for (const c of rows) {
      const list = byCompany.get(c.counterparty_id) || []
      for (const a of words(c.email)) if (!emailProblem(a) && !list.includes(a)) list.push(a)
      byCompany.set(c.counterparty_id, list)
    }
    return byCompany
  }

  // ── Проверки компании ────────────────────────────────────────────────────────────────────────────
  // → { kind: 'new' | 'bind' | 'claim' | 'review', reasons, counterpartyId, addresses }. Отметка транзакции — 'internal'.
  async function companyVerdict(tx, reg) {
    // Строки компании заняты до конца транзакции: внесение в ЧС дождётся и закроет созданную здесь учётку.
    const { rows: same } = await tx.query(`select c.id, c.status::text as status, c.deleted_at, c.registered_via
        from public.counterparties c where ${SAME_INN}
        order by c.updated_at desc nulls last, c.id for share`, [reg.inn])
    const reasons = []
    if (same.some((c) => c.status === 'blacklist')) reasons.push('inn_blacklisted')

    // Аффилированные с ЧС: группа counterparty_relations (связи в обе стороны, до 4 шагов).
    if (same.length) {
      const ids = same.map((c) => c.id)
      const { rows } = await tx.query(`with recursive grp(id, depth) as (
          select unnest($1::uuid[]), 0
          union
          select case when r.counterparty_id = g.id then r.related_counterparty_id else r.counterparty_id end, g.depth + 1
          from grp g join public.counterparty_relations r on g.id in (r.counterparty_id, r.related_counterparty_id)
          where g.depth < 4)
        select exists (select 1 from grp g join public.counterparties c on c.id = g.id
                       where c.status::text = 'blacklist' and c.id <> all($1::uuid[])) as hit`, [ids])
      if (rows[0].hit) reasons.push('affiliate_blacklisted')
      // Блокировку и удаление не обойти новой почтой с тем же ИНН.
      const blocked = await tx.query('select 1 from public.user_roles where counterparty_id = any($1::uuid[]) and is_blocked limit 1', [ids])
      if (blocked.rows.length) reasons.push('company_account_blocked')
    }

    // Те же люди под новым названием: почта, телефон, домен (кроме общедоступных почтовых служб), название.
    const { rows: marks } = await tx.query(`select c.name, cc.email, cc.phone
        from public.counterparties c left join public.counterparty_contacts cc on cc.counterparty_id = c.id
        where c.status::text = 'blacklist'`)
    const email = reg.email_norm
    const domain = emailDomain(email)
    const phone = digitsOnly(reg.phone).slice(-10)
    const key = companyNameKey(reg.company_name)
    let contactHit = false
    let domainHit = false
    let nameHit = false
    for (const m of marks) {
      const addresses = words(m.email)
      if (addresses.includes(email)) contactHit = true
      if (phone.length === 10 && digitsOnly(m.phone).includes(phone)) contactHit = true
      if (!isPublicMailDomain(domain) && addresses.some((a) => emailDomain(a) === domain)) domainHit = true
      if (key.length >= 4 && companyNameKey(m.name) === key) nameHit = true
    }
    if (contactHit) reasons.push('contact_blacklisted')
    if (domainHit) reasons.push('domain_blacklisted')
    if (nameHit) reasons.push('name_blacklisted')

    const live = same.filter((c) => !c.deleted_at && c.status !== 'blacklist')
    if (same.length && !live.length && !reasons.includes('inn_blacklisted')) reasons.push('company_deleted')
    const first = live[0]?.id ?? null
    if (reasons.length) return { kind: 'review', reasons, counterpartyId: first, addresses: [] }
    if (!live.length) return { kind: 'new', reasons, counterpartyId: null, addresses: [] }

    // Компании, которые вёл отдел: заявитель подтвердил почту, которую отдел знает как контакт, — сразу; иначе — письмо туда.
    const known = live.filter((c) => c.registered_via !== 'self')
    const byCompany = await companyAddresses(tx, known.map((c) => c.id))
    for (const c of known) {
      if ((byCompany.get(c.id) || []).includes(email)) return { kind: 'bind', reasons, counterpartyId: c.id, addresses: [] }
    }
    const target = known.find((c) => (byCompany.get(c.id) || []).length)
    if (target) return { kind: 'claim', reasons, counterpartyId: target.id, addresses: byCompany.get(target.id).slice(0, o.maxClaimAddresses) }
    // Компанию создала другая регистрация: её контакт — первый, кто указал этот ИНН, и решать за настоящую компанию он не должен.
    if (live.some((c) => c.registered_via === 'self')) return { kind: 'review', reasons: ['company_unverified'], counterpartyId: first, addresses: [] }
    return { kind: 'review', reasons: ['no_company_mail'], counterpartyId: first, addresses: [] }
  }

  // ── Создание ─────────────────────────────────────────────────────────────────────────────────────
  async function createCompany(tx, reg) {
    await tx.mark('internal')
    const { rows } = await tx.query(`insert into public.counterparties (name, inn, kpp, status, registered_via, registered_at)
        values ($1, $2, $3, 'active', 'self', now()) returning id`, [reg.company_name, reg.inn, reg.kpp])
    await tx.query(`insert into public.counterparty_contacts (counterparty_id, full_name, phone, email) values ($1, $2, $3, $4)`,
      [rows[0].id, reg.contact_name, reg.phone, reg.email])
    return rows[0].id
  }

  // Учётка, строка ролей (всегда подрядчик своей организации), пароль — одной транзакцией. Заявка закрывается, отпечаток
  // из неё стирается. Отметка на выходе — 'auth'.
  async function createAccount(tx, reg, counterpartyId, actorId = null) {
    await tx.mark('internal')
    await tx.query(`insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
        values ($1, 'authenticated', 'authenticated', $2, now(), now(), now(), jsonb_build_object('full_name', $3::text, 'kind', 'contractor'))`,
    [reg.id, reg.email, reg.contact_name])
    await tx.query(`insert into public.user_roles (user_id, email, role, is_approved, full_name, work_phone, counterparty_id, requested_company, self_registered)
        values ($1, $2, 'contractor', true, $3, $4, $5, $6, true)`,
    [reg.id, reg.email, reg.contact_name, reg.phone, counterpartyId, reg.company_name])
    await tx.mark('auth')
    await tx.query(`insert into osp_auth.credentials (user_id, secret, version, algo, source, must_change)
        values ($1, $2, 1, 'scrypt', 'own', false)`, [reg.id, reg.secret])
    await event(tx, reg.id, 'self_registered', { by: actorId })
    await tx.query(`update osp_auth.registrations set status = 'active', secret = null, token_hash = null, expires_at = null,
        claim_token_hash = null, claim_expires_at = null, counterparty_id = $2, decided_at = now(), decided_by = $3 where id = $1`,
    [reg.id, counterpartyId, actorId])
  }

  // ── Заявка ───────────────────────────────────────────────────────────────────────────────────────
  // → { ok: true } (адрес занят или нет — ответ один) | { ok: false, status, code, message, field? }
  async function register(input, { ip = '' } = {}) {
    const parsed = validateSignup(input)
    if (!parsed.ok) return { ok: false, status: 400, code: 'OSP_SIGNUP_FIELD', field: parsed.field, message: parsed.message }
    const v = parsed.value
    const domain = emailDomain(v.email)
    if (!(await acceptsMail(domain))) return fail('domain')

    const caps = await db.read(null, async (tx) => {
      await tx.mark('auth')
      const { rows } = await tx.query(`select count(*)::int as total, count(*) filter (where ip = $1)::int as by_ip
        from osp_auth.registrations where created_at > now() - interval '1 day'`, [ip])
      return rows[0]
    })
    if (caps.total >= o.dailyTotal) {
      log.warn({ total: caps.total }, 'signup: дневной предел заявок — регистрация закрыта до следующих суток')
      return fail('closed')
    }
    if (ip && caps.by_ip >= o.dailyPerIp) return fail('ipLimit')

    const id = randomUUID()
    const token = newToken()
    try {
      await db.write(null, async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`osp:signup:${v.email.toLowerCase()}`])
        await tx.mark('internal')
        const norm = (await tx.query('select osp_private.email_norm($1) as norm', [v.email])).rows[0].norm
        const existing = (await tx.query('select id from auth.users where osp_private.email_norm(email) = $1', [norm])).rows[0]
        await tx.mark('auth')
        if (existing) {
          const notices = (await tx.query(`select count(*)::int as n from osp_auth.events
            where user_id = $1 and kind = 'signup_notice' and at > now() - interval '1 day'`, [existing.id])).rows[0].n
          if (notices < o.dailyNoticesPerUser) {
            await event(tx, existing.id, 'signup_notice', {})
            await send(tx, v.email, MAIL.exists(loginLink))
          }
          return
        }
        const open = (await tx.query(`select id, status, last_notice_at from osp_auth.registrations
          where email_norm = $1 and status in ('pending', 'claim', 'review') for update`, [norm])).rows[0]
        if (open && open.status !== 'pending') {
          // Заявка на проверке: напоминание — не чаще раза в сутки.
          if (!open.last_notice_at || Date.now() - new Date(open.last_notice_at).getTime() > 86_400_000) {
            await tx.query('update osp_auth.registrations set last_notice_at = now() where id = $1', [open.id])
            await send(tx, v.email, MAIL.waiting())
          }
          return
        }
        const sent = (await tx.query(`select count(*)::int as total, count(*) filter (where ip = $2)::int as from_ip
          from osp_auth.registrations where email_norm = $1 and created_at > now() - interval '1 day'`, [norm, ip])).rows[0]
        if (sent.total >= o.dailyPerEmail || sent.from_ip >= o.dailyPerEmailIp) return
        if (!isPublicMailDomain(domain)) {
          const fromDomain = (await tx.query(`select count(*)::int as n from osp_auth.registrations
            where split_part(email_norm, '@', 2) = $1 and created_at > now() - interval '1 day'`, [domain])).rows[0].n
          if (fromDomain >= o.dailyPerDomain) return
        }
        if (open) {
          await tx.query(`update osp_auth.registrations set status = 'superseded', secret = null, token_hash = null, expires_at = null where id = $1`, [open.id])
        }
        await tx.query(`insert into osp_auth.registrations (id, email, email_norm, company_name, inn, kpp, contact_name, phone,
              consent_version, consent_at, status, token_hash, expires_at, ip)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), 'pending', $10, now() + make_interval(hours => $11), $12)`,
        [id, v.email, norm, v.companyName, v.inn, v.kpp, v.contactName, v.phone, SIGNUP_CONSENT_VERSION,
          tokenHash(token), o.confirmTtlHours, ip || null])
        await send(tx, v.email, MAIL.confirm(link(`/partner/confirm#t=${token}`)))
      })
    } catch (err) {
      // Две заявки одновременно: первая уже записана, вторая ничего не меняет — ответ тот же.
      if (!isUniqueViolation(err)) throw err
    }
    return { ok: true }
  }

  // ── Что подтверждается: страница по ссылке показывает это до решения ─────────────────────────────
  // Только тому, у кого есть ссылка из письма. kind: 'confirm' — ссылка на почту заявителя (его же данные), 'claim' — на почту
  // компании (название и ИНН из реестра, адрес заявителя). → { ok: true, companyName, inn, email, contactName? } | invalidToken
  async function preview({ token, kind }) {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      if (kind === 'claim') {
        const reg = (await tx.query(`select email, inn, counterparty_id, claim_expires_at, status from osp_auth.registrations where claim_token_hash = $1`, [tokenHash(token)])).rows[0]
        if (!reg || reg.status !== 'claim' || new Date(reg.claim_expires_at).getTime() <= Date.now()) return fail('invalidToken')
        await tx.mark('internal')
        const company = (await tx.query('select name, inn from public.counterparties where id = $1', [reg.counterparty_id])).rows[0]
        return { ok: true, companyName: company?.name ?? '', inn: company?.inn ?? reg.inn, email: reg.email }
      }
      const reg = (await tx.query(`select email, inn, company_name, contact_name, expires_at, status from osp_auth.registrations where token_hash = $1`, [tokenHash(token)])).rows[0]
      if (!reg || reg.status !== 'pending' || new Date(reg.expires_at).getTime() <= Date.now()) return fail('invalidToken')
      return { ok: true, companyName: reg.company_name, inn: reg.inn, email: reg.email, contactName: reg.contact_name }
    })
  }

  // ── Подтверждение почты: хозяин почты задаёт пароль ──────────────────────────────────────────────
  // → { ok: true, status: 'active' | 'review' } | invalidToken | { field: 'password' }. Чем кончилось — для заявителя только
  // «открыто» или «проверяется». Слабый пароль ссылку не тратит. Отпечаток считается только по настоящей ссылке: задача дорогая.
  async function confirm({ token, password }) {
    const hash = tokenHash(token)
    const found = await db.read(null, async (tx) => {
      await tx.mark('auth')
      return (await tx.query(`select id, email, contact_name, status, expires_at from osp_auth.registrations where token_hash = $1`, [hash])).rows[0] || null
    })
    if (!found || found.status !== 'pending' || new Date(found.expires_at).getTime() <= Date.now()) return fail('invalidToken')
    const problem = checkNewPassword(password, { email: found.email, fullName: found.contact_name }, blocklist)
    if (problem) return { ok: false, status: 400, code: 'OSP_SIGNUP_FIELD', field: 'password', message: problem.message }
    let passwordHash
    try {
      passwordHash = await newHash(password)
    } catch (err) {
      if (err?.code === 'OSP_AUTH_BUSY') return fail('busy')
      throw err
    }
    const secret = box.encrypt(passwordHash, found.id)

    try {
      return await db.write(null, async (tx) => {
        await tx.mark('auth')
        const row = (await tx.query('select * from osp_auth.registrations where token_hash = $1 for update', [hash])).rows[0]
        if (!row || row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) return fail('invalidToken')
        const reg = { ...row, secret }
        // Подтверждения одного ИНН — по очереди: второй увидит компанию, созданную первым.
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`osp:signup-inn:${reg.inn}`])
        await tx.mark('internal')
        const taken = (await tx.query('select 1 from auth.users where osp_private.email_norm(email) = $1', [reg.email_norm])).rows.length > 0
        const verdict = taken ? null : await companyVerdict(tx, reg)
        const newToday = taken ? 0 : (await tx.query(`select count(*)::int as n from public.counterparties
            where registered_via = 'self' and registered_at > now() - interval '1 day'`)).rows[0].n
        await tx.mark('auth')
        if (taken) {
          await tx.query(`update osp_auth.registrations set status = 'superseded', secret = null, token_hash = null, expires_at = null where id = $1`, [reg.id])
          await send(tx, reg.email, MAIL.exists(loginLink))
          return fail('invalidToken')
        }
        await tx.query(`update osp_auth.registrations set confirmed_at = now(), token_hash = null, expires_at = null, secret = $2 where id = $1`, [reg.id, secret])
        let { kind, reasons, counterpartyId, addresses } = verdict
        // Учётку удалил администратор или ему уже отказали — сами не возвращаются.
        const deleted = (await tx.query('select 1 from osp_auth.tombstones where email_norm = $1 limit 1', [reg.email_norm])).rows.length > 0
        if (deleted) { kind = 'review'; reasons = [...reasons, 'email_deleted'] }
        const refused = (await tx.query(`select 1 from osp_auth.registrations where status = 'refused' and id <> $1
          and (email_norm = $2 or inn = $3) and decided_at > now() - interval '180 days' limit 1`, [reg.id, reg.email_norm, reg.inn])).rows.length > 0
        if (refused) { kind = 'review'; reasons = [...reasons, 'previously_refused'] }
        if (kind === 'new' && newToday >= o.dailyNewCompanies) { kind = 'review'; reasons = [...reasons, 'daily_new_limit'] }
        if (kind === 'claim') {
          const sent = (await tx.query(`select count(*)::int as n from osp_auth.registrations
            where counterparty_id = $1 and claim_sent_to > 0 and created_at > now() - interval '1 day'`, [counterpartyId])).rows[0].n
          if (sent >= o.dailyClaimsPerCompany) { kind = 'review'; reasons = [...reasons, 'claim_limit'] }
        }

        if (kind === 'new' || kind === 'bind') {
          const company = kind === 'new' ? await createCompany(tx, reg) : counterpartyId
          await createAccount(tx, reg, company)
          await send(tx, reg.email, MAIL.active(loginLink))
          return { ok: true, status: 'active' }
        }
        if (kind === 'claim') {
          const claim = newToken()
          await tx.query(`update osp_auth.registrations set status = 'claim', counterparty_id = $2, claim_token_hash = $3,
              claim_expires_at = now() + make_interval(days => $4), claim_sent_to = $5 where id = $1`,
          [reg.id, counterpartyId, tokenHash(claim), o.claimTtlDays, addresses.length])
          await tx.mark('internal')
          const company = (await tx.query('select name, inn from public.counterparties where id = $1', [counterpartyId])).rows[0]
          await tx.mark('auth')
          for (const address of addresses) await send(tx, address, MAIL.claim(link(`/partner/claim#t=${claim}`), reg.email, company.name, company.inn))
          return { ok: true, status: 'review' }
        }
        await tx.query(`update osp_auth.registrations set status = 'review', reasons = $2, counterparty_id = $3 where id = $1`,
          [reg.id, reasons, counterpartyId])
        if (notifyEmail) await send(tx, notifyEmail, MAIL.review(link('/admin')))
        return { ok: true, status: 'review' }
      })
    } catch (err) {
      if (isUniqueViolation(err)) return fail('invalidToken')
      throw err
    }
  }

  // ── Подтверждение с почты компании ───────────────────────────────────────────────────────────────
  // decision: 'approve' | 'deny'. Отказ не окончателен: заявка уходит администратору (адрес в карточке мог устареть). Об открытом
  // доступе узнают все адреса компании и отдел: решает один адрес, и он мог ошибиться. → { ok: true, status } | invalidToken
  async function decideClaim({ token, decision }) {
    try {
      return await db.write(null, async (tx) => {
        await tx.mark('auth')
        const reg = (await tx.query('select * from osp_auth.registrations where claim_token_hash = $1 for update', [tokenHash(token)])).rows[0]
        if (!reg || reg.status !== 'claim' || !reg.secret || new Date(reg.claim_expires_at).getTime() <= Date.now()) return fail('invalidToken')
        const toReview = async (reason) => {
          await tx.query(`update osp_auth.registrations set status = 'review', reasons = array_append(reasons, $2),
              claim_token_hash = null, claim_expires_at = null where id = $1`, [reg.id, reason])
          if (notifyEmail) await send(tx, notifyEmail, MAIL.review(link('/admin')))
        }
        if (decision !== 'approve') {
          await toReview('claim_denied')
          return { ok: true, status: 'denied' }
        }
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`osp:signup-inn:${reg.inn}`])
        await tx.mark('internal')
        // За время ожидания компанию могли внести в ЧС или удалить, а адрес — занять.
        const verdict = await companyVerdict(tx, reg)
        const taken = (await tx.query('select 1 from auth.users where osp_private.email_norm(email) = $1', [reg.email_norm])).rows.length > 0
        const company = (await tx.query(`select name, inn from public.counterparties where id = $1 and deleted_at is null and status::text <> 'blacklist'`, [reg.counterparty_id])).rows[0]
        const addresses = company ? (await companyAddresses(tx, [reg.counterparty_id])).get(reg.counterparty_id) || [] : []
        await tx.mark('auth')
        if (verdict.reasons.some((r) => r !== 'no_company_mail' && r !== 'company_unverified') || taken || !company) {
          await toReview('claim_recheck')
          return { ok: true, status: 'approved' }
        }
        await createAccount(tx, reg, reg.counterparty_id)
        await send(tx, reg.email, MAIL.active(loginLink))
        for (const address of addresses.slice(0, o.maxClaimAddresses)) await send(tx, address, MAIL.claimApproved(reg.email, company.name, company.inn))
        if (notifyEmail) await send(tx, notifyEmail, MAIL.claimApproved(reg.email, company.name, company.inn))
        return { ok: true, status: 'approved' }
      })
    } catch (err) {
      if (isUniqueViolation(err)) return fail('invalidToken')
      throw err
    }
  }

  // ── Восстановление пароля: только учётки, заведённые регистрацией ────────────────────────────────
  // Сотрудникам и подрядчикам от администратора пароль выдаёт администратор, как раньше: почта не открывает их учётки.
  async function forgot({ email }) {
    const address = String(email ?? '').trim()
    if (emailProblem(address)) return { ok: true }
    await db.write(null, async (tx) => {
      await tx.mark('internal')
      const user = (await tx.query(`select u.id, u.email from auth.users u
          join public.user_roles r on r.user_id = u.id
          where osp_private.email_norm(u.email) = osp_private.email_norm($1)
            and r.self_registered and r.is_approved and not r.is_blocked`, [address])).rows[0]
      if (!user) return
      await tx.mark('auth')
      const recent = (await tx.query(`select count(*)::int as n from osp_auth.password_resets
        where user_id = $1 and created_at > now() - interval '1 day'`, [user.id])).rows[0].n
      if (recent >= o.dailyResetsPerUser) return
      const token = newToken()
      await tx.query(`insert into osp_auth.password_resets (token_hash, user_id, expires_at)
          values ($1, $2, now() + make_interval(hours => $3))`, [tokenHash(token), user.id, o.resetTtlHours])
      await event(tx, user.id, 'password_reset_requested', {})
      await send(tx, user.email, MAIL.reset(link(`/partner/reset#t=${token}`)))
    })
    return { ok: true }
  }

  // → { ok: true } | invalidToken | { ok: false, status: 400, field: 'password', … }
  async function resetPassword({ token, newPassword }) {
    const hash = tokenHash(token)
    const found = await db.read(null, async (tx) => {
      await tx.mark('auth')
      const row = (await tx.query(`select user_id from osp_auth.password_resets
          where token_hash = $1 and used_at is null and expires_at > now()`, [hash])).rows[0]
      if (!row) return null
      await tx.mark('internal')
      return (await tx.query(`select u.id, u.email, r.full_name from auth.users u
          join public.user_roles r on r.user_id = u.id where u.id = $1 and r.self_registered and not r.is_blocked`, [row.user_id])).rows[0] || null
    })
    if (!found) return fail('invalidToken')
    const problem = checkNewPassword(newPassword, { email: found.email, fullName: found.full_name }, blocklist)
    if (problem) return { ok: false, status: 400, code: 'OSP_SIGNUP_FIELD', field: 'password', message: problem.message }
    let next
    try {
      next = await newHash(newPassword)
    } catch (err) {
      if (err?.code === 'OSP_AUTH_BUSY') return fail('busy')
      throw err
    }
    const secret = box.encrypt(next, found.id)
    return db.write(null, async (tx) => {
      await tx.mark('auth')
      const used = await tx.query(`update osp_auth.password_resets set used_at = now()
          where token_hash = $1 and used_at is null and expires_at > now() returning user_id`, [hash])
      if (!used.rows.length) return fail('invalidToken')
      await tx.query(`update osp_auth.password_resets set used_at = now() where user_id = $1 and used_at is null`, [found.id])
      await tx.query(`update osp_auth.credentials set secret = $2, algo = 'scrypt', source = 'own', must_change = false,
          version = version + 1, changed_at = now() where user_id = $1`, [found.id, secret])
      await tx.query('delete from osp_auth.login_failures where email_norm = osp_private.email_norm($1)', [found.email])
      await event(tx, found.id, 'password_reset', {})
      await send(tx, found.email, MAIL.passwordChanged(loginLink))
      await tx.mark('internal')
      await sessions.revokeAllInTx(tx, found.id, 'password_reset')
      return { ok: true }
    })
  }

  // ── Администратор ────────────────────────────────────────────────────────────────────────────────
  const ADMIN_COLUMNS = `id, email, company_name, inn, kpp, contact_name, phone, status, counterparty_id, reasons, ip, claim_sent_to,
    created_at, confirmed_at, decided_at, decided_by, claim_expires_at`

  // Заявки, по которым почта подтверждена, — без отпечатков и ссылок.
  async function adminList({ status = null, before = null, limit = 100 } = {}) {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const max = Math.min(Math.max(Number(limit) || 100, 1), 200)
      const { rows } = await tx.query(`select ${ADMIN_COLUMNS} from osp_auth.registrations
        where status <> 'superseded' and status <> 'pending'
          and ($1::text is null or status = $1) and ($2::timestamptz is null or created_at < $2)
        order by created_at desc limit $3`, [status, before, max + 1])
      await tx.mark('internal')
      const ids = [...new Set(rows.map((r) => r.counterparty_id).filter(Boolean))]
      const names = ids.length ? (await tx.query('select id, name from public.counterparties where id = any($1::uuid[])', [ids])).rows : []
      const byId = new Map(names.map((n) => [n.id, n.name]))
      return {
        hasMore: rows.length > max,
        items: rows.slice(0, max).map((r) => ({ ...r, counterparty_name: byId.get(r.counterparty_id) ?? null })),
      }
    })
  }

  // decision: 'approve' | 'refuse'. Компанию в ЧС одобрить нельзя: сначала снять статус (это решение видно в журнале контрагента).
  async function adminDecide({ id, decision, actorId }) {
    try {
      return await db.write(null, async (tx) => {
        await tx.mark('auth')
        const reg = (await tx.query('select * from osp_auth.registrations where id = $1 for update', [id])).rows[0]
        if (!reg) return { ok: false, status: 404, code: 'OSP_SIGNUP_NOT_FOUND', message: 'Заявка не найдена — обновите список' }
        if (!['review', 'claim'].includes(reg.status) || !reg.secret) {
          return { ok: false, status: 409, code: 'OSP_SIGNUP_STATE', message: 'По этой заявке решение уже принято' }
        }
        if (decision !== 'approve') {
          await tx.query(`update osp_auth.registrations set status = 'refused', secret = null, claim_token_hash = null,
              claim_expires_at = null, decided_at = now(), decided_by = $2 where id = $1`, [id, actorId])
          await send(tx, reg.email, MAIL.refused())
          return { ok: true, status: 'refused' }
        }
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`osp:signup-inn:${reg.inn}`])
        await tx.mark('internal')
        if ((await tx.query('select 1 from auth.users where osp_private.email_norm(email) = $1', [reg.email_norm])).rows.length) {
          return { ok: false, status: 409, code: 'email_taken', message: 'Учётная запись с такой почтой уже есть' }
        }
        const { rows: same } = await tx.query(`select c.id, c.status::text as status, c.deleted_at from public.counterparties c
            where ${SAME_INN} order by c.updated_at desc nulls last, c.id for share`, [reg.inn])
        if (same.some((c) => c.status === 'blacklist')) {
          return { ok: false, status: 409, code: 'OSP_SIGNUP_BLACKLISTED', message: 'Компания в чёрном списке: сначала снимите статус в реестре контрагентов' }
        }
        const live = same.filter((c) => !c.deleted_at)
        const company = live.find((c) => c.id === reg.counterparty_id)?.id ?? live[0]?.id ?? await createCompany(tx, reg)
        await createAccount(tx, reg, company, actorId)
        await send(tx, reg.email, MAIL.active(loginLink))
        return { ok: true, status: 'active' }
      })
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, status: 409, code: 'email_taken', message: 'Учётная запись с такой почтой уже есть' }
      throw err
    }
  }

  // ── Очистка ──────────────────────────────────────────────────────────────────────────────────────
  // Подтверждение с почты компании не пришло за срок — решает администратор. Незавершённые заявки и использованные ссылки —
  // через 7 дней, остальные заявки (в них персональные данные и адрес) — через 180 дней, как журнал входа.
  async function cleanup() {
    return db.write(null, async (tx) => {
      const { rows } = await tx.query('select pg_try_advisory_xact_lock(hashtext($1)) as ok', ['osp:signup-cleanup'])
      if (!rows[0].ok) return null
      await tx.mark('auth')
      const expired = await tx.query(`update osp_auth.registrations set status = 'review', reasons = array_append(reasons, 'claim_expired'),
          claim_token_hash = null, claim_expires_at = null where status = 'claim' and claim_expires_at < now()`)
      const gone = await tx.query(`delete from osp_auth.registrations where
          (status in ('pending', 'superseded') and created_at < now() - interval '7 days')
          or (status in ('active', 'refused', 'review') and created_at < now() - interval '180 days')`)
      const resets = await tx.query(`delete from osp_auth.password_resets where coalesce(used_at, expires_at) < now() - interval '7 days'`)
      return { expired: expired.rowCount, registrations: gone.rowCount, resets: resets.rowCount }
    })
  }

  return { register, preview, confirm, decideClaim, forgot, resetPassword, adminList, adminDecide, cleanup }
}
