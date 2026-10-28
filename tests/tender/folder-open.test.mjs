// «Открыть папку»: путь к папке на сайте открывается в проводнике (28.10.2026).
//   • помощник public/tools/osp-folder.cmd (пакетный файл + JScript): синтаксис ES3 (JScript 5.8 Windows Script Host),
//     вне комментариев — только ASCII (WSH читает файл в ANSI), строки CRLF; ссылка osp-folder:… → путь, открывает
//     только папки локальной сети и ничего не запускает, установка и удаление — на подделках WScript / реестра;
//   • сайт: ссылка, которую помощник разбирает обратно в тот же путь; на Windows нажатие на путь в первый раз —
//     окно с помощником, затем папка открывается сразу (ссылка osp-folder:), не на Windows — как раньше.
// Стенд tests/tender/ui: «Заявки на ДС» (route=/dc-requests&dcStats=1), реестр тендеров (FolderPathCell).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { canOpenFolders, folderOpenUrl, isFolderPath, FOLDER_HELPER_URL } from '../../src/utils/folderOpen.js'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const HELPER = path.join(REPO, 'public', 'tools', 'osp-folder.cmd')
const helperText = fs.readFileSync(HELPER, 'utf8')
// JScript-часть — после пакетной (она для JScript — комментарий до первого «*/»).
const jscript = helperText.slice(helperText.indexOf('*/') + 2)

// Подделки Windows Script Host: реестр, файлы, вызовы проводника и окна сообщений.
function runHelper(args, { folders = [], files = [], registry = {}, answers = [] } = {}) {
  const calls = { run: [], popup: [], exists: [], reg: { ...registry }, saved: [], deleted: [] }
  const env = { '%LOCALAPPDATA%': 'C:\\Users\\u\\AppData\\Local', '%SystemRoot%': 'C:\\Windows' }
  const fileSet = new Set(files)
  const shell = {
    ExpandEnvironmentStrings: (s) => env[s] ?? s,
    Popup: (text, wait, title, type) => { calls.popup.push({ text, title, type }); return answers.length ? answers.shift() : 1 },
    Run: (cmd, style, wait) => { calls.run.push(cmd); return 0 },
    RegRead: (key) => { if (!(key in calls.reg)) throw new Error('нет ключа'); return calls.reg[key] },
    RegWrite: (key, value, type) => { calls.reg[key] = value },
    RegDelete: (key) => { if (!(key in calls.reg)) throw new Error('нет ключа'); delete calls.reg[key] },
  }
  const fso = {
    FolderExists: (p) => { calls.exists.push(p); return folders.includes(p) },
    FileExists: (p) => { calls.exists.push(p); return fileSet.has(p) },
    GetParentFolderName: (p) => p.slice(0, p.lastIndexOf('\\')),
    CreateFolder: () => {},
    DeleteFile: (p) => { calls.deleted.push(p); fileSet.delete(p) },
  }
  const stream = () => {
    let loaded = null
    return { Open() {}, Close() {}, LoadFromFile(p) { loaded = p }, SaveToFile(p, mode) { calls.saved.push({ from: loaded, to: p, mode }); fileSet.add(p) } }
  }
  const sandbox = {
    WScript: { ScriptFullName: 'C:\\Users\\u\\Downloads\\osp-folder.cmd', Arguments: { length: args.length, Item: (i) => args[i] } },
    ActiveXObject: function ActiveXObject(name) {
      if (name === 'WScript.Shell') return shell
      if (name === 'Scripting.FileSystemObject') return fso
      if (name === 'ADODB.Stream') return stream()
      throw new Error(`нет объекта ${name}`)
    },
  }
  vm.runInNewContext(jscript, sandbox)
  return calls
}

const KEY = 'HKCU\\Software\\Classes\\osp-folder\\'
const HANDLER = 'C:\\Users\\u\\AppData\\Local\\OSP\\osp-folder.js'

describe('Помощник «Открыть папку» (public/tools/osp-folder.cmd)', () => {
  it('файл: пакетная часть запускает себя в wscript, JScript — ES3, вне комментариев только ASCII, строки CRLF', () => {
    const lines = helperText.split('\n')
    assert.match(lines[0], /^@if \(@X\)==\(@Y\) @end \/\*/, 'первая строка — гибрид cmd/JScript')
    assert.ok(helperText.includes('wscript.exe" //E:JScript //Nologo "%~f0" %*'))
    // В рабочей копии — CRLF (.gitattributes): с LF cmd.exe ошибается в разборе.
    assert.ok(lines.slice(0, -1).every((l) => l.endsWith('\r')), 'строки CRLF')
    const nonAscii = lines.filter((l) => /[^\x00-\x7f]/.test(l) && !/^\s*\/\//.test(l))
    assert.deepEqual(nonAscii, [], 'кириллица вне комментариев — кодами \\uXXXX')
    let acorn
    try { acorn = createRequire(import.meta.url)('acorn') } catch { acorn = null }
    if (acorn) assert.doesNotThrow(() => acorn.parse(jscript, { ecmaVersion: 3 }), 'синтаксис ES3 (JScript 5.8)')
  })

  it('ссылка сайта → тот же путь; папка — в проводнике, файл — выделен в папке, корень диска — без кавычек', () => {
    const unc = '\\\\192.168.2.55\\SharA_Tender\\СУБПОДРЯДЫ ДОГОВОРА И ДС\\ЖК Альфа'
    let c = runHelper([folderOpenUrl(unc)], { folders: [unc] })
    assert.deepEqual(c.run, [`"C:\\Windows\\explorer.exe" "${unc}"`])
    assert.deepEqual(c.popup, [])

    // Хвостовая «\» и «/», которую может дописать браузер, не мешают.
    c = runHelper([folderOpenUrl('\\\\su10-fs\\Тендеры\\') + '/'], { folders: ['\\\\su10-fs\\Тендеры\\'] })
    assert.deepEqual(c.run, ['"C:\\Windows\\explorer.exe" "\\\\su10-fs\\Тендеры"'])

    const file = '\\\\su10-fs\\ДС\\setup.exe'
    c = runHelper([folderOpenUrl(file)], { files: [file] })
    assert.deepEqual(c.run, [`"C:\\Windows\\explorer.exe" /select,"${file}"`], 'файл не запускается — только выделяется')

    c = runHelper([folderOpenUrl('Z:\\')], { folders: ['Z:\\'] })
    assert.deepEqual(c.run, ['"C:\\Windows\\explorer.exe" Z:\\'])
    c = runHelper([folderOpenUrl('\\\\fs.su10.local\\Общая')], { folders: ['\\\\fs.su10.local\\Общая'] })
    assert.equal(c.run.length, 1, 'сервер в домене компании')

    // Нет папки — сообщение, проводник не запускается.
    c = runHelper([folderOpenUrl('\\\\su10-fs\\Нет такой')])
    assert.deepEqual(c.run, [])
    assert.match(c.popup[0].text, /^Папка не найдена или к ней нет доступа:\n\\\\su10-fs\\Нет такой/)
  })

  it('чужой сервер, не путь Windows и попытки подставить команду — отказ без обращения к диску и сети', () => {
    const bad = [
      'osp-folder:' + encodeURIComponent('\\\\evil.example.com\\share'),
      'osp-folder:' + encodeURIComponent('\\\\8.8.8.8\\share'),
      'osp-folder:' + encodeURIComponent('\\\\host@SSL@443\\dav'),
      'osp-folder:' + encodeURIComponent('\\\\?\\C:\\Windows'),
      'osp-folder:' + encodeURIComponent('\\\\.\\pipe\\x'),
      'osp-folder:' + encodeURIComponent('C:\\x" & calc & "'),
      'osp-folder:x\' & calc',
      'osp-folder:' + encodeURIComponent('https://example.com'),
      'osp-folder:%E0%A4%A',
      'calc.exe',
    ]
    for (const url of bad) {
      const c = runHelper([url], { folders: ['C:\\Windows', 'C:\\x'] })
      assert.deepEqual(c.run, [], url)
      assert.deepEqual(c.exists, [], `${url}: к диску и сети не обращались`)
      assert.equal(c.popup.length, 1, url)
    }
    assert.match(runHelper(['osp-folder:' + encodeURIComponent('\\\\evil.example.com\\share')]).popup[0].text, /^Сервер не из локальной сети/)
  })

  it('двойной щелчок — установка для пользователя: копия файла и схема osp-folder; повторно — заново или удалить', () => {
    let c = runHelper([], { answers: [6] })
    assert.equal(c.popup[0].type, 4 + 32, 'вопрос «Да / Нет»')
    assert.deepEqual(c.saved, [{ from: 'C:\\Users\\u\\Downloads\\osp-folder.cmd', to: HANDLER, mode: 2 }])
    assert.equal(c.reg[KEY], 'URL:OSP folder')
    assert.equal(c.reg[`${KEY}URL Protocol`], '')
    assert.equal(c.reg[`${KEY}shell\\open\\command\\`],
      `"C:\\Windows\\System32\\wscript.exe" //E:JScript //Nologo "${HANDLER}" "%1"`)
    assert.match(c.popup.at(-1).text, /^Готово\./)

    // «Нет» на первый вопрос — ничего не ставится.
    c = runHelper([], { answers: [7] })
    assert.deepEqual(c.saved, [])
    assert.deepEqual(Object.keys(c.reg), [])

    // Уже установлен: «Нет» — удалить (ключи и файл), «Отмена» — ничего.
    const registry = { [KEY]: 'URL:OSP folder', [`${KEY}shell\\`]: '', [`${KEY}shell\\open\\`]: '', [`${KEY}shell\\open\\command\\`]: 'cmd' }
    c = runHelper([], { registry, files: [HANDLER], answers: [7] })
    assert.equal(c.popup[0].type, 3 + 32, 'вопрос «Да / Нет / Отмена»')
    assert.deepEqual(Object.keys(c.reg), [])
    assert.deepEqual(c.deleted, [HANDLER])
    c = runHelper([], { registry, files: [HANDLER], answers: [2] })
    assert.equal(Object.keys(c.reg).length, 4)
    assert.deepEqual(c.saved, [])
    c = runHelper(['/uninstall'], { registry, files: [HANDLER] })
    assert.deepEqual(Object.keys(c.reg), [])
  })
})

describe('Ссылка «открыть папку» на сайте', () => {
  it('путь к папке Windows — сетевой или диск; ссылка без пробелов, кавычек и «\\»; только Windows', () => {
    for (const p of ['\\\\su10-fs\\Тендеры\\412 Кровля', ' \\\\192.168.2.55\\SharA_Tender ', 'Z:\\ДС\\2026']) assert.ok(isFolderPath(p), p)
    for (const p of ['', null, 'https://drive.google.com/x', '\\\\server', 'Папка тендера', '\\\\ \\x']) assert.ok(!isFolderPath(p), String(p))
    const url = folderOpenUrl(' \\\\su10-fs\\Тендеры\\ЖК "Альфа" & Ко ')
    assert.match(url, /^osp-folder:[A-Za-z0-9%._~!*'()-]+$/)
    assert.equal(decodeURIComponent(url.slice('osp-folder:'.length)), '\\\\su10-fs\\Тендеры\\ЖК "Альфа" & Ко')
    assert.ok(canOpenFolders('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'))
    assert.ok(!canOpenFolders('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile'))
    assert.ok(!canOpenFolders('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605'))
    assert.equal(FOLDER_HELPER_URL, '/tools/osp-folder.cmd')
  })
})

const launch = browserLaunchOptions()
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

describe('Нажатие на путь к папке', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser
  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  // Переходы на osp-folder: перехватываются и записываются — в безголовом Chromium помощника нет.
  async function openPage(query, ready, { windows = true } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1700, height: 1000 }, ...(windows ? { userAgent: WINDOWS_UA } : {}) })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.dismiss().catch(() => {}) })
    await page.addInitScript(() => {
      window.__folderOpens = []
      document.addEventListener('click', (e) => {
        const a = e.target.closest?.('a[href^="osp-folder:"]')
        if (a) { e.preventDefault(); window.__folderOpens.push(a.getAttribute('href')) }
      }, true)
    })
    await page.goto(`${stand.url}?${query}`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const opens = (page) => page.evaluate(() => window.__folderOpens)

  it('«Заявки на ДС»: в первый раз — окно с помощником, затем папка открывается сразу; «Не открылась?» — то же окно', async () => {
    const { page, errors, close } = await openPage('route=/dc-requests&dcStats=1&latency=0', '.dcr-table tbody tr')
    try {
      const path = '\\\\192.168.2.55\\SharA_Tender\\ДС\\ЖК Альфа\\ДС-14'
      const row = page.locator('.dcr-table tbody tr', { hasText: 'ДС-d2' })
      await row.getByRole('button', { name: 'Указать путь к папке' }).click()
      await row.locator('.dcr-folder-path-input').fill(path)
      await row.locator('.dcr-folder-path-input').press('Enter')
      const text = row.locator('.dcr-folder-path-text.is-openable')
      await text.waitFor({ timeout: 10000 })
      assert.equal(await text.getAttribute('title'), `Открыть папку в проводнике:\n${path}`)

      await text.click()
      const help = page.getByRole('dialog', { name: 'Открыть папку в проводнике' })
      await help.waitFor({ timeout: 5000 })
      assert.equal(await help.locator('.fopen-path').textContent(), path)
      assert.equal(await help.getByRole('link', { name: 'Скачать помощник' }).getAttribute('href'), '/tools/osp-folder.cmd')
      assert.deepEqual(await opens(page), [], 'до установки помощника — не переходим')
      await help.getByRole('button', { name: 'Открыть папку' }).click()
      await help.waitFor({ state: 'detached', timeout: 5000 })
      assert.deepEqual(await opens(page), [folderOpenUrl(path)])

      // Второй раз — сразу, внизу подсказка; «Не открылась?» — окно с помощником.
      await text.click()
      assert.deepEqual(await opens(page), [folderOpenUrl(path), folderOpenUrl(path)])
      const toast = page.locator('.fopen-toast')
      await toast.waitFor({ timeout: 5000 })
      assert.equal(await help.count(), 0)
      await toast.getByRole('button', { name: 'Не открылась?' }).click()
      await help.waitFor({ timeout: 5000 })
      await page.keyboard.press('Escape')
      await help.waitFor({ state: 'detached', timeout: 5000 })
      // Копирование — как раньше, отдельной кнопкой.
      assert.equal(await row.getByRole('button', { name: 'Скопировать путь к папке' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('реестр тендеров (FolderPathCell): нажатие на путь открывает папку; не на Windows — путь разворачивается, как раньше', async () => {
    const query = 'route=/tenders/construction&tenders=6&items=20&cps=2&latency=0'
    const win = await openPage(query, 'table.tenders-registry > tbody > tr')
    try {
      await win.page.evaluate(() => localStorage.setItem('osp:folderHelperReady', '1'))
      const text = win.page.locator('.fpath-text.is-openable').first()
      await text.waitFor({ timeout: 10000 })
      const full = (await text.getAttribute('title')).split('\n')[1]
      assert.match(full, /^\\\\su10-fs\\Тендеры\\.+\\Тендер \d+$/)
      await text.click()
      assert.deepEqual(await opens(win.page), [folderOpenUrl(full)])
      await win.page.locator('.fopen-toast').waitFor({ timeout: 5000 })
      assert.equal(await win.page.locator('.fpath.is-expanded').count(), 0)
      assert.deepEqual(win.errors, [])
    } finally { await win.close() }

    const other = await openPage(query, 'table.tenders-registry > tbody > tr', { windows: false })
    try {
      assert.equal(await other.page.locator('.fpath-text.is-openable').count(), 0)
      await other.page.locator('.fpath-text').first().click()
      await other.page.locator('.fpath.is-expanded').waitFor({ timeout: 5000 })
      assert.deepEqual(await opens(other.page), [])
      assert.equal(await other.page.locator('.fopen-overlay').count(), 0)
      assert.deepEqual(other.errors, [])
    } finally { await other.close() }
  })
})
