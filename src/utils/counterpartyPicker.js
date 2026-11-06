// Выбор контрагента в списке с поиском — форма заявки и фильтр «Заявок на проверку ДП/ДС» (06.11.2026, просьба
// пользователя: искать контрагента и по ИНН, и по закреплённому за ним номеру — «№» реестра контрагентов,
// counterparty_number). Что набрано:
//  • «№ 12» — ровно контрагент с постоянным номером 12;
//  • «ИНН 7708…» — только по ИНН;
//  • одни цифры («12», «7708203762») — контрагент с этим номером первым, затем те, у кого цифры есть в ИНН или названии
//    (в названиях бывают цифры: «СУ-10»);
//  • иначе — по названию и ИНН без учёта регистра, кавычек, пробелов и дефисов, слова в любом порядке — как поиск
//    реестра контрагентов (searchKey), но без опечаток и другой раскладки: список короткий, лишнее только мешает.
// Узел без браузера: его грузит node-тест, поэтому соседи — с «.js».
import { searchKey } from './counterpartySearch.js'
import { counterpartyTab } from './counterpartyFilters.js'

// Кого предлагать выбрать: как вкладка «Активные» реестра — действующие и «Малые суммы», без чёрного списка и удалённых.
export const isPickableCounterparty = (cp) => counterpartyTab(cp) === 'active'

// Опции списка: value — id, label — название (его же показывает выбранное значение), inn — цифры ИНН, no — постоянный номер.
// numbers — Map(id → номер) из counterpartyNumbers; нет — номер из строки, нет и его — без номера.
export function counterpartyPickerOptions(list, numbers = null) {
  return (list || []).map((cp) => {
    const inn = String(cp.inn ?? '').replace(/\D/g, '')
    return {
      value: cp.id,
      label: cp.name,
      inn,
      no: numbers?.get(cp.id) ?? cp.counterparty_number ?? null,
      text: [searchKey(cp.name), inn].filter(Boolean).join('\n'),
    }
  })
}

// Подпись под названием в списке: «№ 12 · ИНН 7708203762».
export function counterpartyOptionMeta(option) {
  return [option.no != null && `№ ${option.no}`, option.inn && `ИНН ${option.inn}`].filter(Boolean).join(' · ')
}

// Поиск по опциям counterpartyPickerOptions; порядок сохраняется, кроме контрагента с набранным номером — он первый.
export function filterCounterpartyOptions(options, query) {
  const q = String(query ?? '').trim()
  if (!q) return options
  const numbered = /^№\s*(\d+)$/.exec(q)
  if (numbered) {
    const no = Number(numbered[1])
    return options.filter((o) => o.no === no)
  }
  const byInn = /^инн\s*[:№]?\s*([\d\s]+)$/i.exec(q)
  if (byInn) {
    const digits = byInn[1].replace(/\s+/g, '')
    return options.filter((o) => o.inn.includes(digits))
  }
  const whole = searchKey(q)
  if (!whole) return options
  if (/^[\d\s]+$/.test(q)) {
    const no = Number(whole)
    const exact = options.filter((o) => o.no === no)
    return [...exact, ...options.filter((o) => o.no !== no && o.text.includes(whole))]
  }
  const words = q.split(/\s+/).map(searchKey).filter(Boolean)
  return options.filter((o) => o.text.includes(whole) || (words.length > 1 && words.every((w) => o.text.includes(w))))
}
