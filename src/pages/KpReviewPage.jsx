import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { fetchProposalFilesForReview } from '../services/tenderProposalFiles'
import KpReviewBadge from '../components/KpReviewBadge'
import KpReviewModal from '../components/KpReviewModal'
import S3DocumentPreview from '../components/S3DocumentPreview'
import './KpReviewPage.css'

// task 431: вкладка «Проверка КП» — очередь коммерческих предложений на проверку
// аналитиком-экономистом. Показывает все загруженные КП с их статусом проверки;
// экономист/админ проставляет «проверено» или «есть замечания».

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

const TABS = [
  { key: 'pending', label: 'На проверке', statuses: ['pending'] },
  { key: 'has_remarks', label: 'Замечания', statuses: ['has_remarks'] },
  { key: 'approved', label: 'Проверено', statuses: ['approved'] },
  { key: 'all', label: 'Все', statuses: null },
]

function KpReviewPage() {
  const { isAdmin, role, scopedObjectIds } = useRole()
  const canReview = isAdmin || role === 'economist'

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('pending')
  const [search, setSearch] = useState('')
  const [reviewFile, setReviewFile] = useState(null)
  const [previewDoc, setPreviewDoc] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchProposalFilesForReview({
        objectIds: scopedObjectIds.length ? scopedObjectIds : null,
      })
      setRows(data)
    } catch (e) {
      setError(e.message || 'Не удалось загрузить КП на проверку')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => {
    const c = { pending: 0, has_remarks: 0, approved: 0, all: rows.length }
    for (const r of rows) c[r.review_status] = (c[r.review_status] || 0) + 1
    return c
  }, [rows])

  const visibleRows = useMemo(() => {
    const active = TABS.find(t => t.key === tab)
    const s = search.trim().toLowerCase()
    return rows.filter(r => {
      if (active?.statuses && !active.statuses.includes(r.review_status)) return false
      if (!s) return true
      const hay = [
        r.counterparties?.name,
        r.tenders?.work_description,
        r.tenders?.objects?.name,
        r.s3?.file_name,
        r.tenders?.responsible_contact?.full_name,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(s)
    })
  }, [rows, tab, search])

  return (
    <div className="kprv-page">
      <div className="kprv-header">
        <h2>Проверка КП</h2>
        <p className="kprv-hint">
          Коммерческие предложения контрагентов на проверку аналитиком-экономистом.
          Сюда попадают только КП, загруженные с момента запуска функции; ранее загруженные
          остаются в тендерах.
          {!canReview && ' Просмотр — только чтение; проставлять проверку могут экономист ОСП и администратор.'}
        </p>
      </div>

      <div className="kprv-toolbar">
        <div className="kprv-tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`kprv-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="kprv-tab-count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          className="kprv-search"
          type="search"
          placeholder="Поиск: контрагент, тендер, объект, файл…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="kprv-empty">Загрузка…</div>
      ) : error ? (
        <div className="kprv-error">Ошибка: {error}</div>
      ) : visibleRows.length === 0 ? (
        <div className="kprv-empty">
          {tab === 'pending' ? 'Нет КП, ожидающих проверки.' : 'Нет записей.'}
        </div>
      ) : (
        <div className="kprv-table-wrap">
          <table className="kprv-table">
            <thead>
              <tr>
                <th>Объект</th>
                <th>Тендер</th>
                <th>Контрагент</th>
                <th>КП</th>
                <th>Загружен</th>
                <th>Ответственный</th>
                <th>Статус проверки</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={r.id}>
                  <td>{r.tenders?.objects?.name || '—'}</td>
                  <td>
                    {r.tenders?.id ? (
                      <Link to={`/tenders/${r.tenders.id}`} className="kprv-link">
                        {r.tenders?.work_description || 'Тендер'}
                      </Link>
                    ) : (r.tenders?.work_description || '—')}
                  </td>
                  <td>{r.counterparties?.name || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="kprv-file-btn"
                      title={r.s3?.file_name || 'Открыть КП'}
                      onClick={() => r.s3 && setPreviewDoc(r.s3)}
                      disabled={!r.s3}
                    >
                      📄 {r.s3?.file_name || '—'}
                    </button>
                    {r.version_label && <span className="kprv-vlabel">{r.version_label}</span>}
                  </td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td>{r.tenders?.responsible_contact?.full_name || '—'}</td>
                  <td>
                    <KpReviewBadge file={r} canReview={canReview} onReview={setReviewFile} showRemarks />
                  </td>
                  <td>
                    {canReview && (
                      <button
                        type="button"
                        className="kprv-review-btn"
                        onClick={() => setReviewFile(r)}
                      >{r.review_status === 'pending' ? 'Проверить' : 'Изменить'}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewFile && (
        <KpReviewModal
          file={reviewFile}
          onClose={() => setReviewFile(null)}
          onSaved={load}
        />
      )}
      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  )
}

export default KpReviewPage
