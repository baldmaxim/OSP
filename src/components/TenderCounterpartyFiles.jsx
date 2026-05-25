import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { requestDownloadUrl } from '../services/s3'
import {
  addProposalFile,
  deleteProposalFile,
  fetchProposalFiles,
} from '../services/tenderProposalFiles'
import S3DocumentPreview from './S3DocumentPreview'
import './TenderCounterpartyFiles.css'

// Файлы КП и сопутствующие документы одного контрагента в рамках тендера (task 290).
// Используется и в раскрытой строке списка тендеров, и на детальной странице тендера.
// Сверху — блок «Коммерческие предложения» с группировкой версий (последняя сверху,
// старые под катом «Версии (N)»). Ниже — блок «Документы» (плоский список).

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

function FileRow({ file, variant, onDownload, onPreview, onDelete }) {
  const s3 = file.s3
  if (!s3) return null
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
  const { isEmployee } = useRole()
  const canEdit = canEditProp !== undefined ? canEditProp : isEmployee

  const [data, setData] = useState({ proposals: [], attachments: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const [previewDoc, setPreviewDoc] = useState(null)

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

  const handleProposalFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const groupId = pendingGroupId.current
    pendingGroupId.current = null
    const promptText = groupId
      ? 'Метка вариации (опционально): «со скидкой 5%», «финальный»…'
      : 'Метка КП (опционально): «исходный», «версия 1»…'
    const label = window.prompt(promptText, '')
    if (label === null) return  // Cancel в prompt — отмена загрузки
    setUploading(true)
    try {
      await addProposalFile({
        tenderId,
        counterpartyId,
        file,
        fileKind: 'commercial_proposal',
        proposalGroupId: groupId,
        versionLabel: label,
      })
      // Автоматически разворачиваем только что обновлённую группу (если это вариация),
      // чтобы пользователь сразу видел весь стек версий.
      if (groupId) setExpandedGroups(prev => new Set(prev).add(groupId))
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
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key)
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

  return (
    <div className="tcpf">
      {/* Скрытые file-input'ы — клики на видимые кнопки делегируются на них. */}
      <input ref={newProposalRef} type="file" style={{ display: 'none' }} onChange={handleProposalFile} />
      <input ref={variationRef} type="file" style={{ display: 'none' }} onChange={handleProposalFile} />
      <input ref={attachmentRef} type="file" multiple style={{ display: 'none' }} onChange={handleAttachmentFile} />

      {/* === КОММЕРЧЕСКИЕ ПРЕДЛОЖЕНИЯ === */}
      {/* Заголовок секции опущен: столбец таблицы уже подписан «КП / Документы». */}
      <div className="tcpf-section tcpf-section-proposals">
        {canEdit && (
          <div className="tcpf-section-header tcpf-section-header-no-title">
            <button
              type="button"
              className="tcpf-btn-primary"
              onClick={() => pickProposal(null)}
              disabled={uploading}
            >
              {uploading ? 'Загрузка…' : '+ Добавить КП'}
            </button>
          </div>
        )}

        {loading && <div className="tcpf-empty">Загрузка…</div>}
        {error && <div className="tcpf-error">{error}</div>}
        {!loading && !error && data.proposals.length === 0 && (
          <div className="tcpf-empty">КП не загружены</div>
        )}

        {data.proposals.map(group => {
          const isExpanded = expandedGroups.has(group.groupId)
          return (
            <div key={group.groupId} className="tcpf-group">
              <FileRow
                file={group.latest}
                variant="primary"
                onDownload={handleDownload}
                onPreview={setPreviewDoc}
                onDelete={canEdit ? handleDelete : null}
              />
              {group.older.length > 0 && (
                <>
                  <button
                    type="button"
                    className="tcpf-toggle"
                    onClick={() => toggleGroup(group.groupId)}
                  >
                    {isExpanded ? '▼' : '▶'} Версии ({group.older.length})
                  </button>
                  {isExpanded && (
                    <div className="tcpf-older">
                      {group.older.map(f => (
                        <FileRow
                          key={f.id}
                          file={f}
                          variant="muted"
                          onDownload={handleDownload}
                          onPreview={setPreviewDoc}
                          onDelete={canEdit ? handleDelete : null}
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
                  disabled={uploading}
                >+ Добавить вариацию</button>
              )}
            </div>
          )
        })}
      </div>

      {/* === ДОКУМЕНТЫ === */}
      <div className="tcpf-section">
        <div className="tcpf-section-header">
          <span className="tcpf-section-title">Документы</span>
          {canEdit && (
            <button
              type="button"
              className="tcpf-btn-secondary"
              onClick={() => attachmentRef.current?.click()}
              disabled={uploading}
            >+ Добавить документ</button>
          )}
        </div>
        {!loading && data.attachments.length === 0 && (
          <div className="tcpf-empty tcpf-empty-small">Нет вложений</div>
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

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  )
}
