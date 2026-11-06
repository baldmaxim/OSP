// Просмотр .docx (DocxPreview → utils/docxSafe.js): файл, который загрузил пользователь, не выполняет в странице свой код.
// docx-preview переносит в страницу код символа w:sym через innerHTML и адрес внешней ссылки в href. Тест собирает .docx с
// обоими приёмами, отрисовывает его в Chromium тем же путём, что DocxPreview (parseAsync → sanitizeDocxModel → renderDocument),
// и проверяет: разметки из файла нет, обработчик не сработал, ссылки javascript: нет, обычная ссылка осталась.
// Контроль — та же отрисовка без очистки: если библиотека перестанет переносить эти значения, тест скажет, что проверять нечего.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import JSZip from 'jszip'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { REPO, browserLaunchOptions } from './lib/stand.mjs'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

async function craftedDocx() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.__docxLink=1" TargetMode="External"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/ok" TargetMode="External"/>
</Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
  <w:p><w:r><w:t>Пункт 1</w:t></w:r><w:r><w:sym w:font="Wingdings" w:char="41;&lt;img id=&quot;docx-injected&quot; src=&quot;data:,x&quot; onerror=&quot;window.__docxSym=1&quot;&gt;"/></w:r></w:p>
  <w:p><w:hyperlink r:id="rId8"><w:r><w:t>плохая ссылка</w:t></w:r></w:hyperlink></w:p>
  <w:p><w:hyperlink r:id="rId9"><w:r><w:t>обычная ссылка</w:t></w:r></w:hyperlink></w:p>
  <w:p><w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r></w:p>
</w:body></w:document>`)
  return zip.generateAsync({ type: 'base64' })
}

const launch = browserLaunchOptions()

describe('просмотр .docx: файл не выполняет в странице свой код', { skip: launch ? false : 'нет Chromium (PSDC_BROWSER)' }, () => {
  let browser
  let page
  let docx

  before(async () => {
    const bundle = await build({
      stdin: {
        contents: `import { parseAsync, renderDocument } from 'docx-preview'
import { sanitizeDocxModel, SAFE_DOCX_OPTIONS } from './src/utils/docxSafe.js'
window.renderDocx = async (b64, safe) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const body = document.getElementById('body')
  const style = document.getElementById('style')
  body.innerHTML = ''
  const options = { inWrapper: true, breakPages: false, className: 'docx', ...(safe ? SAFE_DOCX_OPTIONS : {}) }
  let doc = await parseAsync(new Blob([bytes]), options)
  if (safe) doc = sanitizeDocxModel(doc)
  await renderDocument(doc, body, style, options)
  await new Promise((r) => setTimeout(r, 200))
  return {
    injected: !!body.querySelector('#docx-injected'),
    symFired: window.__docxSym === 1,
    hrefs: [...body.querySelectorAll('a')].map((a) => a.getAttribute('href') || ''),
    text: body.textContent,
  }
}`,
        resolveDir: REPO,
        loader: 'js',
      },
      bundle: true,
      format: 'iife',
      write: false,
      platform: 'browser',
      nodePaths: [path.join(REPO, 'node_modules')],
      logLevel: 'silent',
    })
    docx = await craftedDocx()
    browser = await chromium.launch({ headless: true, ...launch })
    page = await browser.newPage()
    await page.setContent('<!doctype html><meta charset="utf-8"><div id="style"></div><div id="body"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
  })

  after(async () => { await browser?.close() })

  it('без очистки библиотека переносит разметку и javascript: — значит, проверять есть что', async () => {
    const raw = await page.evaluate(([b64]) => window.renderDocx(b64, false), [docx])
    assert.ok(raw.injected || raw.symFired, 'docx-preview больше не переносит код символа в разметку — пересмотрите docxSafe.js и этот тест')
    assert.ok(raw.hrefs.some((h) => h.startsWith('javascript:')), 'docx-preview больше не переносит адрес ссылки как есть')
    await page.evaluate(() => { delete window.__docxSym })
  })

  it('с очисткой: разметки и обработчика нет, ссылки javascript: нет, обычная ссылка и текст на месте', async () => {
    const safe = await page.evaluate(([b64]) => window.renderDocx(b64, true), [docx])
    assert.equal(safe.injected, false)
    assert.equal(safe.symFired, false)
    assert.ok(!safe.hrefs.some((h) => /^\s*javascript:/i.test(h)), `ссылки: ${safe.hrefs.join(', ')}`)
    assert.ok(safe.hrefs.includes('https://example.com/ok'), `ссылки: ${safe.hrefs.join(', ')}`)
    assert.match(safe.text, /Пункт 1/)
    assert.match(safe.text, /обычная ссылка/)
  })
})
