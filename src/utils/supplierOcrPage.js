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

// ── Мелкая картинка страницы ─────────────────────────────────────────────────────────────────────────
// 27.11.2026, тендер № 1157, КП «Металлсервис» (mc.ru): страница — картинка 877×1077 точек на листе 699×849 pt, то есть ~90 dpi,
// 16 цветов, буквы без сглаживания по 8–9 точек. Отрисовка pdf.js в 300 dpi растягивает её сглаживанием в 3,3 раза: края букв
// расплываются, «Кол-во» читалось «Kon-Bo» (колонку количества разбор не находил, сверять цены было не с чем), «74990.00» —
// «4990.00», «16П» — «160». Такую страницу рисуем точка в точку и увеличиваем сами (Lanczos), как у распознавателя при обучении.

// Самая большая картинка страницы по командам рисования pdf.js: { w, h, sx, sy, cover } — её точки, точек на pt по осям и доля
// листа, которую она занимает; нет картинки — null. Положение картинки — текущая матрица (save / restore / transform / формы).
export function pageImageInfo(fnArray, argsArray, OPS, pageWidth, pageHeight) {
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []
  const mul = (m, n) => [
    n[0] * m[0] + n[1] * m[2], n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2], n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4], n[4] * m[1] + n[5] * m[3] + m[5],
  ]
  let best = null
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
    else if (fn === OPS.transform && args?.length === 6) ctm = mul(ctm, args)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0])
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const w = fn === OPS.paintImageXObject ? Number(args?.[1]) : Number(args?.[0]?.width)
      const h = fn === OPS.paintImageXObject ? Number(args?.[2]) : Number(args?.[0]?.height)
      const dw = Math.hypot(ctm[0], ctm[1])
      const dh = Math.hypot(ctm[2], ctm[3])
      if (!(w > 0 && h > 0 && dw > 0 && dh > 0)) continue
      const cover = (dw * dh) / Math.max(1, pageWidth * pageHeight)
      if (!best || cover > best.cover) best = { w, h, sx: w / dw, sy: h / dh, cover }
    }
  }
  return best
}

// Увеличение серой картинки (Lanczos, окно 3): ровные края букв без ступенек и без размытия. Масштабы по осям бывают разные (точки
// картинки не квадратные относительно листа), поэтому размер — W×H целиком. Ответ — Uint8Array W×H.
const LANCZOS_A = 3
function lanczosTaps(src, dst) {
  const scale = dst / src
  const taps = new Int32Array(dst)
  const weights = new Float32Array(dst * 2 * LANCZOS_A)
  for (let i = 0; i < dst; i++) {
    const center = (i + 0.5) / scale - 0.5
    const left = Math.floor(center) - LANCZOS_A + 1
    taps[i] = left
    let sum = 0
    for (let k = 0; k < 2 * LANCZOS_A; k++) {
      const x = center - (left + k)
      const v = x === 0 ? 1 : Math.abs(x) >= LANCZOS_A ? 0
        : (LANCZOS_A * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / LANCZOS_A)) / (Math.PI * Math.PI * x * x)
      weights[i * 2 * LANCZOS_A + k] = v
      sum += v
    }
    for (let k = 0; k < 2 * LANCZOS_A; k++) weights[i * 2 * LANCZOS_A + k] /= sum || 1
  }
  return { taps, weights }
}
export function lanczosResize(gray, w, h, W, H) {
  const n = 2 * LANCZOS_A
  const xs = lanczosTaps(w, W)
  const ys = lanczosTaps(h, H)
  const mid = new Float32Array(W * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < W; x++) {
      const left = xs.taps[x]
      let s = 0
      for (let k = 0; k < n; k++) {
        const sx = Math.min(w - 1, Math.max(0, left + k))
        s += gray[row + sx] * xs.weights[x * n + k]
      }
      mid[y * W + x] = s
    }
  }
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const top = ys.taps[y]
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let k = 0; k < n; k++) {
        const sy = Math.min(h - 1, Math.max(0, top + k))
        s += mid[sy * W + x] * ys.weights[y * n + k]
      }
      out[y * W + x] = s < 0 ? 0 : s > 255 ? 255 : Math.round(s)
    }
  }
  return out
}

// ── Числа: второе чтение ─────────────────────────────────────────────────────────────────────────────
// Слово похоже на число таблицы (цена, сумма, количество, код): цифры и то, во что распознаватель превращает цифры мелкого шрифта
// («#15622.70», «2.29?», «Б7326.09», «{15622.70», «g86374.79»). Слова с буквами наименования («ГОСТ3262-75», «дл.7800») — нет.
const NUMBERISH_RE = /^[0-9ОоOoЗзlIбБSBВgbqszZ#?%{}“”"'.,:;/\\|-]+$/
export const numberish = (text) => NUMBERISH_RE.test(String(text || '')) && (String(text).match(/[0-9]/g) || []).length >= 2
// Чистое число второго чтения («74990.00», «2.297», «1201444»).
export const cleanNumber = (text) => {
  const s = String(text || '').replace(/\s+/g, '')
  return /^[0-9]+(?:[.,][0-9]+)?$/.test(s) ? s : null
}
// Где перечитать число: от конца соседнего слова слева до начала соседнего справа, в пределах ячейки (линии рамки cuts — x в
// точках картинки), с запасом по высоте. Так в рамку попадает и цифра, которую первое чтение потеряло («26374.54» вместо
// «726374.54»: «7» мелкого шрифта — тонкая черта). words — слова строки распознавателя по порядку, i — номер слова.
export function numberBox(words, i, cuts, imgW, imgH) {
  const w = words[i].bbox
  const h = Math.max(4, w.y1 - w.y0)
  const leftCut = Math.max(0, ...cuts.filter((x) => x <= w.x0 + 1))
  const rightCut = Math.min(imgW, ...cuts.filter((x) => x >= w.x1 - 1))
  const prev = words[i - 1]?.bbox
  const next = words[i + 1]?.bbox
  const x0 = Math.max(leftCut + 2, prev && prev.x1 < w.x0 ? prev.x1 + 2 : 0, w.x0 - 2 * h)
  const x1 = Math.min(rightCut - 2, next && next.x0 > w.x1 ? next.x0 - 2 : imgW, w.x1 + h)
  const y0 = Math.max(0, w.y0 - Math.round(h * 0.35))
  const y1 = Math.min(imgH, w.y1 + Math.round(h * 0.35))
  return x1 - x0 >= 4 && y1 - y0 >= 4 ? { x0: Math.round(x0), y0, x1: Math.round(x1), y1 } : null
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
const fitsSum = (price, qty, sum) => {
  const made = price * qty
  return VAT_FACTORS.some((f) => near(made * f, sum) || near(made, sum * f))
}
// Точно — до копеек (цена в документе округлена до копеек: на количество набегает до полкопейки на единицу), НДС сверху — тоже.
// Допуск 0,2 % (fitsSum) пропускал неверную цифру десятков: «130080» вместо «130090» при сумме 298 816,73 — разница 23 ₽ (27.11.2026).
export const fitsExactly = (price, qty, sum) => {
  const made = price * qty
  return VAT_FACTORS.some((f) => {
    const tol = (0.006 + qty * 0.005) * f + 0.01
    return Math.abs(made * f - sum) <= tol || Math.abs(made - sum * f) <= tol
  })
}
// Наименование со скана: то, что распознаватель путает в каждом счёте на металл (тендер № 1157, КП «Металлсервиса») — латиница вместо
// кириллицы в ГОСТ и ТУ, «э» как «з», «дл.» как «an.», «3» марки стали как «З» / «Э», «6» в начале размера как «Б», «х» размера как «%».
// Только то, что русским словом и размером не бывает: правка не может испортить верно прочитанное.
const OCR_NAME_FIXES = [
  [/(^|[^a-zа-яё])[MTrFГ][OО][CС][TТ](?=[\s0-9-]|$)/g, '$1ГОСТ'],
  [/\/T[YУ](?![a-zа-яё])/g, '/ТУ'],
  [/(^|[^a-zа-яё])злектр/g, '$1электр'],
  [/(^|[^a-zа-яё])(?:an|gn|ал|дп)\.\s?(?=[0-9])/g, '$1дл.'],
  [/(^|[^a-zа-яё])Ст[ЗЭ](?=(?:пс|сп|кп|еп|пе|[/ ]|$))/g, '$1Ст3'],
  [/(^|[^a-zа-яё0-9])Б(?=[0-9]+(?:[.,][0-9]+)?[xх×*][0-9])/g, '$16'],
  [/(дл\.?\s?)Б(?=[0-9]{2,})/g, '$16'],
  [/([0-9])%(?=[0-9])/g, '$1х'],
]
export const ocrName = (name) => (name ? OCR_NAME_FIXES.reduce((s, [re, to]) => s.replace(re, to), String(name)) : name)

export function ocrChecked(items) {
  return items.map((raw) => {
    const it = { ...raw, name: ocrName(raw.name), unit: ocrUnit(raw.unit) }
    if (it.price > 0 && it.qty > 0 && it.sum > 0) {
      // unsure из разбора (несколько позиций в одной ячейке) сверка не снимает.
      if (fitsExactly(it.price, it.qty, it.sum)) return { ...it, sumOff: false, unsure: raw.unsure === true }
      // Не сошлось до копеек — сначала одна неверная цифра (repairBySum); не нашлась, а сходится с допуском 0,2 % — как раньше:
      // так бывает у документа, где цена и сумма округлены по-своему.
      const fixed = it.per ? null : repairBySum(it.qty, it.price, it.sum)
      if (fixed) return { ...it, ...fixed, sumOff: false, unsure: raw.unsure === true, ocrFixed: true }
      if (fitsSum(it.price, it.qty, it.sum)) return { ...it, sumOff: false, unsure: raw.unsure === true }
      return { ...it, sumOff: true, unsure: true, stacked: raw.unsure === true }
    }
    return { ...it, unsure: true }
  })
}

// Одна цифра прочитана неверно (27.11.2026, тендер № 1157: «74990.00» прочитано «4990.00», «2208727.57» — без точки, «298816.73» —
// «2986816.73»): цена × количество ≠ сумма. Пробуем исправить ОДНУ ошибку в одном из трёх чисел — лишняя, потерянная или другая
// цифра, потерянная точка — и берём исправление, только если сходится ровно одно и сходится точно (до копеек, без НДС сверху).
// Иначе ответ null: строка остаётся «сверьте с файлом». Количество — с тем же числом знаков, что прочитано.
const REPAIR_FIELDS = ['qty', 'price', 'sum']
function numberText(v) {
  const s = String(v)
  return /e/i.test(s) ? null : s
}
function variants(text, { money }) {
  const out = new Set()
  const [int, frac = null] = text.split('.')
  const digits = int + (frac ?? '')
  const point = int.length
  const build = (d, p) => {
    if (!d || p <= 0 || p > d.length) return
    if (d.length > 1 && d[0] === '0' && p > 1) return
    out.add(p < d.length ? `${d.slice(0, p)}.${d.slice(p)}` : d)
  }
  for (let i = 0; i < digits.length; i++) {
    // Лишняя цифра.
    build(digits.slice(0, i) + digits.slice(i + 1), i < point ? point - 1 : point)
    // Другая цифра.
    for (let c = 0; c <= 9; c++) if (String(c) !== digits[i]) build(digits.slice(0, i) + c + digits.slice(i + 1), point)
  }
  // Потерянная цифра.
  for (let i = 0; i <= digits.length; i++) for (let c = 0; c <= 9; c++) build(digits.slice(0, i) + c + digits.slice(i), i <= point ? point + 1 : point)
  // Потерянная точка: у денег — копейки, у количества — до трёх знаков.
  if (frac == null) for (const k of money ? [2] : [1, 2, 3]) if (digits.length > k) build(digits, digits.length - k)
  out.delete(text)
  return [...out].map(Number).filter((n) => n > 0)
}
// Итог документа против строк (после ocrChecked): строка, у которой не сошлись цена × количество и сумма, а все прочие строки верны,
// — сумма с одной неверной цифрой даёт разницу с итогом. Если ровно одна правка суммы ровно одной такой строки закрывает разницу до
// копеек — сумма исправляется, затем по ней и цена (repairBySum). Тендер № 1157, КП «Металлсервиса»: «688374.79» вместо «888374.79» и
// цена «108580» вместо «108590» — две ошибки в строке, по одной строке не исправить. docTotal — итог документа. Ответ — новые строки.
export function reconcileWithTotal(items, docTotal) {
  if (!(docTotal > 0)) return items
  const value = (it) => it.sum ?? (it.price > 0 && it.qty > 0 ? it.price * it.qty : 0)
  const read = items.reduce((s, it) => s + value(it), 0)
  // Итог — с НДС или без (каждый вариант), не дальше четверти от прочитанного: одна цифра старшего разряда — это и 20 %.
  const targets = VAT_FACTORS.map((f) => docTotal / f).filter((t) => Math.abs(read - t) <= t * 0.25)
  if (!targets.length || targets.some((t) => Math.abs(read - t) <= 0.02)) return items
  const found = []
  items.forEach((it, i) => {
    if (!it.sumOff || !(it.sum > 0) || it.per) return
    const text = numberText(it.sum)
    if (!text) return
    for (const v of variants(text, { money: true })) if (targets.some((t) => Math.abs(read - it.sum + v - t) <= 0.02)) found.push({ i, v })
  })
  if (found.length !== 1) return items
  const { i, v } = found[0]
  const it = items[i]
  const fixed = fitsExactly(it.price, it.qty, v) ? { sum: v } : repairBySum(it.qty, it.price, v)
  if (!fixed || (fixed.sum != null && fixed.sum !== v)) return items
  return items.map((x, k) => (k === i ? { ...x, ...fixed, sum: v, sumOff: false, unsure: x.stacked === true, ocrFixed: true } : x))
}

export function repairBySum(qty, price, sum) {
  const exact = (q, p, s) => fitsExactly(p, q, s)
  const now = { qty, price, sum }
  const found = new Map()
  for (const field of REPAIR_FIELDS) {
    const text = numberText(now[field])
    if (!text) continue
    for (const v of variants(text, { money: field !== 'qty' })) {
      const t = { ...now, [field]: v }
      if (exact(t.qty, t.price, t.sum)) found.set(`${t.qty}|${t.price}|${t.sum}`, t)
    }
  }
  return found.size === 1 ? [...found.values()][0] : null
}
