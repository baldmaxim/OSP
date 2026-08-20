import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import { useRole } from '../contexts/RoleContext'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import ObjectDocumentFileSlot from '../components/ObjectDocumentFileSlot'
import S3DocumentPreview from '../components/S3DocumentPreview'
import WarrantyActSignModal from '../components/WarrantyActSignModal'
import WarrantyDocSelect from '../components/WarrantyDocSelect'
import AccessDenied from '../components/AccessDenied'
import FilterDropdown from '../components/FilterDropdown'
import { fetchAllRows } from '../utils/fetchAllRows'
import './ObjectDetailPage.css'

// task 372: подсказки для полей площадей (datalist — список + своё значение).
const AREA_TYPE_SUGGESTIONS = [
  'Общая площадь здания', 'Надземная площадь', 'Подземная площадь',
  'Площадь жилых этажей', 'Площадь 1-го этажа', 'Площадь паркинга',
  'Площадь благоустройства',
]
const AREA_UNIT_SUGGESTIONS = ['м²', 'м.п.', 'шт.', 'компл.']
const AREA_SOURCE_SUGGESTIONS = [
  'Проект', 'БТИ', 'Заказчик', 'МГЭ', 'ПТО', 'Тендерная таблица', 'Внутренний расчет',
]
const AREA_METHOD_SUGGESTIONS = [
  'По внутреннему контуру', 'По БТИ', 'По проектной документации',
  'По тендерной таблице', 'По расчету ПТО',
]
const EMPTY_AREA_FORM = {
  area_type: '', value: '', unit: 'м²', data_source: '', calc_method: '',
  parent_area_id: '', notes: '',
}

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
  // attachments задаётся только для верхней строки (там список уже отфильтрован
  // поиском); вложенные уровни берут своих детей сами через getAttachments —
  // именно это и делает приложения к приложениям возможными.
  attachments,
  getAttachments,
  expandedDocs,
  toggleExpand,
  formatDate,
  onAddAttachment,
  onEdit,
  onDelete,
  onPreviewFile,
  onDownloadFile,
  drag, // общий набор обработчиков перетаскивания (см. docDragProps)
  canEdit = true, // task 333: гейт edit/delete/add-attachment действий
}) {
  const isAttachment = level > 0
  const kids = attachments || getAttachments?.(doc.id) || []
  const hasAttachments = kids.length > 0
  const isExpanded = expandedDocs.has(doc.id)
  // Перетаскиваются только приложения: договор генподряда в своей таблице один,
  // двигать его не с чем.
  const draggableRow = isAttachment && canEdit && !!drag
  const dragOverPosition = drag?.dragOver?.id === doc.id ? drag.dragOver.position : null

  return (
    <>
      <tr
        className={[
          'doc-row-tr',
          isAttachment ? 'doc-row-tr-attachment' : '',
          draggableRow && drag.draggedId === doc.id ? 'doc-row-dragging' : '',
          dragOverPosition === 'before' ? 'doc-row-drop-before' : '',
          dragOverPosition === 'after' ? 'doc-row-drop-after' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={draggableRow ? (e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const isAbove = (e.clientY - rect.top) < rect.height / 2
          drag.onDragOver?.(doc.id, isAbove ? 'before' : 'after')
        } : undefined}
        onDragLeave={draggableRow ? () => drag.onDragLeave?.(doc.id) : undefined}
        onDrop={draggableRow ? (e) => {
          e.preventDefault()
          drag.onDrop?.(e.dataTransfer.getData('text/plain'), doc.id)
        } : undefined}
      >
        <td className="doc-cell-marker">
          {isAttachment ? (
            /* task 332: индент глубоко-вложенных приложений на span (margin-left),
               а сама ↳-стрелка центрируется в ячейке через CSS — без inline-padding,
               иначе при узкой ячейке стрелка выходит за правый край колонки. */
            <span
              className="doc-attachment-marker"
              style={level > 1 ? { marginLeft: `${(level - 1) * 14}px` } : undefined}
              aria-hidden
            >↳</span>
          ) : null}
          {draggableRow && (
            <span
              className="doc-drag-handle"
              role="button"
              tabIndex={-1}
              draggable
              title="Перетащите для изменения порядка"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', doc.id)
                drag.onDragStart?.(doc.id)
              }}
              onDragEnd={() => drag.onDragEnd?.()}
            >⋮⋮</span>
          )}
          {hasAttachments ? (
            <button
              type="button"
              className="doc-expand-btn"
              onClick={() => toggleExpand(doc.id)}
              title={isExpanded ? 'Свернуть приложения' : `Развернуть приложения (${kids.length})`}
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
          {canEdit && (
            <>
              {/* Приложение к приложению: у вложенных строк своя компактная «+».
                  Сразу разворачиваем родителя, иначе новая строка появится
                  «в никуда» — под свёрнутым узлом. */}
              {isAttachment && (
                <button
                  type="button"
                  className="doc-action-btn"
                  onClick={() => { if (!isExpanded) toggleExpand(doc.id); onAddAttachment(doc.id) }}
                  title="Добавить приложение к этому приложению"
                >＋</button>
              )}
              <button type="button" className="doc-action-btn" onClick={() => onEdit(doc)} title="Редактировать">
                ✏️
              </button>
              <button type="button" className="doc-action-btn doc-action-delete" onClick={() => onDelete(doc.id)} title="Удалить">
                🗑️
              </button>
            </>
          )}
        </td>
      </tr>
      {/* Вложенные приложения — показываются только если родитель развёрнут.
          Уровень не ограничен: у приложения могут быть свои приложения. */}
      {isExpanded && kids.map(att => (
        <DocRow
          key={att.id}
          doc={att}
          level={level + 1}
          getAttachments={getAttachments}
          expandedDocs={expandedDocs}
          toggleExpand={toggleExpand}
          formatDate={formatDate}
          onAddAttachment={onAddAttachment}
          onEdit={onEdit}
          onDelete={onDelete}
          onPreviewFile={onPreviewFile}
          onDownloadFile={onDownloadFile}
          drag={drag}
          canEdit={canEdit}
        />
      ))}
      {/* Отдельной строкой кнопка остаётся только у документа верхнего уровня.
          У приложений она живёт в колонке действий: иначе строки-кнопки от
          каждого уровня выстроились бы подряд и таблицу было бы не прочитать. */}
      {!isAttachment && canEdit && (
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

// Приложение в таблице ДС — рекурсивная строка: у приложения могут быть свои
// приложения, а соседей можно переставлять перетаскиванием.
function AgreementAttachmentRow({
  doc,
  level,
  getAttachments,
  expandedDocs,
  toggleExpand,
  onAddAttachment,
  onEdit,
  onDelete,
  onPreviewFile,
  onDownloadFile,
  drag,
  canEdit,
}) {
  const kids = getAttachments?.(doc.id) || []
  const isExpanded = expandedDocs.has(doc.id)
  const draggable = canEdit && !!drag
  const dragOverPosition = drag?.dragOver?.id === doc.id ? drag.dragOver.position : null

  return (
    <>
      <tr
        className={[
          'doc-row-tr', 'doc-row-tr-attachment',
          draggable && drag.draggedId === doc.id ? 'doc-row-dragging' : '',
          dragOverPosition === 'before' ? 'doc-row-drop-before' : '',
          dragOverPosition === 'after' ? 'doc-row-drop-after' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const isAbove = (e.clientY - rect.top) < rect.height / 2
          drag?.onDragOver?.(doc.id, isAbove ? 'before' : 'after')
        }}
        onDragLeave={() => drag?.onDragLeave?.(doc.id)}
        onDrop={(e) => {
          e.preventDefault()
          drag?.onDrop?.(e.dataTransfer.getData('text/plain'), doc.id)
        }}
      >
        <td className="doc-cell-marker">
          <span
            className="doc-attachment-marker"
            style={level > 1 ? { marginLeft: `${(level - 1) * 14}px` } : undefined}
            aria-hidden
          >↳</span>
          {draggable && (
            <span
              className="doc-drag-handle"
              role="button"
              tabIndex={-1}
              draggable
              title="Перетащите для изменения порядка"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', doc.id)
                drag.onDragStart?.(doc.id)
              }}
              onDragEnd={() => drag.onDragEnd?.()}
            >⋮⋮</span>
          )}
          {kids.length > 0 && (
            <button
              type="button"
              className="doc-expand-btn"
              onClick={() => toggleExpand(doc.id)}
              title={isExpanded ? 'Свернуть приложения' : `Развернуть приложения (${kids.length})`}
              aria-label={isExpanded ? 'Свернуть' : 'Развернуть'}
            >{isExpanded ? '▼' : '▶'}</button>
          )}
        </td>
        <td className="doc-cell-name">
          <div className="doc-name-line">
            <span className="doc-name-text" title={doc.document_number || ''}>
              {doc.document_number || <span className="muted">—</span>}
            </span>
          </div>
        </td>
        <td className="doc-cell-date"></td>
        <td className="doc-cell-desc">
          <div title={doc.name || ''}>{doc.name || <span className="muted">—</span>}</div>
          {doc.notes && <div className="doc-notes-line" title={doc.notes}>{doc.notes}</div>}
        </td>
        <td className="doc-cell-link-compact">
          <DocFileCell compact s3doc={doc.signed} accent="signed" onPreview={onPreviewFile} onDownload={onDownloadFile} />
        </td>
        <td className="doc-cell-link-compact">
          <DocFileCell compact s3doc={doc.editable} accent="editable" onPreview={onPreviewFile} onDownload={onDownloadFile} />
        </td>
        <td className="doc-cell-actions">
          {canEdit && (
            <>
              <button
                type="button"
                className="doc-action-btn"
                onClick={() => { if (!isExpanded) toggleExpand(doc.id); onAddAttachment(doc.id) }}
                title="Добавить приложение к этому приложению"
              >＋</button>
              <button type="button" className="doc-action-btn" onClick={() => onEdit(doc)} title="Редактировать">✏️</button>
              <button type="button" className="doc-action-btn doc-action-delete" onClick={() => onDelete(doc.id)} title="Удалить">🗑️</button>
            </>
          )}
        </td>
      </tr>
      {isExpanded && kids.map(k => (
        <AgreementAttachmentRow
          key={k.id}
          doc={k}
          level={level + 1}
          getAttachments={getAttachments}
          expandedDocs={expandedDocs}
          toggleExpand={toggleExpand}
          onAddAttachment={onAddAttachment}
          onEdit={onEdit}
          onDelete={onDelete}
          onPreviewFile={onPreviewFile}
          onDownloadFile={onDownloadFile}
          drag={drag}
          canEdit={canEdit}
        />
      ))}
    </>
  )
}

// AgreementRow — компактный 7-колоночный ряд для таблицы «Дополнительные соглашения».
// Отдельно от DocRow, потому что у ДС-таблицы свой layout: убран «Номер», добавлен
// «Описание ДС», компактные файловые ячейки (только иконки).
function AgreementRow({
  doc,
  attachments = [],
  getAttachments,
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
  drag, // общий набор обработчиков для вложенных приложений
  // task 333: гейт edit/delete/add-attachment/drag-handle
  canEdit = true,
}) {
  const hasAttachments = attachments.length > 0
  const isExpanded = expandedDocs.has(doc.id)
  return (
    <>
      <tr
        className={[
          'doc-row-tr',
          isDragging ? 'doc-row-dragging' : '',
          /* task 331: индикатор «before» рисуется на главной строке ДС.
             «after» рисуется ниже — на строке «+ Приложение», чтобы линия
             всегда стояла между блоками ДС, а не между ДС и его приложением. */
          dragOverPosition === 'before' ? 'doc-row-drop-before' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const isAbove = (e.clientY - rect.top) < rect.height / 2
          onDragOver?.(doc.id, isAbove ? 'before' : 'after')
        }}
        onDragLeave={() => onDragLeave?.(doc.id)}
        onDrop={(e) => {
          e.preventDefault()
          const draggedId = e.dataTransfer.getData('text/plain')
          onDrop?.(draggedId, doc.id)
        }}
      >
        <td className="doc-cell-marker">
          {/* task 332: только handle тащит строку, не вся строка.
              task 333: при read-only handle скрыт — перетаскивание не доступно. */}
          {canEdit && (
            <span
              className="doc-drag-handle"
              role="button"
              tabIndex={-1}
              draggable={true}
              title="Перетащите для изменения порядка"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', doc.id)
                onDragStart?.(doc.id)
              }}
              onDragEnd={() => onDragEnd?.()}
            >⋮⋮</span>
          )}
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
          {canEdit && (
            <>
              <button type="button" className="doc-action-btn" onClick={() => onEdit(doc)} title="Редактировать">✏️</button>
              <button type="button" className="doc-action-btn doc-action-delete" onClick={() => onDelete(doc.id)} title="Удалить">🗑️</button>
            </>
          )}
        </td>
      </tr>
      {isExpanded && attachments.map(att => (
        <AgreementAttachmentRow
          key={att.id}
          doc={att}
          level={1}
          getAttachments={getAttachments}
          expandedDocs={expandedDocs}
          toggleExpand={toggleExpand}
          onAddAttachment={onAddAttachment}
          onEdit={onEdit}
          onDelete={onDelete}
          onPreviewFile={onPreviewFile}
          onDownloadFile={onDownloadFile}
          drag={drag}
          canEdit={canEdit}
        />
      ))}
      {/* Кнопка «+ Приложение» отдельной строкой под ДС — как у Договора Генподряда.
          task 331: это последняя строка блока ДС, поэтому индикатор «after» рисуется
          именно здесь — линия оказывается между блоками двух соседних ДС.
          task 333: скрываем при read-only. */}
      {canEdit && (
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
      )}
    </>
  )
}

function ObjectDetailPage() {
  const { objectId } = useParams()
  const navigate = useNavigate()
  // task 333: гейт add/edit/delete документов, гарантий, удержаний, сметы.
  const { canEdit, scopedObjectIds } = useRole()
  const canEditObj = canEdit('objects')
  // Скоуп по объекту: руководитель, привязанный к объекту, не может открыть чужой
  // объект даже по прямой ссылке.
  const objectDenied = scopedObjectIds.length > 0 && !scopedObjectIds.includes(objectId)

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
    budget: '',
    email: '', // task 335
    construction_manager_contact_id: '',
    economist_contact_id: '',
  })
  // Реестр сотрудников для выбора ответственных по объекту.
  const [staffContacts, setStaffContacts] = useState([])

  // task 372: площади объекта (с вложенными подпунктами).
  const [areas, setAreas] = useState([])
  const [showAreaModal, setShowAreaModal] = useState(false)
  const [editingArea, setEditingArea] = useState(null)
  const [areaFormData, setAreaFormData] = useState(EMPTY_AREA_FORM)
  const [expandedAreas, setExpandedAreas] = useState(() => new Set())

  // Warranty state
  const [warranties, setWarranties] = useState([])
  const [showWarrantyModal, setShowWarrantyModal] = useState(false)
  const [editingWarranty, setEditingWarranty] = useState(null)
  // task 353 + 362: модель формы. По задаче 362 пользователь не выбирает тип
  //   старта — всегда «по событию» (start_type='event'). Радио-переключатель
  //   из UI убран; в БД поле сохраняется как 'event'.
  //   Поля actual_start_* — task 362: загрузка/открепление акта прямо в этой
  //   модалке, без отдельной WarrantyActSignModal.
  const [warrantyFormData, setWarrantyFormData] = useState({
    work_name: '',
    start_date: '',             // фактическая дата начала (опц.)
    start_event_text: '',       // описание события — теперь обязательное
    start_document_id: '',      // форма документа о начале гарантии (опц.)
    warranty_months: '12',
    end_date_override: '',      // фиксированная дата окончания (приоритет)
    notes: '',
    actual_start_file: null,    // новый файл к загрузке
    actual_start_existing: null, // s3_documents текущего акта (при редактировании)
    actual_start_unlinked: false // флаг — открепить существующий акт
  })

  // task 355 + 359: ref'ы для авто-расширения textarea внутри модалки гарантии.
  //   Высота подстраивается под содержимое — без полосы прокрутки внутри.
  const warrantyNotesRef = useRef(null)
  const warrantyEventTextRef = useRef(null)
  const warrantyWorkNameRef = useRef(null)

  // task 357: модалка подписания акта для конкретной строки гарантии.
  //   Если null — модалка закрыта. Иначе содержит саму строку гарантии.
  const [signActWarranty, setSignActWarranty] = useState(null)

  // task 359: модалка просмотра связанного документа (для скрепки в строке гарантии).
  //   Если не null — содержит запись object_documents с подгруженными signed/editable.
  const [linkedDocPreview, setLinkedDocPreview] = useState(null)

  // Warranty retentions state
  // task 364: retentionFormData.payments — массив { portion_text, condition_text }.
  //   Каждая часть выплаты хранится в отдельной строке object_warranty_retention_payments.
  const [retentions, setRetentions] = useState([])
  const [showRetentionModal, setShowRetentionModal] = useState(false)
  const [editingRetention, setEditingRetention] = useState(null)
  const [retentionFormData, setRetentionFormData] = useState({
    retention_percent: '',
    retention_period: '',
    notes: '',
    payments: []
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
      // Ответственных подтягиваем именованными связями: у objects две ссылки на
      // contacts, и без явных имён Supabase не разберёт, какая из них какая.
      // Если миграция 20260822 ещё не применена, связей нет и запрос падает —
      // тогда грузим объект как раньше, просто без ответственных. Иначе вся
      // карточка объекта была бы недоступна до накатывания миграции.
      const STAFF_EMBED = '*, construction_manager:contacts!construction_manager_contact_id(id, full_name, position, phone, email), economist:contacts!economist_contact_id(id, full_name, position, phone, email)'
      let objectRes = await supabase.from('objects').select(STAFF_EMBED).eq('id', objectId).single()
      if (objectRes.error) {
        console.warn('Ответственные по объекту недоступны, грузим без них:', objectRes.error.message)
        objectRes = await supabase.from('objects').select('*').eq('id', objectId).single()
      }
      if (objectRes.error) throw objectRes.error
      setObject(objectRes.data)

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

      // Постранично — смета объекта может превышать потолок PostgREST в 1000 строк.
      try {
        const estimateData = await fetchAllRows((from, to) => supabase
          .from('object_estimate_items').select('*').eq('object_id', objectId)
          .order('row_number').order('id').range(from, to))
        setEstimateItems(estimateData)
      } catch (estimateError) {
        console.error('Ошибка загрузки сметы объекта:', estimateError.message)
      }

      // task 357: подтягиваем s3-документ подписанного акта (если есть)
      //   как нэстед-поле actual_start_doc — отдельный SELECT не нужен.
      const { data: warrantyData, error: warrantyError } = await supabase
        .from('object_warranties')
        .select('*, actual_start_doc:s3_documents!actual_start_document_id(*)')
        .eq('object_id', objectId)
        .order('order_number')
      if (!warrantyError) setWarranties(warrantyData || [])

      // task 372: площади объекта (плоский список, дерево строим в рендере).
      const { data: areaData, error: areaError } = await supabase
        .from('object_areas')
        .select('*')
        .eq('object_id', objectId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
      if (!areaError) setAreas(areaData || [])

      // task 364: подгружаем части выплат вместе с удержанием. payments отдельно
      //   сортируем по order_number — порядок дочерней relation Supabase
      //   гарантирует не всегда, надёжнее досортировать в JS.
      const { data: retentionData, error: retentionError } = await supabase
        .from('object_warranty_retentions')
        .select('*, payments:object_warranty_retention_payments(*)')
        .eq('object_id', objectId)
        .order('order_number')
      if (!retentionError) {
        const normalized = (retentionData || []).map(r => ({
          ...r,
          payments: (r.payments || []).slice().sort(
            (a, b) => (a.order_number ?? 0) - (b.order_number ?? 0)
          )
        }))
        setRetentions(normalized)
      }
    } catch (error) {
      console.error('Ошибка загрузки данных:', error.message)
    } finally {
      setLoading(false)
    }
  }, [objectId])

  useEffect(() => {
    // Чужой объект не грузим — данные не должны попадать даже в память.
    if (objectId && !objectDenied) fetchObjectData()
  }, [objectId, objectDenied, fetchObjectData])

  // task 355: autosize для textarea «Примечание» и «Описание события» в модалке гарантии.
  //   Срабатывает при изменении значения и при открытии модалки (тогда editingWarranty
  //   подставляет уже непустой текст — высоту надо подстроить сразу).
  useEffect(() => {
    const el = warrantyNotesRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [warrantyFormData.notes, showWarrantyModal])

  useEffect(() => {
    const el = warrantyEventTextRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [warrantyFormData.start_event_text, showWarrantyModal])

  useEffect(() => {
    const el = warrantyWorkNameRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [warrantyFormData.work_name, showWarrantyModal])

  // Реестр сотрудников для выбора ответственных. Грузим один раз при монтировании:
  // список нужен только в модалке редактирования, но он небольшой и статичный.
  useEffect(() => {
    let alive = true
    supabase.from('contacts')
      .select('id, full_name, position')
      .order('full_name', { ascending: true })
      .then(({ data, error }) => {
        if (error) { console.error('Ошибка загрузки сотрудников:', error.message); return }
        if (alive) setStaffContacts(data || [])
      })
    return () => { alive = false }
  }, [])

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

  // task 329: переупорядочивание документов drag-and-drop — и дополнительных
  // соглашений, и приложений внутри своего документа (на любом уровне вложенности).
  // Порядок меняется ТОЛЬКО среди соседей: перетащить приложение к другому
  // документу нельзя, для смены родителя есть форма редактирования.
  // Сохраняем order_number кратным 10 — есть запас для будущих ручных вставок
  // без необходимости перенумеровывать соседей.
  const reorderDocuments = async (draggedId, targetId, position) => {
    if (!draggedId || draggedId === targetId) return
    const dragged = documents.find(d => d.id === draggedId)
    const target = documents.find(d => d.id === targetId)
    if (!dragged || !target) return
    const parentId = dragged.parent_document_id || null
    if ((target.parent_document_id || null) !== parentId) return

    // Группа соседей: приложения одного родителя либо верхний уровень ДС
    // (договор генподряда в перетаскивании не участвует — он один).
    const ordered = documents
      .filter(d => (parentId
        ? d.parent_document_id === parentId
        : d.document_type === 'additional_agreement' && !d.parent_document_id))
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
    // task 332: на исходной строке индикатор не рисуем (на самого себя дроп не делаем).
    if (id === draggedAgreementId) {
      setAgreementDragOver(prev => prev ? null : prev)
      return
    }
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
    await reorderDocuments(draggedId, targetId, position)
  }

  // Один набор обработчиков на все перетаскиваемые строки документов: и ДС, и
  // приложения любого уровня. Куда именно упадёт строка, решает reorderDocuments
  // по её родителю.
  const docDragProps = {
    draggedId: draggedAgreementId,
    dragOver: agreementDragOver,
    onDragStart: handleAgreementDragStart,
    onDragOver: handleAgreementDragOver,
    onDragLeave: handleAgreementDragLeave,
    onDragEnd: handleAgreementDragEnd,
    onDrop: handleAgreementDrop,
  }

  // Открытие/скачивание/превью S3-файла из ячейки таблицы.
  const handlePreviewFile = (s3doc) => setPreviewDoc(s3doc)
  const handleDownloadFile = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key, { fileName: s3doc.file_name, download: true })
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
        order_number: editingDocument?.order_number ?? (documents.length + 1),
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

  // Ответственный по объекту: ФИО плюс должность и контакты второй строкой —
  // чтобы не бегать за телефоном в реестр сотрудников.
  const renderStaff = (person) => {
    if (!person) return <span className="muted">—</span>
    return (
      <span className="obj-staff">
        <span className="obj-staff-name">{person.full_name}</span>
        <span className="obj-staff-meta">
          {[
            person.position,
            person.phone,
            person.email,
          ].filter(Boolean).join(' · ') || null}
        </span>
      </span>
    )
  }

  // Опции выбора сотрудника: должность в подписи помогает не перепутать однофамильцев.
  const staffOptions = staffContacts.map(c => ({
    value: c.id,
    label: c.position ? `${c.full_name} — ${c.position}` : c.full_name,
  }))

  // Object info handlers
  const handleEditInfo = () => {
    setInfoFormData({
      developer: object.developer || '',
      design: object.design || '',
      planned_start_date: object.planned_start_date || '',
      planned_end_date: object.planned_end_date || '',
      total_area: object.total_area || '',
      budget: object.budget || '',
      email: object.email || '', // task 335
      construction_manager_contact_id: object.construction_manager_contact_id || '',
      economist_contact_id: object.economist_contact_id || '',
    })
    setShowInfoModal(true)
  }

  const handleSubmitInfo = async (e) => {
    e.preventDefault()
    try {
      const { error } = await supabase
        .from('objects')
        .update({
          developer: infoFormData.developer.trim() || null,
          design: infoFormData.design.trim() || null,
          planned_start_date: infoFormData.planned_start_date || null,
          planned_end_date: infoFormData.planned_end_date || null,
          total_area: parseFloat(infoFormData.total_area) || null,
          budget: parseFloat(infoFormData.budget) || null,
          email: infoFormData.email.trim() || null, // task 335
          // Пустая строка — не валидный UUID, Postgres на ней падает.
          construction_manager_contact_id: infoFormData.construction_manager_contact_id || null,
          economist_contact_id: infoFormData.economist_contact_id || null,
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
    setWarrantyFormData({
      work_name: '',
      start_date: '',
      start_event_text: '',
      start_document_id: '',
      warranty_months: '12',
      end_date_override: '',
      notes: '',
      actual_start_file: null,
      actual_start_existing: null,
      actual_start_unlinked: false
    })
    setShowWarrantyModal(true)
  }

  const handleEditWarranty = (item) => {
    setEditingWarranty(item)
    setWarrantyFormData({
      work_name: item.work_name,
      start_date: item.start_date || '',
      start_event_text: item.start_event_text || '',
      start_document_id: item.start_document_id || '',
      warranty_months: String(item.warranty_months || 12),
      end_date_override: item.end_date_override || '',
      notes: item.notes || '',
      actual_start_file: null,
      actual_start_existing: item.actual_start_doc || null,
      actual_start_unlinked: false
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
    const fd = warrantyFormData
    if (!fd.work_name.trim()) return alert('Введите наименование работ')
    // task 362: тип старта всегда 'event' — текст «с какого момента» обязателен.
    if (!fd.start_event_text.trim()) {
      return alert('Опишите, с какого момента начинается гарантийный срок (например, «с даты подписания Акта № 3»)')
    }
    try {
      // task 362: загрузка/открепление акта (actual_start_document_id) прямо
      //   из этой модалки — без отдельной WarrantyActSignModal.
      let actualStartDocId = editingWarranty?.actual_start_document_id || null

      // 1) Открепление существующего акта (если пользователь нажал «Открепить»
      //    и не выбрал новый файл).
      if (fd.actual_start_unlinked && !fd.actual_start_file && fd.actual_start_existing) {
        try { await deleteDocument(fd.actual_start_existing) } catch { /* лучшее усилие */ }
        actualStartDocId = null
      }

      // 2) Загрузка нового файла. Если он есть — старый удаляем после успешного
      //    PUT'а (race-safe порядок: сначала uploadFile создаёт новый, затем
      //    deleteDocument сносит старый).
      if (fd.actual_start_file) {
        const uploaded = await uploadFile({
          file: fd.actual_start_file,
          ownerType: 'object',
          ownerId: objectId,
          notes: 'Акт начала гарантии'
        })
        actualStartDocId = uploaded.id
        if (fd.actual_start_existing) {
          try { await deleteDocument(fd.actual_start_existing) } catch { /* лучшее усилие */ }
        }
      }

      const dataToSave = {
        object_id: objectId,
        work_name: fd.work_name.trim(),
        start_type: 'event',
        start_date: fd.start_date || null,
        start_event_text: fd.start_event_text.trim() || null,
        start_document_id: fd.start_document_id || null,
        warranty_months: parseInt(fd.warranty_months) || 12,
        end_date_override: fd.end_date_override || null,
        notes: fd.notes.trim() || null,
        actual_start_document_id: actualStartDocId,
        order_number: editingWarranty?.order_number ?? (warranties.length + 1)
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

  // ===== task 372: площади объекта =====
  const toggleAreaExpand = (id) => {
    setExpandedAreas(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const handleAddArea = (parentId = '') => {
    setEditingArea(null)
    setAreaFormData({ ...EMPTY_AREA_FORM, parent_area_id: parentId || '' })
    if (parentId) setExpandedAreas(prev => new Set(prev).add(parentId))
    setShowAreaModal(true)
  }

  const handleEditArea = (item) => {
    setEditingArea(item)
    setAreaFormData({
      area_type: item.area_type || '',
      value: item.value != null ? String(item.value) : '',
      unit: item.unit || 'м²',
      data_source: item.data_source || '',
      calc_method: item.calc_method || '',
      parent_area_id: item.parent_area_id || '',
      notes: item.notes || '',
    })
    setShowAreaModal(true)
  }

  const handleDeleteArea = async (id) => {
    const hasChildren = areas.some(a => a.parent_area_id === id)
    const msg = hasChildren
      ? 'Удалить площадь вместе со всеми вложенными подпунктами?'
      : 'Удалить площадь?'
    if (!window.confirm(msg)) return
    try {
      const { error } = await supabase.from('object_areas').delete().eq('id', id)
      if (error) throw error
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  const handleSubmitArea = async (e) => {
    e.preventDefault()
    const fd = areaFormData
    if (!fd.area_type.trim()) return alert('Укажите тип / название площади')
    try {
      // sort_order — следующий среди соседей того же уровня.
      const siblings = areas.filter(a => (a.parent_area_id || null) === (fd.parent_area_id || null))
      const maxSort = siblings.reduce((m, a) => Math.max(m, a.sort_order || 0), 0)
      const dataToSave = {
        object_id: objectId,
        parent_area_id: fd.parent_area_id || null,
        area_type: fd.area_type.trim(),
        value: cleanNumericValue(fd.value) || null,
        unit: fd.unit.trim() || null,
        data_source: fd.data_source.trim() || null,
        calc_method: fd.calc_method.trim() || null,
        notes: fd.notes.trim() || null,
        sort_order: editingArea?.sort_order ?? (maxSort + 1),
        updated_at: new Date().toISOString(),
      }
      if (editingArea) {
        const { error } = await supabase.from('object_areas').update(dataToSave).eq('id', editingArea.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('object_areas').insert([dataToSave])
        if (error) throw error
      }
      setShowAreaModal(false)
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  // Warranty retention handlers
  const handleAddRetention = () => {
    setEditingRetention(null)
    setRetentionFormData({
      retention_percent: '',
      retention_period: '',
      notes: '',
      payments: []
    })
    setShowRetentionModal(true)
  }

  const handleEditRetention = (item) => {
    setEditingRetention(item)
    setRetentionFormData({
      retention_percent: String(item.retention_percent || ''),
      retention_period: item.retention_period || '',
      notes: item.notes || '',
      payments: (item.payments || []).map(p => ({
        id: p.id, // помечаем id чтобы сохранить order при пересохранении (для UX)
        portion_text: p.portion_text || '',
        condition_text: p.condition_text || ''
      }))
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

  // task 364: хелперы для динамического списка частей выплаты в модалке
  const addRetentionPayment = () => {
    setRetentionFormData(fd => ({
      ...fd,
      payments: [...fd.payments, { portion_text: '', condition_text: '' }]
    }))
  }
  const updateRetentionPayment = (idx, field, value) => {
    setRetentionFormData(fd => ({
      ...fd,
      payments: fd.payments.map((p, i) => i === idx ? { ...p, [field]: value } : p)
    }))
  }
  const removeRetentionPayment = (idx) => {
    setRetentionFormData(fd => ({
      ...fd,
      payments: fd.payments.filter((_, i) => i !== idx)
    }))
  }

  const handleSubmitRetention = async (e) => {
    e.preventDefault()
    if (!retentionFormData.retention_percent) return alert('Введите процент удержания')
    // task 364: валидация частей выплаты — обе колонки обязательны если строка есть.
    const paymentsClean = retentionFormData.payments
      .map(p => ({ portion_text: p.portion_text.trim(), condition_text: p.condition_text.trim() }))
      .filter(p => p.portion_text || p.condition_text)
    for (const p of paymentsClean) {
      if (!p.portion_text || !p.condition_text) {
        return alert('Заполните долю и условие для каждой части выплаты, либо удалите пустую строку')
      }
    }
    try {
      const dataToSave = {
        object_id: objectId,
        retention_percent: parseFloat(retentionFormData.retention_percent) || 0,
        retention_period: retentionFormData.retention_period.trim() || null,
        notes: retentionFormData.notes.trim() || null,
        order_number: editingRetention?.order_number ?? (retentions.length + 1)
      }
      // Получаем id записи (для UPDATE он известен, для INSERT — берём из inserted).
      let retentionId = editingRetention?.id
      if (editingRetention) {
        const { error } = await supabase.from('object_warranty_retentions').update(dataToSave).eq('id', editingRetention.id)
        if (error) throw error
      } else {
        const { data: inserted, error } = await supabase
          .from('object_warranty_retentions')
          .insert([dataToSave])
          .select('id')
          .single()
        if (error) throw error
        retentionId = inserted.id
      }
      // task 364: пересохраняем части выплаты. Для простоты — delete+insert,
      //   т.к. порядок и количество частей пользователь меняет редко, а так
      //   не приходится синхронизировать по id.
      if (editingRetention) {
        const { error: delErr } = await supabase
          .from('object_warranty_retention_payments')
          .delete()
          .eq('retention_id', retentionId)
        if (delErr) throw delErr
      }
      if (paymentsClean.length > 0) {
        const paymentsToInsert = paymentsClean.map((p, i) => ({
          retention_id: retentionId,
          portion_text: p.portion_text,
          condition_text: p.condition_text,
          order_number: i + 1
        }))
        const { error: insErr } = await supabase
          .from('object_warranty_retention_payments')
          .insert(paymentsToInsert)
        if (insErr) throw insErr
      }
      setShowRetentionModal(false)
      fetchObjectData()
    } catch (error) {
      alert('Ошибка: ' + error.message)
    }
  }

  // task 353: расчёт окончания гарантии по приоритетам.
  //   1) end_date_override → берём его;
  //   2) start_date + warranty_months → авторасчёт;
  //   3) start_type='event' + warranty_months → плейсхолдер «после события + N мес.»;
  //   4) иначе — прочерк.
  const getWarrantyEndDisplay = (w) => {
    if (!w) return '-'
    if (w.end_date_override) {
      return new Date(w.end_date_override).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    }
    const months = Number(w.warranty_months) || 0
    if (w.start_date && months > 0) {
      const date = new Date(w.start_date)
      date.setMonth(date.getMonth() + months)
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    }
    if (w.start_type === 'event' && months > 0) {
      return `после события + ${months} мес.`
    }
    return '-'
  }

  // task 355: отображение «Гарантийный срок» — если задана фиксированная дата
  //   окончания, ручной срок не используется. После того как пользователь укажет
  //   фактическую дату начала (подписания акта), срок вычисляется автоматически.
  const getWarrantyDurationDisplay = (w) => {
    if (!w) return '-'
    if (w.end_date_override) {
      if (w.start_date) {
        const start = new Date(w.start_date)
        const end = new Date(w.end_date_override)
        if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end > start) {
          const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())
          return `${months} мес.`
        }
      }
      return 'рассчитается после подписания акта'
    }
    return w.warranty_months ? `${w.warranty_months} мес.` : '-'
  }

  // task 358: «Начало гарантийного срока» теперь рендерится JSX'ом прямо в
  //   таблице (см. рендер row'а в табе 'warranty') — с отдельным «Гарантия с:»
  //   badge'м для фактической даты. Старый текстовый хелпер заменён на inline-разметку.

  const formatDate = (date) => {
    if (!date) return '-'
    return new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
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

  if (objectDenied) return (
    <AccessDenied
      title="Объект недоступен"
      message="Этот объект вне вашего доступа. Вы привязаны к другому объекту — обратитесь к администратору, если нужен доступ."
      backTo="/general/objects"
    />
  )
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
          {object.developer && (
            <span className="header-developer">Застройщик: {object.developer}</span>
          )}
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
        <button className={`tab ${activeTab === 'areas' ? 'active' : ''}`} onClick={() => setActiveTab('areas')}>
          Площади
        </button>
      </div>

      {/* Информация об объекте */}
      {activeTab === 'info' && (
        <div className="tab-content info-content">
          <div className="info-header">
            <span>Информация об объекте</span>
            {canEditObj && (
              <button className="btn-add" onClick={handleEditInfo} title="Редактировать">✏️</button>
            )}
          </div>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">Застройщик</span>
              <span className="info-value">
                {object.developer || <span className="muted">—</span>}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">Проектирование</span>
              <span className="info-value">
                {object.design || <span className="muted">—</span>}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">Планируемое начало работ</span>
              <span className="info-value">{formatDate(object.planned_start_date)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Планируемое окончание работ</span>
              <span className="info-value">{formatDate(object.planned_end_date)}</span>
            </div>
            {/* task 372: «Общая площадь» вынесена в отдельную вкладку «Площади». */}
            <div className="info-item">
              <span className="info-label">Бюджет</span>
              <span className="info-value">{formatBudget(object.budget)}</span>
            </div>
            {/* task 335: email объекта */}
            <div className="info-item">
              <span className="info-label">Email объекта</span>
              <span className="info-value">
                {object.email
                  ? <a href={`mailto:${object.email}`}>{object.email}</a>
                  : <span className="muted">—</span>}
              </span>
            </div>
            {/* Ответственные по объекту — из реестра сотрудников. */}
            <div className="info-item">
              <span className="info-label">Руководитель строительства</span>
              <span className="info-value">{renderStaff(object.construction_manager)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Экономист</span>
              <span className="info-value">{renderStaff(object.economist)}</span>
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
                    {!generalContract && canEditObj && <button className="btn-add" onClick={() => handleAddDocument('general_contract')}>+ Добавить</button>}
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
                            getAttachments={getAttachments}
                            drag={docDragProps}
                            expandedDocs={expandedDocs}
                            toggleExpand={toggleExpand}
                            formatDate={formatDate}
                            onAddAttachment={(parentId) => handleAddDocument('attachment', parentId)}
                            onEdit={handleEditDocument}
                            onDelete={handleDeleteDocument}
                            onPreviewFile={handlePreviewFile}
                            onDownloadFile={handleDownloadFile}
                            canEdit={canEditObj}
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
                    {canEditObj && <button className="btn-add" onClick={() => handleAddDocument('additional_agreement')}>+ Добавить</button>}
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
                              getAttachments={getAttachments}
                              drag={docDragProps}
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
                              canEdit={canEditObj}
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
            {canEditObj && <button className="btn-add" onClick={handleAddWarranty} title="Добавить">+</button>}
          </div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Наименование работ</th>
                <th>Начало гарантийного срока</th>
                <th>Гарантийный срок</th>
                <th>Окончание гарантии</th>
                <th>Примечание</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {warranties.length > 0 ? warranties.map((item, i) => {
                const linkedDoc = item.start_document_id
                  ? documents.find(d => d.id === item.start_document_id)
                  : null
                const endByOverride = Boolean(item.end_date_override)
                return (
                  <tr key={item.id}>
                    <td className="center">{i + 1}</td>
                    <td>{item.work_name}</td>
                    <td>
                      {item.start_type === 'event' ? (
                        <div className="warranty-start-event">{item.start_event_text || '— (по событию)'}</div>
                      ) : (
                        <div>{item.start_date ? formatDate(item.start_date) : '—'}</div>
                      )}
                      {linkedDoc && (
                        <button
                          type="button"
                          className="warranty-doc-chip"
                          onClick={() => setLinkedDocPreview(linkedDoc)}
                          title={`Открыть файлы документа: ${linkedDoc.name}${linkedDoc.document_number ? ` (№ ${linkedDoc.document_number})` : ''}`}
                        >
                          <svg className="warranty-doc-chip-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                          </svg>
                          <span className="warranty-doc-chip-text">
                            {linkedDoc.name}
                            {linkedDoc.document_number ? ` (№ ${linkedDoc.document_number})` : ''}
                          </span>
                        </button>
                      )}
                      {item.start_type === 'event' && item.start_date && (
                        <div className="warranty-fact-date" title="Дата, с которой реально начинается гарантийный срок">
                          <span className="warranty-fact-icon" aria-hidden>📅</span>
                          <span className="warranty-fact-label">Гарантия с:</span>
                          <span className="warranty-fact-value">{formatDate(item.start_date)}</span>
                        </div>
                      )}
                    </td>
                    <td className="center">
                      {(() => {
                        // task 363: кнопка «Загрузить документ…» доступна для каждой
                        //   строки гарантии независимо от end_date_override. Если акт
                        //   уже привязан — показываем чип «Итоговый акт» + 👁/⬇.
                        const hasAct = Boolean(item.actual_start_doc)
                        const durationText = getWarrantyDurationDisplay(item)
                        // task 363: значение «N мес.» — главный акцент; текстовый
                        //   плейсхолдер («рассчитается после…») — мелкий серый курсив.
                        const isPlaceholder = !/мес\./.test(durationText)
                        return (
                          <div className="warranty-duration-cell">
                            <div className={`warranty-duration-value${isPlaceholder ? ' warranty-duration-value--placeholder' : ''}`}>
                              {durationText}
                            </div>
                            {hasAct ? (
                              <div className="warranty-act-row">
                                <button
                                  type="button"
                                  className="warranty-act-chip"
                                  onClick={() => canEditObj && setSignActWarranty(item)}
                                  disabled={!canEditObj}
                                  title={canEditObj
                                    ? `Изменить акт: ${item.actual_start_doc.file_name}`
                                    : item.actual_start_doc.file_name}
                                >
                                  📄 Итоговый акт
                                </button>
                                <button
                                  type="button"
                                  className="warranty-act-icon-btn"
                                  onClick={() => handlePreviewFile(item.actual_start_doc)}
                                  title="Просмотр"
                                  aria-label="Просмотр акта"
                                >
                                  👁
                                </button>
                                <button
                                  type="button"
                                  className="warranty-act-icon-btn"
                                  onClick={() => handleDownloadFile(item.actual_start_doc)}
                                  title="Скачать"
                                  aria-label="Скачать акт"
                                >
                                  ⬇
                                </button>
                              </div>
                            ) : canEditObj ? (
                              <button
                                type="button"
                                className="warranty-act-btn"
                                onClick={() => setSignActWarranty(item)}
                                title="Указать дату подписания и прикрепить файл акта"
                              >
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                                </svg>
                                Загрузить документ подтверждающий начало гарантийного срока
                              </button>
                            ) : (
                              <span className="warranty-act-placeholder">Акт не загружен</span>
                            )}
                          </div>
                        )
                      })()}
                    </td>
                    <td
                      className="center"
                      title={endByOverride ? 'Указана фиксированная дата окончания' : undefined}
                    >
                      {getWarrantyEndDisplay(item)}
                    </td>
                    <td className="notes-cell notes-cell-wide" title={item.notes || ''}>{item.notes || ''}</td>
                    <td className="actions">
                      {canEditObj && (
                        <>
                          <button onClick={() => handleEditWarranty(item)}>✏️</button>
                          <button onClick={() => handleDeleteWarranty(item.id)}>🗑️</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              }) : (
                <tr><td colSpan="7" className="empty">Нет данных о гарантии</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* task 372: Площади объекта (с вложенными подпунктами) */}
      {activeTab === 'areas' && (
        <div className="tab-content">
          <div className="cost-header">
            <span>Площади объекта</span>
            {canEditObj && <button className="btn-add" onClick={() => handleAddArea('')} title="Добавить площадь">+</button>}
          </div>
          <table className="cost-table object-areas-table">
            <thead>
              <tr>
                <th>Тип площади</th>
                <th className="center">Значение</th>
                <th className="center">Ед. изм.</th>
                <th>Источник данных</th>
                <th>Методика / основание</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {areas.length > 0 ? (() => {
                const renderRows = (parentId, depth) => areas
                  .filter(a => (a.parent_area_id || null) === parentId)
                  .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                  .flatMap(area => {
                    const hasKids = areas.some(a => a.parent_area_id === area.id)
                    const isOpen = expandedAreas.has(area.id)
                    const row = (
                      <tr key={area.id} className={depth > 0 ? 'area-child-row' : ''}>
                        <td>
                          <div className="area-type-cell" style={{ paddingLeft: `${depth * 20}px` }}>
                            {hasKids ? (
                              <button
                                type="button"
                                className="area-expand"
                                onClick={() => toggleAreaExpand(area.id)}
                                aria-label={isOpen ? 'Свернуть' : 'Развернуть'}
                              >{isOpen ? '▼' : '▶'}</button>
                            ) : (
                              <span className="area-expand-spacer" aria-hidden />
                            )}
                            <span className="area-type-name">{area.area_type}</span>
                          </div>
                          {area.notes && (
                            <div className="area-notes-sub" style={{ paddingLeft: `${depth * 20 + 18}px` }}>
                              {area.notes}
                            </div>
                          )}
                        </td>
                        <td className="center area-value">
                          {area.value != null
                            ? Number(area.value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
                            : <span className="muted">—</span>}
                        </td>
                        <td className="center">{area.unit || <span className="muted">—</span>}</td>
                        <td>{area.data_source || <span className="muted">—</span>}</td>
                        <td className="notes-cell">{area.calc_method || <span className="muted">—</span>}</td>
                        <td className="actions">
                          {canEditObj && (
                            <>
                              <button onClick={() => handleAddArea(area.id)} title="Добавить подпункт">➕</button>
                              <button onClick={() => handleEditArea(area)} title="Редактировать">✏️</button>
                              <button onClick={() => handleDeleteArea(area.id)} title="Удалить">🗑️</button>
                            </>
                          )}
                        </td>
                      </tr>
                    )
                    const childRows = (hasKids && isOpen) ? renderRows(area.id, depth + 1) : []
                    return [row, ...childRows]
                  })
                return renderRows(null, 0)
              })() : (
                <tr><td colSpan="6" className="empty">Площади не добавлены</td></tr>
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
            {canEditObj && <button className="btn-add" onClick={handleAddRetention} title="Добавить">+</button>}
          </div>
          <table className="cost-table retentions-table">
            <thead>
              <tr>
                <th>#</th>
                <th className="ret-th-percent">Гарантийное удержание, %</th>
                <th>Срок гарантийного удержания</th>
                <th>Выплата</th>
                <th>Примечание</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {retentions.length > 0 ? retentions.map((item, i) => (
                <tr key={item.id}>
                  <td className="center">{i + 1}</td>
                  <td className="center ret-td-percent">
                    <span className="ret-percent-value">{item.retention_percent}%</span>
                  </td>
                  <td className="ret-td-period">{item.retention_period || '—'}</td>
                  <td className="ret-td-payments">
                    {item.payments && item.payments.length > 0 ? (
                      <ul className="ret-payments-list">
                        {item.payments.map(p => (
                          <li key={p.id} className="ret-payment-item">
                            <span className="ret-payment-portion">{p.portion_text}</span>
                            <span className="ret-payment-condition">{p.condition_text}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="ret-payments-empty">—</span>
                    )}
                  </td>
                  <td className="notes-cell notes-cell-wide">{item.notes || ''}</td>
                  <td className="actions">
                    {canEditObj && (
                      <>
                        <button onClick={() => handleEditRetention(item)}>✏️</button>
                        <button onClick={() => handleDeleteRetention(item.id)}>🗑️</button>
                      </>
                    )}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan="6" className="empty">Нет данных об удержаниях</td></tr>
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
                  {canEditObj && (isEstimateApproved ? (
                    <button className="btn-secondary-sm" onClick={handleRevokeApproval}>Снять утверждение</button>
                  ) : (
                    <>
                      <button className="btn-success-sm" onClick={handleApproveEstimate}>Утвердить</button>
                      <button className="btn-danger-sm" onClick={handleClearEstimate}>Очистить</button>
                    </>
                  ))}
                </>
              )}
              {!isEstimateApproved && canEditObj && (
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
                    {!isEstimateApproved && canEditObj && <th className="col-actions"></th>}
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
                            {!isEstimateApproved && canEditObj && <td className="center"><button className="btn-delete-row" onClick={() => handleDeleteEstimateItem(item.id)} title="Удалить">×</button></td>}
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
                            {!isEstimateApproved && canEditObj && <td className="center"><button className="btn-delete-row" onClick={() => handleDeleteEstimateItem(item.id)} title="Удалить">×</button></td>}
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
                        {!isEstimateApproved && canEditObj && <td></td>}
                      </>
                    ) : (
                      <>
                        <td colSpan={hasSections ? 8 : 7}><strong>ИТОГО</strong></td>
                        <td className="money"><strong>{formatMoney(estimateTotalMaterials)}</strong></td>
                        <td className="money"><strong>{formatMoney(estimateTotalWorks)}</strong></td>
                        <td className="money total-cell"><strong>{formatMoney(estimateTotal)}</strong></td>
                        <td>{/* примечание */}</td>
                        {!isEstimateApproved && canEditObj && <td></td>}
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
              <div className="form-row-1">
                <label>Застройщик</label>
                <input
                  type="text"
                  value={infoFormData.developer}
                  onChange={(e) => setInfoFormData({ ...infoFormData, developer: e.target.value })}
                  placeholder="Например: ООО «Специализированный застройщик …»"
                />
              </div>
              <div className="form-row-1">
                <label>Проектирование</label>
                <input
                  type="text"
                  list="obj-design-opts"
                  value={infoFormData.design}
                  onChange={(e) => setInfoFormData({ ...infoFormData, design: e.target.value })}
                  placeholder="Например: СУ-10"
                />
                <datalist id="obj-design-opts">
                  <option value="СУ-10" />
                </datalist>
              </div>
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
              {/* task 372: поле «Общая площадь» убрано — площади ведутся во вкладке «Площади». */}
              <div className="form-row-1">
                <label>Бюджет (₽)</label>
                <input type="number" step="0.01" value={infoFormData.budget} onChange={(e) => setInfoFormData({ ...infoFormData, budget: e.target.value })} placeholder="10000000" />
              </div>
              {/* task 335: контактный email объекта */}
              <div className="form-row-1">
                <label>Email объекта</label>
                <input
                  type="email"
                  value={infoFormData.email}
                  onChange={(e) => setInfoFormData({ ...infoFormData, email: e.target.value })}
                  placeholder="object@example.com"
                />
              </div>
              {/* Ответственные по объекту — выбираются из реестра сотрудников. */}
              <div className="form-row-1">
                <label>Руководитель строительства</label>
                <FilterDropdown
                  className="obj-staff-picker"
                  label=""
                  value={infoFormData.construction_manager_contact_id}
                  onChange={(v) => setInfoFormData({ ...infoFormData, construction_manager_contact_id: v || '' })}
                  options={staffOptions}
                  searchable
                  searchPlaceholder="Поиск сотрудника…"
                  allLabel="Не назначен"
                />
              </div>
              <div className="form-row-1">
                <label>Экономист</label>
                <FilterDropdown
                  className="obj-staff-picker"
                  label=""
                  value={infoFormData.economist_contact_id}
                  onChange={(v) => setInfoFormData({ ...infoFormData, economist_contact_id: v || '' })}
                  options={staffOptions}
                  searchable
                  searchPlaceholder="Поиск сотрудника…"
                  allLabel="Не назначен"
                />
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
                <textarea
                  ref={warrantyWorkNameRef}
                  className="warranty-autosize warranty-autosize-compact"
                  rows="1"
                  value={warrantyFormData.work_name}
                  onChange={(e) => setWarrantyFormData({ ...warrantyFormData, work_name: e.target.value })}
                  placeholder="Например: Строительные и монтажные работы"
                  required
                />
              </div>

              {/* task 362: переключатель типа старта убран — всегда «по событию». */}
              <div className="form-row">
                <label>С какого момента начинается гарантийный срок *</label>
                <textarea
                  ref={warrantyEventTextRef}
                  className="warranty-autosize"
                  rows="3"
                  value={warrantyFormData.start_event_text}
                  onChange={(e) => setWarrantyFormData({ ...warrantyFormData, start_event_text: e.target.value })}
                  placeholder="с даты подписания Акта о практическом завершении Работ по Объекту (Акт № 3), но в любом случае не позднее даты подписания Второго передаточного Акта…"
                />
              </div>
              <div className="form-row">
                <label>Форма документа о начале гарантии (опционально)</label>
                <WarrantyDocSelect
                  value={warrantyFormData.start_document_id}
                  onChange={(id) => setWarrantyFormData({ ...warrantyFormData, start_document_id: id })}
                  documents={documents}
                />
              </div>
              {/* task 355 + 362: фактическая дата + срок (срок скрыт если задан override) */}
              {(() => {
                const hasEndOverride = Boolean(warrantyFormData.end_date_override)
                return (
                  <div className={hasEndOverride ? 'form-row' : 'form-row-2'}>
                    <div>
                      <label>Фактическая дата начала (опционально)</label>
                      <input
                        type="date"
                        value={warrantyFormData.start_date}
                        onChange={(e) => setWarrantyFormData({ ...warrantyFormData, start_date: e.target.value })}
                      />
                    </div>
                    {!hasEndOverride && (
                      <div>
                        <label>Гарантийный срок (мес.)</label>
                        <input type="number" min="1" value={warrantyFormData.warranty_months} onChange={(e) => setWarrantyFormData({ ...warrantyFormData, warranty_months: e.target.value })} />
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* task 362: загрузка акта прямо в модалке — без перехода в WarrantyActSignModal */}
              <div className="form-row">
                <label>Документ подтверждающий начало гарантийного срока (опционально)</label>
                {warrantyFormData.actual_start_existing && !warrantyFormData.actual_start_unlinked && (
                  <div className="warranty-act-current" style={{ marginBottom: '0.5rem' }}>
                    <span className="warranty-act-current-icon" aria-hidden>📄</span>
                    <button
                      type="button"
                      className="warranty-act-current-link"
                      onClick={() => handlePreviewFile(warrantyFormData.actual_start_existing)}
                      title="Просмотр текущего файла"
                    >
                      {warrantyFormData.actual_start_existing.file_name}
                    </button>
                    <button
                      type="button"
                      className="warranty-act-icon-btn"
                      onClick={() => handleDownloadFile(warrantyFormData.actual_start_existing)}
                      title="Скачать"
                      aria-label="Скачать"
                    >⬇</button>
                    <button
                      type="button"
                      className="warranty-act-icon-btn warranty-act-unlink-inline"
                      onClick={() => setWarrantyFormData({ ...warrantyFormData, actual_start_unlinked: true, actual_start_file: null })}
                      title="Открепить файл"
                      aria-label="Открепить файл"
                    >✕</button>
                  </div>
                )}
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                  onChange={(e) => setWarrantyFormData({
                    ...warrantyFormData,
                    actual_start_file: e.target.files?.[0] || null,
                    actual_start_unlinked: false
                  })}
                />
                {warrantyFormData.actual_start_file && (
                  <small className="form-hint">
                    Будет загружен: <strong>{warrantyFormData.actual_start_file.name}</strong>{' '}
                    ({Math.ceil(warrantyFormData.actual_start_file.size / 1024)} KB)
                  </small>
                )}
                {warrantyFormData.actual_start_unlinked && !warrantyFormData.actual_start_file && (
                  <small className="form-hint" style={{ color: '#dc2626' }}>
                    Текущий файл будет откреплён при сохранении.
                  </small>
                )}
              </div>

              <div className="form-row">
                <label>Фиксированная дата окончания (опционально)</label>
                <input
                  type="date"
                  value={warrantyFormData.end_date_override}
                  onChange={(e) => setWarrantyFormData({ ...warrantyFormData, end_date_override: e.target.value })}
                />
                <small className="form-hint">
                  {warrantyFormData.end_date_override
                    ? 'Гарантийный срок рассчитается автоматически после того, как будет указана фактическая дата подписания акта.'
                    : 'Если указана — перекрывает авторасчёт «дата начала + срок».'}
                </small>
              </div>

              <div className="form-row">
                <label>Примечание</label>
                <textarea
                  ref={warrantyNotesRef}
                  className="warranty-autosize"
                  rows="2"
                  value={warrantyFormData.notes}
                  onChange={(e) => setWarrantyFormData({ ...warrantyFormData, notes: e.target.value })}
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => setShowWarrantyModal(false)}>Отмена</button>
                <button type="submit" className="btn-save">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* task 372: модалка добавления/редактирования площади */}
      {showAreaModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingArea ? 'Редактировать площадь' : 'Добавить площадь'}</h3>
              <button onClick={() => setShowAreaModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmitArea}>
              <div className="form-row">
                <label>Тип / название площади *</label>
                <input
                  type="text"
                  list="area-type-options"
                  value={areaFormData.area_type}
                  onChange={(e) => setAreaFormData({ ...areaFormData, area_type: e.target.value })}
                  placeholder="Например: Общая площадь здания / Корпус 1"
                  required
                />
              </div>
              <div className="form-row-2">
                <div>
                  <label>Значение</label>
                  <input
                    type="number"
                    step="0.01"
                    value={areaFormData.value}
                    onChange={(e) => setAreaFormData({ ...areaFormData, value: e.target.value })}
                    placeholder="1500.00"
                  />
                </div>
                <div>
                  <label>Единица измерения</label>
                  <input
                    type="text"
                    list="area-unit-options"
                    value={areaFormData.unit}
                    onChange={(e) => setAreaFormData({ ...areaFormData, unit: e.target.value })}
                    placeholder="м²"
                  />
                </div>
              </div>
              <div className="form-row">
                <label>Источник данных</label>
                <input
                  type="text"
                  list="area-source-options"
                  value={areaFormData.data_source}
                  onChange={(e) => setAreaFormData({ ...areaFormData, data_source: e.target.value })}
                  placeholder="Проект, БТИ, МГЭ, ПТО…"
                />
              </div>
              <div className="form-row">
                <label>Методика / основание расчёта</label>
                <input
                  type="text"
                  list="area-method-options"
                  value={areaFormData.calc_method}
                  onChange={(e) => setAreaFormData({ ...areaFormData, calc_method: e.target.value })}
                  placeholder="По проектной документации…"
                />
              </div>
              <div className="form-row">
                <label>Вложить в площадь (подпункт)</label>
                <select
                  value={areaFormData.parent_area_id}
                  onChange={(e) => setAreaFormData({ ...areaFormData, parent_area_id: e.target.value })}
                >
                  <option value="">— Корневой уровень —</option>
                  {(() => {
                    // Исключаем саму запись и её потомков — иначе цикл в дереве.
                    const excluded = new Set()
                    if (editingArea) {
                      excluded.add(editingArea.id)
                      const collect = (pid) => areas
                        .filter(a => a.parent_area_id === pid)
                        .forEach(c => { excluded.add(c.id); collect(c.id) })
                      collect(editingArea.id)
                    }
                    const opts = []
                    const walk = (parentId, depth) => areas
                      .filter(a => (a.parent_area_id || null) === parentId)
                      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                      .forEach(a => {
                        if (excluded.has(a.id)) return
                        opts.push(
                          <option key={a.id} value={a.id}>
                            {`${'— '.repeat(depth)}${a.area_type}`}
                          </option>
                        )
                        walk(a.id, depth + 1)
                      })
                    walk(null, 0)
                    return opts
                  })()}
                </select>
              </div>
              <div className="form-row">
                <label>Примечание</label>
                <textarea
                  rows="2"
                  value={areaFormData.notes}
                  onChange={(e) => setAreaFormData({ ...areaFormData, notes: e.target.value })}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => setShowAreaModal(false)}>Отмена</button>
                <button type="submit" className="btn-save">Сохранить</button>
              </div>
            </form>
            <datalist id="area-type-options">
              {AREA_TYPE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
            </datalist>
            <datalist id="area-unit-options">
              {AREA_UNIT_SUGGESTIONS.map(s => <option key={s} value={s} />)}
            </datalist>
            <datalist id="area-source-options">
              {AREA_SOURCE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
            </datalist>
            <datalist id="area-method-options">
              {AREA_METHOD_SUGGESTIONS.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>
        </div>
      )}

      {/* task 359: модалка просмотра связанного документа из строки гарантии.
          Показывает подписанный и редактируемый файлы (если они привязаны к
          object_documents) с кнопками просмотра и скачивания. */}
      {linkedDocPreview && (
        <div className="modal-overlay" onClick={() => setLinkedDocPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Связанный документ</h3>
              <button onClick={() => setLinkedDocPreview(null)}>×</button>
            </div>
            <div className="warranty-linked-doc-body">
              <div className="warranty-linked-doc-title">
                {linkedDocPreview.name}
                {linkedDocPreview.document_number && (
                  <span className="warranty-linked-doc-num"> (№ {linkedDocPreview.document_number})</span>
                )}
              </div>
              {[
                { key: 'signed',   label: 'Подписанный',  doc: linkedDocPreview.signed },
                { key: 'editable', label: 'Редактируемый', doc: linkedDocPreview.editable },
              ].map(slot => (
                <div key={slot.key} className="warranty-linked-doc-slot">
                  <div className="warranty-linked-doc-slot-label">{slot.label}</div>
                  {slot.doc ? (
                    <div className="warranty-linked-doc-slot-row">
                      <span className="warranty-linked-doc-filename" title={slot.doc.file_name}>
                        📄 {slot.doc.file_name}
                      </span>
                      <button
                        type="button"
                        className="warranty-act-icon-btn"
                        onClick={() => handlePreviewFile(slot.doc)}
                        title="Просмотр"
                        aria-label="Просмотр"
                      >👁</button>
                      <button
                        type="button"
                        className="warranty-act-icon-btn"
                        onClick={() => handleDownloadFile(slot.doc)}
                        title="Скачать"
                        aria-label="Скачать"
                      >⬇</button>
                    </div>
                  ) : (
                    <div className="warranty-linked-doc-empty">Файл не загружен</div>
                  )}
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-cancel" onClick={() => setLinkedDocPreview(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {/* task 357: модалка подписания акта для строки гарантии */}
      {signActWarranty && (
        <WarrantyActSignModal
          warranty={signActWarranty}
          objectId={objectId}
          onClose={() => setSignActWarranty(null)}
          onSaved={() => {
            setSignActWarranty(null)
            fetchObjectData()
          }}
        />
      )}

      {/* Модальное окно гарантийных удержаний */}
      {showRetentionModal && (() => {
        // task 364: autosize для textarea — вызывается в ref-callback (initial mount)
        //   и в onChange (при вводе). Работает и для динамического списка частей.
        const autosize = (el) => {
          if (!el) return
          el.style.height = 'auto'
          el.style.height = el.scrollHeight + 'px'
        }
        return (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingRetention ? 'Редактировать' : 'Добавить'} удержание</h3>
              <button onClick={() => setShowRetentionModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmitRetention}>
              <div className="form-row">
                <label>Гарантийное удержание, % *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={retentionFormData.retention_percent}
                  onChange={(e) => setRetentionFormData({ ...retentionFormData, retention_percent: e.target.value })}
                  placeholder="5.00"
                  required
                />
              </div>
              <div className="form-row">
                <label>Срок гарантийного удержания</label>
                <textarea
                  ref={autosize}
                  className="warranty-autosize"
                  rows="2"
                  value={retentionFormData.retention_period}
                  onChange={(e) => {
                    setRetentionFormData({ ...retentionFormData, retention_period: e.target.value })
                    autosize(e.target)
                  }}
                  placeholder="Например: По истечении 12 месяцев с даты получения Разрешения на ввод объекта в эксплуатацию…"
                />
              </div>

              {/* task 364: динамический список частей выплаты */}
              <div className="form-row">
                <label>Условия выплаты</label>
                <div className="ret-payments-editor">
                  {retentionFormData.payments.length === 0 && (
                    <div className="ret-payments-editor-empty">
                      Удержание выплачивается одной суммой. Если выплата дробится по частям —
                      нажмите «+ Добавить условие выплаты».
                    </div>
                  )}
                  {retentionFormData.payments.map((p, idx) => (
                    <div className="ret-payment-edit-row" key={idx}>
                      <input
                        type="text"
                        className="ret-payment-edit-portion"
                        value={p.portion_text}
                        onChange={(e) => updateRetentionPayment(idx, 'portion_text', e.target.value)}
                        placeholder="1/3"
                        aria-label="Доля выплаты"
                      />
                      <textarea
                        ref={autosize}
                        className="warranty-autosize ret-payment-edit-condition"
                        rows="1"
                        value={p.condition_text}
                        onChange={(e) => {
                          updateRetentionPayment(idx, 'condition_text', e.target.value)
                          autosize(e.target)
                        }}
                        placeholder="с даты получения Разрешения на ввод объекта в эксплуатацию"
                        aria-label="Условие выплаты"
                      />
                      <button
                        type="button"
                        className="ret-payment-edit-remove"
                        onClick={() => removeRetentionPayment(idx)}
                        title="Удалить часть выплаты"
                        aria-label="Удалить часть выплаты"
                      >🗑️</button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="ret-payment-add-btn"
                    onClick={addRetentionPayment}
                  >
                    + Добавить условие выплаты
                  </button>
                </div>
              </div>

              <div className="form-row">
                <label>Примечание</label>
                <textarea
                  ref={autosize}
                  className="warranty-autosize"
                  rows="2"
                  value={retentionFormData.notes}
                  onChange={(e) => {
                    setRetentionFormData({ ...retentionFormData, notes: e.target.value })
                    autosize(e.target)
                  }}
                  placeholder="Сноски, банковская гарантия, исключения…"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-cancel" onClick={() => setShowRetentionModal(false)}>Отмена</button>
                <button type="submit" className="btn-save">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
        )
      })()}
    </div>
  )
}

export default ObjectDetailPage
