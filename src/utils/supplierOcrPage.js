// Скан счёта → то, что понимает разбор PDF (utils/supplierDoc): слова с координатами и линии рамки. Только расчёты над
// массивами, без браузера и распознавателя: само чтение — utils/supplierOcr.js. Модуль чистый — tests/supply/supplier-ocr.test.mjs.
//
// Зачем линии. Распознавателю рамка таблицы мешает: вертикальная линия читается как «|» и прилипает к слову («|теор.т»,
// «5|лист»), цифра, задевшая линию, читается хуже. А разбору, наоборот, линии нужны: по ним видны колонки и строки таблицы.
// Поэтому линии находятся в картинке (findRulings), стираются (eraseRulings) и передаются разбору отдельно — так же, как
// линии из команд рисования настоящего PDF (rulingsFromOps).

// Порог «тёмное / светлое» по гистограмме страницы (метод Оцу). Скан и фото бывают разной яркости: постоянный порог не годится.
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = gray.length - wB
    if (!wF) break
    sumB += t * hist[t]
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (between > best) { best = between; threshold = t }
  }
  return threshold
}

// Доля тёмного на странице. Пустая страница (только шум сканера, подпись на обороте) — не распознаём.
export function darkShare(gray, threshold) {
  let dark = 0
  for (let i = 0; i < gray.length; i += 7) if (gray[i] <= threshold) dark += 1
  return dark / Math.ceil(gray.length / 7)
}
export const BLANK_SHARE = 0.002

// Тёмные точки в уменьшенной копии страницы: для наклона и поворота хватает и их, а считать всю страницу на каждый угол дорого.
function darkPoints(gray, w, h, threshold, step) {
  const xs = []
  const ys = []
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (gray[y * w + x] <= threshold) { xs.push(x); ys.push(y) }
    }
  }
  return { xs, ys }
}

// «Резкость» проекции строк: чем ровнее лежат строки текста, тем больше сумма квадратов.
function profileScore(xs, ys, angle, size, bin) {
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const rows = new Int32Array(size)
  for (let i = 0; i < xs.length; i++) {
    const r = Math.round((ys[i] * cos - xs[i] * sin) / bin)
    if (r >= 0 && r < size) rows[r] += 1
  }
  let score = 0
  for (let i = 0; i < size; i++) score += rows[i] * rows[i]
  return score
}

const SKEW_MAX_DEG = 5
const SKEW_STEP_DEG = 0.1
const SKEW_MIN_DEG = 0.1
// Наклон страницы в градусах (строки идут вниз вправо — плюс): при таком наклоне строки текста складываются в самые резкие
// полосы проекции. Меньше 0,1° — ноль: поворот картинки лишь размыл бы буквы.
export function estimateSkew(gray, w, h, threshold) {
  const step = Math.max(1, Math.round(Math.max(w, h) / 1200))
  const { xs, ys } = darkPoints(gray, w, h, threshold, step)
  if (xs.length < 200) return 0
  const bin = Math.max(1, step)
  const size = Math.ceil((h + w * Math.sin((SKEW_MAX_DEG * Math.PI) / 180)) / bin) + 2
  // Сначала грубо, затем точно вокруг лучшего: 100 углов на полстраницы точек — заметная пауза на старом компьютере.
  const search = (from, to, by) => {
    let best = { deg: 0, score: -1 }
    for (let deg = from; deg <= to + 1e-9; deg += by) {
      const score = profileScore(xs, ys, (deg * Math.PI) / 180, size, bin)
      if (score > best.score) best = { deg, score }
    }
    return best.deg
  }
  const coarse = search(-SKEW_MAX_DEG, SKEW_MAX_DEG, 0.5)
  const fine = search(coarse - 0.5, coarse + 0.5, SKEW_STEP_DEG)
  return Math.abs(fine) < SKEW_MIN_DEG ? 0 : Math.round(fine * 100) / 100
}

// Страница повёрнута на 90°: строки текста стоят вертикально, и столбцы картинки резче, чем строки. Ответ — true / false.
export function looksSideways(gray, w, h, threshold) {
  const step = Math.max(1, Math.round(Math.max(w, h) / 1000))
  const rows = new Int32Array(Math.ceil(h / step) + 1)
  const cols = new Int32Array(Math.ceil(w / step) + 1)
  let dark = 0
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (gray[y * w + x] <= threshold) { rows[Math.floor(y / step)] += 1; cols[Math.floor(x / step)] += 1; dark += 1 }
    }
  }
  if (dark < 200) return false
  // Нормируем на длину проекции: у листа стороны разные, и у короткой проекции сумма квадратов больше сама по себе.
  const sharp = (p, len) => { let s = 0; for (let i = 0; i < p.length; i++) s += p[i] * p[i]; return s * len }
  return sharp(cols, cols.length) > 1.35 * sharp(rows, rows.length)
}

// ── Линии рамки ──────────────────────────────────────────────────────────────────────────────────────
// Отрезки тёмных точек вдоль оси: ряд за рядом, разрыв до gap точек — тот же отрезок (линия на скане бывает с просветами).
function darkRuns(isDark, along, across, minLen, gap) {
  const out = []
  for (let a = 0; a < across; a++) {
    let start = -1
    let last = -1
    for (let i = 0; i <= along; i++) {
      const on = i < along && isDark(i, a)
      if (on) {
        if (start < 0) start = i
        last = i
      } else if (start >= 0 && (i >= along || i - last > gap)) {
        if (last - start + 1 >= minLen) out.push({ a, from: start, to: last })
        start = -1
      }
    }
  }
  return out
}

// Отрезки соседних рядов → линии: { at — середина толщины, t0..t1 — толщина, from, to }. Линия толще maxThick — не линия
// (заливка шапки, логотип, штамп); короче minTotal — случайный штрих.
function joinRuns(runs, maxThick, minTotal) {
  const open = []
  const done = []
  const close = (l) => { if (l.t1 - l.t0 + 1 <= maxThick && l.to - l.from + 1 >= minTotal) done.push(l) }
  for (const r of runs) {
    let owner = null
    for (let i = open.length - 1; i >= 0; i--) {
      const l = open[i]
      if (r.a - l.t1 > 2) { close(l); open.splice(i, 1); continue }
      if (!owner && Math.min(l.to, r.to) - Math.max(l.from, r.from) > 0) owner = l
    }
    if (owner) {
      owner.t1 = r.a
      owner.from = Math.min(owner.from, r.from)
      owner.to = Math.max(owner.to, r.to)
    } else {
      open.push({ t0: r.a, t1: r.a, from: r.from, to: r.to })
    }
  }
  for (const l of open) close(l)
  return done.map((l) => ({ ...l, at: (l.t0 + l.t1) / 2 }))
}

// Линии рамки страницы в точках картинки: { h: [{ y, x0, x1, t0, t1 }], v: [{ x, y0, y1, t0, t1 }] }. Длина горизонтальной — от
// 8 % ширины (буквы столько не тянутся), вертикальной — от 2 % высоты: у таблицы из одной строки рамка всего в две строки
// текста, а самый высокий штрих буквы на счёте короче. Толщина — до 0,5 % ширины страницы.
export function findRulings(gray, w, h, threshold) {
  const dark = (x, y) => gray[y * w + x] <= threshold
  const maxThick = Math.max(4, Math.round(w * 0.005))
  const gap = Math.max(2, Math.round(w * 0.0015))
  const minH = Math.round(w * 0.08)
  const minV = Math.round(h * 0.02)
  const hRuns = darkRuns((i, a) => dark(i, a), w, h, Math.round(minH / 2), gap)
  const vRuns = darkRuns((i, a) => dark(a, i), h, w, Math.round(minV / 2), gap)
  return {
    h: joinRuns(hRuns, maxThick, minH).map((l) => ({ y: l.at, x0: l.from, x1: l.to, t0: l.t0, t1: l.t1 })),
    v: joinRuns(vRuns, maxThick, minV).map((l) => ({ x: l.at, y0: l.from, y1: l.to, t0: l.t0, t1: l.t1 })),
  }
}

// Стереть линии из картинки (меняет gray). Там, где линию пересекает штрих буквы (тёмно и выше, и ниже линии), точку оставляем:
// иначе цифра, задевшая рамку, потеряла бы кусок.
// Край линии (серая кайма скана) стирается, только если за ним светло: «л» стоит вплотную к рамке, и её крючок — как раз там, а без
// него она читается как «п» («пист г/к»).
export function eraseRulings(gray, w, h, threshold, rules) {
  const white = 255
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? gray[y * w + x] : white)
  const light = (x, y) => at(x, y) > threshold
  for (const r of rules.h) {
    for (let x = r.x0; x <= r.x1; x++) {
      if (!light(x, r.t0 - 2) && !light(x, r.t1 + 2)) continue
      for (let y = Math.max(0, r.t0); y <= Math.min(h - 1, r.t1); y++) gray[y * w + x] = white
      if (r.t0 > 0 && light(x, r.t0 - 2)) gray[(r.t0 - 1) * w + x] = white
      if (r.t1 + 1 < h && light(x, r.t1 + 2)) gray[(r.t1 + 1) * w + x] = white
    }
  }
  for (const r of rules.v) {
    for (let y = r.y0; y <= r.y1; y++) {
      if (!light(r.t0 - 2, y) && !light(r.t1 + 2, y)) continue
      for (let x = Math.max(0, r.t0); x <= Math.min(w - 1, r.t1); x++) gray[y * w + x] = white
      if (r.t0 > 0 && light(r.t0 - 2, y)) gray[y * w + r.t0 - 1] = white
      if (r.t1 + 1 < w && light(r.t1 + 2, y)) gray[y * w + r.t1 + 1] = white
    }
  }
}

// Линии в координатах страницы разбора (точки PDF, y от верха): как у rulingsFromOps.
export function rulingsToPage(rules, scale) {
  return {
    h: rules.h.map((r) => ({ y: r.y / scale, x0: r.x0 / scale, x1: r.x1 / scale })),
    v: rules.v.map((r) => ({ x: r.x / scale, y0: r.y0 / scale, y1: r.y1 / scale })),
  }
}

// ── Слова ────────────────────────────────────────────────────────────────────────────────────────────
// Похожие на цифры буквы в числе («6О 890», «З 409,84»): только если цифр в слове не меньше двух, а буква одна. Наименования с
// буквой и цифрой («З1», «О2») так не задеваются.
const DIGIT_TWINS = { О: '0', о: '0', O: '0', o: '0', З: '3', з: '3', l: '1', I: '1', б: '6', Б: '6', S: '5', B: '8' }
function fixDigits(text) {
  if (!/^[0-9ОоOoЗзlIбБSB.,]+$/.test(text)) return text
  const digits = (text.match(/[0-9]/g) || []).length
  const letters = (text.match(/[^0-9.,]/g) || []).length
  if (digits < 2 || letters !== 1) return text
  return text.replace(/[^0-9.,]/g, (c) => DIGIT_TWINS[c] || c)
}

// Текст, который не значит ничего: остатки рамки и шум скана («|», «[», «_», «©», «°», одна буква при низкой уверенности).
const JUNK_ONLY_RE = /^[^0-9a-zA-Zа-яА-ЯёЁ№%]+$/
const NOISE_CONFIDENCE = 40
function cleanWord(word) {
  const raw = String(word.text || '').trim()
  if (!raw || JUNK_ONLY_RE.test(raw)) return []
  const conf = word.confidence ?? 100
  // Слово с прилипшей к нему рамкой: «|теор.т», «5|лист», «НДС]» — край срезаем, середину делим.
  const pieces = []
  const whole = raw.length
  const width = word.bbox.x1 - word.bbox.x0
  const re = /[^|[\]]+/g
  let m
  while ((m = re.exec(raw))) {
    const text = m[0].replace(/^[_~`'"‘’«»]+|[_~`'"‘’«»]+$/g, '').trim()
    if (!text || JUNK_ONLY_RE.test(text)) continue
    pieces.push({
      text: fixDigits(text),
      x0: word.bbox.x0 + (m.index / whole) * width,
      x1: word.bbox.x0 + ((m.index + m[0].length) / whole) * width,
    })
  }
  return pieces.filter((p) => !(p.text.length <= 2 && !/[0-9№]/.test(p.text) && conf < NOISE_CONFIDENCE)).map((p) => ({ ...p, conf }))
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

// Строки распознавателя → куски текста как у pdf.js ({ str, transform, width, height }): координаты в точках страницы; pageHeight — её
// высота в точках; scale — точек картинки на точку страницы; rules — линии (в точках картинки). Базовая линия и высота — на всю
// строку: у слова со своей рамкой высота разная, а строки разбор собирает по базовой линии. Части числа с пробелом-разрядом
// («2» и «496,49») — один кусок, если между ними нет линии рамки: разбор собирает число только из одного куска или вплотную.
const NUMBER_HEAD_RE = /^[-−]?[0-9]{1,3}$/
const NUMBER_TAIL_RE = /^[0-9]{3}([.,][0-9]+)?$/
const NUMBER_GAP = 1
export function ocrItems(blocks, { pageHeight, scale, rules = null }) {
  const items = []
  const confidences = []
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || []).flatMap(cleanWord)
        if (!words.length) continue
        const heights = (line.words || []).map((w) => w.bbox.y1 - w.bbox.y0).filter((v) => v > 0)
        const h = Math.max(median(heights), line.rowAttributes?.rowHeight || 0, 1)
        const base = line.baseline && Number.isFinite(line.baseline.y0)
          ? (line.baseline.y0 + line.baseline.y1) / 2
          : line.bbox.y1 - (line.rowAttributes?.descenders || 0)
        const cuts = (rules?.v || []).filter((r) => r.y0 <= base && r.y1 >= base - h).map((r) => r.x)
        const merged = []
        for (const w of words) {
          confidences.push(w.conf)
          const prev = merged[merged.length - 1]
          const tail = prev ? prev.text.split(' ').pop() : ''
          if (prev && (NUMBER_HEAD_RE.test(tail) || /^[0-9]{3}$/.test(tail)) && NUMBER_TAIL_RE.test(w.text)
            && w.x0 - prev.x1 < NUMBER_GAP * h && !cuts.some((x) => x >= prev.x1 - 1 && x <= w.x0 + 1)) {
            prev.text += ` ${w.text}`
            prev.x1 = w.x1
          } else {
            merged.push({ ...w })
          }
        }
        for (const w of merged) {
          const size = h / scale
          items.push({
            str: w.text,
            transform: [size, 0, 0, size, w.x0 / scale, pageHeight - base / scale],
            width: (w.x1 - w.x0) / scale,
            height: size,
          })
        }
      }
    }
  }
  return { items, confidence: confidences.length ? confidences.reduce((s, v) => s + v, 0) / confidences.length : 0 }
}

// Ед. изм. со скана: распознаватель читает её то кириллицей, то латиницей («reop.T», «wT»). К виду, который поймёт сравнение единиц.
const UNIT_TWINS = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', r: 'г', t: 'т', u: 'и', w: 'ш', x: 'х', y: 'у' }
export function ocrUnit(text) {
  const s = String(text ?? '').toLowerCase().replace(/[a-z]/g, (c) => UNIT_TWINS[c] || c).replace(/^[^а-яё0-9]+|[^а-яё0-9.]+$/g, '').trim()
  if (!s) return null
  // «теор.т», «геор. т» — теоретические тонны: распознавателю первая буква даётся хуже всего.
  return /^.{0,2}еор\.?\s?т\.?$/.test(s) ? 'теор.т' : s
}

// ── Проверка цифр ────────────────────────────────────────────────────────────────────────────────────
// Цифру со скана распознаватель может прочитать неверно, а цена уходит в расценку. Строке верим, только если её цифры сходятся
// между собой: цена × количество = сумма (допуск — округление; цена и сумма бывают с НДС и без). Не сошлось или сверять нечего —
// unsure: строка видна, но сама не отмечается, человек сверяет её с файлом.
const VAT_FACTORS = [1, 1.22, 1.2, 1.1, 1.07, 1.05]
const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.002)
export function ocrChecked(items) {
  return items.map((raw) => {
    const it = { ...raw, unit: ocrUnit(raw.unit) }
    if (it.price > 0 && it.qty > 0 && it.sum > 0) {
      const made = it.price * it.qty
      const fits = VAT_FACTORS.some((f) => near(made * f, it.sum) || near(made, it.sum * f))
      return fits ? { ...it, sumOff: false, unsure: false } : { ...it, sumOff: true, unsure: true }
    }
    return { ...it, unsure: true }
  })
}
