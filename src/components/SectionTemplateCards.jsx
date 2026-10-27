import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SECTION_TEMPLATE_ACCEPT, SECTION_TEMPLATES_MIGRATION_HINT,
  attachSectionTemplateFile, downloadSectionTemplateFile, fetchSectionTemplates, removeSectionTemplateFile,
} from '../services/sectionTemplates'
import { IconDownload, IconTrash } from './icons/ActionIcons'
import PaperclipIcon from './icons/PaperclipIcon'
import './SectionTemplateCards.css'

// Плитки шаблонов раздела в «Материалах» окна «Документы» (tdm-cards, TenderDocsModal.css): название,
// описание и файл шаблона — «Скачать» у всех, «Прикрепить» / «Заменить» / удалить у администратора.
// items — [{ code, title, desc, icon }]; все шаблоны окна читаются одним запросом
// (services/sectionTemplates.js). Таблицы ещё нет — файл не прикрепить, об этом подсказка администратору.

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
          <span className="tdm-tpl-hint">{SECTION_TEMPLATES_MIGRATION_HINT}</span>
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

export default function SectionTemplateCards({ items, canEdit = false }) {
  const codesKey = items.map(i => i.code).join(',')
  // loading | ready | missing (таблицы нет) | error
  const [state, setState] = useState('loading')
  const [templates, setTemplates] = useState(() => new Map())
  const [busy, setBusy] = useState(null) // { code, kind: 'attach' | 'remove' }

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

  return items.map(item => (
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
  ))
}
