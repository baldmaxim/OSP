// Клиент хранилища в osp-api (defaultDeps.createS3) — со сроками (19.11.2026: загрузка в «Должную осмотрительность» «зависала»).
// Без них запрос по соединению, которое оборвалось по дороге без уведомления, ждал ответа без конца: подтверждение загрузки
// (HeadObject) висело до 504 от nginx. Здесь хранилище «молчит»: принимает соединение и не отвечает — запрос должен закончиться
// ошибкой TimeoutError, а SDK — повторить его на новом соединении. Без зависимостей службы набор пропускается.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'osp-api')
const noDeps = !fs.existsSync(path.join(SERVER, 'node_modules', '@aws-sdk', 'client-s3')) && 'нет зависимостей: npm ci --prefix server/osp-api'

describe('osp-api: клиент хранилища со сроками', { skip: noDeps }, () => {
  let silent
  let port
  const sockets = new Set()
  let connections = 0
  before(async () => {
    silent = net.createServer((socket) => { connections += 1; sockets.add(socket) }) // принимает и молчит
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
    port = silent.address().port
  })
  after(async () => {
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => silent.close(resolve))
  })

  it('по умолчанию: соединение — до 5 с, тишина в сокете — до 20 с', async () => {
    const { defaultDeps, S3_CONNECT_TIMEOUT_MS, S3_REQUEST_TIMEOUT_MS } = await import(path.join(SERVER, 'src', 'app.js'))
    assert.equal(S3_CONNECT_TIMEOUT_MS, 5000)
    assert.equal(S3_REQUEST_TIMEOUT_MS, 20000)
    const client = defaultDeps.createS3({ endpoint: `http://127.0.0.1:${port}`, region: 'ru-central-1', accessKeyId: 'a', secretAccessKey: 'b' })
    const handler = client.config.requestHandler
    const cfg = await (handler.configProvider || Promise.resolve(handler.config))
    assert.equal(cfg.connectionTimeout, 5000)
    assert.equal(cfg.requestTimeout, 20000)
    client.destroy()
  })

  it('хранилище молчит — HeadObject заканчивается TimeoutError, SDK повторяет на новом соединении', async () => {
    const { defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    const { createRequire } = await import('node:module')
    const { HeadObjectCommand } = createRequire(path.join(SERVER, 'package.json'))('@aws-sdk/client-s3')
    const client = defaultDeps.createS3({ endpoint: `http://127.0.0.1:${port}`, region: 'ru-central-1', accessKeyId: 'a', secretAccessKey: 'b', requestTimeoutMs: 300 })
    const started = Date.now()
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: 'osp', Key: 'k' })), (e) => e.name === 'TimeoutError')
    assert.ok(Date.now() - started < 10000, `закончилось за ${Date.now() - started} мс, а не висит`)
    assert.ok(connections >= 2, `повтор — новым соединением: ${connections}`)
    client.destroy()
  })
})
