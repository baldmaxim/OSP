// Скачать документ по ссылке, а не открыть его (30.10.2026, «Скачать ДП» в окне письма подрядчикам): ссылка на
// документ Google ведёт на страницу редактора, файл отдаёт другой адрес — его и берёт downloadLinkFile
// (components/FileDownload.jsx). Google Docs / Таблицы / Презентации — выгрузка …/export?format=docx|xlsx|pptx (у
// файла Word, открытого в Google, — тот же файл байт в байт), файл Google Диска — drive.usercontent.google.com.
// Оба адреса разрешают чтение со страницы сайта (CORS), если доступ к документу — «все, у кого есть ссылка».
// Прочие http(s)-ссылки — как есть; сетевой путь и не ссылка — null.

const GOOGLE_EXPORT = { document: 'docx', spreadsheets: 'xlsx', presentation: 'pptx' }
const GOOGLE_ID = /^[A-Za-z0-9_-]+$/

export function directDownloadUrl(link) {
  let url
  try {
    url = new URL(String(link || '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const resourceKey = url.searchParams.get('resourcekey')
  const withKey = (href) => (resourceKey ? `${href}&resourcekey=${encodeURIComponent(resourceKey)}` : href)
  if (host === 'docs.google.com') {
    const m = url.pathname.match(/^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)
    if (m) return withKey(`https://docs.google.com/${m[1]}/d/${m[2]}/export?format=${GOOGLE_EXPORT[m[1]]}`)
  }
  if (host === 'drive.google.com') {
    const id = url.pathname.match(/^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)?.[1] || url.searchParams.get('id')
    if (id && GOOGLE_ID.test(id)) return withKey(`https://drive.usercontent.google.com/download?id=${id}&export=download`)
  }
  return url.href
}

// Имя файла из Content-Disposition: filename* (UTF-8, RFC 5987) важнее filename — в нём Google заменяет кириллицу
// подчёркиваниями. Без имени — ''.
export function fileNameFromDisposition(header) {
  const text = String(header || '')
  let name = ''
  const star = text.match(/filename\*\s*=\s*([^;]+)/i)
  if (star) {
    const value = star[1].trim().replace(/^"(.*)"$/, '$1')
    const m = value.match(/^[\w-]*'[^']*'(.*)$/)
    try {
      name = decodeURIComponent(m ? m[1] : value)
    } catch {
      name = ''
    }
  }
  if (!name) {
    const plain = text.match(/filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i)
    if (plain) name = (plain[1] ?? plain[2] ?? '').replace(/\\(.)/g, '$1').trim()
  }
  // Только имя: без пути и знаков, которые Windows не примет в имени файла.
  const base = name.split(/[\\/]/).pop()
  return [...base].filter(ch => ch.charCodeAt(0) >= 32 && !'<>:"|?*'.includes(ch)).join('').trim()
}
