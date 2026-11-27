// Распознавание скана и фото счёта в браузере: страница → картинка → (поворот, наклон, стирание линий) → распознаватель → куски текста
// и линии рамки, которые понимает разбор PDF (supplierDocRead.parseSupplierPdfPages). Расчёты над картинкой — utils/supplierOcrPage.js.
//
// Почему в браузере, а не на сервере и не сторонним сервисом. Файл счёта никуда не уходит; служба osp-api живёт на 384 МБ и 0,45
// процессора рядом с чужими порталами, а распознаватель — это 200–300 МБ и секунды на страницу, и у рабочего компьютера они есть.
// Распознавание встроенного просмотрщика Chrome («Текст извлекается из PDF-файла…») страница использовать не может: оно внутри
// самого браузера и наружу не отдаёт ничего.
//
// Файлы распознавателя — свои: рабочий поток и ядро собирает Vite (?url, каталог assets, с хэшем в имени, сжатые копии), языки —
// public/ocr (распознаватель запрашивает их по имени файла, хэш ему не передать). Чужие адреса политика содержимого не пропустит, и
// с чужого сервера файлы и не нужны. Загружается только для скана и фото, поток закрывается после документа: память возвращается.
import Tesseract from 'tesseract.js/dist/tesseract.esm.min.js'
import workerUrl from 'tesseract.js/dist/worker.min.js?url'
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'
import {
  BLANK_SHARE, cleanNumber, darkShare, eraseRulings, estimateSkew, findRulings, lanczosResize, looksSideways, numberBox, numberish, ocrItems, otsuThreshold,
  pageImageInfo, rulingsToPage,
} from './supplierOcrPage.js'

// Разрешение, при котором распознаватель читает мелкий шрифт счёта: выше — дольше, а не лучше.
const TARGET_DPI = 300
const PT_PER_INCH = 72
const MAX_SIDE = 4200
// Фото счёта: короткая сторона мельче этого — увеличиваем.
const MIN_SHORT_SIDE = 1600
// Страниц в скане счёта столько не бывает, а секунды на каждую — в фоне: читаем первые.
export const OCR_MAX_PAGES = 12
// Средняя уверенность ниже — возможно, страница вверх ногами: пробуем повёрнутую на 180° и берём лучшую.
const UPSIDE_DOWN_CONFIDENCE = 55
// Страница — одна картинка мельче LOW_DPI (КП «Металлсервис» — 90 dpi, 16 цветов): рисуем её точка в точку и увеличиваем сами до
// LOW_TARGET_DPI (supplierOcrPage.lanczosResize), числа перечитываем отдельно (rereadNumbers). Картинка — на большей части листа.
const LOW_DPI = 200
const LOW_TARGET_DPI = 360
const LOW_MAX_SIDE = 4400
const IMAGE_COVER_MIN = 0.5
const LANG_PATH = `${import.meta.env?.BASE_URL || '/'}ocr`.replace(/\/\//g, '/')

async function openWorker() {
  const worker = await Tesseract.createWorker('rus+eng', 1, {
    workerPath: workerUrl,
    corePath: coreUrl,
    langPath: LANG_PATH,
    gzip: true,
    workerBlobURL: false,
    // Языки — обычные файлы сайта, их помнит браузер: своя копия в IndexedDB не нужна.
    cacheMethod: 'none',
  })
  await worker.setParameters({
    // Одна колонка текста, а не разбор страницы на блоки: иначе таблица рассыпается на отдельные ячейки вперемешку.
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_COLUMN,
    preserve_interword_spaces: '1',
    user_defined_dpi: String(TARGET_DPI),
  })
  return worker
}

// Второе чтение чисел мелкого шрифта: английская модель и только цифры — на ячейках «Металлсервиса» 52 из 54 чисел верно, у общей
// модели «рус+англ» по всей странице — около 40 (8 и 6, «7» в начале числа терялась). Одна строка текста на кусок картинки.
async function openDigitWorker() {
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: workerUrl,
    corePath: coreUrl,
    langPath: LANG_PATH,
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
  })
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: '0123456789.,',
    user_defined_dpi: String(TARGET_DPI),
  })
  return worker
}

const newCanvas = (w, h) => {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}
const context = (canvas) => canvas.getContext('2d', { willReadFrequently: true })

// Страница в серых тонах и обратно. Цвет распознавателю не нужен: подложка и печать только мешают.
function grayOf(canvas) {
  const { width: w, height: h } = canvas
  const { data } = context(canvas).getImageData(0, 0, w, h)
  const gray = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Прозрачное — белое: у фото и PNG бывает прозрачный фон.
    gray[i] = data[p + 3] < 128 ? 255 : (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
  return gray
}
function putGray(canvas, gray) {
  const { width: w, height: h } = canvas
  const image = context(canvas).createImageData(w, h)
  const out = image.data
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    out[p] = gray[i]
    out[p + 1] = gray[i]
    out[p + 2] = gray[i]
    out[p + 3] = 255
  }
  context(canvas).putImageData(image, 0, 0)
}

// Поворот на угол: холст — по новому размеру, углы — белые.
function rotated(canvas, deg) {
  const rad = (deg * Math.PI) / 180
  const sin = Math.abs(Math.sin(rad))
  const cos = Math.abs(Math.cos(rad))
  const out = newCanvas(Math.round(canvas.width * cos + canvas.height * sin), Math.round(canvas.width * sin + canvas.height * cos))
  const ctx = context(out)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate(rad)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  return out
}

// Числа строк — второй раз, по одному (digits() — поток цифр, открывается при первом числе): слово, похожее на число
// (supplierOcrPage.numberish), читается по куску картинки от соседа слева до соседа справа в пределах ячейки. Ответ — чистое число,
// и цифр в нём не меньше, чем было, без одной, — заменяет слово; нет — слово остаётся как было, его проверит сверка с суммой.
async function rereadNumbers(digits, canvas, blocks, rules) {
  const tasks = []
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = line.words || []
        const cuts = rules.v.filter((r) => r.y0 <= line.bbox.y1 && r.y1 >= line.bbox.y0).map((r) => r.x)
        // Число, распавшееся на два слова («2208727 57», «898637 4.79»), — одно: соседние слова-числа без линии между ними.
        const runs = []
        words.forEach((word, i) => {
          if (!numberish(word.text)) return
          const last = runs[runs.length - 1]
          const prev = words[i - 1]
          const h = Math.max(4, word.bbox.y1 - word.bbox.y0)
          if (last && last.to === i - 1 && word.bbox.x0 - prev.bbox.x1 < h && !cuts.some((x) => x >= prev.bbox.x1 - 1 && x <= word.bbox.x0 + 1)) last.to = i
          else runs.push({ from: i, to: i })
        })
        for (const { from, to } of runs) {
          const part = words.slice(from, to + 1)
          const joined = {
            text: part.map((w) => w.text).join(''),
            bbox: { x0: part[0].bbox.x0, x1: part[part.length - 1].bbox.x1, y0: Math.min(...part.map((w) => w.bbox.y0)), y1: Math.max(...part.map((w) => w.bbox.y1)) },
          }
          const view = [...words.slice(0, from), joined, ...words.slice(to + 1)]
          const box = numberBox(view, from, cuts, canvas.width, canvas.height)
          if (box) tasks.push({ word: part[0], rest: part.slice(1), was: joined.text, box })
        }
      }
    }
  }
  if (!tasks.length) return
  const worker = await digits()
  for (const { word, rest, was: text, box } of tasks) {
    const w = box.x1 - box.x0
    const h = box.y1 - box.y0
    const pad = Math.round(h * 0.5)
    const crop = newCanvas(w + 2 * pad, h + 2 * pad)
    const ctx = context(crop)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, crop.width, crop.height)
    ctx.drawImage(canvas, box.x0, box.y0, w, h, pad, pad, w, h)
    const { data } = await worker.recognize(crop, {}, { text: true })
    crop.width = 0
    const n = cleanNumber(data.text)
    const was = (String(text).match(/[0-9]/g) || []).length
    if (!n || n.replace(/[^0-9]/g, '').length < was - 1) continue
    word.text = n
    for (const w of rest) w.text = ''
  }
}

// Холст страницы → страница для разбора: { items, height, rulings, confidence } или null (пустая). scale — точек холста на точку страницы.
// digits — поток второго чтения чисел (для мелкой картинки, rereadNumbers) или null.
async function recognizeCanvas(worker, source, scale, digits = null) {
  let canvas = source
  let gray = grayOf(canvas)
  let threshold = otsuThreshold(gray)
  if (darkShare(gray, threshold) < BLANK_SHARE) return null
  if (looksSideways(gray, canvas.width, canvas.height, threshold)) {
    canvas = rotated(canvas, 90)
    gray = grayOf(canvas)
  }
  const skew = estimateSkew(gray, canvas.width, canvas.height, threshold)
  if (skew) {
    canvas = rotated(canvas, -skew)
    gray = grayOf(canvas)
    threshold = otsuThreshold(gray)
  }
  const read = async (view) => {
    const g = view === canvas ? gray : grayOf(view)
    const rules = findRulings(g, view.width, view.height, threshold)
    eraseRulings(g, view.width, view.height, threshold, rules)
    const clean = newCanvas(view.width, view.height)
    putGray(clean, g)
    const { data } = await worker.recognize(clean, {}, { blocks: true, text: false })
    if (digits) await rereadNumbers(digits, clean, data.blocks, rules)
    const height = view.height / scale
    const { items, confidence } = ocrItems(data.blocks, { pageHeight: height, scale, rules })
    clean.width = 0
    return { items, height, rulings: rulingsToPage(rules, scale), confidence }
  }
  const page = await read(canvas)
  if (page.confidence >= UPSIDE_DOWN_CONFIDENCE) return page
  const other = await read(rotated(canvas, 180))
  return other.confidence > page.confidence ? other : page
}

// Страница PDF на холсте: { canvas, scale, small }. Обычно — 300 dpi отрисовкой pdf.js. Страница — мелкая картинка (pageImageInfo):
// точка в точку (холст — по точкам картинки, по осям свой масштаб), затем своё увеличение Lanczos до LOW_TARGET_DPI.
async function renderPage(pdfjs, page) {
  const base = page.getViewport({ scale: 1 })
  let info = null
  try {
    const ops = await page.getOperatorList()
    info = pageImageInfo(ops.fnArray, ops.argsArray, pdfjs.OPS, base.width, base.height)
  } catch {
    info = null // команды страницы не прочитались — рисуем как обычно
  }
  if (info && info.cover >= IMAGE_COVER_MIN && Math.max(info.sx, info.sy) * PT_PER_INCH < LOW_DPI) {
    const w = Math.max(1, Math.round(base.width * info.sx))
    const h = Math.max(1, Math.round(base.height * info.sy))
    const native = newCanvas(w, h)
    const nctx = context(native)
    nctx.fillStyle = '#fff'
    nctx.fillRect(0, 0, w, h)
    await page.render({ canvas: native, canvasContext: nctx, viewport: base, transform: [info.sx, 0, 0, info.sy, 0, 0] }).promise
    const scale = Math.min(LOW_TARGET_DPI / PT_PER_INCH, LOW_MAX_SIDE / Math.max(base.width, base.height))
    const W = Math.round(base.width * scale)
    const H = Math.round(base.height * scale)
    const big = lanczosResize(grayOf(native), w, h, W, H)
    native.width = 0
    const canvas = newCanvas(W, H)
    putGray(canvas, big)
    return { canvas, scale, small: true }
  }
  const scale = Math.min(TARGET_DPI / PT_PER_INCH, MAX_SIDE / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = newCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const ctx = context(canvas)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return { canvas, scale, small: false }
}

// Страницы PDF без текста → страницы для разбора. onProgress({ page, pages }) — перед каждой страницей.
export async function readScanPdf(pdfjs, bytes, { onProgress = null } = {}) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false })
  const doc = await task.promise
  let worker = null
  let digitWorker = null
  const digits = () => (digitWorker ||= openDigitWorker())
  try {
    const count = Math.min(doc.numPages, OCR_MAX_PAGES)
    const out = []
    for (let i = 1; i <= count; i++) {
      onProgress?.({ page: i, pages: count })
      const page = await doc.getPage(i)
      const { canvas, scale, small } = await renderPage(pdfjs, page)
      page.cleanup?.()
      worker ||= await openWorker()
      const read = await recognizeCanvas(worker, canvas, scale, small ? digits : null)
      canvas.width = 0
      if (read) out.push(read)
    }
    return out
  } finally {
    await worker?.terminate()
    if (digitWorker) await (await digitWorker.catch(() => null))?.terminate()
    await task.destroy()
  }
}

// Фото или картинка счёта → страница для разбора. Точек на «точку страницы» — как у скана 300 dpi, поэтому пороги разбора те же.
export async function readScanImage(bytes, fileName, { onProgress = null } = {}) {
  onProgress?.({ page: 1, pages: 1 })
  const bitmap = await createImageBitmap(new Blob([bytes]))
  const short = Math.min(bitmap.width, bitmap.height)
  const long = Math.max(bitmap.width, bitmap.height)
  const k = Math.min(MAX_SIDE / long, Math.max(1, MIN_SHORT_SIDE / short))
  const canvas = newCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k))
  const ctx = context(canvas)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const worker = await openWorker()
  try {
    const read = await recognizeCanvas(worker, canvas, TARGET_DPI / PT_PER_INCH)
    return read ? [read] : []
  } finally {
    canvas.width = 0
    await worker.terminate()
  }
}
