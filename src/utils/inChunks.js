// Список id в .in() уходит в адрес запроса, а у адреса есть предел: шлюз tender.su10.ru — 8 КБ
// (общий nginx сервера), Supabase — около 16 КБ. Один UUID в адресе — 39 байт (с запятой %2C),
// поэтому список на все тендеры или договоры реестра (сотни id) одним запросом не проходит
// (задача 402). Порция в 100 id — ~3,9 КБ, с запасом на select и остальные фильтры.
export const IN_CHUNK = 100

export function chunkList(list, size = IN_CHUNK) {
  const chunks = []
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size))
  return chunks
}
