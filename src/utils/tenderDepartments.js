// Направления раздела «Тендеры» — единый источник правды для страницы-хаба,
// маршрутов и самой TendersPage.
//
// Принадлежность тендера направлению хранится в tenders.department (миграция
// 20260820). Раньше она вычислялась из objects.status; для «совместных» и
// «прочих» так уже не получится — объект там либо любой, либо его нет вовсе.
//
// objectStatus — какие объекты доступны в форме создания:
//   строка → только объекты этого статуса;
//   null   → объекты обоих отделов (в выпадающем списке помечаем бейджем ОС/ГО).
// requireObject — обязателен ли объект в форме.
// allowCustomObject — можно ли вписать наименование объекта вручную, минуя
//   реестр объектов (миграция 20260825).
// tone — ключ цветового тона плитки-иконки (см. IconTile.css).
export const TENDER_DEPARTMENTS = [
  {
    key: 'construction',
    label: 'Основное строительство',
    title: 'Тендеры — Основное строительство',
    desc: 'Тендеры по основным строительно-монтажным работам',
    objectStatus: 'main_construction',
    requireObject: true,
    tone: 'sky',
  },
  {
    key: 'warranty',
    label: 'Гарантийный отдел',
    title: 'Тендеры — Гарантийный отдел',
    desc: 'Тендеры по гарантийному обслуживанию сданных объектов',
    objectStatus: 'warranty_service',
    requireObject: true,
    tone: 'green',
  },
  {
    key: 'joint',
    label: 'Совместные тендеры',
    title: 'Тендеры — Совместные',
    desc: 'Тендеры с Заказчиком/Застройщиком',
    objectStatus: null,
    requireObject: true,
    tone: 'violet',
  },
  {
    key: 'other',
    label: 'Тендеры (прочее)',
    title: 'Тендеры — Прочее',
    desc: 'Закупки и работы без привязки к конкретному объекту',
    objectStatus: null,
    requireObject: false,
    // Единственное направление, где объекта в реестре может не быть вовсе —
    // разовый подрядчик, общехозяйственная закупка, офис.
    allowCustomObject: true,
    tone: 'slate',
  },
]

const BY_KEY = Object.fromEntries(TENDER_DEPARTMENTS.map(d => [d.key, d]))

// Неизвестный ключ (старая ссылка, опечатка в маршруте) не должен ронять
// страницу — отдаём основное строительство.
export function departmentConfig(key) {
  return BY_KEY[key] || BY_KEY.construction
}

// Наименование объекта тендера для показа и поиска. У направления «прочее»
// объекта в реестре может не быть — тогда берём вписанное вручную имя.
// fallback возвращается, когда не указано ни то, ни другое.
export function tenderObjectName(tender, fallback = '—') {
  return tender?.objects?.name || tender?.custom_object_name || fallback
}

// Короткий бейдж отдела объекта для выпадающих списков «все объекты».
export function objectDeptBadge(status) {
  if (status === 'main_construction') return 'ОС'
  if (status === 'warranty_service') return 'ГО'
  return ''
}
