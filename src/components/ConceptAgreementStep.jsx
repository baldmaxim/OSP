import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument } from '../services/s3'
import {
  prepareConceptAgreement, reloadConceptCard, uploadSignedConceptAgreement,
} from '../services/tenderConceptAgreement'
import {
  CONCEPT_SIGNED_ACCEPT, CONCEPT_SIGNED_CATEGORY, CONCEPT_TEMPLATE_CATEGORY, CONCEPT_TEMPLATE_LINK_TITLE,
  filesOfCategory, signedFileProblem,
} from '../utils/tenderConceptAgreement'
import { downloadS3File } from './FileDownload'
import { IconAlert, IconCheck, IconDownload, IconTrash } from './icons/ActionIcons'
import PaperclipIcon from './icons/PaperclipIcon'
import './ConceptAgreementStep.css'

// Шаг окна завершения тендера основного строительства: вопрос «Понятийное соглашение подписано?», шаблон — он сам
// подгружается в «Документы» тендера при открытии окна и остаётся там, если тендер не завершили, — и загрузка подписанного.
export default function ConceptAgreementStep({ tenderId, onSignedChange }) {
  const { user, userProfile } = useRole()
  const userId = user?.id || null
  const userName = userProfile?.full_name || user?.email || null

  const [state, setState] = useState('loading')
  const [card, setCard] = useState(null)
  const [template, setTemplate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const aliveRef = useRef(true)

  const prepare = useCallback(async () => {
    setState('loading')
    setError('')
    try {
      const res = await prepareConceptAgreement(tenderId, { userId, userName })
      if (!aliveRef.current) return
      setCard(res.card)
      setTemplate(res.template)
      setState('ready')
    } catch (err) {
      if (!aliveRef.current) return
      setError(err.message)
      setState('error')
    }
  }, [tenderId, userId, userName])

  useEffect(() => {
    aliveRef.current = true
    prepare()
    return () => { aliveRef.current = false }
  }, [prepare])

  const signed = filesOfCategory(card, CONCEPT_SIGNED_CATEGORY)
  const templateFile = filesOfCategory(card, CONCEPT_TEMPLATE_CATEGORY)[0] || null
  const templateLink = (card?.links || []).find((l) => l.title === CONCEPT_TEMPLATE_LINK_TITLE) || null

  useEffect(() => { onSignedChange(signed.length) }, [signed.length, onSignedChange])

  const refresh = async () => {
    const fresh = await reloadConceptCard(tenderId)
    if (aliveRef.current) setCard(fresh)
  }

  const upload = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length || busy || !card) return
    setBusy(true)
    const problems = []
    try {
      for (const file of files) {
        const problem = signedFileProblem(file)
        if (problem) { problems.push(`${file.name}: ${problem}`); continue }
        try {
          await uploadSignedConceptAgreement(card, file)
        } catch (err) {
          problems.push(`${file.name}: не загрузился (${err.message})`)
        }
      }
      await refresh()
    } catch (err) {
      problems.push(err.message)
    } finally {
      if (aliveRef.current) {
        setError(problems.join('; '))
        setBusy(false)
      }
    }
  }

  const remove = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    setBusy(true)
    setError('')
    try {
      await deleteDocument(doc)
      await refresh()
    } catch (err) {
      if (aliveRef.current) setError(`Файл не удалён: ${err.message}`)
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const download = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (err) {
      setError(`Файл не скачался: ${err.message}`)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    upload(e.dataTransfer?.files)
  }

  if (state === 'loading') {
    return <div className="cas-step" data-state="loading"><p className="cas-question">Понятийное соглашение подписано?</p><p className="cas-muted">Подгружаем шаблон…</p></div>
  }
  if (state === 'error') {
    return (
      <div className="cas-step" data-state="error">
        <p className="cas-question">Понятийное соглашение подписано?</p>
        <p className="cas-error" role="alert">Не удалось подготовить документы тендера: {error}</p>
        <button type="button" className="btn-secondary" onClick={prepare}>Повторить</button>
      </div>
    )
  }

  return (
    <div
      className={`cas-step${dragging ? ' is-drag' : ''}`}
      data-state="ready"
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
      onDrop={onDrop}
    >
      <p className="cas-question">Понятийное соглашение подписано?</p>
      <p className="cas-muted">Без подписанного соглашения тендер не завершить. Файлы сохраняются во вкладке «Документы» тендера.</p>

      <div className="cas-row">
        <span className="cas-label">Шаблон</span>
        <div className="cas-value">
          {templateFile ? (
            <button type="button" className="cas-file" onClick={() => download(templateFile)} title={`Скачать ${templateFile.file_name}`}>
              <IconDownload size={14} /> <span>{templateFile.file_name}</span>
            </button>
          ) : templateLink ? (
            <>
              <a className="cas-file" href={templateLink.url} target="_blank" rel="noopener noreferrer"><span>Открыть шаблон</span></a>
              {template?.kind === 'link_only' && (
                <p className="cas-muted">Файл шаблона не скопировался ({template.reason}), поэтому в «Документы» добавлена ссылка.</p>
              )}
            </>
          ) : template?.kind === 'path' ? (
            <p className="cas-muted cas-path">{template.path}</p>
          ) : (
            <p className="cas-muted">Шаблон не указан: ссылку задаёт администратор в «Документах раздела» → «Материалы». Загрузить подписанное соглашение это не мешает.</p>
          )}
        </div>
      </div>

      <div className="cas-row">
        <span className="cas-label">Подписанное</span>
        <div className="cas-value">
          {signed.map((doc) => (
            <div className="cas-signed" key={doc.id}>
              <IconCheck size={14} />
              <button type="button" className="cas-file" onClick={() => download(doc)} title={`Скачать ${doc.file_name}`}>
                <span>{doc.file_name}</span>
              </button>
              <button type="button" className="cas-remove" onClick={() => remove(doc)} disabled={busy} aria-label={`Удалить файл ${doc.file_name}`} title="Удалить файл">
                <IconTrash size={14} />
              </button>
            </div>
          ))}
          {signed.length === 0 && (
            <p className="cas-missing"><IconAlert size={14} /> <span>Файла нет: можно выбрать или перетащить сюда PDF, Word или скан</span></p>
          )}
          <button type="button" className="btn-secondary cas-upload" onClick={() => inputRef.current?.click()} disabled={busy}>
            <PaperclipIcon size={14} /> {busy ? 'Загружаем…' : signed.length ? 'Добавить ещё файл' : 'Загрузить подписанное'}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept={CONCEPT_SIGNED_ACCEPT}
            aria-label="Подписанное понятийное соглашение"
            onChange={(e) => { upload(e.target.files); e.target.value = '' }}
          />
        </div>
      </div>

      {error && <p className="cas-error" role="alert">{error}</p>}
    </div>
  )
}
