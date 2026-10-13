// Барьер записи на время переноса данных: есть файл-переключатель (OSP_DB_READONLY_FILE) — сервер
// только читает. Один на все маршруты, которые меняют данные: шлюз /api/db (src/routes/dbGateway.js) и
// файлы документов (src/routes/s3Presign.js) — иначе при закрытом шлюзе файл всё равно можно было бы
// загрузить или удалить, и возврат на прежнюю базу перестал бы быть чистым.
//
// Файл проверяется не чаще раза в секунду. Каталог файла должен быть доступен службе: иначе «файла нет»
// и «файл не виден» неразличимы, и барьер молча не сработал бы — такая настройка останавливает запуск.
import fs from 'node:fs'
import path from 'node:path'

export const READONLY_CODE = 'OSP_READONLY'
export const READONLY_TEXT = 'Идёт перенос данных: запись временно недоступна. Повторите через несколько минут.'

export function createWriteBarrier({ file = '', enabled = true, intervalMs = 1000, now = Date.now } = {}) {
  if (!enabled || !file) return () => false
  try {
    fs.accessSync(path.dirname(file), fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    throw new Error('osp-api: каталог файла-переключателя барьера записи (OSP_DB_READONLY_FILE) недоступен службе')
  }
  let state = { at: -Infinity, value: false }
  return () => {
    if (now() - state.at > intervalMs) state = { at: now(), value: fs.existsSync(file) }
    return state.value
  }
}
