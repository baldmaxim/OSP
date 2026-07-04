import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import './GeneralDocumentsPage.css'

// task 416: реестр общих документов компании. Одна запись — «карточка документа»,
// в которой может быть несколько ссылок (general_document_links) и несколько файлов
// (s3_documents по owner_type='general_document', owner_id=id).

const MATERIALS_PREVIEW = 4  // сколько материалов показывать в строке до «Ещё N»

function normalizeUrl(raw) {
  const v = (raw || '').trim()
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}
function isValidUrl(v) {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
// ДД.ММ.ГГГГ ЧЧ:ММ — для колонки «Обновлено»
function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
}
// Нейтральные SVG-иконки действий (currentColor, единый размер 16×16).
const gdIconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  width: 16, height: 16, 'aria-hidden': true,
}
const EditIcon = () => (
  <svg {...gdIconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const TrashIcon = () => (
  <svg {...gdIconProps}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
)
// Мягкий бейдж типа файла по расширению (без внешних библиотек).
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

const EMPTY_FORM = { title: '', description: '', links: [], newFiles: [] }

export default function GeneralDocumentsPage() {
  const navigate = useNavigate()
  const { user, userProfile, canEdit } = useRole()
  const canEditDocs = canEdit('general_documents')
  // Отображаемое имя текущего пользователя (ФИО → email → null) для created_by/updated_by.
  const currentUserName = userProfile?.full_name || user?.email || null

  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [removeFileIds, setRemoveFileIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef(null)

  // Загрузка: карточки + ссылки (join) + файлы из s3_documents (по owner).
  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const { data: docs, error } = await supabase
        .from('general_documents')
        .select('*, general_document_links(*)')
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
      if (error) throw error

      const ids = (docs || []).map(d => d.id)
      let filesByDoc = {}
      if (ids.length) {
        const { data: files, error: fErr } = await supabase
          .from('s3_documents')
          .select('id, owner_id, file_name, s3_key, size_bytes, created_at')
          .eq('owner_type', 'general_document')
          .in('owner_id', ids)
          .order('created_at', { ascending: true })
        if (fErr) throw fErr
        filesByDoc = (files || []).reduce((acc, f) => {
          (acc[f.owner_id] = acc[f.owner_id] || []).push(f)
          return acc
        }, {})
      }

      const mapped = (docs || []).map(d => ({
        ...d,
        links: [...(d.general_document_links || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
        files: filesByDoc[d.id] || [],
      }))
      setDocuments(mapped)
      return mapped
    } catch (err) {
      console.error('Ошибка загрузки документов:', err.message)
      alert('Ошибка загрузки документов: ' + err.message)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return documents
    return documents.filter(d => {
      const hay = [
        d.title,
        d.description,
        ...(d.links || []).flatMap(l => [l.title, l.url]),
        ...(d.files || []).map(f => f.file_name),
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [documents, search])

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // ── Модалка ────────────────────────────────────────────────────────────
  const clearErrors = () => { setFormError(''); setLinkError('') }
  const openAdd = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, links: [] })
    setRemoveFileIds(new Set())
    clearErrors()
    setShowModal(true)
  }
  const openEdit = (doc) => {
    setEditing(doc)
    setForm({
      title: doc.title || '',
      description: doc.description || '',
      links: (doc.links || []).map(l => ({ title: l.title || '', url: l.url || '' })),
      newFiles: [],
    })
    setRemoveFileIds(new Set())
    clearErrors()
    setShowModal(true)
  }
  const closeModal = () => {
    if (saving) return
    setShowModal(false); setEditing(null); setForm(EMPTY_FORM); setRemoveFileIds(new Set())
    clearErrors(); setDragActive(false)
  }

  // Закрытие по Escape (не мешаем во время сохранения).
  useEffect(() => {
    if (!showModal) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) {
        setShowModal(false); setEditing(null); setForm(EMPTY_FORM); setRemoveFileIds(new Set())
        setFormError(''); setLinkError(''); setDragActive(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showModal, saving])

  const openFileDialog = () => fileInputRef.current?.click()
  const onDropZoneDragOver = (e) => { e.preventDefault(); if (!dragActive) setDragActive(true) }
  const onDropZoneDragLeave = (e) => { e.preventDefault(); setDragActive(false) }
  const onDropZoneDrop = (e) => {
    e.preventDefault()
    setDragActive(false)
    if (e.dataTransfer?.files?.length) addNewFiles(e.dataTransfer.files)
  }

  const addLinkRow = () => setForm(f => ({ ...f, links: [...f.links, { title: '', url: '' }] }))
  const updateLinkRow = (i, field, value) => setForm(f => ({
    ...f, links: f.links.map((l, idx) => idx === i ? { ...l, [field]: value } : l),
  }))
  const removeLinkRow = (i) => setForm(f => ({ ...f, links: f.links.filter((_, idx) => idx !== i) }))

  const addNewFiles = (fileList) => {
    const arr = Array.from(fileList || [])
    if (arr.length) setForm(f => ({ ...f, newFiles: [...f.newFiles, ...arr] }))
  }
  const removeNewFile = (i) => setForm(f => ({ ...f, newFiles: f.newFiles.filter((_, idx) => idx !== i) }))
  const toggleRemoveExistingFile = (id) => setRemoveFileIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const handleDownload = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key)
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = s3doc.file_name || ''
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      alert('Не удалось получить файл: ' + e.message)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    clearErrors()
    const title = form.title.trim()
    if (!title) { setFormError('Укажите наименование документа'); return }

    // Валидация ссылок: игнорируем полностью пустые строки; ловим «есть название, но нет URL»
    // и некорректные URL. Ошибку показываем рядом с блоком ссылок.
    const nonEmpty = form.links
      .map(l => ({ title: (l.title || '').trim(), rawUrl: (l.url || '').trim() }))
      .filter(r => r.title || r.rawUrl)
    for (const r of nonEmpty) {
      if (!r.rawUrl) { setLinkError('Для заполненного названия укажите ссылку (URL)'); return }
      if (!isValidUrl(normalizeUrl(r.rawUrl))) { setLinkError(`Укажите корректную ссылку: ${r.rawUrl}`); return }
    }
    const validLinks = nonEmpty.map(r => ({ title: r.title, url: normalizeUrl(r.rawUrl) }))

    const keptExisting = (editing?.files || []).filter(f => !removeFileIds.has(f.id))
    if (validLinks.length + form.newFiles.length + keptExisting.length === 0) {
      setFormError('Добавьте хотя бы одну ссылку или файл')
      return
    }

    setSaving(true)
    const problems = []
    try {
      let docId
      if (editing) {
        const { error } = await supabase.from('general_documents')
          .update({
            title,
            description: form.description.trim() || null,
            updated_at: new Date().toISOString(),
            updated_by: user?.id || null,
            updated_by_name: currentUserName,
          })
          .eq('id', editing.id)
        if (error) throw error
        docId = editing.id

        // Ссылки: вставляем новый набор, затем удаляем старые (безопасно при сбое).
        const oldLinkIds = (editing.links || []).map(l => l.id)
        if (validLinks.length) {
          const rows = validLinks.map((l, idx) => ({ general_document_id: docId, title: l.title || null, url: l.url, sort_order: idx }))
          const { error: insErr } = await supabase.from('general_document_links').insert(rows)
          if (insErr) throw insErr
        }
        if (oldLinkIds.length) {
          const { error: delErr } = await supabase.from('general_document_links').delete().in('id', oldLinkIds)
          if (delErr) throw delErr
        }

        // Удаляем помеченные существующие файлы.
        const toRemove = (editing.files || []).filter(f => removeFileIds.has(f.id))
        const failedDel = []
        for (const f of toRemove) {
          try { await deleteDocument(f) } catch { failedDel.push(f.file_name) }
        }
        if (failedDel.length) problems.push('не удалось удалить: ' + failedDel.join(', '))
      } else {
        const { data: created, error } = await supabase.from('general_documents')
          .insert({
            title,
            description: form.description.trim() || null,
            source_type: 'mixed',
            created_by: user?.id || null,
            created_by_name: currentUserName,
            updated_by: user?.id || null,
            updated_by_name: currentUserName,
          })
          .select('id')
          .single()
        if (error) throw error
        docId = created.id

        if (validLinks.length) {
          const rows = validLinks.map((l, idx) => ({ general_document_id: docId, title: l.title || null, url: l.url, sort_order: idx }))
          const { error: linkErr } = await supabase.from('general_document_links').insert(rows)
          if (linkErr) throw linkErr
        }
      }

      // Загрузка новых файлов (частичный сбой — сообщаем, но не откатываем всё).
      const failedNames = []
      for (const file of form.newFiles) {
        try {
          await uploadFile({ file, ownerType: 'general_document', ownerId: docId })
        } catch (upErr) {
          console.error('Файл не загружен:', file.name, upErr.message)
          failedNames.push(file.name)
        }
      }
      if (failedNames.length) problems.push('не удалось загрузить: ' + failedNames.join(', '))

      const docs = await fetchDocs()

      if (problems.length) {
        // Оставляем модалку открытой в режиме редактирования сохранённого документа,
        // чтобы можно было повторить проблемные операции без дублей.
        const saved = docs.find(d => d.id === docId) || editing
        setEditing(saved)
        setForm({
          title,
          description: form.description,
          links: (saved?.links || validLinks).map(l => ({ title: l.title || '', url: l.url || '' })),
          newFiles: form.newFiles.filter(f => failedNames.includes(f.name)),
        })
        setRemoveFileIds(new Set())
        setFormError('Часть операций не выполнена (' + problems.join('; ') + '). Проверьте и сохраните снова.')
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
    if (!window.confirm(`Удалить документ «${doc.title}» и все связанные файлы и ссылки?`)) return
    try {
      // Сначала файлы из S3 (при сбое — прерываемся, чтобы не потерять связь).
      for (const f of (doc.files || [])) {
        await deleteDocument(f)
      }
      // Ссылки удалятся каскадом вместе с записью.
      const { error } = await supabase.from('general_documents').delete().eq('id', doc.id)
      if (error) throw error
      await fetchDocs()
    } catch (err) {
      alert('Не удалось удалить документ: ' + err.message)
    }
  }

  // Материалы карточки для отображения (сначала ссылки, потом файлы).
  const buildMaterials = (doc) => ([
    ...(doc.links || []).map(l => ({ kind: 'link', id: `l-${l.id}`, title: l.title, url: l.url })),
    ...(doc.files || []).map(f => ({ kind: 'file', id: `f-${f.id}`, s3: f })),
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

  const colCount = canEditDocs ? 6 : 5

  return (
    <div className="general-documents-page">
      <div className="gd-header">
        <div className="gd-header-left">
          <button className="gd-back" onClick={() => navigate('/general')} title="Назад к общей информации">←</button>
          <div>
            <h2>Документы</h2>
            <p className="gd-subtitle">Общие документы, инструкции и полезные ссылки</p>
          </div>
        </div>
        {canEditDocs && (
          <button className="btn-primary" onClick={openAdd}>+ Добавить документ</button>
        )}
      </div>

      <div className="gd-toolbar">
        <input
          type="text"
          className="gd-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по наименованию, файлу или ссылке"
        />
        <span className="gd-total">Всего: {filtered.length} {pluralDocs(filtered.length)}</span>
      </div>

      <div className="gd-card">
        {loading ? (
          <div className="gd-loading">Загрузка...</div>
        ) : filtered.length === 0 ? (
          <div className="gd-empty">
            {search.trim() ? (
              <p>Ничего не найдено.</p>
            ) : (
              <>
                <p className="gd-empty-title">Документы пока не добавлены</p>
                <p className="gd-empty-hint">Добавьте первую ссылку, инструкцию или файл</p>
                {canEditDocs && <button className="btn-primary" onClick={openAdd} style={{ marginTop: '0.75rem' }}>+ Добавить документ</button>}
              </>
            )}
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
                {canEditDocs && <col className="cg-actions" />}
              </colgroup>
              <thead>
                <tr>
                  <th className="gd-col-num">№</th>
                  <th className="gd-col-title">Наименование документа</th>
                  <th className="gd-col-materials">Документы и ссылки</th>
                  <th className="gd-col-updated">Обновлено</th>
                  <th className="gd-col-updatedby">Обновил</th>
                  {canEditDocs && <th className="gd-col-actions">Действия</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((doc, index) => {
                  const materials = buildMaterials(doc)
                  const isExp = expanded.has(doc.id)
                  const shown = isExp ? materials : materials.slice(0, MATERIALS_PREVIEW)
                  const hiddenCount = materials.length - shown.length
                  return (
                    <tr key={doc.id}>
                      <td className="gd-col-num">{index + 1}</td>
                      <td className="gd-col-title gd-title-cell">
                        <span className="gd-title-text">{doc.title}</span>
                        {doc.description && <span className="gd-desc-text">{doc.description}</span>}
                      </td>
                      <td className="gd-col-materials">
                        {materials.length === 0 ? (
                          <span className="gd-missing">—</span>
                        ) : (
                          <div className="gd-materials">
                            {shown.map(renderMaterial)}
                            {hiddenCount > 0 && (
                              <button className="gd-more-btn" onClick={() => toggleExpand(doc.id)}>Ещё {hiddenCount}</button>
                            )}
                            {isExp && materials.length > MATERIALS_PREVIEW && (
                              <button className="gd-more-btn" onClick={() => toggleExpand(doc.id)}>Свернуть</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="gd-col-updated gd-updated-cell">{formatDateTime(doc.updated_at || doc.created_at)}</td>
                      <td className="gd-col-updatedby gd-updatedby-cell">
                        {doc.updated_by_name || doc.created_by_name || '—'}
                      </td>
                      {canEditDocs && (
                        <td className="gd-col-actions">
                          <button className="gd-icon-btn" onClick={() => openEdit(doc)} title="Редактировать" aria-label="Редактировать"><EditIcon /></button>
                          <button className="gd-icon-btn gd-icon-danger" onClick={() => handleDelete(doc)} title="Удалить" aria-label="Удалить"><TrashIcon /></button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={colCount} className="gd-tfoot">Всего: {filtered.length} {pluralDocs(filtered.length)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="gd-modal-overlay" onClick={closeModal}>
          <div className="gd-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="gd-modal-header">
              <div className="gd-modal-heading">
                <h3>{editing ? 'Редактировать документ' : 'Добавить документ'}</h3>
                <p className="gd-modal-subtitle">
                  {editing
                    ? 'Измените название, ссылки и прикреплённые файлы'
                    : 'Добавьте название, ссылки и прикреплённые файлы'}
                </p>
              </div>
              <button className="gd-modal-close" onClick={closeModal} aria-label="Закрыть">×</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="gd-modal-body">
                {/* Основная информация */}
                <section className="gd-section">
                  <h4 className="gd-section-title">Основная информация</h4>
                  <div className="gd-form-group">
                    <label htmlFor="gd-title">Наименование документа *</label>
                    <input
                      id="gd-title"
                      type="text"
                      value={form.title}
                      onChange={(e) => { setForm(f => ({ ...f, title: e.target.value })); if (formError) setFormError('') }}
                      placeholder="Например: Обучение Excel и Revit"
                      autoFocus
                    />
                  </div>
                  <div className="gd-form-group">
                    <label htmlFor="gd-desc">Описание / примечание</label>
                    <textarea
                      id="gd-desc"
                      className="gd-textarea"
                      value={form.description}
                      onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Краткое описание — для кого и зачем этот документ (необязательно)"
                    />
                  </div>
                </section>

                {/* Ссылки */}
                <section className="gd-section">
                  <h4 className="gd-section-title">Ссылки</h4>
                  {form.links.length === 0 && <p className="gd-hint">Ссылки пока не добавлены</p>}
                  {form.links.map((l, i) => (
                    <div className="gd-link-row" key={i}>
                      <input
                        type="text"
                        className="gd-link-title"
                        value={l.title}
                        onChange={(e) => { updateLinkRow(i, 'title', e.target.value); if (linkError) setLinkError('') }}
                        placeholder="Название ссылки"
                      />
                      <input
                        type="text"
                        className="gd-link-url"
                        value={l.url}
                        onChange={(e) => { updateLinkRow(i, 'url', e.target.value); if (linkError) setLinkError('') }}
                        placeholder="https://..."
                      />
                      <button type="button" className="gd-row-remove" onClick={() => removeLinkRow(i)} title="Удалить ссылку" aria-label="Удалить ссылку">×</button>
                    </div>
                  ))}
                  {linkError && <p className="gd-inline-error">{linkError}</p>}
                  <button type="button" className="gd-add-row" onClick={addLinkRow}>+ Добавить ссылку</button>
                </section>

                {/* Файлы — зона загрузки */}
                <section className="gd-section">
                  <h4 className="gd-section-title">Файлы</h4>
                  <div
                    className={`gd-dropzone ${dragActive ? 'is-drag' : ''}`}
                    onClick={openFileDialog}
                    onDragOver={onDropZoneDragOver}
                    onDragLeave={onDropZoneDragLeave}
                    onDrop={onDropZoneDrop}
                  >
                    <span className="gd-dropzone-icon" aria-hidden>📎</span>
                    <div className="gd-dropzone-main">Перетащите файлы сюда</div>
                    <div className="gd-dropzone-sub">или выберите их на компьютере</div>
                    <button type="button" className="gd-dropzone-btn" onClick={(e) => { e.stopPropagation(); openFileDialog() }}>Выбрать файлы</button>
                    <div className="gd-dropzone-hint">PDF, DOCX, XLSX и другие документы</div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="gd-file-input-hidden"
                      onChange={(e) => { addNewFiles(e.target.files); e.target.value = '' }}
                    />
                  </div>

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

                {/* Прикреплённые файлы (режим редактирования) */}
                {editing && (editing.files || []).length > 0 && (
                  <section className="gd-section">
                    <h4 className="gd-section-title">Прикреплённые файлы</h4>
                    <ul className="gd-file-list">
                      {editing.files.map(f => {
                        const b = fileBadge(f.file_name)
                        const marked = removeFileIds.has(f.id)
                        return (
                          <li key={f.id} className={`gd-file-item ${marked ? 'is-removed' : ''}`}>
                            <span className={`gd-file-badge ${b.cls}`}>{b.label}</span>
                            <span className="gd-file-name" title={f.file_name}>{f.file_name}</span>
                            {f.size_bytes != null && <span className="gd-file-size">{formatSize(f.size_bytes)}</span>}
                            <button type="button" className="gd-file-action" onClick={() => handleDownload(f)} title="Скачать" aria-label="Скачать файл">Скачать</button>
                            <button
                              type="button"
                              className={`gd-file-action ${marked ? '' : 'gd-file-remove'}`}
                              onClick={() => toggleRemoveExistingFile(f.id)}
                              title={marked ? 'Вернуть' : 'Удалить'}
                              aria-label={marked ? 'Вернуть файл' : 'Удалить файл'}
                            >{marked ? 'Вернуть' : 'Удалить'}</button>
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

function pluralDocs(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'документ'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'документа'
  return 'документов'
}
