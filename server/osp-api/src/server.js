// Запуск osp-api. На VPS — служба systemd (deploy/osp-api.service), слушает 127.0.0.1:8787,
// снаружи доступна только через nginx (location ^~ /api/, docs/DEPLOYMENT.md).
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

let config
try {
  config = loadConfig()
} catch (err) {
  // Неверная настройка (например, OSP_API_REQUIRE): не запускаемся — выкладка увидит отказ.
  console.error(`osp-api: ${err.message}`)
  process.exit(1)
}
const app = buildApp({ config })

let stopping = false
async function stop(signal) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'stopping')
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (err) {
  app.log.error({ msg: err.message }, 'listen failed')
  process.exit(1)
}
