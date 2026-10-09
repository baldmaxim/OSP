// Значение флага: config.json (для всех) и localStorage одного браузера (?features=, пилот).
// Явное false в config.json — выключатель для всех, включая пилотные браузеры: откат одним правом
// файла на сервере. Иначе локальное значение браузера, затем config.json, затем значение по умолчанию.
// Модуль чистый — проверяется в tests/osp-api/client.test.mjs.
export function resolveFeature(name, configFeatures = {}, localFeatures = {}, fallback = false) {
  if (configFeatures[name] === false) return false
  if (typeof localFeatures[name] === 'boolean') return localFeatures[name]
  if (typeof configFeatures[name] === 'boolean') return configFeatures[name]
  return fallback
}

// Флаги из config.json: берутся только логические значения.
export function parseFeatures(raw) {
  const features = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return features
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') features[name] = value
  }
  return features
}

// Флаги после повторного чтения config.json в уже открытой вкладке — выключатель без перезагрузки:
//   'ok'     — файл прочитан: его флаги (нет поля features — все выключены);
//   'absent' — файла нет (404, вместо JSON — index.html): все выключены, как при старте;
//   'error'  — сбой сети, таймаут, ошибка сервера, битый JSON: прежние значения.
export function nextFeatures(current, result) {
  if (result?.status === 'ok') return parseFeatures(result.raw?.features)
  if (result?.status === 'absent') return {}
  return current
}
