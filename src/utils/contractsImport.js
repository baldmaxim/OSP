// Логика импорта договоров (ДП) из Excel: парсинг, нормализация, валидация.
// Чистые функции без React — используются в ContractsImportModal.
// Импорт создаёт ТОЛЬКО ДП тем же payload-ом, что и ручная форма (handleSubmit).
import * as XLSX from 'xlsx'

// --- Канонические колонки шаблона (ровно 29, порядок из ТЗ) ---
// key — внутреннее имя, header — заголовок в Excel-шаблоне.
export const IMPORT_COLUMNS = [
  { key: 'record_type', header: 'Тип' },
  { key: 'parent_display_id', header: 'ID основного договора (для ДС)' },
  { key: 'contract_number', header: '№ договора' },
  { key: 'contract_date', header: 'Дата договора' },
  { key: 'status', header: 'Статус' },
  { key: 'counterparty_name', header: 'Наименование контрагента' },
  { key: 'counterparty_inn', header: 'ИНН контрагента' },
  { key: 'gen_director_name', header: 'ФИО Ген.директора' },
  { key: 'phone', header: 'Телефон' },
  { key: 'email', header: 'Email' },
  { key: 'object_name', header: 'Объект работ' },
  { key: 'tender', header: 'Тендер (необязательно)' },
  { key: 'work_name', header: 'Наименование работ' },
  { key: 'lawyer', header: 'Ответственный юрист' },
  { key: 'contract_amount', header: 'Сумма по договору' },
  { key: 'currency', header: 'Валюта' },
  { key: 'vat_rate', header: 'Ставка НДС' },
  { key: 'amount_includes_vat', header: 'Хранение суммы' },
  { key: 'bsm', header: 'БСМ' },
  { key: 'warranty_retention_percent', header: 'Гарантийное удержание' },
  { key: 'warranty_retention_period', header: 'Срок гарантийных удержаний' },
  { key: 'work_start_date', header: 'Начало работ' },
  { key: 'work_end_date', header: 'Окончание работ' },
  { key: 'accepted_date', header: 'Дата принятия в работу ДП' },
  { key: 'signed_date', header: 'Дата подписания' },
  { key: 'warranty_period', header: 'Срок гарантии на работы' },
  { key: 'document_link', header: 'Ссылка на документ' },
  { key: 'notes', header: 'Примечание' },
  { key: 'comments', header: 'Комментарии' },
]

export const TEMPLATE_HEADERS = IMPORT_COLUMNS.map((c) => c.header)

// --- Нормализация текста ---
function nfold(s) {
  // Нижний регистр, ё→е, схлопывание любых пробелов (в т.ч. неразрывных — их
  // покрывает \s в JS), обрезка краёв.
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim()
}

// Нормализация заголовка: как nfold, но без пунктуации (№, точки, скобки и пр.).
function normHeader(s) {
  return nfold(s).replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim()
}

// Нормализация имени контрагента/объекта для сопоставления:
// убираем кавычки (обычные/типографские), схлопываем пробелы, ё→е, нижний регистр.
export function normMatchName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»""„"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ИНН: оставляем только цифры (точный ключ).
export function normInn(s) {
  return String(s == null ? '' : s).replace(/\D/g, '')
}

// --- Сопоставление заголовков с колонками файла ---
// Возвращает { colIndexByKey, matched } — индекс колонки в ФАЙЛЕ по каждому key.
// Если заголовки узнаваемы (совпало большинство) — по заголовкам, иначе позиционно.
export function mapHeaderRow(headerRow = []) {
  const fileNorms = headerRow.map((h) => normHeader(h))
  const byHeader = {}
  let matched = 0
  IMPORT_COLUMNS.forEach((col, canonicalIdx) => {
    const target = normHeader(col.header)
    const j = fileNorms.findIndex((h) => h && h === target)
    if (j >= 0) {
      byHeader[col.key] = j
      matched++
    } else {
      byHeader[col.key] = canonicalIdx // fallback: позиция по шаблону
    }
  })
  // Если по заголовкам почти ничего не совпало — считаем, что порядок стандартный.
  if (matched < Math.ceil(IMPORT_COLUMNS.length * 0.5)) {
    const positional = {}
    IMPORT_COLUMNS.forEach((col, i) => { positional[col.key] = i })
    return { colIndexByKey: positional, matched, positional: true }
  }
  return { colIndexByKey: byHeader, matched, positional: false }
}

// --- Дата ---
function daysInMonth(y, m) {
  return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}
function validYMD(y, m, d) {
  if (!(y >= 1900 && y <= 2100)) return false
  if (!(m >= 1 && m <= 12)) return false
  if (!(d >= 1 && d <= daysInMonth(y, m))) return false
  return true
}
function fmtYMD(y, m, d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}`
}

// parseDate → { value:'YYYY-MM-DD' } | { empty:true } | { error:true }
export function parseDate(v) {
  if (v == null || v === '') return { empty: true }
  // Excel-serial (число): используем разбор SheetJS, учитывающий баг 1900.
  if (typeof v === 'number') {
    const dc = XLSX.SSF && XLSX.SSF.parse_date_code ? XLSX.SSF.parse_date_code(v) : null
    if (dc && dc.y && validYMD(dc.y, dc.m, dc.d)) return { value: fmtYMD(dc.y, dc.m, dc.d) }
    return { error: true }
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { value: fmtYMD(v.getFullYear(), v.getMonth() + 1, v.getDate()) }
  }
  const s = String(v).trim()
  if (!s) return { empty: true }
  // ДД<sep>ММ<sep>ГГГГ, где sep ∈ . - / и допускаются пробелы вокруг.
  let m = s.match(/^(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{4})$/)
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3]
    return validYMD(y, mo, d) ? { value: fmtYMD(y, mo, d) } : { error: true }
  }
  // ГГГГ-ММ-ДД (ISO).
  m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/)
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3]
    return validYMD(y, mo, d) ? { value: fmtYMD(y, mo, d) } : { error: true }
  }
  return { error: true }
}

// --- Сумма ---
// Понимает Excel number и строки: "8 285 000,00", "8285000", "8 285 000.00".
export function parseAmount(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  let s = String(v).replace(/[₽$€¥£]/g, '').replace(/\s/g, '')
  if (!s) return null
  const hasComma = s.includes(','), hasDot = s.includes('.')
  if (hasComma && hasDot) s = s.replace(/,/g, '')      // запятая — разделитель тысяч
  else if (hasComma) s = s.replace(',', '.')           // запятая — десятичный разделитель
  s = s.replace(/[^\d.-]/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// --- Валюта --- (не выдумываем новую из-за другого написания)
export function normalizeCurrency(v) {
  const s = nfold(v).replace(/\./g, '')
  if (!s) return 'RUB'
  if (['р', 'руб', 'рубли', 'рубль', '₽', 'rub'].includes(s) || s.startsWith('руб')) return 'RUB'
  if (['¥', 'cny', 'юань', 'юани'].includes(s)) return 'CNY'
  if (['$', 'usd', 'доллар', 'долларов'].includes(s)) return 'USD'
  if (['€', 'eur', 'евро'].includes(s)) return 'EUR'
  const up = String(v).trim().toUpperCase()
  if (['RUB', 'CNY', 'USD', 'EUR'].includes(up)) return up
  return 'RUB'
}

// --- НДС --- → { value:number|null } | { error:true }
const VAT_ALLOWED = [0, 5, 7, 10, 20, 22]
export function normalizeVat(v) {
  if (v == null || v === '') return { value: null }
  const s = nfold(v)
  if (s.includes('без')) return { value: null } // «Без НДС»
  const num = parseFloat(String(v).replace('%', '').replace(',', '.').replace(/\s/g, ''))
  if (Number.isFinite(num) && VAT_ALLOWED.includes(num)) return { value: num }
  return { error: true }
}

// --- Хранение суммы --- «С НДС» → true, «Без НДС» → false, пусто → true.
export function normalizeAmountIncludesVat(v) {
  const s = nfold(v)
  if (!s) return true
  if (s.includes('без')) return false
  return true
}

// --- Гарантийное удержание --- процент; пусто/«-»/«нет» → null.
export function normalizeRetention(v) {
  if (v == null) return null
  const s = nfold(v)
  if (s === '' || s === '-' || s === '—' || s === 'нет' || s === 'н/д') return null
  const num = parseFloat(String(v).replace('%', '').replace(',', '.').replace(/\s/g, ''))
  if (Number.isFinite(num) && num >= 0 && num <= 100) return num
  return null
}

// --- Тип ДП/ДС --- → { value:'dp'|'ds' } | { error:true }
export function normalizeRecordType(v) {
  const n = nfold(v).replace(/\./g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n) return { error: true }
  const dsHit = n.startsWith('дс') || n.includes('доп согл') || n.includes('допсогл') || n.includes('дополнительн')
  const dpHit = n.startsWith('дп') || n.includes('подряд') || n.includes('основной договор') ||
    n.includes('осн договор') || n === 'договор'
  if (dsHit) return { value: 'ds' }        // ДС имеет приоритет (доп. соглашение к договору → ДС)
  if (dpHit) return { value: 'dp' }
  return { error: true }
}

// --- Статус --- → { value } | { error:true }; пусто → completed.
export function normalizeStatus(v) {
  const s = nfold(v)
  if (!s) return { value: 'completed' }
  if (s.includes('заявк') || s.includes('заключени')) return { value: 'new_request' }
  if (s.includes('приостанов')) return { value: 'paused' }
  // Проверяем до «заверш» и «в работ»: формулировка «ожидание подписания» может
  // соседствовать с ними в одной ячейке, а этот статус конкретнее.
  if (s.includes('подписан') && (s.includes('ожидан') || s.includes('бум'))) {
    return { value: 'awaiting_paper_sign' }
  }
  if (s.includes('заверш')) return { value: 'completed' }
  if (s.includes('в работ') || s === 'работа' || s.includes('в работе')) return { value: 'in_work' }
  return { error: true }
}

// --- Ссылка на документ --- (http/https или произвольный текст-ссылка; не ограничиваем GDrive)
export function parseDocumentLink(v) {
  const s = v == null ? '' : String(v).trim()
  return s || null
}

function textOrNull(v) {
  const s = v == null ? '' : String(v).trim()
  return s || null
}

// --- Валидация одной строки ---
// raw — объект { key: rawCellValue }; ctx — индексы справочников.
// Возвращает { kind, payload, errors:[{key,message}], warnings:[{type,label}], reason }.
export function validateRow(raw, ctx) {
  const errors = []
  const warnings = []

  // 1) Тип
  const typeRes = normalizeRecordType(raw.record_type)
  if (typeRes.error) {
    errors.push({ key: 'record_type', message: 'Тип: непонятное или пустое значение' })
  } else if (typeRes.value === 'ds') {
    // ДС не импортируем сейчас — вне зависимости от прочих полей.
    return {
      kind: 'ds_skip',
      payload: null,
      errors: [],
      warnings: [],
      reason: 'Импорт дополнительных соглашений будет реализован позже',
    }
  }

  // 2) Контрагент (ровно один, обязателен, не создаём)
  const inn = normInn(raw.counterparty_inn)
  const name = String(raw.counterparty_name == null ? '' : raw.counterparty_name).trim()
  const nameKey = normMatchName(name)
  let counterpartyId = null
  if (!inn && !name) {
    errors.push({ key: 'counterparty_name', message: 'Контрагент не указан' })
    errors.push({ key: 'counterparty_inn', message: 'ИНН не указан' })
  } else {
    const byInn = inn ? (ctx.cpByInn.get(inn) || []) : []
    const byName = nameKey ? (ctx.cpByName.get(nameKey) || []) : []
    if (inn) {
      if (byInn.length === 0) {
        errors.push({ key: 'counterparty_inn', message: 'Контрагент по ИНН не найден' })
      } else if (byInn.length > 1) {
        errors.push({ key: 'counterparty_inn', message: 'Найдено несколько контрагентов с таким ИНН' })
      } else {
        counterpartyId = byInn[0]
        // ИНН и название указывают на разных контрагентов → ошибка.
        if (byName.length === 1 && byName[0] !== counterpartyId) {
          counterpartyId = null
          errors.push({ key: 'counterparty_name', message: 'ИНН и название указывают на разных контрагентов' })
          errors.push({ key: 'counterparty_inn', message: 'ИНН и название указывают на разных контрагентов' })
        }
      }
    } else {
      // ИНН пуст — ищем по названию.
      if (byName.length === 0) {
        errors.push({ key: 'counterparty_name', message: 'Контрагент по названию не найден' })
      } else if (byName.length > 1) {
        errors.push({ key: 'counterparty_name', message: 'Найдено несколько контрагентов с таким названием' })
      } else {
        counterpartyId = byName[0]
      }
    }
  }

  // 3) Объект (обязателен, только существующий; оба отдела — ОС и ГО)
  const objName = String(raw.object_name == null ? '' : raw.object_name).trim()
  let objectId = null
  if (!objName) {
    errors.push({ key: 'object_name', message: 'Объект не указан' })
  } else {
    const byObj = ctx.objByName.get(normMatchName(objName)) || []
    if (byObj.length === 0) errors.push({ key: 'object_name', message: 'Объект не найден' })
    else if (byObj.length > 1) errors.push({ key: 'object_name', message: 'Найдено несколько объектов с таким названием' })
    else objectId = byObj[0]
  }

  // 4) Даты
  const dateFields = [
    ['contract_date', 'Дата договора'],
    ['work_start_date', 'Начало работ'],
    ['work_end_date', 'Окончание работ'],
    ['accepted_date', 'Дата принятия в работу'],
    ['signed_date', 'Дата подписания'],
  ]
  const dates = {}
  for (const [key, label] of dateFields) {
    const r = parseDate(raw[key])
    if (r.error) errors.push({ key, message: `${label}: неверная дата` })
    dates[key] = r.value || null
  }

  // 5) Статус
  const statusRes = normalizeStatus(raw.status)
  if (statusRes.error) errors.push({ key: 'status', message: 'Статус: непонятное значение' })

  // 6) НДС
  const vatRes = normalizeVat(raw.vat_rate)
  if (vatRes.error) errors.push({ key: 'vat_rate', message: 'Ставка НДС: неизвестное значение' })

  // 7) Предупреждения (не ошибки данных)
  const numberRaw = String(raw.contract_number == null ? '' : raw.contract_number).trim()
  const numberExists = numberRaw && ctx.existingNumbers.has(numberRaw)
  if (numberExists) warnings.push({ type: 'dup_number', label: 'Договор с таким № уже существует' })
  if (!numberRaw) warnings.push({ type: 'empty_number', label: 'Номер договора пустой' })
  if (!dates.contract_date && !errors.some((e) => e.key === 'contract_date')) {
    warnings.push({ type: 'empty_date', label: 'Дата договора пустая' })
  }

  // Классификация
  let kind
  if (errors.length > 0) kind = 'error'
  else if (warnings.length > 0) kind = 'warn'
  else kind = 'ready'

  let payload = null
  if (kind !== 'error') {
    payload = {
      record_type: 'dp',
      parent_contract_id: null,
      contract_number: numberRaw || null,
      contract_date: dates.contract_date,
      counterparty_id: counterpartyId,
      object_id: objectId,
      tender_id: null,                 // при импорте не привязываем
      responsible_contact_id: null,    // юриста не назначаем
      work_name: textOrNull(raw.work_name),
      contract_amount: parseAmount(raw.contract_amount),
      currency: normalizeCurrency(raw.currency),
      vat_rate: vatRes.value,
      amount_includes_vat: normalizeAmountIncludesVat(raw.amount_includes_vat),
      warranty_retention_percent: normalizeRetention(raw.warranty_retention_percent),
      warranty_retention_period: textOrNull(raw.warranty_retention_period),
      work_start_date: dates.work_start_date,
      work_end_date: dates.work_end_date,
      accepted_date: dates.accepted_date,
      signed_date: dates.signed_date,
      warranty_period: textOrNull(raw.warranty_period),
      document_link: parseDocumentLink(raw.document_link),
      status: statusRes.value,
      notes: textOrNull(raw.notes),
      gen_director_name: textOrNull(raw.gen_director_name),
      phone: textOrNull(raw.phone),
      email: textOrNull(raw.email),
      bsm: textOrNull(raw.bsm),
      comments: textOrNull(raw.comments),
    }
  }

  return { kind, payload, errors, warnings, reason: null }
}
