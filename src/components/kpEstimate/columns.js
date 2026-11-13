// Столбцы таблицы сметы КП / ПЗ — один вид (13.11.2026: КП до перекидок и план затрат — одна таблица, без
// переключателя «КП / ПЗ» и без дублей: коммерция ПЗ = стоимость КП, цена и материалы / работы — в окне строки).
// key — имя для заливки ячеек (kp_estimate_marks.cell_fills) и выгрузки; width — rem. Наименование — ширина по самому
// длинному видимому наименованию (одной строкой, без переноса), столбцы после него закреплены справа; не уместилось —
// при наведении наименование показывается целиком поверх чисел (KpEstimateTable).
import { fmtMoney } from '../../utils/kpEstimate'

export const COLUMNS = [
  { key: 'code', label: 'Код', width: 5.5, left: true },
  { key: 'name', label: 'Наименование', width: 0 },
  { key: 'qty_gp', label: 'Кол-во (ГП)', hint: 'Количество (ГП) из КП до перекидок — по нему посчитана цена', width: 7.5, num: true },
  { key: 'actual', label: 'Актуальный', hint: 'Уточнённый объём; пусто — как «Кол-во (ГП)». Нажмите в ячейке, чтобы изменить', width: 6.25, num: true, editable: 'actual' },
  { key: 'total', label: 'Стоимость КП, ₽', width: 9.5, num: true, strong: true, fmt: fmtMoney },
  { key: 'direct', label: 'Прямые затраты, ₽', hint: 'Прямые затраты плана затрат', width: 9.5, num: true, fmt: fmtMoney },
  { key: 'free', label: 'Свободно', hint: 'Актуальный объём минус распределённый по тендерам и подрядчикам', width: 6.25, num: true },
  { key: 'alloc', label: 'Тендер и подрядчик', width: 11 },
  { key: 'note', label: 'Примечание', width: 10, editable: 'note' },
]

// Ключи столбцов, которые можно залить.
export const FILLABLE = new Set(COLUMNS.map((c) => c.key))
