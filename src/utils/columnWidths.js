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

// Ширины столбцов, при которых граница справа от столбца index сдвинулась на экране на delta — ровно за мышью.
// Считается от ширин на начало перетаскивания: где мышь, там и граница, в какую сторону ни веди.
//   widths, mins — ширины и минимумы столбцов по порядку; container — место под таблицу; delta, scrollLeft — в rem экрана.
//
// Столбцы левее границы не меняются: если бы они сужались вместе с остальными (сумма больше — растянутая таблица ужимает
// все столбцы), граница уезжала бы от мыши тем сильнее, чем правее столбец: у «Документов» — 22 px из 120, у «Статуса
// ОКС» — 3 из 60. Поэтому место берётся только у соседа справа, сумма не меняется, и остальные столбцы стоят:
//   • шире — сосед уже, до своего минимума; дальше таблица становится шире места и прокручивается. Растянутая таблица в
//     этот момент переходит на ширины как на экране, иначе скачком сузились бы все столбцы;
//   • уже — сосед шире. Таблица, которая и так шире места, сначала сужается сама, но лишь пока прокрутка не упрётся в
//     новый край: дальше браузер сдвинул бы всю таблицу вправо, и граница осталась бы на месте;
//   • таблица и так шире места и столбец растёт — он просто раздвигает таблицу, сосед не меняется.
export function dragWidths({ widths, mins, index, delta, container, scrollLeft = 0 }) {
  const sum = widths.reduce((total, w) => total + w, 0)
  const scale = sum < container ? container / sum : 1 // во сколько раз столбцы на экране шире своих ширин
  const neighbor = index + 1 < widths.length ? index + 1 : -1
  const width = Math.min(COLUMN_WIDTH_MAX, Math.max(mins[index], widths[index] + delta / scale))
  const moved = width - widths[index]
  const next = [...widths]
  next[index] = width
  if (moved < 0) {
    const tableShrinks = Math.min(-moved, Math.max(0, sum - container - scrollLeft))
    if (neighbor >= 0) next[neighbor] += -moved - tableShrinks
  } else if (moved > 0 && sum <= container) {
    const given = neighbor >= 0 ? Math.min(moved, Math.max(0, widths[neighbor] - mins[neighbor])) : 0
    if (neighbor >= 0) next[neighbor] -= given
    if (moved > given && scale > 1) return next.map(w => round(w * scale))
  }
  return next.map(round)
}
