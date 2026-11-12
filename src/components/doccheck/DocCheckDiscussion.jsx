import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import DocCheckGrowingField from './DocCheckGrowingField'
import S3DocumentPreview from '../S3DocumentPreview'
import { downloadS3File } from '../FileDownload'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconDownload } from '../icons/ActionIcons'
import { addComment, removeChatDraft, uploadChatFile } from '../../services/docCheckCard'
import { MAX_CHAT_FILES, MAX_COMMENT_LENGTH, formatBytes } from '../../utils/docCheckHelpers'
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
//
// Файлы в сообщении (12.11.2026, решение пользователя; миграция 20270216, chatFiles): скрепка у поля ввода, файл можно бросить
// в любое место переписки или вставить из буфера. Выбранные файлы ждут у поля ввода (убрать — «×»), уходят вместе с сообщением:
// сначала загружаются (черновик вложения), затем сообщение, в котором база записывает снимок каждого файла — имя, размер,
// отпечаток и ключ в хранилище. Отправленный файл никто не меняет и не удаляет — переписка хранится как есть. Не ушло
// сообщение — загруженные черновики убираются, текст и выбранные файлы остаются.

// Как у загрузки osp-api (предел файла — 100 МБ): больше сервер не примет, лучше сказать сразу.
const MAX_FILE_BYTES = 100 * 1024 * 1024

const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

let pendingSeq = 0

export default function DocCheckDiscussion({
  requestId, comments, onCommentsChange, currentUserId, unreadAfter = Number.POSITIVE_INFINITY, canWrite, state, onRetry,
  chatFiles = false, onFilesSent,
}) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState([]) // { key, file }
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState('')
  const [over, setOver] = useState(false)
  const [preview, setPreview] = useState(null)
  // Не даёт отправить дважды (Enter, нажатый снова до ответа базы).
  const sendingRef = useRef(false)
  const listRef = useRef(null)
  const newMarkRef = useRef(null)
  const inputRef = useRef(null)
  const fileRef = useRef(null)
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

  const ready = state === 'ready'
  const canAttach = ready && canWrite && chatFiles

  // Выбранные файлы — к полю ввода. Пустые, слишком большие и сверх предела — сразу с причиной.
  const addFiles = (list) => {
    const files = Array.from(list || [])
    if (!files.length || !canAttach || sendingRef.current) return
    const problems = []
    const accepted = []
    for (const file of files) {
      if (!file.size) problems.push(`${file.name}: пустой файл`)
      else if (file.size > MAX_FILE_BYTES) problems.push(`${file.name}: больше 100 МБ`)
      else accepted.push(file)
    }
    const room = Math.max(MAX_CHAT_FILES - pending.length, 0)
    if (accepted.length > room) problems.push(`В одном сообщении — не больше ${MAX_CHAT_FILES} файлов`)
    const added = accepted.slice(0, room).map(file => ({ key: `p${++pendingSeq}`, file }))
    if (added.length) setPending(prev => [...prev, ...added])
    if (problems.length) alert(`Не все файлы добавлены:\n${problems.join('\n')}`)
    inputRef.current?.focus()
  }

  const send = async () => {
    const body = text.trim()
    if ((!body && !pending.length) || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    const uploaded = []
    try {
      for (const [i, p] of pending.entries()) {
        setProgress(pending.length > 1 ? `Загрузка файлов: ${i + 1} из ${pending.length}…` : 'Загрузка файла…')
        try {
          uploaded.push(await uploadChatFile(requestId, p.file))
        } catch (err) {
          throw new Error(`${p.file.name}: ${err.message || err}`)
        }
      }
      setProgress(uploaded.length ? 'Отправка…' : '')
      const row = await addComment(requestId, body, uploaded.map(d => d.id))
      onCommentsChange(prev => [...prev, row])
      setText('')
      setPending([])
      if (uploaded.length) onFilesSent?.()
    } catch (err) {
      // Сообщение не ушло: черновики вложений — убрать (их автор может), текст и выбранные файлы остаются в поле.
      for (const doc of uploaded) removeChatDraft(doc).catch(() => {})
      alert('Не удалось отправить сообщение: ' + (err.message || err))
    } finally {
      sendingRef.current = false
      setSending(false)
      setProgress('')
    }
  }

  const download = async (file) => {
    try {
      await downloadS3File(file.s3_key, file.file_name)
    } catch (err) {
      alert('Не удалось скачать файл: ' + (err.message || err))
    }
  }

  // Файл можно бросить в любое место панели; брошенный мимо — не уводит страницу (окно заявки ловит и его).
  const dropProps = canAttach ? {
    onDragOver: (e) => { if (carriesFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false) },
    onDrop: (e) => { if (!carriesFiles(e)) return; e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files) },
  } : {}

  const fileCount = comments.reduce((n, c) => n + (c.attachments?.length || 0), 0)

  return (
    <section className={`dc-talk${over ? ' is-over' : ''}`} aria-label="Обсуждение" {...dropProps}>
      <h4 className="dc-talk-title">
        Обсуждение
        {ready && comments.length > 0 && <span className="dc-tab-count">{comments.length}</span>}
        {ready && fileCount > 0 && (
          <span className="dc-talk-title-files" title="Файлов в переписке">
            <PaperclipIcon size={13} />{fileCount}
          </span>
        )}
      </h4>
      <div className="dc-talk-list" ref={listRef}>
        {state === 'loading' && <p className="dc-muted">Загрузка…</p>}
        {state === 'error' && (
          <p className="dc-muted">
            Не удалось загрузить.{' '}
            <button type="button" className="dc-retry" onClick={onRetry}>Повторить</button>
          </p>
        )}
        {ready && comments.length === 0 && (
          <p className="dc-muted">Сообщений пока нет.{canAttach ? ' Файл можно перетащить сюда.' : ''}</p>
        )}
        {ready && comments.map(c => {
          const unread = unreadIds.has(c.id)
          const mine = c.author_user_id && c.author_user_id === currentUserId
          const files = Array.isArray(c.attachments) ? c.attachments : []
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
                {c.body && <p className="dc-talk-body">{c.body}</p>}
                {files.length > 0 && (
                  <ul className="dc-talk-files" aria-label="Файлы сообщения">
                    {files.map(f => (
                      <li key={f.id} className="dc-talk-file">
                        <span className="dc-file-icon" aria-hidden="true"><PaperclipIcon size={14} /></span>
                        <button type="button" className="dc-talk-file-name" title={`Открыть: ${f.file_name}`} onClick={() => setPreview(f)}>
                          {f.file_name}
                        </button>
                        {f.size_bytes != null && <span className="dc-talk-file-size">{formatBytes(f.size_bytes)}</span>}
                        <button
                          type="button"
                          className="dc-icon-btn dc-file-btn"
                          aria-label={`Скачать ${f.file_name}`}
                          title="Скачать"
                          onClick={() => download(f)}
                        ><IconDownload size={15} /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
      {ready && canWrite && (
        <div className="dc-talk-add">
          {pending.length > 0 && (
            <ul className="dc-talk-pending" aria-label="Выбранные файлы">
              {pending.map(p => (
                <li key={p.key} className="dc-talk-pending-item">
                  <PaperclipIcon size={13} />
                  <span className="dc-talk-pending-name" title={p.file.name}>{p.file.name}</span>
                  <span className="dc-talk-file-size">{formatBytes(p.file.size)}</span>
                  <button
                    type="button"
                    className="dc-talk-pending-remove"
                    aria-label={`Убрать ${p.file.name}`}
                    title="Убрать из сообщения"
                    disabled={sending}
                    onClick={() => setPending(prev => prev.filter(x => x.key !== p.key))}
                  >×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="dc-inline-add">
            {canAttach && (
              <>
                <button
                  type="button"
                  className="dc-talk-attach"
                  aria-label="Прикрепить файл"
                  title="Прикрепить файл — или перетащите его в переписку"
                  disabled={sending || pending.length >= MAX_CHAT_FILES}
                  onClick={() => fileRef.current?.click()}
                ><PaperclipIcon size={16} /></button>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  multiple
                  aria-label="Файлы к сообщению"
                  onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
                />
              </>
            )}
            <DocCheckGrowingField
              ref={inputRef}
              value={text}
              onChange={setText}
              onSubmit={send}
              onPaste={canAttach ? (e) => {
                const files = e.clipboardData?.files
                if (files?.length) { e.preventDefault(); addFiles(files) }
              } : undefined}
              maxLength={MAX_COMMENT_LENGTH}
              placeholder={canAttach ? 'Написать сообщение или перетащить файл…' : 'Написать сообщение…'}
              aria-label="Новое сообщение"
              title="Enter — отправить. Shift+Enter — новая строка"
            />
            <button type="button" className="btn-primary" disabled={sending || (!text.trim() && !pending.length)} onClick={send}>
              {sending ? 'Отправка…' : 'Отправить'}
            </button>
          </div>
          {progress && <p className="dc-talk-progress" role="status">{progress}</p>}
        </div>
      )}
      {over && (
        <div className="dc-talk-drop" aria-hidden="true">
          <PaperclipIcon size={22} />
          <span>Отпустите — файлы прикрепятся к сообщению</span>
        </div>
      )}
      {preview && <S3DocumentPreview doc={preview} onClose={() => setPreview(null)} />}
    </section>
  )
}
