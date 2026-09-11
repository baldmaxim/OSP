// Параллельная постраничная загрузка из PostgREST (потолок — 1000 строк за запрос).
//
// Последовательный обход на 30 000 строк — это 30 запросов подряд, каждый ждёт
// предыдущий. Здесь первый запрос заодно возвращает общее число строк, и
// остальные страницы идут одновременно (не больше `concurrency` за раз).
//
// `makeQuery(from, to, withCount)` каждый раз создаёт НОВЫЙ запрос с `.range(from, to)`;
// при withCount=true — `select(cols, { count: 'exact' })`. Сортировка обязана быть
// однозначной (с тай-брейком по id) — страницы склеиваются по номеру.
//
// Модуль без зависимостей: его используют и страницы, и тесты.
export async function fetchAllRowsParallel(makeQuery, { page = 1000, concurrency = 4 } = {}) {
  const first = await makeQuery(0, page - 1, true)
  if (first.error) throw first.error
  const pages = [first.data || []]
  if (pages[0].length < page) return pages[0]

  const total = Number.isFinite(first.count) ? first.count : null
  if (total != null) {
    const pageCount = Math.ceil(total / page)
    let next = 1
    const worker = async () => {
      while (next < pageCount) {
        const index = next++
        const from = index * page
        const { data, error } = await makeQuery(from, from + page - 1, false)
        if (error) throw error
        pages[index] = data || []
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(pageCount - 1, 0)) }, worker))
  }

  // Строки могли добавиться после подсчёта (или count недоступен) — дочитываем хвост.
  for (let index = pages.length; pages[pages.length - 1]?.length === page; index++) {
    const from = index * page
    const { data, error } = await makeQuery(from, from + page - 1, false)
    if (error) throw error
    pages[index] = data || []
  }
  return pages.flat()
}
