import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, requestDownloadUrl } from '../services/s3'
import {
  addRdCode, isMissingTableError, isPdfFile, loadVorRd, setDocumentCodes, uploadRdDocuments,
  LEGACY_VOR_CATEGORY, VOR_STATEMENT_CATEGORY,
} from '../services/tenderVorRd'
import S3DocumentList from './S3DocumentList'
import S3DocumentPreview from './S3DocumentPreview'
import './S3DocumentList.css'
import './TenderVorRdPanel.css'

// «ВОРы и РД» тендера — одна панель для вкладки карточки тендера и для окна на
// странице «ВОРы и РД» (VorRdModal).
//
//   1. Рабочая документация — только PDF, при загрузке обязательно указываются
//      шифры РД. Шифры — общий список тендера (вкладка «Шифр РД», таблица
//      tender_rd_codes): здесь их выбирают, а недостающий можно добавить прямо в
//      форме — он появится и во вкладке «Шифр РД».
//   2. Ведомость объёмов работ — файлы ВОР.
//   3. «Загружены ранее» — файлы прежней общей категории «ВОРы и РД», чтобы
//      ничего из уже загруженного не пропало. Блок виден, только если такие есть.

const Icon = ({ children, size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const EyeIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /></Icon>
const DownloadIcon = () => <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Icon>
const TrashIcon = () => <Icon><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></Icon>
const TagIcon = () => <Icon><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z" /><circle cx="7.5" cy="7.5" r="1" /></Icon>
const PdfIcon = () => <Icon size={18}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M9 15h6" /><path d="M9 11h2" /></Icon>

function formatBytes(bytes) {
  if (bytes == null) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function TenderVorRdPanel({ tenderId, canEdit = false, onChange }) {
  const { userProfile } = useRole()
  const byName = userProfile?.full_name || null

  const [data, setData] = useState({ codes: [], rdDocs: [], vorDocs: [], legacyDocs: [], linksMissing: false, codesError: null, linksError: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [codeFilter, setCodeFilter] = useState('') // '' = все, '__none__' = без шифра
  const [previewDoc, setPreviewDoc] = useState(null)
  const [adding, setAdding] = useState(false)
  const [editingDocId, setEditingDocId] = useState(null)

  // Через ref: колбэк родителя не обязан быть мемоизирован.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const reload = useCallback(async ({ notify = false } = {}) => {
    setError(null)
    try {
      const next = await loadVorRd(tenderId)
      setData(next)
      if (notify) onChangeRef.current?.()
    } catch (err) {
      console.error('Ошибка загрузки ВОРов и РД:', err.message)
      setError(isMissingTableError(err, 'tender_rd_codes')
        ? 'Раздел недоступен: не применена миграция 20260901_tender_rd_codes.'
        : err.message)
    } finally {
      setLoading(false)
    }
  }, [tenderId])

  useEffect(() => { setLoading(true); reload() }, [reload])

  // Шифры не загрузились (сеть/таймаут) — файлы показываем, но загрузку РД и правку
  // шифров закрываем: без списка шифров их не выбрать, а сохранение перезаписало бы
  // набор, которого мы не видели.
  const codesUnavailable = !!(data.codesError || data.linksError)
  const canEditCodes = canEdit && !data.linksMissing && !codesUnavailable
  const retry = () => { setLoading(true); reload() }

  const codeById = useMemo(() => new Map(data.codes.map(c => [c.id, c])), [data.codes])

  const docsCountByCode = useMemo(() => {
    const m = new Map()
    for (const d of data.rdDocs) for (const id of d.codeIds) m.set(id, (m.get(id) || 0) + 1)
    return m
  }, [data.rdDocs])
  const noCodeCount = data.rdDocs.filter(d => d.codeIds.length === 0).length

  const visibleRdDocs = data.rdDocs.filter(d =>
    !codeFilter ? true
      : codeFilter === '__none__' ? d.codeIds.length === 0
        : d.codeIds.includes(codeFilter))

  const handleDownload = async (doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(doc.s3_key, { fileName: doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = doc.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка получения ссылки: ' + (err.message || err))
    }
  }

  const handleDeleteRd = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»? Шифры РД останутся в списке тендера.`)) return
    try {
      await deleteDocument(doc)
      await reload({ notify: true })
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  if (loading) return <div className="tvr-empty">Загрузка…</div>
  if (error) {
    return (
      <div className="tvr-error">
        {error}
        <div style={{ marginTop: '0.5rem' }}>
          <button type="button" className="s3-doc-btn-primary" onClick={retry}>Повторить</button>
        </div>
      </div>
    )
  }

  return (
    <div className="tvr-panel">
      {/* ── 1. Рабочая документация ── */}
      <section className="tvr-section">
        <div className="tvr-section-head">
          <div>
            <h3 className="tvr-title"><span className="tvr-step">1</span>Рабочая документация</h3>
            <p className="tvr-hint">PDF-файлы РД. У каждого файла указываются шифры — из списка «Шифр РД» этого тендера.</p>
          </div>
          {canEdit && !adding && !codesUnavailable && (
            <button type="button" className="s3-doc-btn-primary" onClick={() => setAdding(true)}>
              + Добавить РД
            </button>
          )}
        </div>

        {data.linksMissing && (
          <div className="tvr-warn">
            Шифры у файлов не отображаются: не применена миграция 20260918_tender_rd_documents.
          </div>
        )}
        {codesUnavailable && (
          <div className="tvr-warn">
            {data.codesError || data.linksError} Файлы ниже доступны; загрузка РД и правка шифров — после повторной загрузки.{' '}
            <button type="button" className="tvr-link-btn" onClick={retry}>Повторить</button>
          </div>
        )}

        {adding && (
          <RdUploadForm
            tenderId={tenderId}
            codes={data.codes}
            byName={byName}
            onCancel={() => setAdding(false)}
            onCodesChanged={() => reload({ notify: true })}
            onDone={async () => { setAdding(false); await reload({ notify: true }) }}
          />
        )}

        {data.rdDocs.length > 0 && data.codes.length > 0 && (
          <div className="tvr-filter" role="group" aria-label="Фильтр по шифру РД">
            <button type="button" className={`tvr-chip${!codeFilter ? ' is-active' : ''}`} onClick={() => setCodeFilter('')}>
              Все <span className="tvr-chip-count">{data.rdDocs.length}</span>
            </button>
            {data.codes.map(c => (
              <button
                key={c.id}
                type="button"
                className={`tvr-chip${codeFilter === c.id ? ' is-active' : ''}`}
                onClick={() => setCodeFilter(c.id)}
                title={c.title || c.code}
              >
                {c.code} <span className="tvr-chip-count">{docsCountByCode.get(c.id) || 0}</span>
              </button>
            ))}
            {noCodeCount > 0 && (
              <button type="button" className={`tvr-chip is-warn${codeFilter === '__none__' ? ' is-active' : ''}`} onClick={() => setCodeFilter('__none__')}>
                Без шифра <span className="tvr-chip-count">{noCodeCount}</span>
              </button>
            )}
          </div>
        )}

        {data.rdDocs.length === 0 ? (
          !adding && (
            <div className="tvr-empty">
              Рабочая документация не загружена.
              {canEdit && ' Нажмите «Добавить РД», выберите PDF и укажите шифры.'}
            </div>
          )
        ) : (
          <div className="tvr-table-wrap">
            <table className="s3-doc-table tvr-table">
              <thead>
                <tr>
                  <th>Файл</th>
                  <th className="tvr-col-codes">Шифры РД</th>
                  <th className="tvr-col-who">Загрузил</th>
                  <th className="s3-doc-actions-col">Действия</th>
                </tr>
              </thead>
              <tbody>
                {visibleRdDocs.map(doc => (
                  <tr key={doc.id}>
                    <td>
                      <div className="tvr-file">
                        <span className="tvr-file-icon"><PdfIcon /></span>
                        <div className="tvr-file-text">
                          <span className="tvr-file-name" title={doc.file_name}>{doc.file_name}</span>
                          <span className="tvr-file-size">{formatBytes(doc.size_bytes)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="tvr-col-codes">
                      {editingDocId === doc.id ? (
                        <DocCodesEditor
                          doc={doc}
                          codes={data.codes}
                          byName={byName}
                          onCancel={() => setEditingDocId(null)}
                          onSaved={async () => { setEditingDocId(null); await reload({ notify: false }) }}
                        />
                      ) : (
                        <div className="tvr-codes">
                          {doc.codeIds.length === 0 ? (
                            <span className="tvr-code is-missing">шифр не указан</span>
                          ) : doc.codeIds.map(id => {
                            const c = codeById.get(id)
                            return c ? (
                              <span key={id} className="tvr-code" title={c.title || c.code}>{c.code}</span>
                            ) : null
                          })}
                          {canEditCodes && (
                            <button type="button" className="tvr-link-btn" onClick={() => setEditingDocId(doc.id)} title="Изменить шифры">
                              <TagIcon /> изменить
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="tvr-col-who">
                      <span className="tvr-who">{doc.uploaded_by_name || '—'}</span>
                      <span className="tvr-when">{formatDateTime(doc.created_at)}</span>
                    </td>
                    <td className="s3-doc-actions">
                      <button type="button" title="Просмотр" aria-label="Просмотр" onClick={() => setPreviewDoc(doc)}><EyeIcon /></button>
                      <button type="button" title="Скачать" aria-label="Скачать" onClick={() => handleDownload(doc)}><DownloadIcon /></button>
                      {canEdit && (
                        <button type="button" title="Удалить" aria-label="Удалить" className="s3-doc-btn-danger" onClick={() => handleDeleteRd(doc)}>
                          <TrashIcon />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {visibleRdDocs.length === 0 && (
                  <tr><td colSpan={4} className="tvr-empty-cell">По выбранному шифру файлов нет.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 2. Ведомость объёмов работ ── */}
      <section className="tvr-section">
        <div className="tvr-section-head">
          <div>
            <h3 className="tvr-title"><span className="tvr-step">2</span>Ведомость объёмов работ</h3>
            <p className="tvr-hint">Файлы ВОР (Excel, PDF).</p>
          </div>
        </div>
        <S3DocumentList
          ownerType="tender"
          ownerId={tenderId}
          category={VOR_STATEMENT_CATEGORY}
          title="Файлы ВОР"
          canEdit={canEdit}
          onChange={() => reload({ notify: true })}
        />
      </section>

      {/* ── 3. Загружены ранее ── */}
      {data.legacyDocs.length > 0 && (
        <section className="tvr-section tvr-section--legacy">
          <div className="tvr-section-head">
            <div>
              <h3 className="tvr-title">Загружены ранее</h3>
              <p className="tvr-hint">
                Файлы, загруженные до разделения на РД и ВОР. Их можно скачать или удалить;
                новые файлы добавляйте в разделы выше.
              </p>
            </div>
          </div>
          <S3DocumentList
            ownerType="tender"
            ownerId={tenderId}
            category={LEGACY_VOR_CATEGORY}
            title="Файлы"
            canEdit={canEdit}
            onChange={() => reload({ notify: true })}
          />
        </section>
      )}

      {previewDoc && <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}

// Выбор шифров: чек-лист из шифров тендера + добавление недостающего.
function CodePicker({ tenderId, codes, selected, onToggle, byName, onCodeAdded }) {
  const [showNew, setShowNew] = useState(codes.length === 0)
  const [newCode, setNewCode] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const add = async () => {
    if (!newCode.trim()) { alert('Укажите шифр РД'); return }
    setSaving(true)
    try {
      const created = await addRdCode(tenderId, { code: newCode, title: newTitle }, codes, byName)
      onCodeAdded(created)
      setNewCode('')
      setNewTitle('')
      setShowNew(false)
    } catch (err) {
      alert('Не удалось добавить шифр: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="tvr-picker">
      {codes.length > 0 && (
        <div className="tvr-picker-list">
          {codes.map(c => (
            <label key={c.id} className={`tvr-picker-item${selected.includes(c.id) ? ' is-checked' : ''}`}>
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => onToggle(c.id)} />
              <span className="tvr-picker-code">{c.code}</span>
              {c.title && <span className="tvr-picker-title">{c.title}</span>}
            </label>
          ))}
        </div>
      )}
      {showNew ? (
        <div className="tvr-new-code">
          <input
            type="text"
            placeholder="Шифр, например 2024-15-АР"
            value={newCode}
            autoFocus={codes.length > 0}
            onChange={(e) => setNewCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            disabled={saving}
          />
          <input
            type="text"
            placeholder="Наименование раздела (необязательно)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            disabled={saving}
          />
          <button type="button" className="tvr-btn" onClick={add} disabled={saving}>
            {saving ? 'Добавление…' : 'Добавить шифр'}
          </button>
          {codes.length > 0 && (
            <button type="button" className="tvr-btn is-ghost" onClick={() => setShowNew(false)} disabled={saving}>Отмена</button>
          )}
        </div>
      ) : (
        <button type="button" className="tvr-link-btn" onClick={() => setShowNew(true)}>+ Новый шифр</button>
      )}
      {codes.length === 0 && (
        <p className="tvr-hint">У тендера ещё нет шифров РД — добавьте первый. Он появится и во вкладке «Шифр РД».</p>
      )}
    </div>
  )
}

function RdUploadForm({ tenderId, codes, byName, onCancel, onDone, onCodesChanged }) {
  const [files, setFiles] = useState([])
  const [selected, setSelected] = useState([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const fileRef = useRef(null)

  const pickFiles = (e) => {
    const list = Array.from(e.target.files || [])
    const bad = list.filter(f => !isPdfFile(f))
    if (bad.length) alert(`Рабочая документация принимается только в PDF. Пропущены: ${bad.map(f => f.name).join(', ')}`)
    const pdfs = list.filter(isPdfFile)
    if (pdfs.length) setFiles(prev => [...prev, ...pdfs.filter(f => !prev.some(p => p.name === f.name && p.size === f.size))])
    if (fileRef.current) fileRef.current.value = ''
  }

  const toggle = (id) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  const submit = async () => {
    if (files.length === 0) { alert('Выберите PDF-файлы рабочей документации'); return }
    if (selected.length === 0) { alert('Укажите хотя бы один шифр РД'); return }
    setBusy(true)
    try {
      await uploadRdDocuments(tenderId, files, selected, byName, (i, n) => setProgress(`${i} из ${n}`))
      await onDone()
    } catch (err) {
      alert((isMissingTableError(err, 'tender_rd_document_codes')
        ? 'Не применена миграция 20260918_tender_rd_documents — файл не сохранён. '
        : 'Ошибка загрузки: ') + (err.message || err))
      // Часть файлов могла загрузиться до ошибки — обновляем список.
      await onCodesChanged()
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const ready = files.length > 0 && selected.length > 0

  return (
    <div className="tvr-form">
      <div className="tvr-form-step">
        <div className="tvr-form-label">PDF-файлы <span className="tvr-req">*</span></div>
        <input ref={fileRef} type="file" accept=".pdf,application/pdf" multiple hidden onChange={pickFiles} />
        <button type="button" className="tvr-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          Выбрать PDF
        </button>
        {files.length > 0 && (
          <ul className="tvr-file-list">
            {files.map((f, i) => (
              <li key={`${f.name}-${f.size}`}>
                <span className="tvr-file-name">{f.name}</span>
                <span className="tvr-file-size">{formatBytes(f.size)}</span>
                {!busy && (
                  <button type="button" className="tvr-x" aria-label="Убрать файл"
                    onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}>×</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="tvr-form-step">
        <div className="tvr-form-label">
          Шифры РД <span className="tvr-req">*</span>{' '}
          <span className="tvr-form-sub">— отмеченные шифры будут привязаны к каждому выбранному файлу</span>
        </div>
        <CodePicker
          tenderId={tenderId}
          codes={codes}
          selected={selected}
          onToggle={toggle}
          byName={byName}
          onCodeAdded={async (c) => {
            setSelected(prev => (prev.includes(c.id) ? prev : [...prev, c.id]))
            await onCodesChanged()
          }}
        />
      </div>

      <div className="tvr-form-actions">
        <button type="button" className="s3-doc-btn-primary" onClick={submit} disabled={busy || !ready}>
          {busy ? `Загрузка${progress ? ` ${progress}` : '…'}` : 'Загрузить'}
        </button>
        <button type="button" className="tvr-btn is-ghost" onClick={onCancel} disabled={busy}>Отмена</button>
        {!ready && !busy && (
          <span className="tvr-form-note">
            {files.length === 0 ? 'Выберите PDF' : 'Отметьте хотя бы один шифр'}
          </span>
        )}
      </div>
    </div>
  )
}

function DocCodesEditor({ doc, codes, byName, onCancel, onSaved }) {
  const [selected, setSelected] = useState(doc.codeIds)
  const [saving, setSaving] = useState(false)
  const toggle = (id) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  const save = async () => {
    setSaving(true)
    try {
      await setDocumentCodes(doc.id, selected, doc.codeIds, byName)
      await onSaved()
    } catch (err) {
      alert('Не удалось сохранить шифры: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="tvr-codes-editor">
      <div className="tvr-picker-list">
        {codes.map(c => (
          <label key={c.id} className={`tvr-picker-item${selected.includes(c.id) ? ' is-checked' : ''}`}>
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} disabled={saving} />
            <span className="tvr-picker-code">{c.code}</span>
          </label>
        ))}
      </div>
      <div className="tvr-form-actions">
        <button type="button" className="tvr-btn" onClick={save} disabled={saving || selected.length === 0}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button type="button" className="tvr-btn is-ghost" onClick={onCancel} disabled={saving}>Отмена</button>
      </div>
    </div>
  )
}
