import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { requestDownloadUrl } from '../services/s3'
import {
  addProposalFile,
  deleteProposalFile,
  fetchProposalFiles,
} from '../services/tenderProposalFiles'
import S3DocumentPreview from './S3DocumentPreview'
import KpReviewModal from './KpReviewModal'
import KpReviewBadge from './KpReviewBadge'
import './TenderCounterpartyFiles.css'

// Файлы КП и сопутствующие документы одного контрагента в рамках тендера (task 290).
// Используется и в раскрытой строке списка тендеров, и на детальной странице тендера.
// Task 300: список свёрнут под тоггл, загрузка КП — через модалку.

function formatBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
}

function FileRow({ file, variant, onDownload, onPreview, onDelete, canReview, onReview }) {
  const s3 = file.s3
  if (!s3) return null
  // Проверку показываем только для КП (не для документов) и только для тех, что
  // требуют проверки (review_required). Легаси-КП до запуска фичи — без бейджа.
  const isProposal = file.file_kind === 'commercial_proposal' && file.review_required === true
  const cls =
    `tcpf-row${variant === 'primary' ? ' tcpf-row-primary' : ''}${variant === 'muted' ? ' tcpf-row-muted' : ''}`
  return (
    <div className={cls}>
      <div className="tcpf-row-main">
        <span className="tcpf-row-name" title={s3.file_name}>
          📄 {s3.file_name}
        </span>
        {file.version_label && (
          <span className="tcpf-row-label" title={file.version_label}>
            {file.version_label}
          </span>
        )}
        {isProposal && (
          <KpReviewBadge file={file} canReview={canReview} onReview={onReview} showRemarks />
        )}
      </div>
      <div className="tcpf-row-meta">
        <span>{formatBytes(s3.size_bytes)}</span>
        <span className="tcpf-row-meta-sep">·</span>
        <span>{s3.uploaded_by_name || '—'}</span>
        <span className="tcpf-row-meta-sep">·</span>
        <span>{formatDateTime(s3.created_at)}</span>
      </div>
      <div className="tcpf-row-actions">
        <button type="button" title="Просмотр" onClick={() => onPreview(s3)}>👁️</button>
        <button type="button" title="Скачать" onClick={() => onDownload(s3)}>⬇️</button>
        {onDelete && (
          <button
            type="button"
            title="Удалить"
            className="tcpf-btn-danger"
            onClick={() => onDelete(file)}
          >🗑️</button>
        )}
      </div>
    </div>
  )
}

export default function TenderCounterpartyFiles({
  tenderId,
  counterpartyId,
  canEdit: canEditProp,
}) {
  const { isEmployee, isAdmin, role } = useRole()
  const canEdit = canEditProp !== undefined ? canEditProp : isEmployee
  // task 431: проверять КП может экономист ОСП и админ.
  const canReview = isAdmin || role === 'economist'

  const [data, setData] = useState({ proposals: [], attachments: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const [previewDoc, setPreviewDoc] = useState(null)
  // task 431: файл, для которого открыта модалка проверки КП.
  const [reviewFile, setReviewFile] = useState(null)
  // task 300: список файлов свёрнут по умолчанию.
  const [isExpanded, setIsExpanded] = useState(false)
  // task 300: модалка для ввода метки версии при загрузке КП.
  // null | { file, proposalGroupId, label }
  const [uploadModal, setUploadModal] = useState(null)

  const newProposalRef = useRef(null)
  const variationRef = useRef(null)
  const attachmentRef = useRef(null)
  // groupId, под которым уйдёт следующая вариация (выставляется перед .click() на input).
  const pendingGroupId = useRef(null)

  const reload = useCallback(async () => {
    if (!tenderId || !counterpartyId) return
    setLoading(true)
    setError(null)
    try {
      setData(await fetchProposalFiles(tenderId, counterpartyId))
    } catch (e) {
      setError(e.message || 'Не удалось загрузить файлы')
    } finally {
      setLoading(false)
    }
  }, [tenderId, counterpartyId])

  useEffect(() => { reload() }, [reload])

  const pickProposal = (groupId = null) => {
    pendingGroupId.current = groupId
    if (groupId) variationRef.current?.click()
    else newProposalRef.current?.click()
  }

  // task 300: после выбора файла открываем модалку для ввода метки версии,
  // а не window.prompt. Загрузка происходит в handleUploadConfirm.
  const handleProposalFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const groupId = pendingGroupId.current
    pendingGroupId.current = null
    setUploadModal({ file, proposalGroupId: groupId, label: '' })
  }

  const handleUploadCancel = () => setUploadModal(null)

  const handleUploadConfirm = async () => {
    if (!uploadModal) return
    const { file, proposalGroupId, label } = uploadModal
    setUploading(true)
    try {
      await addProposalFile({
        tenderId,
        counterpartyId,
        file,
        fileKind: 'commercial_proposal',
        proposalGroupId,
        versionLabel: label,
      })
      // Автораскрытие группы при добавлении вариации — чтобы стек версий был сразу виден.
      if (proposalGroupId) {
        setExpandedGroups(prev => new Set(prev).add(proposalGroupId))
      }
      // При первой загрузке полезно сразу показать список целиком.
      setIsExpanded(true)
      setUploadModal(null)
      await reload()
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setUploading(false)
    }
  }

  const handleAttachmentFile = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) {
        await addProposalFile({ tenderId, counterpartyId, file, fileKind: 'attachment' })
      }
      // Раскрыть список — чтобы пользователь сразу увидел добавленные документы.
      setIsExpanded(true)
      await reload()
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (file) => {
    if (!window.confirm(`Удалить файл «${file.s3?.file_name || ''}»?`)) return
    try {
      await deleteProposalFile(file)
      await reload()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const handleDownload = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key, { fileName: s3doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = s3doc.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const toggleGroup = (gid) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid); else next.add(gid)
      return next
    })
  }

  const proposalsCount = data.proposals.length
  const attachmentsCount = data.attachments.length
  const isEmpty = proposalsCount === 0 && attachmentsCount === 0

  return (
    <div className="tcpf">
      {/* Скрытые file-input'ы — клики на видимые кнопки делегируются на них. */}
      <input ref={newProposalRef} type="file" style={{ display: 'none' }} onChange={handleProposalFile} />
      <input ref={variationRef}   type="file" style={{ display: 'none' }} onChange={handleProposalFile} />
      <input ref={attachmentRef}  type="file" multiple style={{ display: 'none' }} onChange={handleAttachmentFile} />

      {/* Быстрые действия — всегда видны, доступны без раскрытия списка. */}
      {canEdit && (
        <div className="tcpf-quick-actions">
          <button
            type="button"
            className="tcpf-btn-primary"
            onClick={() => pickProposal(null)}
            disabled={uploading || !!uploadModal}
          >+ КП</button>
          <button
            type="button"
            className="tcpf-btn-secondary"
            onClick={() => attachmentRef.current?.click()}
            disabled={uploading || !!uploadModal}
          >+ Документ</button>
        </div>
      )}

      {/* Компактный тоггл-сводка. */}
      {!loading && !error && (
        <button
          type="button"
          className={`tcpf-toggle-header${!isEmpty ? ' tcpf-toggle-header-active' : ''}`}
          onClick={() => setIsExpanded(v => !v)}
          aria-expanded={isExpanded}
        >
          <span className="tcpf-chev" aria-hidden>{isExpanded ? '▼' : '▶'}</span>
          <span className="tcpf-summary">
            {isEmpty
              ? 'Файлов нет'
              : `Файлы: ${proposalsCount} КП · ${attachmentsCount} док.`}
          </span>
        </button>
      )}
      {loading && <div className="tcpf-empty">Загрузка…</div>}
      {error && <div className="tcpf-error">{error}</div>}

      {/* Раскрытое содержимое */}
      {isExpanded && !loading && !error && !isEmpty && (
        <div className="tcpf-expanded">
          {/* КП-группы */}
          {data.proposals.map(group => {
            const groupExpanded = expandedGroups.has(group.groupId)
            return (
              <div key={group.groupId} className="tcpf-group">
                <FileRow
                  file={group.latest}
                  variant="primary"
                  onDownload={handleDownload}
                  onPreview={setPreviewDoc}
                  onDelete={canEdit ? handleDelete : null}
                  canReview={canReview}
                  onReview={setReviewFile}
                />
                {group.older.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="tcpf-toggle"
                      onClick={() => toggleGroup(group.groupId)}
                    >
                      {groupExpanded ? '▼' : '▶'} Версии ({group.older.length})
                    </button>
                    {groupExpanded && (
                      <div className="tcpf-older">
                        {group.older.map(f => (
                          <FileRow
                            key={f.id}
                            file={f}
                            variant="muted"
                            onDownload={handleDownload}
                            onPreview={setPreviewDoc}
                            onDelete={canEdit ? handleDelete : null}
                            canReview={canReview}
                            onReview={setReviewFile}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="tcpf-btn-secondary"
                    onClick={() => pickProposal(group.groupId)}
                    disabled={uploading || !!uploadModal}
                  >+ Добавить вариацию</button>
                )}
              </div>
            )
          })}

          {/* Раздел вложений (только если есть оба типа — нужен явный разделитель) */}
          {attachmentsCount > 0 && proposalsCount > 0 && (
            <div className="tcpf-attachments-divider">Документы</div>
          )}
          {data.attachments.map(file => (
            <FileRow
              key={file.id}
              file={file}
              onDownload={handleDownload}
              onPreview={setPreviewDoc}
              onDelete={canEdit ? handleDelete : null}
            />
          ))}
        </div>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}

      {/* task 431: модалка проверки КП */}
      {reviewFile && (
        <KpReviewModal
          file={reviewFile}
          onClose={() => setReviewFile(null)}
          onSaved={reload}
        />
      )}

      {/* Модалка загрузки КП */}
      {uploadModal && (
        // Клик по подложке и Escape НЕ закрывают окно — только крестик/«Отмена»/загрузка.
        <div className="tcpf-modal-overlay">
          <div className="tcpf-modal" role="dialog" aria-modal="true">
            <div className="tcpf-modal-header">
              <h3 className="tcpf-modal-title">
                {uploadModal.proposalGroupId ? 'Загрузка вариации КП' : 'Загрузка КП'}
              </h3>
              <button
                type="button"
                className="tcpf-modal-close"
                onClick={handleUploadCancel}
                aria-label="Закрыть"
              >×</button>
            </div>
            <div className="tcpf-modal-body">
              <div className="tcpf-modal-file">
                <span className="tcpf-modal-file-icon" aria-hidden>📄</span>
                <div className="tcpf-modal-file-info">
                  <span className="tcpf-modal-file-name" title={uploadModal.file.name}>
                    {uploadModal.file.name}
                  </span>
                  <span className="tcpf-modal-file-size">
                    {formatBytes(uploadModal.file.size)}
                  </span>
                </div>
              </div>
              <label className="tcpf-modal-field">
                <span className="tcpf-modal-field-label">Метка версии (опционально)</span>
                <input
                  type="text"
                  value={uploadModal.label}
                  onChange={(e) => setUploadModal(s => s ? { ...s, label: e.target.value } : s)}
                  placeholder={uploadModal.proposalGroupId
                    ? 'например: со скидкой 5%, финальный'
                    : 'например: исходный, версия 1'}
                  className="tcpf-modal-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleUploadConfirm() }
                  }}
                />
              </label>
            </div>
            <div className="tcpf-modal-footer">
              <button
                type="button"
                className="tcpf-btn-secondary"
                onClick={handleUploadCancel}
                disabled={uploading}
              >Отмена</button>
              <button
                type="button"
                className="tcpf-btn-primary"
                onClick={handleUploadConfirm}
                disabled={uploading}
              >{uploading ? 'Загрузка…' : 'Загрузить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
