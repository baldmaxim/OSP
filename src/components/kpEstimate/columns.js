// Столбцы таблицы сметы КП / ПЗ: вид «КП» (укрупнённые позиции, коммерция) и вид «ПЗ» (прямые затраты и коммерция после
// коэффициентов). key — имя для заливки ячеек (kp_estimate_marks.cell_fills) и выгрузки; group — какие столбцы
// прячутся переключателями над таблицей; width — rem.
import { fmtMoney, fmtQty, isPosition, originalQty, unitPrice } from '../../utils/kpEstimate'

export const COLUMN_GROUPS = [
  { key: 'volume', label: 'Объёмы' },
  { key: 'money', label: 'Стоимость' },
  { key: 'dist', label: 'Распределение' },
  { key: 'work', label: 'Работа' },
]

const money = (v) => fmtMoney(v)
const kpVal = (key) => (row, ctx) => (isPosition(row) || row.kind === 'aggregate' ? row.kp?.[key] : ctx.sum?.[key])
const pzVal = (key, sumKey) => (row, ctx) => (row.pz ? row.pz[key] : (ctx.sum && !isPosition(row) ? ctx.sum[sumKey] : null))

const COMMON_HEAD = [
  { key: 'code', label: 'Код', width: 5.75, group: null, sticky: true },
  { key: 'name', label: 'Наименование', width: 21, group: null, sticky: true },
  { key: 'unit', label: 'Ед.', width: 3.5, group: 'volume', get: (row) => row.unit || '' },
]

const ORIGINAL = { key: 'qty_gp', label: 'Исходный объём', hint: 'Кол-во ГП из КП: по нему посчитана цена', width: 7, group: 'volume', num: true,
  get: (row) => (row.unit ? originalQty(row) : null), fmt: fmtQty }
const ACTUAL = [
  { key: 'actual', label: 'Актуальный объём', hint: 'Уточнённый экономистом; не задан — исходный. Нажмите в ячейке, чтобы изменить', width: 7.5, group: 'volume', num: true, editable: 'actual' },
  { key: 'diff', label: 'Разница', width: 6.5, group: 'volume', num: true },
]

const DIST = [
  { key: 'distributed', label: 'Распределено', hint: 'Взято в тендеры и закреплено договорами (одно и то же не дважды)', width: 7.5, group: 'dist', num: true },
  { key: 'free', label: 'Свободно', hint: 'Актуальный объём минус распределённый', width: 7.5, group: 'dist', num: true },
  { key: 'tenders', label: 'Тендеры (объём в ПЗ)', width: 10, group: 'dist' },
  { key: 'contractors', label: 'Подрядчики, договоры', width: 12, group: 'dist' },
]

const WORK = [
  { key: 'responsible', label: 'Ответственный', width: 9, group: 'work' },
  { key: 'note', label: 'Примечание', width: 14, group: 'work', editable: 'note' },
]

export const KP_COLUMNS = [
  ...COMMON_HEAD,
  { key: 'qty_customer', label: 'Кол-во заказчика', width: 7, group: 'volume', num: true,
    get: (row) => (row.unit ? (row.kp?.qty_customer ?? row.pz?.qty_customer) : null), fmt: fmtQty },
  ORIGINAL,
  { key: 'materials', label: 'Материалы, ₽', width: 8.5, group: 'money', num: true, get: kpVal('materials'), fmt: money },
  { key: 'works', label: 'Работы, ₽', width: 8.5, group: 'money', num: true, get: kpVal('works'), fmt: money },
  { key: 'total', label: 'Стоимость КП, ₽', width: 9, group: 'money', num: true, get: kpVal('total'), fmt: money, strong: true },
  { key: 'price', label: 'За ед., ₽', width: 7.5, group: 'money', num: true,
    get: (row) => (row.unit ? unitPrice(row) : null), fmt: money },
  ...ACTUAL,
  ...DIST,
  ...WORK,
]

export const PZ_COLUMNS = [
  ...COMMON_HEAD,
  ORIGINAL,
  { key: 'direct', label: 'Прямые затраты', width: 9, group: 'money', num: true, get: pzVal('direct', 'direct'), fmt: money, strong: true },
  { key: 'direct_main', label: 'Осн. материалы', width: 8.5, group: 'money', num: true, get: pzVal('direct_main', 'directMain'), fmt: money },
  { key: 'direct_aux', label: 'Вспом. материалы', width: 8, group: 'money', num: true, get: pzVal('direct_aux', 'directAux'), fmt: money },
  { key: 'direct_works', label: 'Работы (прямые)', width: 8.5, group: 'money', num: true, get: pzVal('direct_works', 'directWorks'), fmt: money },
  { key: 'comm_materials', label: 'Коммерция: мат.', width: 8.5, group: 'money', num: true, get: pzVal('comm_materials', 'commMaterials'), fmt: money },
  { key: 'comm_works', label: 'Коммерция: раб.', width: 8.5, group: 'money', num: true, get: pzVal('comm_works', 'commWorks'), fmt: money },
  { key: 'comm_total', label: 'Коммерция итого', width: 9, group: 'money', num: true, get: pzVal('comm_total', 'commTotal'), fmt: money, strong: true },
  { key: 'price', label: 'Цена за ед.', width: 7.5, group: 'money', num: true,
    get: (row) => (row.unit ? unitPrice(row) : null), fmt: money },
  ...ACTUAL,
  { key: 'taken', label: 'Забрано, ₽', hint: 'Распределённый объём × цена за единицу', width: 8.5, group: 'dist', num: true },
  { key: 'rest', label: 'Остаток, ₽', hint: 'Свободный объём × цена за единицу', width: 8.5, group: 'dist', num: true },
  { key: 'status', label: 'Статус', width: 7.5, group: 'dist' },
  ...DIST,
  ...WORK,
]

export const columnsFor = (view, hidden) => (view === 'pz' ? PZ_COLUMNS : KP_COLUMNS)
  .filter((c) => !c.group || !hidden?.has(c.group))

// Ключи столбцов, которые можно залить.
export const FILLABLE = new Set([...KP_COLUMNS, ...PZ_COLUMNS].map((c) => c.key))
