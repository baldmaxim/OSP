// Запуск osp-api. На VPS — служба systemd (deploy/osp-api.service), слушает 127.0.0.1:8787,
// снаружи доступна только через nginx (location ^~ /api/, docs/DEPLOYMENT.md).
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
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
