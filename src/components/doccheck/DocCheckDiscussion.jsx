import { useLayoutEffect, useRef, useState } from 'react'
import DocCheckGrowingField from './DocCheckGrowingField'
import { addComment } from '../../services/docCheckCard'
import { MAX_COMMENT_LENGTH } from '../../utils/docCheckHelpers'
import { formatDateTimeRu } from '../../utils/taskHelpers'

// Обсуждение заявки — по образцу обсуждения задачи: автор, время, текст; свои сообщения прижаты вправо. Написать может
// любой, кто видит раздел. Автора и время ставит база, поэтому подделать их нельзя; сообщения только добавляются.
export default function DocCheckDiscussion({ requestId, comments, onCommentsChange, currentUserId, canWrite }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // Не даёт отправить дважды (Enter, нажатый снова до ответа базы).
  const sendingRef = useRef(false)
  const rootRef = useRef(null)

  // Новые сообщения — внизу, поле ввода — под ними: при открытии вкладки и после отправки показываем конец переписки.
  useLayoutEffect(() => {
    const box = rootRef.current?.closest('.dc-detail-body')
    if (box) box.scrollTop = box.scrollHeight
  }, [comments.length])

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

  return (
    <div className="dc-talk" ref={rootRef}>
      {comments.length === 0 && <p className="dc-muted">Сообщений пока нет.</p>}
      {comments.map(c => (
        <div key={c.id} className={`dc-talk-msg${c.author_user_id && c.author_user_id === currentUserId ? ' is-mine' : ''}`}>
          <div className="dc-talk-head">
            <b>{c.author_name || 'Сотрудник'}</b>
            <span className="dc-talk-time">{formatDateTimeRu(c.created_at)}</span>
          </div>
          <p className="dc-talk-body">{c.body}</p>
        </div>
      ))}
      {canWrite && (
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
    </div>
  )
}
