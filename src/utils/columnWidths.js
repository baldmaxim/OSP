// Ширины столбцов таблицы, выставленные человеком (перетаскиванием границы в заголовке), — в rem, в localStorage:
// переживают обновление страницы и новые вкладки этого браузера. Хранилище закрыто или запись испорчена —
// ширины по умолчанию.
//
// Сетка — table-layout: fixed, width: 100%: у каждого столбца своя ширина в rem, min-width таблицы — их сумма.
// Окно шире суммы (меню свёрнуто, широкий монитор) — браузер растягивает ВСЕ столбцы пропорционально их ширинам;
// уже — таблица прокручивается сама, данные не ужимаются.

export const COLUMN_WIDTH_MIN = 2.5
export const COLUMN_WIDTH_MAX = 48

export function localStore() {
  try { return window.localStorage } catch { return null }
}

const round = (rem) => Math.round(rem * 1000) / 1000

export function clampWidth(rem, min = COLUMN_WIDTH_MIN, max = COLUMN_WIDTH_MAX) {
  return round(Math.min(max, Math.max(min, rem)))
}

// Сохранённые ширины: только разумные числа (и только столбцы keys, если они заданы). Столбцы, которых сейчас нет
// (колонки ещё нет в базе), не теряются — запись хранит все.
export function readColumnWidths(key, keys = null, storage = localStore()) {
  try {
    const raw = JSON.parse(storage?.getItem(key) || 'null')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const k of keys || Object.keys(raw)) {
      const v = Number(raw[k])
      if (Number.isFinite(v) && v > 0) out[k] = clampWidth(v)
    }
    return out
  } catch {
    return {}
  }
}

export function writeColumnWidths(key, widths, storage = localStore()) {
  try {
    if (Object.keys(widths).length === 0) storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify(widths))
  } catch { /* хранилище переполнено или закрыто — ширины просто не запомнятся */ }
}

// Новая ширина столбца (в тех же единицах, что base и sum), при которой на экране он будет target.
// base — ширина столбца, sum — сумма всех столбцов, container — ширина места под таблицу. Пока сумма не больше
// места, таблица растянута: столбец на экране = base × container / sum, и растёт он за счёт остальных,
// пропорционально; шире места — таблица прокручивается, столбец на экране равен своей ширине.
export function resizedWidth({ base, sum, container, target }) {
  if (target < container) {
    const delta = (target * sum - base * container) / (container - target)
    if (sum + delta <= container) return base + delta
  }
  return target
}

// Как столбец выглядит сейчас: ширина на экране при данной сумме и месте (таблица не уже места).
export function shownWidth({ base, sum, container }) {
  return sum < container ? base * container / sum : base
}
