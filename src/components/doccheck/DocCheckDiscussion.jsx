import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import DocCheckGrowingField from './DocCheckGrowingField'
import { addComment } from '../../services/docCheckCard'
import { MAX_COMMENT_LENGTH } from '../../utils/docCheckHelpers'
import { isUnreadMessage } from '../../utils/docCheckTalkRead'
import { formatDateTimeRu } from '../../utils/taskHelpers'

// Обсуждение заявки — по образцу обсуждения задачи: автор, время, текст; свои сообщения прижаты вправо. Написать может
// любой, кто видит раздел. Автора и время ставит база, поэтому подделать их нельзя; сообщения только добавляются.
//
// С 11.11.2026 (решение пользователя: «переписку разместить справа, на общем») — не вкладка, а панель справа на вкладке
// «Общая»: заголовок с числом сообщений, переписка прокручивается сама по себе, поле ввода — у нижнего края. На телефоне
// панель стоит под сведениями заявки и прокручивается вместе с окном.
//
// Непрочитанные (11.11.2026, docCheckTalkRead.js): сообщения коллег позже unreadAfter — цветом и с пометкой «новое», перед
// первым — черта «Новые сообщения»; окно открывается на ней, если новых больше, чем видно.
export default function DocCheckDiscussion({
  requestId, comments, onCommentsChange, currentUserId, unreadAfter = Number.POSITIVE_INFINITY, canWrite, state, onRetry,
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // Не даёт отправить дважды (Enter, нажатый снова до ответа базы).
  const sendingRef = useRef(false)
  const listRef = useRef(null)
  const newMarkRef = useRef(null)
  // Первое положение — после первой загрузки: на черте новых; дальше (своё сообщение, новые коллег) — конец переписки.
  const placed = useRef(false)

  const unreadIds = new Set(comments.filter(c => isUnreadMessage(c, currentUserId, unreadAfter)).map(c => c.id))
  const firstUnreadId = comments.find(c => unreadIds.has(c.id))?.id

  // Новые сообщения — внизу, поле ввода — под ними: при открытии и после отправки показываем конец переписки. Прокручивается
  // только сама переписка: на телефоне своей прокрутки у неё нет, и окно со сведениями заявки остаётся на месте.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    if (state !== 'ready' || placed.current) return
    placed.current = true
    const mark = newMarkRef.current
    if (!mark) return
    const above = mark.getBoundingClientRect().top - list.getBoundingClientRect().top
    if (above < 0) list.scrollTop += above - 8
  }, [comments.length, state])

  const send = async () => {
    const body = text.trim()
    if (!body || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    try {
      const row = await addComment(requestId, body)
      onCommentsChange(prev => [...prev, row])
      setText('')
    } catch (err) {
      // Текст остаётся в поле: написанное не должно пропасть из-за сбоя сети.
      alert('Не удалось отправить сообщение: ' + (err.message || err))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const ready = state === 'ready'
  return (
    <section className="dc-talk" aria-label="Обсуждение">
      <h4 className="dc-talk-title">
        Обсуждение
        {ready && comments.length > 0 && <span className="dc-tab-count">{comments.length}</span>}
      </h4>
      <div className="dc-talk-list" ref={listRef}>
        {state === 'loading' && <p className="dc-muted">Загрузка…</p>}
        {state === 'error' && (
          <p className="dc-muted">
            Не удалось загрузить.{' '}
            <button type="button" className="dc-retry" onClick={onRetry}>Повторить</button>
          </p>
        )}
        {ready && comments.length === 0 && <p className="dc-muted">Сообщений пока нет.</p>}
        {ready && comments.map(c => {
          const unread = unreadIds.has(c.id)
          const mine = c.author_user_id && c.author_user_id === currentUserId
          return (
            <Fragment key={c.id}>
              {c.id === firstUnreadId && (
                <div className="dc-talk-new-mark" ref={newMarkRef} role="separator">
                  <span>{unreadIds.size === 1 ? 'Новое сообщение' : `Новые сообщения: ${unreadIds.size}`}</span>
                </div>
              )}
              <div className={`dc-talk-msg${mine ? ' is-mine' : ''}${unread ? ' is-unread' : ''}`}>
                <div className="dc-talk-head">
                  <b>{c.author_name || 'Сотрудник'}</b>
                  {unread && <span className="dc-talk-new">новое</span>}
                  <span className="dc-talk-time">{formatDateTimeRu(c.created_at)}</span>
                </div>
                <p className="dc-talk-body">{c.body}</p>
              </div>
            </Fragment>
          )
        })}
      </div>
      {ready && canWrite && (
        <div className="dc-inline-add dc-talk-add">
          <DocCheckGrowingField
            value={text}
            onChange={setText}
            onSubmit={send}
            maxLength={MAX_COMMENT_LENGTH}
            placeholder="Написать сообщение…"
            aria-label="Новое сообщение"
            title="Enter — отправить. Shift+Enter — новая строка"
          />
          <button type="button" className="btn-primary" disabled={sending || !text.trim()} onClick={send}>Отправить</button>
        </div>
      )}
    </section>
  )
}
