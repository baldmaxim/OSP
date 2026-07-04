import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import './GeneralDocumentsPage.css'

// task 416: реестр общих документов компании и полезных ссылок.
// Метаданные — в general_documents; файлы — в S3 (owner_type='general_document').

const EMPTY_FORM = { title: '', source_type: 'file', link_url: '', file: null }

// Аккуратно нормализуем ссылку: без схемы — добавляем https://
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

export default function GeneralDocumentsPage() {
  const navigate = useNavigate()
  const { user, userProfile, canEdit } = useRole()
  const canEditDocs = canEdit('general_documents')

  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const fetchDocs = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('general_documents')
      .select('*, s3_documents(id, file_name, s3_key)')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
    if (error) {
      console.error('Ошибка загрузки документов:', error.message)
      alert('Ошибка загрузки документов: ' + error.message)
    } else {
      setDocuments(data || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return documents
    return documents.filter(d =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.link_url || '').toLowerCase().includes(q) ||
      (d.s3_documents?.file_name || '').toLowerCase().includes(q)
    )
  }, [documents, search])

  const openAdd = () => { setEditing(null); setForm(EMPTY_FORM); setShowModal(true) }
  const openEdit = (doc) => {
    setEditing(doc)
    setForm({ title: doc.title || '', source_type: doc.source_type || 'file', link_url: doc.link_url || '', file: null })
    setShowModal(true)
  }
  const closeModal = () => {
    if (saving) return
    setShowModal(false); setEditing(null); setForm(EMPTY_FORM)
  }

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
    const title = form.title.trim()
    if (!title) { alert('Укажите наименование документа'); return }

    // ── Ссылка ────────────────────────────────────────────────────────────
    if (form.source_type === 'link') {
      const url = normalizeUrl(form.link_url)
      if (!url || !isValidUrl(url)) { alert('Укажите корректную ссылку (например, https://...)'); return }
      setSaving(true)
      try {
        const oldFile = editing?.source_type === 'file' ? editing.s3_documents : null
        if (editing) {
          const { error } = await supabase.from('general_documents')
            .update({ title, source_type: 'link', link_url: url, s3_document_id: null, updated_at: new Date().toISOString() })
            .eq('id', editing.id)
          if (error) throw error
          // Тип сменился с файла на ссылку — старый файл больше не нужен.
          if (oldFile?.s3_key) {
            try { await deleteDocument(oldFile) } catch (err) { console.error('Не удалён старый файл:', err.message) }
          }
        } else {
          const { error } = await supabase.from('general_documents')
            .insert({ title, source_type: 'link', link_url: url, s3_document_id: null, created_by: user?.id || null, created_by_name: userProfile?.full_name || null })
          if (error) throw error
        }
        await fetchDocs()
        closeModal()
      } catch (err) {
        alert('Ошибка сохранения: ' + err.message)
      } finally {
        setSaving(false)
      }
      return
    }

    // ── Файл ──────────────────────────────────────────────────────────────
    const hasExistingFile = !!(editing && editing.source_type === 'file' && editing.s3_document_id)
    if (!form.file && !hasExistingFile) { alert('Выберите файл'); return }

    setSaving(true)
    try {
      if (editing) {
        if (form.file) {
          // Загружаем новый файл; при успехе заменяем ссылку и удаляем старый.
          const uploaded = await uploadFile({ file: form.file, ownerType: 'general_document', ownerId: editing.id })
          const oldFile = editing.source_type === 'file' ? editing.s3_documents : null
          const { error } = await supabase.from('general_documents')
            .update({ title, source_type: 'file', link_url: null, s3_document_id: uploaded.id, updated_at: new Date().toISOString() })
            .eq('id', editing.id)
          if (error) {
            try { await deleteDocument(uploaded) } catch { /* лучшее усилие */ }
            throw error
          }
          if (oldFile?.s3_key) {
            try { await deleteDocument(oldFile) } catch (err) { console.error('Не удалён старый файл:', err.message) }
          }
        } else {
          // Файл не меняем — правим только наименование.
          const { error } = await supabase.from('general_documents')
            .update({ title, source_type: 'file', link_url: null, updated_at: new Date().toISOString() })
            .eq('id', editing.id)
          if (error) throw error
        }
      } else {
        // Новый документ-файл: 1) создаём запись, 2) грузим файл, 3) проставляем s3_document_id.
        const { data: created, error: insErr } = await supabase.from('general_documents')
          .insert({ title, source_type: 'file', link_url: null, s3_document_id: null, created_by: user?.id || null, created_by_name: userProfile?.full_name || null })
          .select('id')
          .single()
        if (insErr) throw insErr
        try {
          const uploaded = await uploadFile({ file: form.file, ownerType: 'general_document', ownerId: created.id })
          const { error: updErr } = await supabase.from('general_documents')
            .update({ s3_document_id: uploaded.id }).eq('id', created.id)
          if (updErr) {
            try { await deleteDocument(uploaded) } catch { /* лучшее усилие */ }
            throw updErr
          }
        } catch (upErr) {
          // Загрузка упала — не оставляем пустую строку.
          await supabase.from('general_documents').delete().eq('id', created.id)
          throw upErr
        }
      }
      await fetchDocs()
      closeModal()
    } catch (err) {
      alert('Ошибка сохранения: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (doc) => {
    if (!window.confirm(`Удалить документ «${doc.title}»?`)) return
    try {
      // Для файла: сначала удаляем объект из S3 (+ запись s3_documents), потом метаданные.
      if (doc.source_type === 'file' && doc.s3_documents?.s3_key) {
        await deleteDocument(doc.s3_documents)
      }
      const { error } = await supabase.from('general_documents').delete().eq('id', doc.id)
      if (error) throw error
      await fetchDocs()
    } catch (err) {
      alert('Не удалось удалить документ: ' + err.message)
    }
  }

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
          placeholder="Поиск по наименованию документа или ссылке"
        />
      </div>

      {loading ? (
        <div className="gd-loading">Загрузка...</div>
      ) : filtered.length === 0 ? (
        <div className="gd-empty">
          {search.trim()
            ? <p>Ничего не найдено.</p>
            : (
              <>
                <p className="gd-empty-title">Документы пока не добавлены</p>
                {canEditDocs && <p className="gd-empty-hint">Добавьте первый документ или ссылку</p>}
              </>
            )}
        </div>
      ) : (
        <div className="gd-table-container">
          <table className="gd-table">
            <thead>
              <tr>
                <th className="gd-col-num">№ п/п</th>
                <th>Наименование документа</th>
                <th>Документ / ссылка на документ</th>
                {canEditDocs && <th className="gd-col-actions">Действия</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((doc, index) => (
                <tr key={doc.id}>
                  <td className="gd-col-num">{index + 1}</td>
                  <td className="gd-title-cell">{doc.title}</td>
                  <td className="gd-doc-cell">
                    {doc.source_type === 'link' ? (
                      doc.link_url ? (
                        <a href={doc.link_url} target="_blank" rel="noopener noreferrer" className="gd-link">
                          Открыть ссылку
                        </a>
                      ) : (
                        <span className="gd-missing">Ссылка не указана</span>
                      )
                    ) : doc.s3_documents?.s3_key ? (
                      <button className="gd-link gd-file-btn" onClick={() => handleDownload(doc.s3_documents)}>
                        Скачать {doc.s3_documents.file_name}
                      </button>
                    ) : (
                      <span className="gd-missing">Файл не найден</span>
                    )}
                  </td>
                  {canEditDocs && (
                    <td className="gd-col-actions">
                      <button className="gd-icon-btn" onClick={() => openEdit(doc)} title="Редактировать">✎</button>
                      <button className="gd-icon-btn gd-icon-danger" onClick={() => handleDelete(doc)} title="Удалить">🗑</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="gd-modal-overlay" onClick={closeModal}>
          <div className="gd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gd-modal-header">
              <h3>{editing ? 'Редактировать документ' : 'Добавить документ'}</h3>
              <button className="gd-modal-close" onClick={closeModal} aria-label="Закрыть">×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="gd-form-group">
                <label>Наименование документа *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="Например: Инструкция по оформлению отпуска"
                  autoFocus
                />
              </div>

              <div className="gd-form-group">
                <label>Тип документа *</label>
                <div className="gd-radio-row">
                  <label className="gd-radio">
                    <input
                      type="radio"
                      name="source_type"
                      checked={form.source_type === 'file'}
                      onChange={() => setForm(f => ({ ...f, source_type: 'file' }))}
                    />
                    Файл
                  </label>
                  <label className="gd-radio">
                    <input
                      type="radio"
                      name="source_type"
                      checked={form.source_type === 'link'}
                      onChange={() => setForm(f => ({ ...f, source_type: 'link' }))}
                    />
                    Ссылка
                  </label>
                </div>
              </div>

              {form.source_type === 'file' ? (
                <div className="gd-form-group">
                  <label>Файл{editing?.source_type === 'file' && editing?.s3_document_id ? '' : ' *'}</label>
                  {editing?.source_type === 'file' && editing?.s3_documents?.file_name && (
                    <p className="gd-current-file">Текущий файл: {editing.s3_documents.file_name}. Выберите новый, чтобы заменить.</p>
                  )}
                  <input
                    type="file"
                    onChange={(e) => setForm(f => ({ ...f, file: e.target.files?.[0] || null }))}
                  />
                </div>
              ) : (
                <div className="gd-form-group">
                  <label>Ссылка на документ *</label>
                  <input
                    type="text"
                    value={form.link_url}
                    onChange={(e) => setForm(f => ({ ...f, link_url: e.target.value }))}
                    placeholder="https://..."
                  />
                </div>
              )}

              <div className="gd-modal-footer">
                <button type="button" className="btn-secondary" onClick={closeModal} disabled={saving}>Отмена</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
