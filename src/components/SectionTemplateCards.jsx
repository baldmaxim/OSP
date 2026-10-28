import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SECTION_TEMPLATE_ACCEPT, attachSectionTemplateFile, downloadSectionTemplateFile, fetchSectionTemplates,
  fetchTemplateLinks, isWebLink, parseTemplateLink, removeSectionTemplateFile, saveTemplateLink,
  sectionTemplatesMigrationHint,
} from '../services/sectionTemplates'
import { copyToClipboard } from '../utils/clipboard'
import { IconCheck, IconDownload, IconLink, IconPencil, IconTrash } from './icons/ActionIcons'
import PaperclipIcon from './icons/PaperclipIcon'
import './SectionTemplateCards.css'

// Плитки шаблонов раздела в «Материалах» окна «Документы» (tdm-cards, TenderDocsModal.css): название,
// описание и файл шаблона — «Скачать» у всех, «Прикрепить» / «Заменить» / удалить у администратора.
// items — [{ code, title, desc, icon, migration?, linkKey? }]; все шаблоны окна читаются одним запросом
// (services/sectionTemplates.js). Таблицы ещё нет — файл не прикрепить, об этом подсказка администратору
// (migration — какая миграция заводит строку шаблона, по умолчанию 20261107).
// linkKey — шаблон-ссылка («Понятийное соглашение», «Шаблон ДП»): адрес или сетевой путь из app_settings, «Открыть» /
// «Скопировать путь» у всех, «Указать ссылку» / «Изменить» / убрать у администратора. Файл, прикреплённый к
// такому шаблону раньше, виден ниже, пока администратор его не удалит; нового файла не прикрепить.

function formatBytes(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

function TemplateCard({ item, template, state, canEdit, busy, onAttach, onDownload, onRemove }) {
  const inputRef = useRef(null)
  const doc = template?.files[0] || null
  const canAttach = canEdit && !!template
  const pick = () => { if (!busy) inputRef.current?.click() }
  const onFiles = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onAttach(template, file)
  }
  let empty = 'Файл ещё не прикреплён'
  if (state === 'loading') empty = 'Загружаем…'
  else if (state === 'error') empty = 'Не удалось загрузить файл шаблона'
  else if (!canEdit) empty = 'Файл ещё не прикреплён — его добавит администратор'

  return (
    <div className="tdm-card tdm-tpl-card" data-template={item.code}>
      <span className="tdm-card-icon">{item.icon}</span>
      <span className="tdm-card-title">{item.title}</span>
      <span className="tdm-card-desc">{item.desc}</span>
      <div className="tdm-tpl-file">
        {doc ? (
          <>
            <span className="tdm-tpl-name" title={doc.file_name}>
              <PaperclipIcon size={13} /> {doc.file_name}
            </span>
            <span className="tdm-tpl-meta">
              {[formatBytes(doc.size_bytes), formatDate(doc.created_at)].filter(Boolean).join(' · ')}
            </span>
          </>
        ) : (
          <span className={`tdm-tpl-empty${state === 'error' ? ' is-error' : ''}`}>{empty}</span>
        )}
        {canEdit && state === 'missing' && (
          <span className="tdm-tpl-hint">{sectionTemplatesMigrationHint(item.migration)}</span>
        )}
        <div className="tdm-tpl-actions">
          {doc && (
            <button type="button" className="tdm-tpl-btn is-primary" onClick={() => onDownload(doc)} disabled={!!busy}>
              <IconDownload size={14} /> Скачать
            </button>
          )}
          {canAttach && (
            <button type="button" className="tdm-tpl-btn" onClick={pick} disabled={!!busy}>
              <PaperclipIcon size={13} /> {busy === 'attach' ? 'Загружаем…' : doc ? 'Заменить' : 'Прикрепить файл'}
            </button>
          )}
          {canAttach && doc && (
            <button
              type="button"
              className="tdm-tpl-btn is-icon is-danger"
              onClick={() => onRemove(doc)}
              disabled={!!busy}
              aria-label={`Удалить файл шаблона «${item.title}»`}
              title="Удалить файл"
            >
              <IconTrash size={14} />
            </button>
          )}
        </div>
        {canAttach && (
          <input ref={inputRef} type="file" accept={SECTION_TEMPLATE_ACCEPT} hidden onChange={onFiles}
            data-testid={`template-input-${item.code}`} />
        )}
      </div>
    </div>
  )
}

// Плитка шаблона-ссылки. link — адрес или сетевой путь ('' — не указан); linkState — loading | ready | error.
function LinkTemplateCard({ item, link, linkState, canEdit, saving, onSave, legacyDoc, fileBusy, onDownload, onRemove }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const web = isWebLink(link)

  const startEdit = () => { setDraft(link || ''); setError(''); setEditing(true) }
  const submit = async (e) => {
    e.preventDefault()
    const parsed = parseTemplateLink(draft)
    if (parsed.error) { setError(parsed.error); return }
    if ((parsed.value || '') === (link || '')) { setEditing(false); return }
    if (await onSave(item, parsed.value)) setEditing(false)
  }
  const clear = async () => {
    if (!window.confirm(`Убрать ссылку на шаблон «${item.title}»? Открыть его из портала больше будет нельзя.`)) return
    await onSave(item, null)
  }
  const copy = async () => {
    if (!(await copyToClipboard(link))) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  let empty = 'Ссылка ещё не указана'
  if (linkState === 'loading') empty = 'Загружаем…'
  else if (linkState === 'error') empty = 'Не удалось загрузить ссылку'
  else if (!canEdit) empty = 'Ссылка ещё не указана — её добавит администратор'

  return (
    <div className="tdm-card tdm-tpl-card" data-template={item.code}>
      <span className="tdm-card-icon">{item.icon}</span>
      <span className="tdm-card-title">{item.title}</span>
      <span className="tdm-card-desc">{item.desc}</span>
      <div className="tdm-tpl-file">
        {editing ? (
          <form className="tdm-tpl-link-form" onSubmit={submit}>
            <input
              type="text"
              className="tdm-tpl-link-input"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError('') }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } }}
              placeholder={`https://… или \\\\сервер\\папка\\${item.title}.docx`}
              aria-label={`Ссылка на шаблон «${item.title}»`}
              disabled={saving}
              autoFocus
            />
            {error && <span className="tdm-tpl-empty is-error" role="alert">{error}</span>}
            <div className="tdm-tpl-actions">
              <button type="submit" className="tdm-tpl-btn is-primary" disabled={saving}>
                <IconCheck size={14} /> {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
              <button type="button" className="tdm-tpl-btn" onClick={() => setEditing(false)} disabled={saving}>Отмена</button>
            </div>
          </form>
        ) : (
          <>
            {link ? (
              <span className="tdm-tpl-name tdm-tpl-link" title={link}>
                <IconLink size={13} /> <span className="tdm-tpl-link-text">{link}</span>
              </span>
            ) : (
              <span className={`tdm-tpl-empty${linkState === 'error' ? ' is-error' : ''}`}>{empty}</span>
            )}
            {link && !web && <span className="tdm-tpl-meta">Сетевой путь — браузер его не откроет, скопируйте в проводник</span>}
            <div className="tdm-tpl-actions">
              {link && web && (
                <a className="tdm-tpl-btn is-primary" href={link} target="_blank" rel="noopener noreferrer">
                  <IconLink size={14} /> Открыть
                </a>
              )}
              {link && !web && (
                <button type="button" className="tdm-tpl-btn is-primary" onClick={copy}>
                  {copied ? <><IconCheck size={14} /> Скопировано</> : <><IconLink size={14} /> Скопировать путь</>}
                </button>
              )}
              {canEdit && linkState === 'ready' && (
                <button type="button" className="tdm-tpl-btn" onClick={startEdit} disabled={saving}>
                  <IconPencil size={13} /> {link ? 'Изменить' : 'Указать ссылку'}
                </button>
              )}
              {canEdit && link && (
                <button
                  type="button"
                  className="tdm-tpl-btn is-icon is-danger"
                  onClick={clear}
                  disabled={saving}
                  aria-label={`Убрать ссылку на шаблон «${item.title}»`}
                  title="Убрать ссылку"
                >
                  <IconTrash size={14} />
                </button>
              )}
            </div>
          </>
        )}
        {legacyDoc && (
          <div className="tdm-tpl-legacy">
            <span className="tdm-tpl-meta">Файл, прикреплённый раньше:</span>
            <span className="tdm-tpl-name" title={legacyDoc.file_name}>
              <PaperclipIcon size={13} /> {legacyDoc.file_name}
            </span>
            <div className="tdm-tpl-actions">
              <button type="button" className="tdm-tpl-btn" onClick={() => onDownload(legacyDoc)} disabled={!!fileBusy}>
                <IconDownload size={14} /> Скачать
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="tdm-tpl-btn is-icon is-danger"
                  onClick={() => onRemove(legacyDoc)}
                  disabled={!!fileBusy}
                  aria-label={`Удалить прежний файл шаблона «${item.title}»`}
                  title="Удалить прежний файл"
                >
                  <IconTrash size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function SectionTemplateCards({ items, canEdit = false }) {
  const codesKey = items.map(i => i.code).join(',')
  const linkKeysKey = items.map(i => i.linkKey).filter(Boolean).join(',')
  // loading | ready | missing (таблицы нет) | error
  const [state, setState] = useState('loading')
  const [templates, setTemplates] = useState(() => new Map())
  const [busy, setBusy] = useState(null) // { code, kind: 'attach' | 'remove' | 'link' }
  // Ссылки шаблонов-ссылок — отдельно от таблицы шаблонов: им миграция не нужна.
  const [linkState, setLinkState] = useState(linkKeysKey ? 'loading' : 'ready')
  const [links, setLinks] = useState(() => new Map())

  const loadLinks = useCallback(async () => {
    if (!linkKeysKey) return
    try {
      setLinks(await fetchTemplateLinks(linkKeysKey.split(',')))
      setLinkState('ready')
    } catch (err) {
      console.error('Ссылки шаблонов раздела не загрузились:', err?.message)
      setLinkState('error')
    }
  }, [linkKeysKey])

  useEffect(() => { loadLinks() }, [loadLinks])

  const handleSaveLink = async (item, value) => {
    setBusy({ code: item.code, kind: 'link' })
    try {
      await saveTemplateLink(item.linkKey, value)
      setLinks(prev => {
        const next = new Map(prev)
        if (value) next.set(item.linkKey, value)
        else next.delete(item.linkKey)
        return next
      })
      return true
    } catch (err) {
      alert('Не удалось сохранить ссылку: ' + (err?.message || err))
      return false
    } finally {
      setBusy(null)
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetchSectionTemplates(codesKey.split(','))
      setTemplates(res.templates)
      setState(res.supported ? 'ready' : 'missing')
    } catch (err) {
      console.error('Шаблоны раздела не загрузились:', err?.message)
      setState('error')
    }
  }, [codesKey])

  useEffect(() => { load() }, [load])

  const handleAttach = async (template, file) => {
    const old = template.files[0]
    if (old && !window.confirm(`Заменить файл шаблона?\n«${old.file_name}» → «${file.name}»`)) return
    setBusy({ code: template.code, kind: 'attach' })
    try {
      const failed = await attachSectionTemplateFile(template, file)
      if (failed.length) alert(`Новый файл прикреплён, но прежний не удалился: ${failed.join(', ')}. Удалите его позже.`)
    } catch (err) {
      alert('Не удалось прикрепить файл: ' + (err?.message || err))
    } finally {
      await load()
      setBusy(null)
    }
  }

  const handleRemove = async (doc) => {
    if (!window.confirm(`Удалить файл шаблона «${doc.file_name}»? Скачать его больше никто не сможет.`)) return
    const code = [...templates.values()].find(t => t.id === doc.owner_id)?.code || null
    setBusy({ code, kind: 'remove' })
    try {
      await removeSectionTemplateFile(doc)
    } catch (err) {
      alert('Не удалось удалить файл: ' + (err?.message || err))
    } finally {
      await load()
      setBusy(null)
    }
  }

  const handleDownload = async (doc) => {
    try {
      await downloadSectionTemplateFile(doc)
    } catch (err) {
      alert('Не удалось скачать файл: ' + (err?.message || err))
    }
  }

  return items.map(item => (item.linkKey ? (
    <LinkTemplateCard
      key={item.code}
      item={item}
      link={links.get(item.linkKey) || ''}
      linkState={linkState}
      canEdit={canEdit}
      saving={busy?.code === item.code && busy.kind === 'link'}
      onSave={handleSaveLink}
      legacyDoc={templates.get(item.code)?.files[0] || null}
      fileBusy={busy?.code === item.code ? busy.kind : null}
      onDownload={handleDownload}
      onRemove={handleRemove}
    />
  ) : (
    <TemplateCard
      key={item.code}
      item={item}
      template={templates.get(item.code)}
      state={state === 'ready' && !templates.has(item.code) ? 'missing' : state}
      canEdit={canEdit}
      busy={busy?.code === item.code ? busy.kind : null}
      onAttach={handleAttach}
      onDownload={handleDownload}
      onRemove={handleRemove}
    />
  )))
}
