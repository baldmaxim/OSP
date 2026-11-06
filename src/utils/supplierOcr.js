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
import { BLANK_SHARE, darkShare, eraseRulings, estimateSkew, findRulings, looksSideways, ocrItems, otsuThreshold, rulingsToPage } from './supplierOcrPage.js'

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

// Холст страницы → страница для разбора: { items, height, rulings, confidence } или null (пустая). scale — точек холста на точку страницы.
async function recognizeCanvas(worker, source, scale) {
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

// Страницы PDF без текста → страницы для разбора. onProgress({ page, pages }) — перед каждой страницей.
export async function readScanPdf(pdfjs, bytes, { onProgress = null } = {}) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false })
  const doc = await task.promise
  let worker = null
  try {
    const count = Math.min(doc.numPages, OCR_MAX_PAGES)
    const out = []
    for (let i = 1; i <= count; i++) {
      onProgress?.({ page: i, pages: count })
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(TARGET_DPI / PT_PER_INCH, MAX_SIDE / Math.max(base.width, base.height))
      const viewport = page.getViewport({ scale })
      const canvas = newCanvas(Math.round(viewport.width), Math.round(viewport.height))
      const ctx = context(canvas)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      page.cleanup?.()
      worker ||= await openWorker()
      const read = await recognizeCanvas(worker, canvas, scale)
      canvas.width = 0
      if (read) out.push(read)
    }
    return out
  } finally {
    await worker?.terminate()
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
