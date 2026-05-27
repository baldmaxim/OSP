import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import { deleteDocument, requestDownloadUrl } from '../services/s3'
import ObjectDocumentFileSlot from '../components/ObjectDocumentFileSlot'
import S3DocumentPreview from '../components/S3DocumentPreview'
import './ObjectDetailPage.css'

// Табличная строка документа (договор/ДС/приложение).
// Объявлена вне ObjectDetailPage — иначе при каждом рендере родителя пересоздаётся компонент,
// что приводит к unmount-mount всех строк документа и «вылетающим» модалкам редактирования.
// Ячейка одного файла в строке документа: имя + просмотр + скачать.
function DocFileCell({ s3doc, accent, onPreview, onDownload, compact = false }) {
  if (!s3doc) return <span className="muted">—</span>
  return (
    <div
      className={`doc-cell-file ${accent === 'signed' ? 'doc-cell-file-signed' : 'doc-cell-file-editable'}${compact ? ' doc-cell-file-compact' : ''}`}
      title={compact ? s3doc.file_name : undefined}
    >
      {compact ? (
        // В компакт-режиме показываем только иконку документа — визуальный маркер
        // «файл есть» — без имени; кнопки идут сразу следом.
        <svg className="doc-cell-file-icon doc-cell-file-icon-compact" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      ) : (
        <span className="doc-cell-file-name" title={s3doc.file_name}>
          <svg className="doc-cell-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          {s3doc.file_name}
        </span>
      )}
      <button type="button" className="doc-cell-file-btn doc-cell-file-btn-view" onClick={() => onPreview(s3doc)} title="Просмотр" aria-label="Просмотр">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button type="button" className="doc-cell-file-btn doc-cell-file-btn-download" onClick={() => onDownload(s3doc)} title="Скачать" aria-label="Скачать">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
    </div>
  )
}

function DocRow({
  doc,
  level = 0,
  attachments = [],
  expandedDocs,
  toggleExpand,
  formatDate,
  onAddAttachment,
  onEdit,
  onDelete,
  onPreviewFile,
  onDownloadFile,
}) {
  const isAttachment = level > 0
  const hasAttachments = attachments.length > 0
  const isExpanded = expandedDocs.has(doc.id)

  return (
    <>
      <tr className={`doc-row-tr ${isAttachment ? 'doc-row-tr-attachment' : ''}`}>
        <td className="doc-cell-marker" style={{ paddingLeft: `${level * 14 + 8}px` }}>
          {isAttachment ? (
            <span className="doc-attachment-marker" aria-hidden>↳</span>
          ) : hasAttachments ? (
            <button
              type="button"
              className="doc-expand-btn"
              onClick={() => toggleExpand(doc.id)}
              title={isExpanded ? 'Свернуть приложения' : `Развернуть приложения (${attachments.length})`}
              aria-label={isExpanded ? 'Свернуть' : 'Развернуть'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          ) : null}
        </td>
        <td className="doc-cell-name">
          <div className="doc-name-line">
            {/* Для приложений в первой колонке (у стрелочки) — № приложения, наименование уходит правее */}
            <span className="doc-name-text" title={isAttachment ? (doc.document_number || '') : doc.name}>
              {isAttachment ? (doc.document_number || <span className="muted">—</span>) : doc.name}
            </span>
          </div>
          {doc.notes && <div className="doc-notes-line" title={doc.notes}>{doc.notes}</div>}
        </td>
        <td className="doc-cell-meta">
          {isAttachment ? (
            <div title={doc.name || ''}>{doc.name || <span className="muted">—</span>}</div>
          ) : (
            <>
              <div>{doc.document_number || <span className="muted">—</span>}</div>
              <div className="doc-date-line">{doc.document_date ? formatDate(doc.document_date) : ''}</div>
            </>
          )}
        </td>
        <td className="doc-cell-link-compact">
          <DocFileCell compact s3doc={doc.signed} accent="signed" onPreview={onPreviewFile} onDownload={onDownloadFile} />
        </td>
        <td className="doc-cell-link-compact">
          <DocFileCell compact s3doc={doc.editable} accent="editable" onPreview={onPreviewFile} onDownload={onDownloadFile} />
        </td>
        <td className="doc-cell-actions">
          <button type="button" className="doc-action-btn" onClick={() => onEdit(doc)} title="Редактировать">
            ✏️
          </button>
          <button type="button" className="doc-action-btn doc-action-delete" onClick={() => onDelete(doc.id)} title="Удалить">
            🗑️
          </button>
        </td>
      </tr>
      {/* Вложенные приложения — показываются только если родитель развёрнут */}
      {!isAttachment && isExpanded && attachments.map(att => (
        <DocRow
          key={att.id}
          doc={att}
          level={level + 1}
          expandedDocs={expandedDocs}
          toggleExpand={toggleExpand}
          formatDate={formatDate}
          onAddAttachment={onAddAttachment}
          onEdit={onEdit}
          onDelete={onDelete}
          onPreviewFile={onPreviewFile}
          onDownloadFile={onDownloadFile}
        />
      ))}
      {/* Кнопка «+ Приложение» под каждым родительским документом */}
      {!isAttachment && (
        <tr className="doc-row-tr-add-attachment">
          <td colSpan={6}>
            <button
              type="button"
              className="doc-add-attachment-btn"
              onClick={() => onAddAttachment(doc.id)}
              title="Добавить приложение к этому документу"
            >
              <span aria-hidden>+</span>
              <span>Приложение</span>
            </button>
          </td>
        </tr>
      )}
    </>
  )
}

// AgreementRow — компактный 7-колоночный ряд для таблицы «Дополнительные соглашения».
// Отдельно от DocRow, потому что у ДС-таблицы свой layout: убран «Номер», добавлен
// «Описание ДС», компактные файловые ячейки (только иконки).
function AgreementRow({
  doc,
  attachments = [],
  expandedDocs,
  toggleExpand,
  formatDate,
  onAddAttachment,
  onEdit,
  onDelete,
  onPreviewFile,
  onDownloadFile,
  // task 329: drag-drop reorder props (passed from ObjectDetailPage)
  isDragging,
  dragOverPosition, // 'before' | 'after' | null
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
}) {
  const hasAttachments = attachments.length > 0
  const isExpanded = expandedDocs.has(doc.id)
  return (
    <>
      <tr
        className={[
          'doc-row-tr',
          'doc-row-draggable',
          isDragging ? 'doc-row-dragging' : '',
          /* task 331: индикатор «before» рисуется на главной строке ДС.
             «after» рисуется ниже — на строке «+ Приложение», чтобы линия
             всегда стояла между блоками ДС, а не между ДС и его приложением. */
          dragOverPosition === 'before' ? 'doc-row-drop-before' : '',
        ].filter(Boolean).join(' ')}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', doc.id)
          onDragStart?.(doc.id)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const isAbove = (e.clientY - rect.top) < rect.height / 2
          onDragOver?.(doc.id, isAbove ? 'before' : 'after')
        }}
        onDragLeave={() => onDragLeave?.(doc.id)}
        onDragEnd={() => onDragEnd?.()}
        onDrop={(e) => {
          e.preventDefault()
          const draggedId = e.dataTransfer.getData('text/plain')
          onDrop?.(draggedId, doc.id)
        }}
      >
        <td className="doc-cell-marker">
          <span className="doc-drag-handle" title="Перетащите для изменения порядка" aria-hidden>⋮⋮</span>
          {hasAttachments ? (
            <button
              type="button"
              className="doc-expand-btn"
              onClick={() => toggleExpand(doc.id)}
              title={isExpanded ? 'Свернуть приложения' : `Развернуть приложения (${attachments.length})`}
              aria-label={isExpanded ? 'Свернуть' : 'Развернуть'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          ) : null}
        </td>
        <td className="doc-cell-name">
          <div className="doc-name-line">
            <span className="doc-name-text" title={doc.name}>{doc.name}</span>
          </div>
        </td>
        <td className="doc-cell-date">
          {doc.document_date ? formatDate(doc.document_date) : <span className="muted">—</span>}
        </td>
        <td className="doc-cell-desc">
          {doc.notes || <span className="muted">—</span>}
        </td>
        <td className="doc-cell-link-compact">
          <DocFileCell compact s3doc={doc.signed} accent="signed" onPreview={onPreviewFile} onDownload={onDownloadFile} />
        </td>
        <td className="doc-cell-link-compact">
          <DocFileCell compact s3doc={doc.editable} accent="editable" onPreview={onPreviewFile} onDownload={onDownloadFile} />
        </td>
        <td className="doc-cell-actions">
          <button type="button" className="doc-action-btn" onClick={() => onEdit(doc)} title="Редактировать">✏️</button>
          <button type="button" className="doc-action-btn doc-action-delete" onClick={() => onDelete(doc.id)} title="Удалить">🗑️</button>
        </td>
      </tr>
      {isExpanded && attachments.map(att => (
        <tr
          key={att.id}
          className="doc-row-tr doc-row-tr-attachment"
          /* task 331: hover на строку-приложение во время drag = «after» родительского ДС.
             Сами приложения не реордерим — это только проксирование позиции. */
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            onDragOver?.(doc.id, 'after')
          }}
          onDrop={(e) => {
            e.preventDefault()
            const draggedId = e.dataTransfer.getData('text/plain')
            onDrop?.(draggedId, doc.id)
          }}
        >
          <td className="doc-cell-marker" style={{ paddingLeft: '22px' }}>
            <span className="doc-attachment-marker" aria-hidden>↳</span>
          </td>
          <td className="doc-cell-name">
            <div className="doc-name-line">
              <span className="doc-name-text" title={att.document_number || ''}>
                {att.document_number || <span className="muted">—</span>}
              </span>
            </div>
          </td>
          <td className="doc-cell-date"></td>
          <td className="doc-cell-desc">
            <div title={att.name || ''}>{att.name || <span className="muted">—</span>}</div>
            {att.notes && <div className="doc-notes-line" title={att.notes}>{att.notes}</div>}
          </td>
          <td className="doc-cell-link-compact">
            <DocFileCell compact s3doc={att.signed} accent="signed" onPreview={onPreviewFile} onDownload={onDownloadFile} />
          </td>
          <td className="doc-cell-link-compact">
            <DocFileCell compact s3doc={att.editable} accent="editable" onPreview={onPreviewFile} onDownload={onDownloadFile} />
          </td>
          <td className="doc-cell-actions">
            <button type="button" className="doc-action-btn" onClick={() => onEdit(att)} title="Редактировать">✏️</button>
            <button type="button" className="doc-action-btn doc-action-delete" onClick={() => onDelete(att.id)} title="Удалить">🗑️</button>
          </td>
        </tr>
      ))}
      {/* Кнопка «+ Приложение» отдельной строкой под ДС — как у Договора Генподряда.
          task 331: это последняя строка блока ДС, поэтому индикатор «after» рисуется
          именно здесь — линия оказывается между блоками двух соседних ДС. */}
      <tr
        className={[
          'doc-row-tr-add-attachment',
          dragOverPosition === 'after' ? 'doc-row-drop-after' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          onDragOver?.(doc.id, 'after')
        }}
        onDrop={(e) => {
          e.preventDefault()
          const draggedId = e.dataTransfer.getData('text/plain')
          onDrop?.(draggedId, doc.id)
        }}
      >
        <td colSpan={7}>
          <button
            type="button"
            className="doc-add-attachment-btn"
            onClick={() => onAddAttachment(doc.id)}
            title="Добавить приложение к этому документу"
          >
            <span aria-hidden>+</span>
            <span>Приложение</span>
          </button>
        </td>
      </tr>
    </>
  )
}

function ObjectDetailPage() {
  const { objectId } = useParams()
  const navigate = useNavigate()

  const [object, setObject] = useState(null)
  const [documents, setDocuments] = useState([])
  const [estimateItems, setEstimateItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('info')
  const [expandedDocs, setExpandedDocs] = useState(new Set())
  const didInitExpand = useRef(false)
  const [docSearchQuery, setDocSearchQuery] = useState('')
  // task 329: drag-drop порядка дополнительных соглашений.
  const [draggedAgreementId, setDraggedAgreementId] = useState(null)
  const [agreementDragOver, setAgreementDragOver] = useState(null) // {id, position: 'before'|'after'}
  const [isEstimateFullscreen, setIsEstimateFullscreen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState(new Set())
  const estimateFileRef = useRef(null)
  const [showVatModal, setShowVatModal] = useState(false)
  const [vatPercent, setVatPercent] = useState('22')
  const [startRow, setStartRow] = useState('2')
  const [endRow, setEndRow] = useState('')
  const [importMode, setImportMode] = useState('separate') // 'separate' | 'combined'
  const [pendingWorkbook, setPendingWorkbook] = useState(null)
  const [sheetNames, setSheetNames] = useState([])
  const [selectedSheet, setSelectedSheet] = useState('')

  // Document modal state
  const [showDocumentModal, setShowDocumentModal] = useState(false)
  const [editingDocument, setEditingDocument] = useState(null)
  const [parentDocumentId, setParentDocumentId] = useState(null)
  const [documentFormData, setDocumentFormData] = useState({
    document_type: 'general_contract',
    name: '',
    document_number: '',
    document_date: '',
    notes: ''
  })
  // S3-файлы в текущей открытой форме документа.
  // signed/editable — текущие записи s3_documents (объект или null).
  // originalIds — что было привязано на момент открытия формы; нужно, чтобы при
  // отмене понять, какие записи были загружены в этой сессии и подчистить их.
  const [docFiles, setDocFiles] = useState({ signed: null, editable: null })
  const [docFilesOriginalIds, setDocFilesOriginalIds] = useState({ signed: null, editable: null })
  const [docFilesUploading, setDocFilesUploading] = useState({ signed: false, editable: false })
  // Превью S3-файла в полноэкранной модалке.
  const [previewDoc, setPreviewDoc] = useState(null)

  // Object info modal state
  const [showInfoModal, setShowInfoModal] = useState(false)
  const [infoFormData, setInfoFormData] = useState({
    planned_start_date: '',
    planned_end_date: '',
    total_area: '',
    budget: ''
  })

  // Warranty state
  const [warranties, setWarranties] = useState([])
  const [showWarrantyModal, setShowWarrantyModal] = useState(false)
  const [editingWarranty, setEditingWarranty] = useState(null)
  const [warrantyFormData, setWarrantyFormData] = useState({
    work_name: '',
    start_date: '',
    warranty_months: '12'
  })

  // Warranty retentions state
  const [retentions, setRetentions] = useState([])
  const [showRetentionModal, setShowRetentionModal] = useState(false)
  const [editingRetention, setEditingRetention] = useState(null)
  const [retentionFormData, setRetentionFormData] = useState({
    retention_percent: '',
    retention_period: '',
    notes: ''
  })

  useEffect(() => {
    const handleEsc = (e) => { if (e.key === 'Escape') setIsEstimateFullscreen(false) }
    if (isEstimateFullscreen) {
      document.addEventListener('keydown', handleEsc)
      return () => document.removeEventListener('keydown', handleEsc)
    }
  }, [isEstimateFullscreen])

  const fetchObjectData = useCallback(async () => {
    setLoading(true)
    try {
      const { data: objectData, error: objectError } = await supabase
        .from('objects').select('*').eq('id', objectId).single()
      if (objectError) throw objectError
      setObject(objectData)

      const { data: docsData, error: docsError } = await supabase
        .from('object_documents')
        .select('*, signed:s3_documents!signed_s3_document_id(*), editable:s3_documents!editable_s3_document_id(*)')
        .eq('object_id', objectId)
        // task 329: при равных order_number сортируем по дате создания —
        // это гарантирует стабильный порядок для документов, у которых ещё не
        // выставлен ручной порядок (все DEFAULT 0).
        .order('order_number', { ascending: true })
        .order('created_at', { ascending: true })
      if (docsError) throw docsError
      const allDocs = docsData || []
      setDocuments(allDocs)
      // При первой загрузке раскрываем все родительские документы с приложениями.
      // Дальнейшие re-fetch (после добавления/удаления) не сбрасывают выбор пользователя.
      if (!didInitExpand.current) {
        didInitExpand.current = true
        const parentIdsWithChildren = allDocs
          .filter(d => d.parent_document_id)
          .map(d => d.parent_document_id)
        if (parentIdsWithChildren.length > 0) {
          setExpandedDocs(new Set(parentIdsWithChildren))
        }
      }

      const { data: estimateData, error: estimateError } = await supabase
        .from('object_estimate_items').select('*').eq('object_id', objectId).order('row_number')
      if (!estimateError) setEstimateItems(estimateData || [])

      const { data: warrantyData, error: warrantyError } = await supabase
        .from('object_warranties').select('*').eq('object_id', objectId).order('order_number')
      if (!warrantyError) setWarranties(warrantyData || [])

      const { data: retentionData, error: retentionError } = await supabase
        .from('object_warranty_retentions').select('*').eq('object_id', objectId).order('order_number')
      if (!retentionError) setRetentions(retentionData || [])
    } catch (error) {
      console.error('Ошибка загрузки данных:', error.message)
    } finally {
      setLoading(false)
    }
  }, [objectId])

  useEffect(() => {
    if (objectId) fetchObjectData()
  }, [objectId, fetchObjectData])

  // Автораскрытие групп с совпавшими приложениями при поиске (task 297).
  useEffect(() => {
    const q = docSearchQuery.trim().toLowerCase()
    if (!q) return
    const idsToExpand = new Set()
    for (const d of documents) {
      if (!d.parent_document_id) continue
      const hay = [d.name, d.document_number, d.notes].filter(Boolean).join(' ').toLowerCase()
      if (hay.includes(q)) idsToExpand.add(d.parent_document_id)
    }
    if (idsToExpand.size === 0) return
    setExpandedDocs(prev => {
      let changed = false
      const next = new Set(prev)
      for (const id of idsToExpand) {
        if (!next.has(id)) { next.add(id); changed = true }
      }
      return changed ? next : prev
    })
  }, [docSearchQuery, documents])

  const toggleExpand = (docId) => {
    setExpandedDocs(prev => {
      const next = new Set(prev)
      next.has(docId) ? next.delete(docId) : next.add(docId)
      return next
    })
  }

  // Document handlers
  const handleAddDocument = (documentType, parentId = null) => {
    setEditingDocument(null)
    setParentDocumentId(parentId)
    setDocumentFormData({
      document_type: documentType,
      name: '',
      document_number: '',
      document_date: '',
      notes: ''
    })
    setDocFiles({ signed: null, editable: null })
    setDocFilesOriginalIds({ signed: null, editable: null })
    setShowDocumentModal(true)
  }

  const handleEditDocument = (doc) => {
    setEditingDocument(doc)
    setParentDocumentId(doc.parent_document_id)
    setDocumentFormData({
      document_type: doc.document_type,
      name: doc.name,
      document_number: doc.document_number || '',
      document_date: doc.document_date || '',
      notes: doc.notes || ''
    })
    setDocFiles({ signed: doc.signed || null, editable: doc.editable || null })
    setDocFilesOriginalIds({
      signed: doc.signed_s3_document_id || null,
      editable: doc.editable_s3_document_id || null,
    })
    setShowDocumentModal(true)
  }

  // Удалить все S3-файлы (signed+editable), привязанные к документу и любому
  // из его потомков. Используем рекурсивный обход: parent_document_id ON DELETE
  // CASCADE удалит сами записи в БД, но не подскажет нам, какие s3_documents
  // нужно подчистить — сделаем это до DELETE.
  const collectS3DocsToDelete = (rootId, allDocs) => {
    const result = []
    const stack = [rootId]
    const visited = new Set()
    while (stack.length) {
      const id = stack.pop()
      if (visited.has(id)) continue
      visited.add(id)
      const node = allDocs.find(d => d.id === id)
      if (!node) continue
      if (node.signed) result.push(node.signed)
      if (node.editable) result.push(node.editable)
      const children = allDocs.filter(d => d.parent_document_id === id)
      for (const c of children) stack.push(c.id)
    }
    return result
  }

  const handleDeleteDocument = async (docId) => {
    if (!window.confirm('Удалить документ и все его приложения?')) return
    try {
      const s3Docs = collectS3DocsToDelete(docId, documents)
      // Сначала S3-файлы (best-effort: ошибки логируем, но не блокируем удаление документа).
      await Promise.allSettled(s3Docs.map(d => deleteDocument(d)))
      const { error } = await supabase.from('object_documents').delete().eq('id', docId)
      if (error) throw error
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  // task 329: переупорядочивание дополнительных соглашений drag-and-drop.
  // Сохраняем order_number кратным 10 — есть запас для будущих ручных вставок
  // без необходимости перенумеровывать соседей.
  const reorderAgreements = async (draggedId, targetId, position) => {
    if (!draggedId || draggedId === targetId) return
    // Берём актуальный отсортированный список ДС (без приложений).
    const ordered = documents
      .filter(d => d.document_type === 'additional_agreement' && !d.parent_document_id)
      .sort((a, b) => {
        const o = (a.order_number || 0) - (b.order_number || 0)
        if (o !== 0) return o
        return (a.created_at || '').localeCompare(b.created_at || '')
      })
    const fromIdx = ordered.findIndex(a => a.id === draggedId)
    if (fromIdx === -1) return
    const [moved] = ordered.splice(fromIdx, 1)
    let toIdx = ordered.findIndex(a => a.id === targetId)
    if (toIdx === -1) {
      ordered.splice(fromIdx, 0, moved) // вернуть как было
      return
    }
    if (position === 'after') toIdx += 1
    ordered.splice(toIdx, 0, moved)

    // Optimistic update — сразу обновляем локальный массив, чтобы UI не дёргался.
    const newOrderMap = new Map(ordered.map((a, idx) => [a.id, (idx + 1) * 10]))
    setDocuments(prev => prev.map(d =>
      newOrderMap.has(d.id) ? { ...d, order_number: newOrderMap.get(d.id) } : d
    ))

    try {
      await Promise.all(ordered.map((a, idx) =>
        supabase
          .from('object_documents')
          .update({ order_number: (idx + 1) * 10 })
          .eq('id', a.id)
      ))
    } catch (err) {
      alert('Не удалось сохранить новый порядок: ' + (err.message || err))
      fetchObjectData()
    }
  }

  const handleAgreementDragStart = (id) => setDraggedAgreementId(id)
  const handleAgreementDragOver = (id, position) => {
    setAgreementDragOver(prev => (prev?.id === id && prev?.position === position) ? prev : { id, position })
  }
  const handleAgreementDragLeave = (id) => {
    setAgreementDragOver(prev => prev?.id === id ? null : prev)
  }
  const handleAgreementDragEnd = () => {
    setDraggedAgreementId(null)
    setAgreementDragOver(null)
  }
  const handleAgreementDrop = async (draggedId, targetId) => {
    const position = agreementDragOver?.position || 'before'
    setDraggedAgreementId(null)
    setAgreementDragOver(null)
    await reorderAgreements(draggedId, targetId, position)
  }

  // Открытие/скачивание/превью S3-файла из ячейки таблицы.
  const handlePreviewFile = (s3doc) => setPreviewDoc(s3doc)
  const handleDownloadFile = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key)
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = s3doc.file_name || ''
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (error) {
      alert('Ошибка скачивания: ' + error.message)
    }
  }

  // Закрытие формы документа — отдельная функция, чтобы корректно подчистить
  // pending uploads (файлы, загруженные в S3, но не сохранённые в object_documents).
  const closeDocumentModalWithCleanup = useCallback(async () => {
    const orphans = []
    if (docFiles.signed && docFiles.signed.id !== docFilesOriginalIds.signed) {
      orphans.push(docFiles.signed)
    }
    if (docFiles.editable && docFiles.editable.id !== docFilesOriginalIds.editable) {
      orphans.push(docFiles.editable)
    }
    setShowDocumentModal(false)
    if (orphans.length > 0) {
      await Promise.allSettled(orphans.map(d => deleteDocument(d)))
    }
  }, [docFiles, docFilesOriginalIds])

  const handleSubmitDocument = async (e) => {
    e.preventDefault()
    if (parentDocumentId) {
      if (!documentFormData.document_number.trim()) return alert('Введите № приложения')
    } else {
      if (!documentFormData.name.trim()) return alert('Введите наименование')
    }

    try {
      const dataToSave = {
        object_id: objectId,
        parent_document_id: parentDocumentId,
        document_type: documentFormData.document_type,
        name: documentFormData.name.trim(),
        document_number: documentFormData.document_number.trim() || null,
        document_date: documentFormData.document_date || null,
        notes: documentFormData.notes?.trim() || null,
        order_number: editingDocument?.order_number || documents.length + 1,
        signed_s3_document_id: docFiles.signed?.id || null,
        editable_s3_document_id: docFiles.editable?.id || null,
      }

      if (editingDocument) {
        const { error } = await supabase.from('object_documents').update(dataToSave).eq('id', editingDocument.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('object_documents').insert([dataToSave])
        if (error) throw error
      }

      // Файлы уже привязаны — закрываем без cleanup-а, иначе только что
      // сохранённые записи будут удалены.
      setShowDocumentModal(false)
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  // Estimate handlers
  const cleanNumericValue = (value) => {
    if (typeof value === 'number') return value
    let str = String(value)
    str = str.replace(/[₽$€¥£]/g, '')
    str = str.replace(/[\s\u00A0\u2007\u202F]/g, '')
    str = str.replace(',', '.')
    str = str.replace(/[^\d.-]/g, '')
    return parseFloat(str) || 0
  }

  const handleFileSelect = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const workbook = XLSX.read(data, { type: 'array' })
      const names = workbook.SheetNames || []
      setPendingWorkbook(workbook)
      setSheetNames(names)
      setSelectedSheet(names[0] || '')
      setShowVatModal(true)
    } catch (error) {
      alert('Ошибка чтения файла: ' + error.message)
    }
    if (estimateFileRef.current) estimateFileRef.current.value = ''
  }

  const handleImportEstimate = async () => {
    if (!pendingWorkbook) return
    setShowVatModal(false)
    const vat = parseFloat(vatPercent) || 0
    try {
      const sheet = pendingWorkbook.Sheets[selectedSheet || pendingWorkbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      const start = Math.max(0, (parseInt(startRow) || 2) - 1)
      const end = endRow ? Math.min(rows.length, parseInt(endRow) || rows.length) : rows.length

      const items = []
      let rowNum = 1
      for (let i = start; i < end; i++) {
        const row = rows[i]
        if (!row || row.length === 0) continue

        // A=Код, B=Наименование, C=ед.изм., D=количество
        const code = row[0] ? String(row[0]).trim() : ''
        const name = row[1] ? String(row[1]).trim() : ''
        if (!name) continue

        const unit = row[2] ? String(row[2]).trim() : ''
        const quantity = cleanNumericValue(row[3])

        let priceMaterials, priceWorks, unitPrice, notes
        if (importMode === 'combined') {
          // E=цена за ед., F=примечания
          unitPrice = cleanNumericValue(row[4])
          priceMaterials = 0
          priceWorks = 0
          notes = row[5] ? String(row[5]).trim() : ''
        } else {
          // E=цена мат., F=цена работ, G=примечания
          priceMaterials = cleanNumericValue(row[4])
          priceWorks = cleanNumericValue(row[5])
          unitPrice = (priceMaterials || 0) + (priceWorks || 0)
          notes = row[6] ? String(row[6]).trim() : ''
        }

        // Секция: строка содержит только текст (нет ед.изм., нет числовых данных)
        const isSection = !unit && !quantity && !priceMaterials && !priceWorks && !unitPrice

        items.push({
          object_id: objectId,
          row_number: rowNum++,
          code: code || null,
          cost_name: name,
          unit: unit || null,
          quantity: quantity || null,
          unit_price_materials: priceMaterials || 0,
          unit_price_works: priceWorks || 0,
          unit_price: unitPrice || 0,
          total_price: quantity ? quantity * (unitPrice || 0) : 0,
          vat_percent: vat,
          is_section: isSection,
          original_row_number: String(i + 1),
          notes: notes || null,
          import_mode: importMode
        })
      }

      if (items.length === 0) return alert('Не найдено позиций в файле')

      await supabase.from('object_estimate_items').delete().eq('object_id', objectId)
      const { error } = await supabase.from('object_estimate_items').insert(items)
      if (error) throw error

      fetchObjectData()
      alert(`Импортировано ${items.length} позиций`)
    } catch (error) {
      alert('Ошибка импорта: ' + error.message)
    } finally {
      setPendingWorkbook(null)
    }
  }

  const handleDeleteEstimateItem = async (itemId) => {
    try {
      const { error } = await supabase.from('object_estimate_items').delete().eq('id', itemId)
      if (error) throw error
      setEstimateItems(prev => prev.filter(i => i.id !== itemId))
    } catch (error) {
      alert('Ошибка удаления: ' + error.message)
    }
  }

  const handleClearEstimate = async () => {
    if (!window.confirm('Удалить все позиции сметы?')) return
    try {
      const { error } = await supabase.from('object_estimate_items').delete().eq('object_id', objectId)
      if (error) throw error
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const handleApproveEstimate = async () => {
    try {
      const { error } = await supabase.from('object_estimate_items')
        .update({ is_approved: true }).eq('object_id', objectId)
      if (error) throw error
      setEstimateItems(prev => prev.map(i => ({ ...i, is_approved: true })))
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const handleRevokeApproval = async () => {
    if (!window.confirm('Снять утверждение сметы? Станет доступно редактирование.')) return
    try {
      const { error } = await supabase.from('object_estimate_items')
        .update({ is_approved: false }).eq('object_id', objectId)
      if (error) throw error
      setEstimateItems(prev => prev.map(i => ({ ...i, is_approved: false })))
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const calcMaterialsCost = (item) => (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price_materials) || 0)
  const calcWorksCost = (item) => (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price_works) || 0)
  const calcTotalCost = (item) => {
    const matWork = calcMaterialsCost(item) + calcWorksCost(item)
    return matWork || (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
  }

  const estimateTotalMaterials = estimateItems.filter(i => !i.is_section).reduce((sum, item) => sum + calcMaterialsCost(item), 0)
  const estimateTotalWorks = estimateItems.filter(i => !i.is_section).reduce((sum, item) => sum + calcWorksCost(item), 0)
  const estimateTotal = estimateItems.filter(i => !i.is_section).reduce((sum, item) => sum + calcTotalCost(item), 0)
  const estimateVat = estimateItems.length > 0 ? (parseFloat(estimateItems[0]?.vat_percent) || 0) : 0
  const isCombinedEstimate = estimateItems.length > 0 && estimateItems[0]?.import_mode === 'combined'
  const isEstimateApproved = estimateItems.length > 0 && estimateItems[0]?.is_approved

  // Build section groups: sectionId -> array of child items
  const sectionGroups = (() => {
    const groups = {}
    let currentSectionId = null
    for (const item of estimateItems) {
      if (item.is_section) {
        currentSectionId = item.id
        groups[currentSectionId] = []
      } else if (currentSectionId) {
        groups[currentSectionId].push(item)
      }
    }
    return groups
  })()

  const getSectionTotal = (sectionId) => {
    const items = sectionGroups[sectionId] || []
    return items.reduce((sum, item) => sum + calcTotalCost(item), 0)
  }

  const getSectionMaterialsTotal = (sectionId) => {
    const items = sectionGroups[sectionId] || []
    return items.reduce((sum, item) => sum + calcMaterialsCost(item), 0)
  }

  const getSectionWorksTotal = (sectionId) => {
    const items = sectionGroups[sectionId] || []
    return items.reduce((sum, item) => sum + calcWorksCost(item), 0)
  }

  const toggleSection = (sectionId) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      next.has(sectionId) ? next.delete(sectionId) : next.add(sectionId)
      return next
    })
  }

  const collapseAllSections = () => {
    const allSectionIds = estimateItems.filter(i => i.is_section).map(i => i.id)
    setCollapsedSections(new Set(allSectionIds))
  }

  const expandAllSections = () => {
    setCollapsedSections(new Set())
  }

  // Determine which items are hidden (belong to a collapsed section)
  const hiddenItemIds = (() => {
    const hidden = new Set()
    for (const sectionId of collapsedSections) {
      for (const item of (sectionGroups[sectionId] || [])) {
        hidden.add(item.id)
      }
    }
    return hidden
  })()

  const hasSections = estimateItems.some(i => i.is_section)

  const formatMoney = (amount) => {
    if (!amount) return ''
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
  }

  // Object info handlers
  const handleEditInfo = () => {
    setInfoFormData({
      planned_start_date: object.planned_start_date || '',
      planned_end_date: object.planned_end_date || '',
      total_area: object.total_area || '',
      budget: object.budget || ''
    })
    setShowInfoModal(true)
  }

  const handleSubmitInfo = async (e) => {
    e.preventDefault()
    try {
      const { error } = await supabase
        .from('objects')
        .update({
          planned_start_date: infoFormData.planned_start_date || null,
          planned_end_date: infoFormData.planned_end_date || null,
          total_area: parseFloat(infoFormData.total_area) || null,
          budget: parseFloat(infoFormData.budget) || null
        })
        .eq('id', objectId)
      if (error) throw error
      setShowInfoModal(false)
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  // Warranty handlers
  const handleAddWarranty = () => {
    setEditingWarranty(null)
    setWarrantyFormData({ work_name: '', start_date: '', warranty_months: '12' })
    setShowWarrantyModal(true)
  }

  const handleEditWarranty = (item) => {
    setEditingWarranty(item)
    setWarrantyFormData({
      work_name: item.work_name,
      start_date: item.start_date || '',
      warranty_months: String(item.warranty_months || 12)
    })
    setShowWarrantyModal(true)
  }

  const handleDeleteWarranty = async (id) => {
    if (!window.confirm('Удалить запись?')) return
    try {
      const { error } = await supabase.from('object_warranties').delete().eq('id', id)
      if (error) throw error
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const handleSubmitWarranty = async (e) => {
    e.preventDefault()
    if (!warrantyFormData.work_name.trim()) return alert('Введите наименование работ')
    try {
      const dataToSave = {
        object_id: objectId,
        work_name: warrantyFormData.work_name.trim(),
        start_date: warrantyFormData.start_date || null,
        warranty_months: parseInt(warrantyFormData.warranty_months) || 12,
        order_number: editingWarranty?.order_number || warranties.length + 1
      }
      if (editingWarranty) {
        const { error } = await supabase.from('object_warranties').update(dataToSave).eq('id', editingWarranty.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('object_warranties').insert([dataToSave])
        if (error) throw error
      }
      setShowWarrantyModal(false)
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  // Warranty retention handlers
  const handleAddRetention = () => {
    setEditingRetention(null)
    setRetentionFormData({ retention_percent: '', retention_period: '', notes: '' })
    setShowRetentionModal(true)
  }

  const handleEditRetention = (item) => {
    setEditingRetention(item)
    setRetentionFormData({
      retention_percent: String(item.retention_percent || ''),
      retention_period: item.retention_period || '',
      notes: item.notes || ''
    })
    setShowRetentionModal(true)
  }

  const handleDeleteRetention = async (id) => {
    if (!window.confirm('Удалить запись?')) return
    try {
      const { error } = await supabase.from('object_warranty_retentions').delete().eq('id', id)
      if (error) throw error
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const handleSubmitRetention = async (e) => {
    e.preventDefault()
    if (!retentionFormData.retention_percent) return alert('Введите процент удержания')
    try {
      const dataToSave = {
        object_id: objectId,
        retention_percent: parseFloat(retentionFormData.retention_percent) || 0,
        retention_period: retentionFormData.retention_period.trim() || null,
        notes: retentionFormData.notes.trim() || null,
        order_number: editingRetention?.order_number || retentions.length + 1
      }
      if (editingRetention) {
        const { error } = await supabase.from('object_warranty_retentions').update(dataToSave).eq('id', editingRetention.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('object_warranty_retentions').insert([dataToSave])
        if (error) throw error
      }
      setShowRetentionModal(false)
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const getWarrantyEndDate = (startDate, months) => {
    if (!startDate || !months) return '-'
    const date = new Date(startDate)
    date.setMonth(date.getMonth() + months)
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const formatDate = (date) => {
    if (!date) return '-'
    return new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const formatArea = (area) => {
    if (!area) return '-'
    return `${Number(area).toLocaleString('ru-RU')} м²`
  }

  const formatBudget = (budget) => {
    if (!budget) return '-'
    return `${Number(budget).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`
  }

  // Группируем документы
  const generalContract = documents.find(d => d.document_type === 'general_contract' && !d.parent_document_id)
  const contractAttachments = documents.filter(d => d.parent_document_id === generalContract?.id)
  // task 329 + 331: явная сортировка после optimistic update reorderAgreements —
  // порядок массива documents не меняется, переупорядочивание считаем по order_number.
  const additionalAgreements = documents
    .filter(d => d.document_type === 'additional_agreement' && !d.parent_document_id)
    .sort((a, b) => {
      const o = (a.order_number || 0) - (b.order_number || 0)
      if (o !== 0) return o
      return (a.created_at || '').localeCompare(b.created_at || '')
    })
  const getAttachments = (parentId) => documents.filter(d => d.parent_document_id === parentId)

  // Фильтрация по поисковому запросу (task 297). Родитель показывается, если совпал
  // сам или совпало хотя бы одно из его приложений. При совпадении только приложения
  // — показываем родителя + только совпавшие приложения (контекст).
  const docQuery = docSearchQuery.trim().toLowerCase()
  const matchesDocQuery = (doc) => {
    if (!docQuery) return true
    const hay = [doc.name, doc.document_number, doc.notes]
      .filter(Boolean).join(' ').toLowerCase()
    return hay.includes(docQuery)
  }
  const filterDocGroup = (parent, atts) => {
    if (!docQuery) return { parent, atts }
    if (matchesDocQuery(parent)) return { parent, atts }
    const matched = atts.filter(matchesDocQuery)
    return matched.length > 0 ? { parent, atts: matched } : null
  }
  const visibleContract = generalContract ? filterDocGroup(generalContract, contractAttachments) : null
  const visibleAgreements = additionalAgreements
    .map(ag => filterDocGroup(ag, getAttachments(ag.id)))
    .filter(Boolean)
  const docSearchEmpty = !!docQuery && !visibleContract && visibleAgreements.length === 0

  if (loading) return <div className="loading">Загрузка...</div>
  if (!object) return (
    <div className="object-detail-page">
      <div className="error-message">Объект не найден
        <button className="btn-secondary" onClick={() => navigate('/general/objects')}>Назад</button>
      </div>
    </div>
  )


  return (
    <div className="object-detail-page">
      {/* Шапка */}
      <div className="object-detail-header">
        <button className="btn-back" onClick={() => navigate('/general/objects')}>←</button>
        <div className="header-info">
          <h1>{object.name}</h1>
          <span className="header-address">{object.address}</span>
        </div>
        <span className={`status-badge ${object.status}`}>
          {object.status === 'warranty_service' ? 'ГО' : 'ОС'}
        </span>
      </div>

      {/* Вкладки */}
      <div className="tabs">
        <button className={`tab ${activeTab === 'info' ? 'active' : ''}`} onClick={() => setActiveTab('info')}>
          Информация
        </button>
        <button className={`tab ${activeTab === 'documents' ? 'active' : ''}`} onClick={() => setActiveTab('documents')}>
          Документы
        </button>
        <button className={`tab ${activeTab === 'warranty' ? 'active' : ''}`} onClick={() => setActiveTab('warranty')}>
          Гарантия
        </button>
        <button className={`tab ${activeTab === 'retentions' ? 'active' : ''}`} onClick={() => setActiveTab('retentions')}>
          Гарантийные удержания
        </button>
        <button className={`tab ${activeTab === 'estimate' ? 'active' : ''}`} onClick={() => setActiveTab('estimate')}>
          Смета
        </button>
      </div>

      {/* Информация об объекте */}
      {activeTab === 'info' && (
        <div className="tab-content info-content">
          <div className="info-header">
            <span>Информация об объекте</span>
            <button className="btn-add" onClick={handleEditInfo} title="Редактировать">✏️</button>
          </div>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">Планируемое начало работ</span>
              <span className="info-value">{formatDate(object.planned_start_date)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Планируемое окончание работ</span>
              <span className="info-value">{formatDate(object.planned_end_date)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Общая площадь</span>
              <span className="info-value">{formatArea(object.total_area)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Бюджет</span>
              <span className="info-value">{formatBudget(object.budget)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Документы */}
      {activeTab === 'documents' && (
        <div className="tab-content documents-content">
          {/* Поиск по документам (task 297) */}
          <div className="docs-search-toolbar">
            <span className="docs-search-icon" aria-hidden>🔍</span>
            <input
              type="search"
              className="docs-search-input"
              placeholder="Поиск по документам..."
              value={docSearchQuery}
              onChange={(e) => setDocSearchQuery(e.target.value)}
            />
            {docSearchQuery && (
              <button
                type="button"
                className="docs-search-clear"
                onClick={() => setDocSearchQuery('')}
                title="Очистить"
              >×</button>
            )}
          </div>

          {docSearchEmpty ? (
            <div className="docs-empty-state">
              По запросу «{docSearchQuery}» ничего не найдено
            </div>
          ) : (
            <>
              {/* Договор Генподряда */}
              {(!docQuery || visibleContract) && (
                <div className="doc-section">
                  <div className="doc-section-header">
                    <span>Договор Генподряда</span>
                    {!generalContract && <button className="btn-add" onClick={() => handleAddDocument('general_contract')}>+ Добавить</button>}
                  </div>
                  {visibleContract ? (
                    <div className="doc-table-wrap">
                      <table className="doc-table">
                        <thead>
                          <tr>
                            <th style={{ width: '28px' }}></th>
                            <th style={{ width: '200px' }}>Наименование</th>
                            <th>№ / дата</th>
                            <th style={{ width: '130px' }}>Подписанный</th>
                            <th style={{ width: '130px' }}>Редактируемый</th>
                            <th style={{ width: '80px' }}>Действия</th>
                          </tr>
                        </thead>
                        <tbody>
                          <DocRow
                            doc={visibleContract.parent}
                            attachments={visibleContract.atts}
                            expandedDocs={expandedDocs}
                            toggleExpand={toggleExpand}
                            formatDate={formatDate}
                            onAddAttachment={(parentId) => handleAddDocument('attachment', parentId)}
                            onEdit={handleEditDocument}
                            onDelete={handleDeleteDocument}
                            onPreviewFile={handlePreviewFile}
                            onDownloadFile={handleDownloadFile}
                          />
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="doc-empty">Не добавлен</div>
                  )}
                </div>
              )}

              {/* Дополнительные соглашения */}
              {(!docQuery || visibleAgreements.length > 0) && (
                <div className="doc-section">
                  <div className="doc-section-header">
                    <span>Дополнительные соглашения ({additionalAgreements.length})</span>
                    <button className="btn-add" onClick={() => handleAddDocument('additional_agreement')}>+ Добавить</button>
                  </div>
                  {visibleAgreements.length > 0 ? (
                    <div className="doc-table-wrap">
                      <table className="doc-table">
                        <thead>
                          <tr>
                            <th style={{ width: '28px' }}></th>
                            <th style={{ width: '130px' }}>Наименование</th>
                            <th style={{ width: '100px' }}>Дата</th>
                            <th>Описание ДС</th>
                            <th style={{ width: '130px' }}>Подписанный</th>
                            <th style={{ width: '130px' }}>Редактируемый</th>
                            <th style={{ width: '80px' }}>Действия</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleAgreements.map(g => (
                            <AgreementRow
                              key={g.parent.id}
                              doc={g.parent}
                              attachments={g.atts}
                              expandedDocs={expandedDocs}
                              toggleExpand={toggleExpand}
                              formatDate={formatDate}
                              onAddAttachment={(parentId) => handleAddDocument('attachment', parentId)}
                              onEdit={handleEditDocument}
                              onDelete={handleDeleteDocument}
                              onPreviewFile={handlePreviewFile}
                              onDownloadFile={handleDownloadFile}
                              isDragging={draggedAgreementId === g.parent.id}
                              dragOverPosition={agreementDragOver?.id === g.parent.id ? agreementDragOver.position : null}
                              onDragStart={handleAgreementDragStart}
                              onDragOver={handleAgreementDragOver}
                              onDragLeave={handleAgreementDragLeave}
                              onDragEnd={handleAgreementDragEnd}
                              onDrop={handleAgreementDrop}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="doc-empty">Нет</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Гарантия */}
      {activeTab === 'warranty' && (
        <div className="tab-content">
          <div className="cost-header">
            <span>Гарантийные сроки</span>
            <button className="btn-add" onClick={handleAddWarranty} title="Добавить">+</button>
          </div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Наименование работ</th>
                <th>Начало гарантийного срока</th>
                <th>Гарантийный срок</th>
                <th>Окончание гарантии</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {warranties.length > 0 ? warranties.map((item, i) => (
                <tr key={item.id}>
                  <td className="center">{i + 1}</td>
                  <td>{item.work_name}</td>
                  <td className="center">{formatDate(item.start_date)}</td>
                  <td className="center">{item.warranty_months} мес.</td>
                  <td className="center">{getWarrantyEndDate(item.start_date, item.warranty_months)}</td>
                  <td className="actions">
                    <button onClick={() => handleEditWarranty(item)}>✏️</button>
                    <button onClick={() => handleDeleteWarranty(item.id)}>🗑️</button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan="6" className="empty">Нет данных о гарантии</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Гарантийные удержания */}
      {activeTab === 'retentions' && (
        <div className="tab-content">
          <div className="cost-header">
            <span>Гарантийные удержания</span>
            <button className="btn-add" onClick={handleAddRetention} title="Добавить">+</button>
          </div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>#</th>
                <th>% удержания</th>
                <th>Срок удержания</th>
                <th>Примечание</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {retentions.length > 0 ? retentions.map((item, i) => (
                <tr key={item.id}>
                  <td className="center">{i + 1}</td>
                  <td className="center">{item.retention_percent}%</td>
                  <td>{item.retention_period || '-'}</td>
                  <td className="notes-cell">{item.notes || '-'}</td>
                  <td className="actions">
                    <button onClick={() => handleEditRetention(item)}>✏️</button>
                    <button onClick={() => handleDeleteRetention(item.id)}>🗑️</button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan="5" className="empty">Нет данных об удержаниях</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Смета */}
      {activeTab === 'estimate' && (
        <div className={`tab-content estimate-content${isEstimateFullscreen ? ' estimate-fullscreen' : ''}`}>
          <div className="cost-header">
            <span>Смета объекта {estimateItems.length > 0 && `(${estimateItems.filter(i => !i.is_section).length} позиций${estimateVat ? `, НДС ${estimateVat}%` : ''})`}</span>
            <div className="cost-header-actions">
              {estimateItems.length > 0 && (
                <>
                  {hasSections && (
                    <div className="section-group-controls">
                      <button
                        className={`btn-group-level${collapsedSections.size === 0 ? ' active' : ''}`}
                        onClick={expandAllSections}
                        title="Развернуть все разделы"
                      >1</button>
                      <button
                        className={`btn-group-level${collapsedSections.size > 0 && collapsedSections.size === estimateItems.filter(i => i.is_section).length ? ' active' : ''}`}
                        onClick={collapseAllSections}
                        title="Свернуть все разделы"
                      >2</button>
                    </div>
                  )}
                  <button className="btn-icon" onClick={() => setIsEstimateFullscreen(f => !f)} title={isEstimateFullscreen ? 'Свернуть (Esc)' : 'Развернуть'}>
                    {isEstimateFullscreen ? '✕' : '⛶'}
                  </button>
                  {isEstimateApproved ? (
                    <button className="btn-secondary-sm" onClick={handleRevokeApproval}>Снять утверждение</button>
                  ) : (
                    <>
                      <button className="btn-success-sm" onClick={handleApproveEstimate}>Утвердить</button>
                      <button className="btn-danger-sm" onClick={handleClearEstimate}>Очистить</button>
                    </>
                  )}
                </>
              )}
              {!isEstimateApproved && (
                <label className="btn-add-label">
                  Импорт из Excel
                  <input
                    ref={estimateFileRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                  />
                </label>
              )}
            </div>
          </div>

          {estimateItems.length > 0 ? (
            <div className="estimate-table-wrapper">
              <table className="estimate-table">
                <thead>
                  <tr>
                    {hasSections && <th className="col-group"></th>}
                    <th className="col-code">Код</th>
                    <th className="col-num">№</th>
                    <th className="col-name">Наименование работ</th>
                    <th className="col-unit">Ед. изм.</th>
                    <th className="col-qty">Кол-во</th>
                    {isCombinedEstimate ? (
                      <>
                        <th className="col-price">Цена за ед., с НДС</th>
                        <th className="col-total">Стоимость, с НДС</th>
                      </>
                    ) : (
                      <>
                        <th className="col-price">Цена мат. за ед., с НДС</th>
                        <th className="col-price">Цена работ за ед., с НДС</th>
                        <th className="col-total">Стоимость мат., с НДС</th>
                        <th className="col-total">Стоимость работ, с НДС</th>
                        <th className="col-total">Итого, с НДС</th>
                      </>
                    )}
                    <th className="col-notes">Примечание</th>
                    {!isEstimateApproved && <th className="col-actions"></th>}
                  </tr>
                </thead>
                <tbody>
                  {estimateItems.map(item => {
                    if (!item.is_section && hiddenItemIds.has(item.id)) return null
                    const isCollapsed = item.is_section && collapsedSections.has(item.id)
                    const sectionTotal = item.is_section ? getSectionTotal(item.id) : 0

                    return (
                      <tr key={item.id} className={item.is_section ? `section-row${isCollapsed ? ' collapsed' : ''}` : ''}>
                        {item.is_section ? (
                          <>
                            {hasSections && (
                              <td className="section-group-cell">
                                <button className={`btn-group-toggle${isCollapsed ? ' collapsed' : ''}`} onClick={() => toggleSection(item.id)}>
                                  {isCollapsed ? '+' : '−'}
                                </button>
                              </td>
                            )}
                            <td colSpan={5} className="section-cell" onClick={() => toggleSection(item.id)} style={{ cursor: 'pointer' }}>
                              {item.cost_name}
                            </td>
                            {isCombinedEstimate ? (
                              <>
                                <td className="money section-subtotal"></td>
                                <td className="money section-subtotal total-cell">{formatMoney(sectionTotal)}</td>
                              </>
                            ) : (
                              <>
                                <td className="money section-subtotal"></td>
                                <td className="money section-subtotal"></td>
                                <td className="money section-subtotal">{formatMoney(getSectionMaterialsTotal(item.id))}</td>
                                <td className="money section-subtotal">{formatMoney(getSectionWorksTotal(item.id))}</td>
                                <td className="money section-subtotal total-cell">{formatMoney(sectionTotal)}</td>
                              </>
                            )}
                            <td className="notes-cell"></td>
                            {!isEstimateApproved && <td className="center"><button className="btn-delete-row" onClick={() => handleDeleteEstimateItem(item.id)} title="Удалить">×</button></td>}
                          </>
                        ) : (
                          <>
                            {hasSections && <td className="group-line-cell"></td>}
                            <td className="center">{item.code || ''}</td>
                            <td className="center">{item.row_number}</td>
                            <td className="name-cell">{item.cost_name}</td>
                            <td className="center">{item.unit || ''}</td>
                            <td className="money">{item.quantity || ''}</td>
                            {isCombinedEstimate ? (
                              <>
                                <td className="money">{formatMoney(item.unit_price)}</td>
                                <td className="money total-cell">{formatMoney(item.total_price)}</td>
                              </>
                            ) : (
                              <>
                                <td className="money">{formatMoney(item.unit_price_materials)}</td>
                                <td className="money">{formatMoney(item.unit_price_works)}</td>
                                <td className="money">{formatMoney(calcMaterialsCost(item))}</td>
                                <td className="money">{formatMoney(calcWorksCost(item))}</td>
                                <td className="money total-cell">{formatMoney(calcTotalCost(item))}</td>
                              </>
                            )}
                            <td className="notes-cell">{item.notes || ''}</td>
                            {!isEstimateApproved && <td className="center"><button className="btn-delete-row" onClick={() => handleDeleteEstimateItem(item.id)} title="Удалить">×</button></td>}
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    {isCombinedEstimate ? (
                      <>
                        <td colSpan={hasSections ? 7 : 6}><strong>ИТОГО</strong></td>
                        <td className="money total-cell"><strong>{formatMoney(estimateTotal)}</strong></td>
                        <td>{/* примечание */}</td>
                        {!isEstimateApproved && <td></td>}
                      </>
                    ) : (
                      <>
                        <td colSpan={hasSections ? 8 : 7}><strong>ИТОГО</strong></td>
                        <td className="money"><strong>{formatMoney(estimateTotalMaterials)}</strong></td>
                        <td className="money"><strong>{formatMoney(estimateTotalWorks)}</strong></td>
                        <td className="money total-cell"><strong>{formatMoney(estimateTotal)}</strong></td>
                        <td>{/* примечание */}</td>
                        {!isEstimateApproved && <td></td>}
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="estimate-empty">
              <p>Смета не загружена</p>
              <p className="estimate-hint">Импортируйте Excel-файл с колонками:<br/>
                Раздельно: A — код, B — наименование, C — ед. изм., D — кол-во, E — мат., F — работы, G — примечание<br/>
                Совместно: A — код, B — наименование, C — ед. изм., D — кол-во, E — цена, F — примечание</p>
            </div>
          )}
        </div>
      )}

      {/* Модальное окно документа */}
      {showDocumentModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingDocument ? 'Редактировать' : 'Добавить'} {parentDocumentId ? 'приложение' : documentFormData.document_type === 'general_contract' ? 'договор' : 'ДС'}</h3>
              <button onClick={closeDocumentModalWithCleanup}>×</button>
            </div>
            <form onSubmit={handleSubmitDocument}>
              {parentDocumentId ? (
                // Для приложений: № приложения слева, Наименование справа. Дата не нужна.
                <div className="form-row-2">
                  <div>
                    <label>№ приложения *</label>
                    <input type="text" value={documentFormData.document_number} onChange={(e) => setDocumentFormData({ ...documentFormData, document_number: e.target.value })} required />
                  </div>
                  <div>
                    <label>Наименование приложения</label>
                    <input type="text" value={documentFormData.name} onChange={(e) => setDocumentFormData({ ...documentFormData, name: e.target.value })} />
                  </div>
                </div>
              ) : (
                <>
                  <div className="form-row">
                    <label>Наименование *</label>
                    <input type="text" value={documentFormData.name} onChange={(e) => setDocumentFormData({ ...documentFormData, name: e.target.value })} required />
                  </div>
                  {documentFormData.document_type === 'additional_agreement' ? (
                    // Для ДС «Номер» не нужен — он дублирует «Наименование» (ДС №00.0).
                    <div className="form-row">
                      <label>Дата</label>
                      <input type="date" min="1900-01-01" max="2100-12-31" value={documentFormData.document_date} onChange={(e) => setDocumentFormData({ ...documentFormData, document_date: e.target.value })} />
                    </div>
                  ) : (
                    <div className="form-row-2">
                      <div>
                        <label>Номер</label>
                        <input type="text" value={documentFormData.document_number} onChange={(e) => setDocumentFormData({ ...documentFormData, document_number: e.target.value })} />
                      </div>
                      <div>
                        <label>Дата</label>
                        <input type="date" min="1900-01-01" max="2100-12-31" value={documentFormData.document_date} onChange={(e) => setDocumentFormData({ ...documentFormData, document_date: e.target.value })} />
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="form-row-2">
                <ObjectDocumentFileSlot
                  slot="signed"
                  currentDoc={docFiles.signed}
                  ownerId={objectId}
                  onUploaded={(s3doc) => setDocFiles(prev => ({ ...prev, signed: s3doc }))}
                  onRemoved={() => setDocFiles(prev => ({ ...prev, signed: null }))}
                  onUploadingChange={(v) => setDocFilesUploading(prev => ({ ...prev, signed: v }))}
                />
                <ObjectDocumentFileSlot
                  slot="editable"
                  currentDoc={docFiles.editable}
                  ownerId={objectId}
                  onUploaded={(s3doc) => setDocFiles(prev => ({ ...prev, editable: s3doc }))}
                  onRemoved={() => setDocFiles(prev => ({ ...prev, editable: null }))}
                  onUploadingChange={(v) => setDocFilesUploading(prev => ({ ...prev, editable: v }))}
                />
              </div>
              <div className="form-row">
                <label>
                  {parentDocumentId
                    ? 'Описание'
                    : (documentFormData.document_type === 'additional_agreement' ? 'Описание ДС' : 'Примечание')}
                </label>
                <input
                  type="text"
                  value={documentFormData.notes}
                  onChange={(e) => setDocumentFormData({ ...documentFormData, notes: e.target.value })}
                  placeholder={parentDocumentId
                    ? 'Описание приложения'
                    : (documentFormData.document_type === 'additional_agreement'
                      ? 'Назначение ДС, краткое описание'
                      : 'Дополнительная информация')}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={closeDocumentModalWithCleanup}>Отмена</button>
                <button
                  type="submit"
                  className="btn-save"
                  disabled={docFilesUploading.signed || docFilesUploading.editable}
                  title={(docFilesUploading.signed || docFilesUploading.editable) ? 'Дождитесь окончания загрузки файла' : ''}
                >
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Превью S3-файла */}
      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}

      {/* Модальное окно НДС при импорте сметы */}
      {showVatModal && (
        <div className="modal-overlay">
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Импорт сметы</h3>
              <button onClick={() => { setShowVatModal(false); setPendingWorkbook(null) }}>×</button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleImportEstimate() }}>
              {sheetNames.length > 1 && (
                <div className="form-row">
                  <label>Лист Excel</label>
                  <select value={selectedSheet} onChange={(e) => setSelectedSheet(e.target.value)}>
                    {sheetNames.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-row">
                <label>Формат расценок</label>
                <div className="import-mode-cards">
                  <div className={`import-mode-card${importMode === 'separate' ? ' active' : ''}`} onClick={() => setImportMode('separate')}>
                    <div className="import-mode-card-radio">
                      <span className="radio-circle" />
                    </div>
                    <div className="import-mode-card-content">
                      <span className="import-mode-card-title">Материалы и работы</span>
                      <span className="import-mode-card-desc">A — код, B — наименование, C — ед. изм., D — кол-во, E — мат., F — работы, G — примечание</span>
                    </div>
                  </div>
                  <div className={`import-mode-card${importMode === 'combined' ? ' active' : ''}`} onClick={() => setImportMode('combined')}>
                    <div className="import-mode-card-radio">
                      <span className="radio-circle" />
                    </div>
                    <div className="import-mode-card-content">
                      <span className="import-mode-card-title">Комплекты</span>
                      <span className="import-mode-card-desc">A — код, B — наименование, C — ед. изм., D — кол-во, E — цена, F — примечание</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="form-row-3">
                <div>
                  <label>Со строки</label>
                  <input type="number" step="1" min="1" value={startRow} onChange={(e) => setStartRow(e.target.value)} placeholder="2" />
                </div>
                <div>
                  <label>По строку</label>
                  <input type="number" step="1" min="1" value={endRow} onChange={(e) => setEndRow(e.target.value)} placeholder="Все" />
                </div>
                <div>
                  <label>% НДС</label>
                  <input type="number" step="1" min="0" max="100" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} placeholder="22" />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => { setShowVatModal(false); setPendingWorkbook(null) }}>Отмена</button>
                <button type="submit" className="btn-save">Импортировать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно информации об объекте */}
      {showInfoModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Редактировать информацию</h3>
              <button onClick={() => setShowInfoModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmitInfo}>
              <div className="form-row-2">
                <div>
                  <label>Планируемое начало работ</label>
                  <input type="date" value={infoFormData.planned_start_date} onChange={(e) => setInfoFormData({ ...infoFormData, planned_start_date: e.target.value })} />
                </div>
                <div>
                  <label>Планируемое окончание работ</label>
                  <input type="date" value={infoFormData.planned_end_date} onChange={(e) => setInfoFormData({ ...infoFormData, planned_end_date: e.target.value })} />
                </div>
              </div>
              <div className="form-row-2">
                <div>
                  <label>Общая площадь (м²)</label>
                  <input type="number" step="0.01" value={infoFormData.total_area} onChange={(e) => setInfoFormData({ ...infoFormData, total_area: e.target.value })} placeholder="1500.00" />
                </div>
                <div>
                  <label>Бюджет (₽)</label>
                  <input type="number" step="0.01" value={infoFormData.budget} onChange={(e) => setInfoFormData({ ...infoFormData, budget: e.target.value })} placeholder="10000000" />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => setShowInfoModal(false)}>Отмена</button>
                <button type="submit" className="btn-save">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно гарантии */}
      {showWarrantyModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingWarranty ? 'Редактировать' : 'Добавить'} гарантийный срок</h3>
              <button onClick={() => setShowWarrantyModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmitWarranty}>
              <div className="form-row">
                <label>Наименование работ *</label>
                <input type="text" value={warrantyFormData.work_name} onChange={(e) => setWarrantyFormData({ ...warrantyFormData, work_name: e.target.value })} placeholder="Например: Общестроительные работы" required />
              </div>
              <div className="form-row-2">
                <div>
                  <label>Начало гарантийного срока</label>
                  <input type="date" value={warrantyFormData.start_date} onChange={(e) => setWarrantyFormData({ ...warrantyFormData, start_date: e.target.value })} />
                </div>
                <div>
                  <label>Гарантийный срок (мес.)</label>
                  <input type="number" min="1" value={warrantyFormData.warranty_months} onChange={(e) => setWarrantyFormData({ ...warrantyFormData, warranty_months: e.target.value })} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => setShowWarrantyModal(false)}>Отмена</button>
                <button type="submit" className="btn-save">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно гарантийных удержаний */}
      {showRetentionModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingRetention ? 'Редактировать' : 'Добавить'} удержание</h3>
              <button onClick={() => setShowRetentionModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmitRetention}>
              <div className="form-row-2">
                <div>
                  <label>% удержания *</label>
                  <input type="number" step="0.01" min="0" max="100" value={retentionFormData.retention_percent} onChange={(e) => setRetentionFormData({ ...retentionFormData, retention_percent: e.target.value })} placeholder="5.00" required />
                </div>
                <div>
                  <label>Срок удержания</label>
                  <input type="text" value={retentionFormData.retention_period} onChange={(e) => setRetentionFormData({ ...retentionFormData, retention_period: e.target.value })} placeholder="Например: 24 мес." />
                </div>
              </div>
              <div className="form-row">
                <label>Примечание</label>
                <input type="text" value={retentionFormData.notes} onChange={(e) => setRetentionFormData({ ...retentionFormData, notes: e.target.value })} placeholder="Дополнительная информация" />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => setShowRetentionModal(false)}>Отмена</button>
                <button type="submit" className="btn-save">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default ObjectDetailPage
