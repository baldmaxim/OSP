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
