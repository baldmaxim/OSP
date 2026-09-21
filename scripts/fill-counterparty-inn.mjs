#!/usr/bin/env node
// Разовое заполнение пустых ИНН у существующих контрагентов (counterparties.inn).
//
// Что делает и чего НЕ делает:
//  • обновляет ТОЛЬКО пустой ИНН (NULL, '' или строка из пробелов);
//  • совпадение ищет по точному названию после trim; регистр/кавычки — только
//    вторым проходом и только если кандидат один;
//  • при нескольких кандидатах, при уже заполненном другом ИНН и при отсутствии
//    карточки запись пропускается с причиной (см. отчёт);
//  • карточки не создаёт, не удаляет, не объединяет; другие поля не трогает;
//  • ИНН пишет строкой (ведущие нули сохраняются: 0276088789);
//  • по умолчанию — сухой прогон. Запись только с флагом --apply.
//
// Запуск (из корня репозитория, где лежит .env):
//   node scripts/fill-counterparty-inn.mjs            # сухой прогон, ничего не пишет
//   node scripts/fill-counterparty-inn.mjs --apply    # запись в базу
//
// Доступ (одно из двух, берётся из .env или из окружения):
//   SUPABASE_SERVICE_ROLE_KEY  — сервисный ключ (обходит RLS), плюс VITE_SUPABASE_URL;
//   либо VITE_SUPABASE_ANON_KEY + SUPABASE_EMAIL + SUPABASE_PASSWORD —
//   вход под своей учётной записью портала (RLS: политика для authenticated).
// Ключи не печатаются и в отчёт не попадают.
//
// Артефакты (создаются рядом, в scripts/out/):
//   snapshot-<метка>.json — снимок затрагиваемых записей ДО изменения;
//   report-<метка>.json / report-<метка>.csv — отчёт по каждой строке.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(HERE, 'out')
const APPLY = process.argv.includes('--apply')

// ── Данные для внесения ─────────────────────────────────────────────────────
// name — как в выгрузке портала; inn — строкой.
const UPDATES = [
  { name: 'ООО "СТРОЙИНВЕСТ"', inn: '7716986926' },
  { name: 'АО "ТопРендж"', inn: '7704025036' },
  { name: 'Астро-лифт', inn: '0276088789' },
  { name: 'БК Глобус', inn: '5001148873' },
  { name: 'ДСК Профстрой', inn: '7720378790' },
  { name: 'Империя', inn: '9701146276' },
  { name: 'Интеллект Обслуживание', inn: '7722465946' },
  { name: 'ИП "Гаджиев"', inn: '370606654100' },
  { name: 'ИП "Лихолитов"', inn: '771311712158' },
  { name: 'ИП "Порунов"', inn: '524310784550' },
  { name: 'ИП "Соловьева"', inn: '645109889300' },
  { name: 'ИП "Хэлл"', inn: '270414747284' },
  { name: 'ИП Ганичев', inn: '292501781094' },
  { name: 'Корона Лифт', inn: '7725275319' },
  { name: 'МеталлАлмазСтрой', inn: '7720965005' },
  { name: 'ООО "АДМ СТРОЙ"', inn: '9723012117' },
  { name: 'ООО "Адм-Строй"', inn: '9723012117' },
  { name: 'ООО "Азимут ВСК"', inn: '5005065184' },
  { name: 'ООО "Алюспейс"', inn: '5047145219' },
  { name: 'ООО "Атриум"', inn: '7725496212' },
  { name: 'ООО "ВЕКТОР-СТРОЙ 26"', inn: '5047326617' },
  { name: 'ООО “ВОКСЭМ”', inn: '9726043106' },
  { name: 'ООО "Гранд Строй Мир"', inn: '7725476304' },
  { name: 'ООО "Интегрированное Комплексное Строительство"', inn: '9724214130' },
  { name: 'ООО "ИНТЕЛ МУЗ"', inn: '9710154629' },
  { name: 'ООО "Инфотрейд"', inn: '7730176190' },
  { name: 'ООО "КД Дельта"', inn: '9705046530' },
  { name: 'ООО "Кросс-ГРУПП"', inn: '9701157694' },
  { name: 'ООО "ЛЭНДМЭН"', inn: '9701309114' },
  { name: 'ООО "Омен Групп"', inn: '9721174031' },
  { name: 'ООО "РСК (РСД)"', inn: '5047197930' },
  { name: 'ООО "Техстронг" (ТС Инжиниринг)', inn: '7716890075' },
  { name: 'ООО "ТОНОЗ"', inn: '9729384746' },
  { name: 'ООО "Фасадные системы"', inn: '7703443104' },
  { name: 'ООО "ЭСКО"', inn: '3123301684' },
  {
    name: 'ООО «АТС ГРУПП»',
    inn: '9701097212',
    match: {
      contact_name: 'Агафонов Дмитрий Анатольевич',
      phone: '+7(495)649-09-63',
      email: 'office@atsgroup.pro',
      work_type: 'ВИС',
    },
  },
  { name: 'ООО «ПартнерЦентр»', inn: '7713743869' },
  { name: 'ООО «Спецпорт „Надежда“», Москва', inn: '7726448317' },
  { name: 'ООО «ТехСтройГарант»', inn: '9704140307' },
  {
    name: 'ООО ГК РВ Инжиниринг',
    inn: '7708801138',
    match: {
      contact_name: 'Андреев Алексей Владимирович',
      phone: '+7(903)759-04-15',
      email: 'olec91@list.ru',
      work_type: 'Водомерный узел, Кондиционирование, ВИС',
    },
  },
  { name: 'ООО ЛТМ', inn: '6678002550' },
  { name: 'ООО ТетраГрупп', inn: '7727362341' },
  { name: 'ООО Фаст-Групп', inn: '9727113518' },
  { name: 'ПАО "МГТС"', inn: '7710016640' },
  { name: 'Промальянс', inn: '5048026687' },
  { name: 'ПромАтомСтрой', inn: '9717186066' },
  { name: 'Профистрой', inn: '9701191600' },
  { name: 'ПЭМ-ЭНЕРГО', inn: '7743190837' },
  { name: 'СК Стройсервис', inn: '9728074050' },
  { name: 'Спектрарстрой', inn: '9715000245' },
  { name: 'ТехСтройГарант', inn: '9704140307' },
  { name: 'ФСК Инжиниринг', inn: '7725494913' },
  { name: 'ЭМДМ-строй', inn: '7720961314' },
  { name: 'QWENT / ООО «ИНЖСИСТЕМС»', inn: '9724214532' },
]

// Только на ручное решение: в выгрузке две одинаковые карточки — автоматически
// по одному названию не обновляем, в отчёт выводим реальные id обеих.
const MANUAL_REVIEW = [
  { name: 'ООО "3М Групп"', inn: '7730263252', reason: 'Две одинаковые карточки в выгрузке — решение по ним принимает человек' },
]

// ── Чтение .env (как в проекте: один файл в корне репозитория) ──────────────
function loadEnv() {
  const file = path.join(ROOT, '.env')
  const env = { ...process.env }
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      let value = m[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (!(m[1] in env)) env[m[1]] = value
    }
  }
  return env
}

// ── Нормализация названий ───────────────────────────────────────────────────
const trim = (s) => String(s ?? '').trim()
// Вторичный поиск: регистр, кавычки любого вида, неразрывные пробелы, повторные пробелы.
const norm = (s) => trim(s)
  .replace(/[«»„“”"'‘’]/g, '"')
  .replace(/[\u00A0\u2007\u202F]/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase()
const digits = (s) => String(s ?? '').replace(/\D/g, '')
const isEmptyInn = (v) => v === null || v === undefined || trim(v) === ''
// Валидация проекта: поле inn — VARCHAR(12), в форме maxLength 12. Принимаем
// 10 или 12 цифр (ЮЛ / ИП); остальное не «исправляем», а пропускаем.
const validInn = (v) => /^\d{10}$|^\d{12}$/.test(v)

// ── Разбор: кого обновляем, кого пропускаем (чистая функция — её же гоняет --selftest) ──
export function plan(live, all, contactsByCp, updates, manualReview, apply) {
  const byExact = new Map()
  const byNorm = new Map()
  for (const cp of live) {
    const e = trim(cp.name), n = norm(cp.name)
    byExact.set(e, [...(byExact.get(e) || []), cp])
    byNorm.set(n, [...(byNorm.get(n) || []), cp])
  }
  const deletedByNorm = new Map()
  for (const cp of all.filter(c => c.deleted_at)) {
    const n = norm(cp.name)
    deletedByNorm.set(n, [...(deletedByNorm.get(n) || []), cp])
  }

  const matchesBlock = (cp, m) => {
    const list = contactsByCp.get(cp.id) || []
    const hits = []
    if (m.work_type && trim(cp.work_type) && norm(cp.work_type) === norm(m.work_type)) hits.push('work_type')
    if (m.contact_name && list.some(c => norm(c.full_name) === norm(m.contact_name))) hits.push('contact_name')
    if (m.phone && list.some(c => digits(c.phone) && digits(c.phone) === digits(m.phone))) hits.push('phone')
    if (m.email && list.some(c => norm(c.email) === norm(m.email))) hits.push('email')
    return hits
  }

  const rows = []
  const planned = []
  for (const upd of updates) {
    const name = trim(upd.name)
    const inn = trim(upd.inn)
    const base = { id: '', name: upd.name, old_inn: '', new_inn: inn, status: '', reason: '' }

    if (!validInn(inn)) {
      rows.push({ ...base, status: 'rejected', reason: 'ИНН не 10 и не 12 цифр — значение не исправляем' })
      continue
    }

    let candidates = byExact.get(name) || []
    let how = 'точное название'
    if (candidates.length === 0) {
      candidates = byNorm.get(norm(name)) || []
      how = 'название без учёта регистра и кавычек'
    }
    if (candidates.length === 0) {
      const del = deletedByNorm.get(norm(name)) || []
      rows.push({
        ...base,
        status: 'not_found',
        reason: del.length
          ? `активной карточки нет; есть удалённая (id ${del.map(d => d.id).join(', ')}) — восстановление вне этой задачи`
          : 'карточка с таким названием не найдена',
      })
      continue
    }
    if (candidates.length > 1 && upd.match) {
      const scored = candidates.map(cp => ({ cp, hits: matchesBlock(cp, upd.match) }))
      const best = scored.filter(x => x.hits.length > 0).sort((a, b) => b.hits.length - a.hits.length)
      if (best.length === 1 || (best.length > 1 && best[0].hits.length > best[1].hits.length)) {
        candidates = [best[0].cp]
        how = `название + сверка (${best[0].hits.join(', ')})`
      }
    }
    if (candidates.length > 1) {
      rows.push({
        ...base,
        id: candidates.map(c => c.id).join(' | '),
        status: 'ambiguous',
        reason: `подходит ${candidates.length} карточки — однозначно определить нельзя, нужна ручная проверка`,
      })
      continue
    }

    const cp = candidates[0]
    const row = { ...base, id: cp.id, name: cp.name, old_inn: cp.inn ?? '' }
    if (!isEmptyInn(cp.inn) && trim(cp.inn) === inn) {
      rows.push({ ...row, status: 'already', reason: 'такой же ИНН уже указан' })
      continue
    }
    if (!isEmptyInn(cp.inn)) {
      rows.push({ ...row, status: 'conflict', reason: `в базе другой ИНН (${trim(cp.inn)}) — не перезаписываем` })
      continue
    }
    rows.push({ ...row, status: apply ? 'to_update' : 'would_update', reason: how })
    planned.push({ cp, inn })
  }

  for (const mr of manualReview) {
    const found = byExact.get(trim(mr.name)) || byNorm.get(norm(mr.name)) || []
    rows.push({
      id: found.map(c => `${c.id} (ИНН ${c.inn ?? '—'})`).join(' | '),
      name: mr.name,
      old_inn: found.map(c => c.inn ?? '').join(' | '),
      new_inn: mr.inn,
      status: 'manual_review',
      reason: `${mr.reason}; найдено карточек: ${found.length}`,
    })
  }

  return { rows, planned }
}

// ── Самопроверка правил без базы: node scripts/fill-counterparty-inn.mjs --selftest ──
function selftest() {
  const cards = [
    { id: 'c1', name: '  Астро-лифт ', inn: null, deleted_at: null },                      // пустой → обновить
    { id: 'c2', name: 'БК Глобус', inn: '   ', deleted_at: null },                          // пробелы → обновить
    { id: 'c3', name: 'Империя', inn: '9701146276', deleted_at: null },                     // тот же → already
    { id: 'c4', name: 'Профистрой', inn: '7700000000', deleted_at: null },                  // другой → conflict
    { id: 'c5', name: 'ооо «воксэм»', inn: '', deleted_at: null },                          // регистр/кавычки
    { id: 'c6', name: 'ООО «АТС ГРУПП»', inn: null, deleted_at: null, work_type: 'ВИС' },   // дубль, решает match
    { id: 'c7', name: 'ООО «АТС ГРУПП»', inn: null, deleted_at: null, work_type: 'Кровля' },
    { id: 'c8', name: 'Корона Лифт', inn: null, deleted_at: null },
    { id: 'c9', name: 'Корона Лифт', inn: null, deleted_at: null },                         // дубль без match → ambiguous
    { id: 'c10', name: 'ООО ЛТМ', inn: null, deleted_at: '2026-01-01' },                    // только удалённая
    { id: 'c11', name: 'ООО "3М Групп"', inn: null, deleted_at: null },
    { id: 'c12', name: 'ООО "3М Групп"', inn: null, deleted_at: null },
  ]
  const contacts = new Map([['c6', [{ full_name: 'Агафонов Дмитрий Анатольевич', phone: '+7 (495) 649-09-63', email: 'OFFICE@atsgroup.pro' }]]])
  const updates = [
    { name: 'Астро-лифт', inn: '0276088789' },
    { name: 'БК Глобус', inn: '5001148873' },
    { name: 'Империя', inn: '9701146276' },
    { name: 'Профистрой', inn: '9701191600' },
    { name: 'ООО “ВОКСЭМ”', inn: '9726043106' },
    { name: 'ООО «АТС ГРУПП»', inn: '9701097212', match: { contact_name: 'Агафонов Дмитрий Анатольевич', phone: '+7(495)649-09-63', email: 'office@atsgroup.pro', work_type: 'ВИС' } },
    { name: 'Корона Лифт', inn: '7725275319' },
    { name: 'ООО ЛТМ', inn: '6678002550' },
    { name: 'Нет такой карточки', inn: '7700000001' },
    { name: 'Астро-лифт', inn: '12345' },
  ]
  const live = cards.filter(c => !c.deleted_at)
  const { rows, planned } = plan(live, cards, contacts, updates, [{ name: 'ООО "3М Групп"', inn: '7730263252', reason: 'дубль' }], false)

  const expect = [
    ['Астро-лифт', 'would_update'], ['БК Глобус', 'would_update'], ['Империя', 'already'],
    ['Профистрой', 'conflict'], ['ООО “ВОКСЭМ”', 'would_update'], ['ООО «АТС ГРУПП»', 'would_update'],
    ['Корона Лифт', 'ambiguous'], ['ООО ЛТМ', 'not_found'], ['Нет такой карточки', 'not_found'],
    ['ООО "3М Групп"', 'manual_review'],
  ]
  let bad = 0
  for (const [nm, st] of expect) {
    const got = rows.find(r => r.name === nm || norm(r.name) === norm(nm))
    const ok = got && got.status === st
    if (!ok) bad++
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${nm} → ${got ? got.status : 'нет строки'} (ожидалось ${st})`)
  }
  const rejected = rows.filter(r => r.status === 'rejected').length
  console.log(`${rejected === 1 ? 'OK  ' : 'FAIL'} короткий ИНН отклонён: ${rejected}`)
  const atc = planned.find(p => p.cp.id === 'c6')
  console.log(`${atc ? 'OK  ' : 'FAIL'} дубль «АТС ГРУПП» разведён по сверке контакта: ${atc ? atc.cp.id : '—'}`)
  const zeros = planned.find(p => p.cp.id === 'c1')
  console.log(`${zeros && zeros.inn === '0276088789' ? 'OK  ' : 'FAIL'} ведущий ноль сохранён: ${zeros && zeros.inn}`)
  if (bad || rejected !== 1 || !atc) process.exitCode = 1
}

async function main() {
  const env = loadEnv()
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY
  const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
  if (!url) throw new Error('Не задан VITE_SUPABASE_URL (.env в корне репозитория)')
  if (!serviceKey && !anonKey) throw new Error('Нужен SUPABASE_SERVICE_ROLE_KEY либо VITE_SUPABASE_ANON_KEY')

  const supabase = createClient(url, serviceKey || anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let actor = serviceKey ? 'service_role' : null
  if (!serviceKey) {
    const email = env.SUPABASE_EMAIL
    const password = env.SUPABASE_PASSWORD
    if (!email || !password) {
      throw new Error('Без сервисного ключа нужны SUPABASE_EMAIL и SUPABASE_PASSWORD (вход под учётной записью портала)')
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error('Вход не выполнен: ' + error.message)
    actor = data.user?.email || 'authenticated'
  }
  // Проект показываем по ссылке без ключей — чтобы в отчёте было видно окружение.
  const host = new URL(url).host
  console.log(`База: ${host} · доступ: ${serviceKey ? 'service_role' : 'вход как ' + actor} · режим: ${APPLY ? 'ЗАПИСЬ' : 'сухой прогон'}`)

  // ── Читаем справочник целиком (в базе >1000 строк — обязательна пагинация) ──
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('counterparties')
      .select('id, name, inn, work_type, status, deleted_at')
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error('Чтение counterparties: ' + error.message)
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  const live = all.filter(c => !c.deleted_at)
  console.log(`Карточек в базе: ${all.length} (активных ${live.length}, удалённых ${all.length - live.length})`)

  // Контакты нужны только для строк с блоком match.
  const needContacts = UPDATES.some(u => u.match)
  const contactsByCp = new Map()
  if (needContacts) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('counterparty_contacts')
        .select('counterparty_id, full_name, phone, email')
        .range(from, from + PAGE - 1)
      if (error) throw new Error('Чтение counterparty_contacts: ' + error.message)
      for (const row of data || []) {
        const arr = contactsByCp.get(row.counterparty_id) || []
        arr.push(row)
        contactsByCp.set(row.counterparty_id, arr)
      }
      if (!data || data.length < PAGE) break
    }
  }

  // ── Индексы поиска ──────────────────────────────────────────────────────────
  const byExact = new Map()
  const byNorm = new Map()
  for (const cp of live) {
    const e = trim(cp.name), n = norm(cp.name)
    byExact.set(e, [...(byExact.get(e) || []), cp])
    byNorm.set(n, [...(byNorm.get(n) || []), cp])
  }
  const deletedByNorm = new Map()
  for (const cp of all.filter(c => c.deleted_at)) {
    const n = norm(cp.name)
    deletedByNorm.set(n, [...(deletedByNorm.get(n) || []), cp])
  }

  const { rows, planned } = plan(live, all, contactsByCp, UPDATES, MANUAL_REVIEW, APPLY)

  // ── Снимок ДО изменения ─────────────────────────────────────────────────────
  fs.mkdirSync(OUT, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const snapshotIds = new Set([...planned.map(p => p.cp.id), ...rows.flatMap(r => String(r.id).split(/ \| /)).map(s => s.split(' ')[0]).filter(Boolean)])
  const snapshot = all.filter(c => snapshotIds.has(c.id))
  const snapshotFile = path.join(OUT, `snapshot-${stamp}.json`)
  fs.writeFileSync(snapshotFile, JSON.stringify({ base: host, taken_at: new Date().toISOString(), rows: snapshot }, null, 2), 'utf8')
  console.log(`Снимок до изменения: ${snapshotFile} (${snapshot.length} записей)`)

  // ── Запись ──────────────────────────────────────────────────────────────────
  if (APPLY) {
    for (const { cp, inn } of planned) {
      // Адресное обновление по id с условием «ИНН всё ещё пуст»: если кто-то
      // заполнил его параллельно, строка не вернётся и мы это увидим.
      let q = supabase.from('counterparties').update({ inn }).eq('id', cp.id)
      q = cp.inn === null ? q.is('inn', null) : q.eq('inn', cp.inn)
      const { data, error } = await q.select('id, name, inn')
      const row = rows.find(r => r.id === cp.id)
      if (error) {
        row.status = 'error'
        row.reason = error.message
        continue
      }
      if (!data || data.length === 0) {
        row.status = 'skipped_changed'
        row.reason = 'ИНН изменился между чтением и записью — не трогаем'
        continue
      }
      row.status = 'updated'
      row.new_inn = data[0].inn
      // История изменений — как в интерфейсе (сбой журнала не отменяет правку).
      const { error: logError } = await supabase.from('counterparty_audit_log').insert([{
        counterparty_id: cp.id,
        event_type: 'field_updated',
        field_name: 'inn',
        old_value: cp.inn ?? null,
        new_value: inn,
        description: `ИНН: ${isEmptyInn(cp.inn) ? 'не указан' : trim(cp.inn)} → ${inn}`,
        changed_by_role: 'script',
        changed_by_name: `Массовое заполнение ИНН (${actor})`,
      }])
      if (logError) console.warn(`История не записана для ${cp.id}: ${logError.message}`)
    }

    // ── Повторное чтение: проверяем, что сохранилось именно то ───────────────
    const ids = planned.map(p => p.cp.id)
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data, error } = await supabase.from('counterparties').select('id, name, inn').in('id', chunk)
      if (error) throw new Error('Повторное чтение: ' + error.message)
      for (const cur of data || []) {
        const row = rows.find(r => r.id === cur.id)
        const want = planned.find(p => p.cp.id === cur.id)?.inn
        if (row && row.status === 'updated' && trim(cur.inn) !== want) {
          row.status = 'verify_failed'
          row.reason = `после записи в базе «${cur.inn ?? '—'}», ожидалось «${want}»`
        }
      }
    }
  }

  // ── Отчёт ───────────────────────────────────────────────────────────────────
  const order = ['updated', 'would_update', 'already', 'conflict', 'ambiguous', 'not_found', 'manual_review', 'rejected', 'skipped_changed', 'verify_failed', 'error']
  rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name, 'ru'))
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = ['id,name,old_inn,new_inn,status,reason']
    .concat(rows.map(r => [r.id, r.name, r.old_inn, r.new_inn, r.status, r.reason].map(csvCell).join(',')))
    .join('\r\n')
  const reportJson = path.join(OUT, `report-${stamp}.json`)
  const reportCsv = path.join(OUT, `report-${stamp}.csv`)
  fs.writeFileSync(reportJson, JSON.stringify({ base: host, mode: APPLY ? 'apply' : 'dry-run', at: new Date().toISOString(), rows }, null, 2), 'utf8')
  fs.writeFileSync(reportCsv, '﻿' + csv, 'utf8')

  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
  console.log('\nИтог:')
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`)
  console.log(`\nОтчёт: ${reportCsv}\n        ${reportJson}`)
  if (!APPLY) console.log('\nЭто был сухой прогон. Для записи: node scripts/fill-counterparty-inn.mjs --apply')
}

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  main().catch((err) => {
    console.error('Сбой:', err.message)
    process.exitCode = 1
  })
}
