// Скан счёта для тестов распознавания: Chromium рисует страницу счёта, снимок — JPEG, как у сканера, и он же — единственное содержимое
// PDF (текста в файле нет). Настоящие счета в репозиторий не кладём: в них реквизиты и цены поставщиков.
export const INVOICE_STYLE = `
  body { margin: 0; padding: 60px 70px; background: #fff; color: #000; font: 15px Arial, 'Liberation Sans', sans-serif; width: 1100px; }
  table { border-collapse: collapse; width: 100%; margin: 18px 0; }
  th, td { border: 2px solid #000; padding: 5px 7px; vertical-align: top; }
  th { font-weight: bold; text-align: center; }
  .r { text-align: right; white-space: nowrap; }
  .c { text-align: center; }`

// Страница счёта → JPEG. skew — наклон страницы в градусах, как у листа в сканере.
export async function invoiceJpeg(browser, body, { skew = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1240, height: 1754 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const tilt = skew ? `body { transform: rotate(${skew}deg); transform-origin: 50% 0; }` : ''
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${INVOICE_STYLE}${tilt}</style></head><body>${body}</body></html>`)
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1240, height: 1754 } })
  await context.close()
  return { jpeg, width: 2480, height: 3508 }
}

// JPEG → PDF из одной страницы A4 с этой картинкой: так устроен файл со сканера.
export function jpegPdf({ jpeg, width, height }) {
  const parts = []
  const offsets = []
  let size = 0
  const put = (chunk) => {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1')
    parts.push(b)
    size += b.length
  }
  const object = (n, body, stream = null) => {
    offsets[n] = size
    put(`${n} 0 obj\n${body}\n`)
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n') }
    put('endobj\n')
  }
  const page = 'q 595 0 0 842 0 0 cm /Im0 Do Q'
  put('%PDF-1.4\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>')
  object(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg)
  object(5, `<< /Length ${page.length} >>`, Buffer.from(page, 'latin1'))
  const xref = size
  put(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`)
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}
