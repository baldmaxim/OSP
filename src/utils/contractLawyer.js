// «Ответственный юрист» договора и ДС в «Реестре по договорам» (миграция 20270226_registry_osp_lawyers, обе базы; решение
// пользователя 23.11.2026: «только юристов ОСП можно было назначать в реестре … в /contracts/registry есть заблокированные учётки и
// не юристы ОСП в юристах»).
//
// Юрист — учётка действующего юриста ОСП (contracts.responsible_user_id), то же правило, что у исполнителей доски ДП/ДС
// (docCheckHelpers.shownAssigneeIds): роль lawyer, учётка подтверждена. Список отдаёт функция list_osp_lawyers
// (services/employees.fetchOspLawyers) — только действующих юристов; заблокированных там нет (блокировка снимает подтверждение),
// поэтому уволенный юрист или сменивший роль сам пропадает из реестра, отчёта и выбора.
// Назначить другого не даст и база (триггер contracts_lawyer_guard). Прежнее поле — запись «Сотрудников» responsible_contact_id —
// осталось в базе нетронутым, страница его больше не показывает и не пишет.
import { ROLES } from '../contexts/roleConstants.js'

export const LAWYER_FIELD = 'responsible_user_id'
export const LAWYER_LABEL = 'Ответственный юрист'
export const CONTRACT_LAWYER_MIGRATION_HINT =
  'Ответственный юрист недоступен: в базе не применена миграция 20270226_registry_osp_lawyers.'

export const isOspLawyer = (employee) => employee?.role === ROLES.LAWYER

// Колонка есть, если её вернула выборка select('*') хотя бы у одного документа (как contractDivisionEnabled).
export const contractLawyerEnabled = (docs) => (docs || []).some(d => d && LAWYER_FIELD in d)

const employeeLabel = (e) => e?.display_name || e?.full_name || e?.email || ''

// Юрист документа, если он действующий юрист ОСП, иначе '' (в реестре — «—»).
export function shownLawyerId(doc, employees) {
  const id = doc?.[LAWYER_FIELD]
  return id && isOspLawyer(employees?.get(id)) ? id : ''
}

export function contractLawyerName(doc, employees) {
  const id = shownLawyerId(doc, employees)
  return id ? employeeLabel(employees.get(id)) : ''
}

// ФИО по id для «Истории» (не юрист / не найден — '').
export function lawyerNameById(employees, id) {
  return id && isOspLawyer(employees?.get(id)) ? employeeLabel(employees.get(id)) : ''
}

// Кого можно выбрать: действующие юристы ОСП по алфавиту.
export function lawyerOptions(employees) {
  return [...(employees?.values() || [])]
    .filter(isOspLawyer)
    .map(e => ({ value: e.user_id, label: employeeLabel(e) || 'Без имени' }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
}

// Отказ при записи юриста: колонки нет — называем миграцию; база не приняла не юриста — её текст.
export function contractLawyerSaveError(err) {
  const msg = String(err?.message || err || '')
  if ((err?.code === 'PGRST204' || err?.code === '42703') && /responsible_user_id/.test(msg)) return CONTRACT_LAWYER_MIGRATION_HINT
  return 'Ошибка: ' + msg
}

// ФИО для сравнения: без регистра, «ё» = «е», пробелы сжаты.
export function personKey(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е')
}

// Импорт из Excel: «Ответственный юрист» по ФИО — действующий юрист ОСП, совпавший полностью или началом по словам («Фамилия Имя»
// ↔ «Фамилия Имя Отчество»), как перенос прежних юристов в миграции. → { id } | { error }.
export function matchLawyerByName(name, employees) {
  const key = personKey(name)
  if (!key) return { id: null }
  const found = new Set()
  for (const e of employees?.values() || []) {
    if (!isOspLawyer(e)) continue
    const k = personKey(e.full_name || e.display_name)
    if (!k) continue
    if (k === key || k.startsWith(key + ' ') || key.startsWith(k + ' ')) found.add(e.user_id)
  }
  if (found.size === 1) return { id: [...found][0] }
  if (found.size > 1) return { error: 'Найдено несколько юристов ОСП с таким ФИО' }
  return { error: 'Не найден среди действующих юристов ОСП' }
}
