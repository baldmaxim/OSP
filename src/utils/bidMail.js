// Письмо с КП в отдел из кабинета подрядчика (просьба пользователя 25.11.2026: КП фиксируется письмом на почту отдела, адрес —
// кликабельный). Ящик — общий, тот же, что в письме подрядчикам (siteContacts.js). Ссылка mailto вложения не добавляет — текст
// напоминает приложить файлы ВОР с ценами.
import { TENDER_MAILBOX } from './siteContacts.js'

export { TENDER_MAILBOX }

export function kpMailHref(tender, company) {
  const number = tender?.public_tender_number
  const object = tender?.objects?.name
  const subject = `КП по тендеру${number != null ? ` № ${number}` : ''}${company ? ` — ${company}` : ''}`
  const body = `Добрый день!\n\nНаправляем КП${number != null ? ` по тендеру № ${number}` : ''}${object ? ` (${object})` : ''}.\n`
    + 'Файлы ВОР с ценами — во вложении.\n'
  return `mailto:${TENDER_MAILBOX}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
