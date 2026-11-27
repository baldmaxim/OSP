// Нормализация имени для сопоставления (контрагенты, объекты, папки Signal). Общий код сайта и службы osp-api:
// копия — server/osp-api/src/shared/matchName.js (node scripts/sync-osp-api-shared.mjs). Файл без импортов.
// Нормализация имени контрагента/объекта для сопоставления:
// убираем кавычки (обычные/типографские), схлопываем пробелы, ё→е, нижний регистр.
export function normMatchName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»""„"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
