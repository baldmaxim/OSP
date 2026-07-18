import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import { fetchTenderDocs, deleteTenderDoc } from '../services/tenderDocs'
import AutoGrowTextarea from './AutoGrowTextarea'
import '../pages/GeneralDocumentsPage.css'
import './TenderDocumentsTab.css'

// task: вкладка «Документы» внутри тендера. Таблица как в «Общая информация → Документы»:
// № · Наименование документа · Документы и ссылки · Дата загрузки (+ кто загрузил).
// Итоговый документ (is_final) закреплён сверху и визуально выделен — он же управляется
// из блока победителя тендера, обе точки работают с одной записью.

const MATERIALS_PREVIEW = 4
const MAX_FILE_SIZE_MB = 50
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
const BLOCKED_EXTENSIONS = ['exe', 'msi', 'bat', 'cmd', 'scr', 'ps1', 'sh', 'dll', 'com', 'jar', 'vbs', 'vbe', 'wsf', 'pif', 'hta', 'cpl', 'msc', 'reg']
const ACCEPT_HINT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp,.heic,.zip,.rar,.7z,.odt,.ods,.odp'

function normalizeUrl(raw) {
  const v = (raw || '').trim()
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}
function isValidUrl(v) {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}
function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function getFileExtension(name) {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}
function validateFile(file) {
  const ext = getFileExtension(file.name)
  if (BLOCKED_EXTENSIONS.includes(ext)) return 'исполняемые файлы запрещены'
  if (file.size === 0) return 'файл пустой'
  if (file.size > MAX_FILE_SIZE) return `превышает лимит ${MAX_FILE_SIZE_MB} МБ`
  return null
}
function fileBadge(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return { label: 'PDF', cls: 'badge-pdf' }
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { label: 'DOC', cls: 'badge-doc' }
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return { label: 'XLS', cls: 'badge-xls' }
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { label: 'PPT', cls: 'badge-ppt' }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return { label: 'IMG', cls: 'badge-img' }
  if (['zip', 'rar', '7z'].includes(ext)) return { label: 'ZIP', cls: 'badge-other' }
  return { label: (ext || 'FILE').slice(0, 4).toUpperCase(), cls: 'badge-other' }
}

const iconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  width: 16, height: 16, 'aria-hidden': true,
}
const EditIcon = () => (
  <svg {...iconProps}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
)
const TrashIcon = () => (
  <svg {...iconProps}><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
)

const EMPTY_FORM = { title: '', description: '', links: [], newFiles: [] }

export default function TenderDocumentsTab({ tenderId, canEdit = false, version = 0, onChange }) {
  const { user, userProfile } = useRole()
  const currentUserName = userProfile?.full_name || user?.email || null

  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set())

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [removeFileIds, setRemoveFileIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [fileErrors, setFileErrors] = useState([])
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const docs = await fetchTenderDocs(tenderId)
      setDocuments(docs)
      return docs
    } catch (err) {
      console.error('Ошибка загрузки документов тендера:', err.message)
      return []
    } finally {
      setLoading(false)
    }
  }, [tenderId])

  // Перезагрузка при монтировании и при внешнем изменении (version меняет блок победителя).
  useEffect(() => { load() }, [load, version])

  const toggleExpand = (id) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const clearErrors = () => { setFormError(''); setLinkError(''); setFileErrors([]) }
  const openAdd = () => {
    setEditing(null); setForm({ ...EMPTY_FORM, links: [] }); setRemoveFileIds(new Set()); clearErrors(); setShowModal(true)
  }
  const openEdit = (doc) => {
    setEditing(doc)
    setForm({
      title: doc.title || '',
      description: doc.description || '',
      links: (doc.links || []).map((l) => ({ title: l.title || '', url: l.url || '' })),
      newFiles: [],
    })
    setRemoveFileIds(new Set()); clearErrors(); setShowModal(true)
  }
  const closeModal = () => {
    if (saving) return
    setShowModal(false); setEditing(null); setForm(EMPTY_FORM); setRemoveFileIds(new Set()); clearErrors(); setDragActive(false)
  }

  const openFileDialog = () => fileInputRef.current?.click()
  const onDropOver = (e) => { e.preventDefault(); if (!dragActive) setDragActive(true) }
  const onDropLeave = (e) => { e.preventDefault(); setDragActive(false) }
  const onDrop = (e) => { e.preventDefault(); setDragActive(false); if (e.dataTransfer?.files?.length) addNewFiles(e.dataTransfer.files) }

  const addLinkRow = () => setForm((f) => ({ ...f, links: [...f.links, { title: '', url: '' }] }))
  const updateLinkRow = (i, field, value) => setForm((f) => ({ ...f, links: f.links.map((l, idx) => idx === i ? { ...l, [field]: value } : l) }))
  const removeLinkRow = (i) => setForm((f) => ({ ...f, links: f.links.filter((_, idx) => idx !== i) }))

  const addNewFiles = (fileList) => {
    const arr = Array.from(fileList || [])
    if (!arr.length) return
    const accepted = []; const rejected = []
    arr.forEach((f) => { const reason = validateFile(f); if (reason) rejected.push(`${f.name} — ${reason}`); else accepted.push(f) })
    if (accepted.length) setForm((f) => ({ ...f, newFiles: [...f.newFiles, ...accepted] }))
    setFileErrors(rejected)
  }
  const removeNewFile = (i) => setForm((f) => ({ ...f, newFiles: f.newFiles.filter((_, idx) => idx !== i) }))
  const toggleRemoveExistingFile = (id) => setRemoveFileIds((prev) => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next
  })

  const handleDownload = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key)
      const a = document.createElement('a')
      a.href = presigned_url; a.download = s3doc.file_name || ''; a.target = '_blank'; a.rel = 'noopener noreferrer'
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e) {
      alert('Не удалось получить файл: ' + e.message)
    }
  }

  const notifyChange = () => { if (onChange) onChange() }

  const handleSubmit = async (e) => {
    e.preventDefault()
    clearErrors()
    const title = form.title.trim()
    if (!title) { setFormError('Укажите наименование документа'); return }

    const nonEmpty = form.links
      .map((l) => ({ title: (l.title || '').trim(), rawUrl: (l.url || '').trim() }))
      .filter((r) => r.title || r.rawUrl)
    for (const r of nonEmpty) {
      if (!r.rawUrl) { setLinkError('Для заполненного названия укажите ссылку (URL)'); return }
      if (!isValidUrl(normalizeUrl(r.rawUrl))) { setLinkError(`Укажите корректную ссылку: ${r.rawUrl}`); return }
    }
    const validLinks = nonEmpty.map((r) => ({ title: r.title, url: normalizeUrl(r.rawUrl) }))

    const keptExisting = (editing?.files || []).filter((f) => !removeFileIds.has(f.id))
    if (validLinks.length + form.newFiles.length + keptExisting.length === 0) {
      setFormError('Добавьте хотя бы одну ссылку или файл'); return
    }

    setSaving(true)
    const problems = []
    try {
      let docId
      if (editing) {
        const { error } = await supabase.from('tender_docs')
          .update({ title, description: form.description.trim() || null, updated_at: new Date().toISOString(), updated_by: user?.id || null, updated_by_name: currentUserName })
          .eq('id', editing.id)
        if (error) throw error
        docId = editing.id

        const oldLinkIds = (editing.links || []).map((l) => l.id)
        if (validLinks.length) {
          const rows = validLinks.map((l, idx) => ({ tender_doc_id: docId, title: l.title || null, url: l.url, sort_order: idx }))
          const { error: insErr } = await supabase.from('tender_doc_links').insert(rows)
          if (insErr) throw insErr
        }
        if (oldLinkIds.length) {
          const { error: delErr } = await supabase.from('tender_doc_links').delete().in('id', oldLinkIds)
          if (delErr) throw delErr
        }

        const toRemove = (editing.files || []).filter((f) => removeFileIds.has(f.id))
        for (const f of toRemove) {
          try { await deleteDocument(f) } catch (delErr) {
            console.error('Файл не удалён:', f.file_name, delErr?.message)
            problems.push(`${f.file_name} — не удалось удалить файл из хранилища`)
          }
        }
      } else {
        const { data: created, error } = await supabase.from('tender_docs')
          .insert({ tender_id: tenderId, title, description: form.description.trim() || null, is_final: false, created_by: user?.id || null, created_by_name: currentUserName, updated_by: user?.id || null, updated_by_name: currentUserName })
          .select('id').single()
        if (error) throw error
        docId = created.id
        if (validLinks.length) {
          const rows = validLinks.map((l, idx) => ({ tender_doc_id: docId, title: l.title || null, url: l.url, sort_order: idx }))
          const { error: linkErr } = await supabase.from('tender_doc_links').insert(rows)
          if (linkErr) throw linkErr
        }
      }

      for (const file of form.newFiles) {
        try {
          await uploadFile({ file, ownerType: 'tender', ownerId: docId })
        } catch (upErr) {
          console.error('Файл не загружен:', file.name, upErr?.message)
          problems.push(`${file.name} — не удалось загрузить`)
        }
      }

      await load()
      notifyChange()
      if (problems.length) {
        setFileErrors(problems)
        setFormError('Документ сохранён, но часть операций не выполнена. Проверьте список ниже.')
        // Обновляем editing, чтобы повторное сохранение не плодило дубли ссылок.
        const fresh = await fetchTenderDocs(tenderId)
        const saved = fresh.find((d) => d.id === docId)
        if (saved) { setEditing(saved); setForm((f) => ({ ...f, links: (saved.links || []).map((l) => ({ title: l.title || '', url: l.url || '' })), newFiles: [] })); setRemoveFileIds(new Set()) }
        return
      }
      closeModal()
    } catch (err) {
      setFormError('Не удалось сохранить документ: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (doc) => {
    const what = doc.is_final ? 'итоговый документ' : `документ «${doc.title}»`
    if (!window.confirm(`Удалить ${what} и все связанные файлы и ссылки?`)) return
    try {
      await deleteTenderDoc(doc)
      await load()
      notifyChange()
    } catch (err) {
      alert('Не удалось удалить документ: ' + err.message)
    }
  }

  const buildMaterials = (doc) => ([
    ...(doc.links || []).map((l) => ({ kind: 'link', id: `l-${l.id}`, title: l.title, url: l.url })),
    ...(doc.files || []).map((f) => ({ kind: 'file', id: `f-${f.id}`, s3: f })),
  ])

  const renderMaterial = (m) => {
    if (m.kind === 'link') {
      return (
        <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" className="gd-material gd-material-link" title={m.url}>
          <span className="gd-mat-icon" aria-hidden>🔗</span>
          <span className="gd-mat-text">{m.title || 'Открыть ссылку'}</span>
        </a>
      )
    }
    return (
      <button key={m.id} className="gd-material gd-material-file" onClick={() => handleDownload(m.s3)} title={`Скачать ${m.s3.file_name}`}>
        <span className="gd-mat-icon" aria-hidden>📎</span>
        <span className="gd-mat-text">{m.s3.file_name}</span>
        {m.s3.size_bytes != null && <span className="gd-mat-size">{formatSize(m.s3.size_bytes)}</span>}
      </button>
    )
  }

  const colCount = canEdit ? 6 : 5

  return (
    <div className="tender-docs-tab">
      <div className="tdoc-toolbar">
        <p className="tdoc-hint">Согласования, понятийные соглашения, технические задания, сводки и прочие документы по тендеру.</p>
        {canEdit && <button className="btn-primary" onClick={openAdd}>+ Добавить документ</button>}
      </div>

      <div className="gd-card">
        {loading ? (
          <div className="gd-loading">Загрузка...</div>
        ) : documents.length === 0 ? (
          <div className="gd-empty">
            <p className="gd-empty-title">Документы пока не добавлены</p>
            <p className="gd-empty-hint">Прикрепите согласования, ТЗ, сводку по тендеру и другие документы</p>
            {canEdit && <button className="btn-primary" onClick={openAdd} style={{ marginTop: '0.75rem' }}>+ Добавить документ</button>}
          </div>
        ) : (
          <div className="gd-table-container">
            <table className="gd-table">
              <colgroup>
                <col className="cg-num" />
                <col className="cg-title" />
                <col className="cg-materials" />
                <col className="cg-updated" />
                <col className="cg-updatedby" />
                {canEdit && <col className="cg-actions" />}
              </colgroup>
              <thead>
                <tr>
                  <th className="gd-col-num">№</th>
                  <th className="gd-col-title">Наименование документа</th>
                  <th className="gd-col-materials">Документы и ссылки</th>
                  <th className="gd-col-updated">Дата загрузки</th>
                  <th className="gd-col-updatedby">Загрузил</th>
                  {canEdit && <th className="gd-col-actions">Действия</th>}
                </tr>
              </thead>
              <tbody>
                {documents.map((doc, index) => {
                  const materials = buildMaterials(doc)
                  const isExp = expanded.has(doc.id)
                  const shown = isExp ? materials : materials.slice(0, MATERIALS_PREVIEW)
                  const hiddenCount = materials.length - shown.length
                  return (
                    <tr key={doc.id} className={doc.is_final ? 'tdoc-final-row' : ''}>
                      <td className="gd-col-num">{index + 1}</td>
                      <td className="gd-col-title gd-title-cell">
                        <div className="document-title-cell">
                          <span className="document-title gd-title-text">{doc.title}</span>
                          {doc.is_final && <span className="tdoc-final-badge">Итоговый документ</span>}
                          {canEdit && (
                            <button className="document-title-edit-button" onClick={() => openEdit(doc)} title="Редактировать документ" aria-label="Редактировать документ"><EditIcon /></button>
                          )}
                        </div>
                        {doc.description && (
                          canEdit ? (
                            <button type="button" className="gd-desc-text gd-desc-btn" onClick={() => openEdit(doc)} title="Открыть карточку документа">{doc.description}</button>
                          ) : (
                            <span className="gd-desc-text" title={doc.description}>{doc.description}</span>
                          )
                        )}
                      </td>
                      <td className="gd-col-materials">
                        {materials.length === 0 ? (
                          <span className="gd-missing">—</span>
                        ) : (
                          <div className="gd-materials">
                            {shown.map(renderMaterial)}
                            {hiddenCount > 0 && <button className="gd-more-btn" onClick={() => toggleExpand(doc.id)}>Ещё {hiddenCount}</button>}
                            {isExp && materials.length > MATERIALS_PREVIEW && <button className="gd-more-btn" onClick={() => toggleExpand(doc.id)}>Свернуть</button>}
                          </div>
                        )}
                      </td>
                      <td className="gd-col-updated gd-updated-cell">{formatDateTime(doc.created_at)}</td>
                      <td className="gd-col-updatedby gd-updatedby-cell">{doc.created_by_name || doc.updated_by_name || '—'}</td>
                      {canEdit && (
                        <td className="gd-col-actions">
                          <button className="gd-icon-btn gd-icon-danger" onClick={() => handleDelete(doc)} title="Удалить" aria-label="Удалить"><TrashIcon /></button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={colCount} className="gd-tfoot">Всего: {documents.length}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="gd-modal-overlay">
          <div className="gd-modal" role="dialog" aria-modal="true">
            <div className="gd-modal-header">
              <div className="gd-modal-heading">
                <h3>{editing ? 'Редактировать документ' : 'Добавить документ'}</h3>
                <p className="gd-modal-subtitle">{editing ? 'Измените название, ссылки и прикреплённые файлы' : 'Добавьте название, ссылки и прикреплённые файлы'}</p>
              </div>
              <button className="gd-modal-close" onClick={closeModal} aria-label="Закрыть">×</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="gd-modal-body">
                <section className="gd-section">
                  <h4 className="gd-section-title">Основная информация</h4>
                  <div className="gd-form-group">
                    <label htmlFor="tdoc-title">Наименование документа *</label>
                    <input id="tdoc-title" type="text" value={form.title} onChange={(e) => { setForm((f) => ({ ...f, title: e.target.value })); if (formError) setFormError('') }} placeholder="Например: Техническое задание" autoFocus />
                  </div>
                  <div className="gd-form-group">
                    <label htmlFor="tdoc-desc">Описание / примечание</label>
                    <AutoGrowTextarea id="tdoc-desc" className="gd-textarea" minHeight={90} defaultValue={form.description} onInput={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Краткое описание (необязательно)" />
                  </div>
                </section>

                <section className="gd-section">
                  <h4 className="gd-section-title">Ссылки</h4>
                  {form.links.length === 0 && <p className="gd-hint">Ссылки пока не добавлены</p>}
                  {form.links.map((l, i) => (
                    <div className="gd-link-row" key={i}>
                      <input type="text" className="gd-link-title" value={l.title} onChange={(e) => { updateLinkRow(i, 'title', e.target.value); if (linkError) setLinkError('') }} placeholder="Название ссылки" />
                      <input type="text" className="gd-link-url" value={l.url} onChange={(e) => { updateLinkRow(i, 'url', e.target.value); if (linkError) setLinkError('') }} placeholder="https://..." />
                      <button type="button" className="gd-row-remove" onClick={() => removeLinkRow(i)} title="Удалить ссылку" aria-label="Удалить ссылку">×</button>
                    </div>
                  ))}
                  {linkError && <p className="gd-inline-error">{linkError}</p>}
                  <button type="button" className="gd-add-row" onClick={addLinkRow}>+ Добавить ссылку</button>
                </section>

                <section className="gd-section">
                  <h4 className="gd-section-title">Файлы</h4>
                  <div className={`gd-dropzone ${dragActive ? 'is-drag' : ''}`} onClick={openFileDialog} onDragOver={onDropOver} onDragLeave={onDropLeave} onDrop={onDrop}>
                    <span className="gd-dropzone-icon" aria-hidden>📎</span>
                    <div className="gd-dropzone-main">Перетащите файлы сюда</div>
                    <div className="gd-dropzone-sub">или выберите их на компьютере</div>
                    <button type="button" className="gd-dropzone-btn" onClick={(e) => { e.stopPropagation(); openFileDialog() }}>Выбрать файлы</button>
                    <div className="gd-dropzone-hint">PDF, DOCX, XLSX, изображения и архивы — до {MAX_FILE_SIZE_MB} МБ</div>
                    <input ref={fileInputRef} type="file" multiple accept={ACCEPT_HINT} className="gd-file-input-hidden" onChange={(e) => { addNewFiles(e.target.files); e.target.value = '' }} />
                  </div>

                  {fileErrors.length > 0 && (
                    <div className="gd-file-errors" role="alert">
                      <div className="gd-file-errors-title">Проблемы с файлами:</div>
                      <ul>{fileErrors.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
                    </div>
                  )}

                  {form.newFiles.length > 0 && (
                    <div className="gd-file-block">
                      <div className="gd-file-block-title">Новые файлы</div>
                      <ul className="gd-file-list">
                        {form.newFiles.map((f, i) => {
                          const b = fileBadge(f.name)
                          return (
                            <li key={i} className="gd-file-item is-new">
                              <span className={`gd-file-badge ${b.cls}`}>{b.label}</span>
                              <span className="gd-file-name" title={f.name}>{f.name}</span>
                              <span className="gd-file-size">{formatSize(f.size)}</span>
                              <button type="button" className="gd-file-action gd-file-remove" onClick={() => removeNewFile(i)} title="Убрать" aria-label="Убрать файл">Убрать</button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                </section>

                {editing && (editing.files || []).length > 0 && (
                  <section className="gd-section">
                    <h4 className="gd-section-title">Прикреплённые файлы</h4>
                    <ul className="gd-file-list">
                      {editing.files.map((f) => {
                        const b = fileBadge(f.file_name)
                        const marked = removeFileIds.has(f.id)
                        return (
                          <li key={f.id} className={`gd-file-item ${marked ? 'is-removed' : ''}`}>
                            <span className={`gd-file-badge ${b.cls}`}>{b.label}</span>
                            <span className="gd-file-name" title={f.file_name}>{f.file_name}</span>
                            {f.size_bytes != null && <span className="gd-file-size">{formatSize(f.size_bytes)}</span>}
                            <button type="button" className="gd-file-action" onClick={() => handleDownload(f)} title="Скачать" aria-label="Скачать файл">Скачать</button>
                            <button type="button" className={`gd-file-action ${marked ? '' : 'gd-file-remove'}`} onClick={() => toggleRemoveExistingFile(f.id)} title={marked ? 'Вернуть' : 'Удалить'} aria-label={marked ? 'Вернуть файл' : 'Удалить файл'}>{marked ? 'Вернуть' : 'Удалить'}</button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}
              </div>

              <div className="gd-modal-footer">
                {formError && <span className="gd-form-error">{formError}</span>}
                <div className="gd-footer-actions">
                  <button type="button" className="btn-secondary" onClick={closeModal} disabled={saving}>Отмена</button>
                  <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
