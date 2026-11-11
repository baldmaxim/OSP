import { IconComment } from '../icons/ActionIcons'
import { IconMail } from '../icons/ToolbarIcons'
import { safeHttpUrl } from '../../utils/publicTenders'
import { plural } from '../../utils/taskHelpers'

// Что внутри заявки — на карточке доски и в строке реестра: сколько сообщений и ссылка на письмо (с 11.11.2026 её не вводят
// при создании, но у прежних заявок она есть). Письмо открывается сразу, в новой вкладке: щелчок не открывает карточку
// заявки, а перетаскивать карточку можно и за ссылку. В href попадает только http(s): значение вводил человек, и
// javascript:… выполнился бы по щелчку.
//
// Есть непрочитанные сообщения коллег (11.11.2026, docCheckTalkRead.js) — счётчик залит цветом; сколько новых — в подсказке.
export default function DocCheckCardCounts({ request }) {
  const messages = request.commentsCount || 0
  const unread = Math.min(request.unreadCount || 0, messages)
  const mail = safeHttpUrl(request.email_link)
  const talkTitle = `Обсуждение: ${messages} ${plural(messages, 'сообщение', 'сообщения', 'сообщений')}`
  return (
    <>
      {messages > 0 && (
        <span
          className={`dc-count dc-count--talk${unread ? ' is-unread' : ''}`}
          title={unread ? `${talkTitle}, непрочитанных: ${unread}` : talkTitle}
          aria-label={unread ? `${talkTitle}, непрочитанных: ${unread}` : undefined}
        ><IconComment size={12} />{messages}</span>
      )}
      {mail && (
        <a
          className="dc-chip dc-chip--mail"
          href={mail}
          target="_blank"
          rel="noopener noreferrer"
          draggable={false}
          title={`Открыть письмо: ${request.email_link}`}
          onClick={(e) => e.stopPropagation()}
        ><IconMail size={11} />Письмо</a>
      )}
    </>
  )
}
