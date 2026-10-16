// Справочник ролей (src/contexts/useAvailableRoles.js) в настоящем браузере:
//   • до входа — встроенные роли, запроса к базе нет (гостю база отдаёт пустой список без ошибки);
//   • после входа — справочник из базы без перезагрузки страницы (раньше читался только при открытии сайта:
//     вход с формы входа давал «0 ролей» и пустые списки);
//   • выход, вход другого пользователя, ошибка, пустой ответ — встроенные роли;
//   • поздний ответ для прежнего пользователя не перезаписывает справочник нового; ручное обновление перечитывает.
// Стенд — страница на vite с React, где хук получает подделку запроса к базе.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { browserLaunchOptions, REPO } from '../tender/lib/stand.mjs'
import { ROLE_LABELS } from '../../src/contexts/roleConstants.js'

const launch = browserLaunchOptions()
const BUILTIN = Object.keys(ROLE_LABELS)
const FROM_DB = Array.from({ length: 17 }, (_, i) => `role_${i + 1}`)

const MAIN = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAvailableRoles } from '${path.join(REPO, 'src', 'contexts', 'useAvailableRoles.js').replace(/\\/g, '/')}'

// Ответы «базы» — по очереди из window.__replies: { keys, error, delay }.
window.__calls = []
window.__replies = []
const load = async () => {
  const reply = window.__replies.shift() || { keys: [] }
  window.__calls.push(reply.tag || '')
  await new Promise((r) => setTimeout(r, reply.delay || 0))
  return { data: reply.error ? null : reply.keys.map((key) => ({ key, label: key, is_system: false })), error: reply.error ? { message: reply.error } : null }
}
function App() {
  const [userId, setUserId] = useState(null)
  const [roles, refresh] = useAvailableRoles(userId, load)
  window.__setUser = setUserId
  window.__refresh = refresh
  return <pre id="roles">{JSON.stringify(roles.map((r) => r.key))}</pre>
}
createRoot(document.getElementById('root')).render(<App />)
`

describe('Справочник ролей: после входа — из базы, без перезагрузки страницы', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 120000 }, () => {
  let server, browser, page, tmp

  const roles = async () => JSON.parse(await page.textContent('#roles'))
  const calls = () => page.evaluate(() => window.__calls.length)
  const waitRoles = async (expected) => {
    const deadline = Date.now() + 5000
    let last
    while (Date.now() < deadline) {
      last = await roles()
      if (JSON.stringify(last) === JSON.stringify(expected)) return last
      await new Promise((r) => setTimeout(r, 50))
    }
    return last
  }

  before(async () => {
    // Внутри проекта: отсюда vite находит react в node_modules. Каталог удаляется после теста.
    tmp = fs.mkdtempSync(path.join(REPO, 'tests', 'release', '.roles-stand-'))
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/main.jsx"></script>')
    fs.writeFileSync(path.join(tmp, 'main.jsx'), MAIN)
    const port = 32300 + Math.floor(Math.random() * 300)
    server = await createServer({
      configFile: false, root: tmp, logLevel: 'error', plugins: [react()],
      resolve: { dedupe: ['react', 'react-dom'] },
      server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [REPO, tmp] } },
      optimizeDeps: { include: ['react', 'react-dom/client'] },
    })
    await server.listen()
    browser = await chromium.launch({ headless: true, ...launch })
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/index.html`)
    await page.waitForSelector('#roles')
  })
  after(async () => {
    await browser?.close()
    await server?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('до входа — встроенные роли, запроса к базе нет', async () => {
    assert.deepEqual(await roles(), BUILTIN)
    assert.equal(await calls(), 0)
  })

  it('вход — справочник из базы без перезагрузки; выход — встроенные без запроса', async () => {
    await page.evaluate((keys) => { window.__replies.push({ keys }); window.__setUser('u1') }, FROM_DB)
    assert.deepEqual(await waitRoles(FROM_DB), FROM_DB)
    assert.equal(await calls(), 1)
    await page.evaluate(() => window.__setUser(null))
    assert.deepEqual(await waitRoles(BUILTIN), BUILTIN)
    assert.equal(await calls(), 1, 'после выхода база не спрашивается')
  })

  it('ошибка и пустой ответ вошедшему — встроенные роли, а не пустой список', async () => {
    await page.evaluate(() => { window.__replies.push({ error: 'сбой сети' }); window.__setUser('u2') })
    assert.deepEqual(await waitRoles(BUILTIN), BUILTIN)
    await page.evaluate(() => { window.__replies.push({ keys: [] }); window.__refresh() })
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(await roles(), BUILTIN)
    assert.equal(await calls(), 3)
  })

  it('поздний ответ для прежнего пользователя не перезаписывает справочник нового; обновление перечитывает', async () => {
    await page.evaluate(() => window.__setUser(null))
    await page.evaluate(() => {
      window.__replies.push({ keys: ['stale'], delay: 600, tag: 'u3' }, { keys: ['fresh_1', 'fresh_2'], tag: 'u4' })
      window.__setUser('u3')
    })
    await new Promise((r) => setTimeout(r, 50))
    await page.evaluate(() => window.__setUser('u4'))
    assert.deepEqual(await waitRoles(['fresh_1', 'fresh_2']), ['fresh_1', 'fresh_2'])
    await new Promise((r) => setTimeout(r, 900))
    assert.deepEqual(await roles(), ['fresh_1', 'fresh_2'], 'ответ для u3 пришёл позже и не применился')
    await page.evaluate((keys) => { window.__replies.push({ keys }); window.__refresh() }, FROM_DB)
    assert.deepEqual(await waitRoles(FROM_DB), FROM_DB)
  })
})
