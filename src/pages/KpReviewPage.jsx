import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { fetchProposalFilesForReview, setRemarksSent } from '../services/tenderProposalFiles'
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

// Небольшая SVG-иконка документа (проект использует SVG-иконки, не эмодзи).
const IconFile = () => (
  <svg className="kprv-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)

// Этап (стадия) КП в цепочке проверки:
//   pending         — на проверке (ждёт аналитика);
//   approved        — «нет замечаний» (цепочка 1 завершена);
//   remarks_pending — есть замечания, инженер ещё не отправил их контрагенту;
//   remarks_sent    — замечания отправлены контрагенту (цепочка 2 завершена).
function stageOf(r) {
  if (r.review_status === 'approved') return 'approved'
  if (r.review_status === 'has_remarks') return r.remarks_sent ? 'remarks_sent' : 'remarks_pending'
  return 'pending'
}

const TABS = [
  { key: 'pending', label: 'На проверке' },
  { key: 'approved', label: 'Нет замечаний' },
  { key: 'remarks_pending', label: 'Замечания: к отправке' },
  { key: 'remarks_sent', label: 'Отправлено контрагенту' },
  { key: 'all', label: 'Все' },
]

function KpReviewPage() {
  const { isAdmin, role, scopedObjectIds, userProfile, user } = useRole()
  // Аналитик-экономист (или админ) проставляет вердикт/замечания.
  const canReview = isAdmin || role === 'economist'
  // Инженер (или админ) отмечает отправку замечаний контрагенту.
  const canSend = isAdmin || role === 'engineer'

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

  const handleSend = async (r, sent) => {
    try {
      await setRemarksSent(r.id, { sent, sender: userProfile?.full_name || user?.email || '' })
      load()
    } catch (e) {
      alert('Ошибка отметки отправки: ' + (e.message || e))
    }
  }

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, remarks_pending: 0, remarks_sent: 0, all: rows.length }
    for (const r of rows) { const st = stageOf(r); c[st] = (c[st] || 0) + 1 }
    return c
  }, [rows])

  const visibleRows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return rows.filter(r => {
      if (tab !== 'all' && stageOf(r) !== tab) return false
      if (!s) return true
      const hay = [
        r.counterparties?.name,
        r.tenders?.work_description,
        r.tenders?.objects?.name,
        r.s3?.file_name,
        r.tenders?.responsible_contact?.full_name,
        r.reviewed_by,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(s)
    })
  }, [rows, tab, search])

  return (
    <div className="kprv-page">
      <div className="kprv-header">
        <h2>Проверка КП</h2>
        <p className="kprv-hint">
          Коммерческие предложения контрагентов на проверку. Сюда попадают только КП,
          загруженные с момента запуска функции; ранее загруженные остаются в тендерах.
        </p>

        {/* Схема прохождения КП по двум цепочкам — чтобы всем было понятно, что к чему */}
        <div className="kprv-flow" aria-hidden>
          <span className="kprv-flow-start">На&nbsp;проверке</span>
          <span className="kprv-flow-split">
            <span className="kprv-flow-row">
              <span className="kprv-flow-arrow">→</span>
              <span className="kprv-flow-step is-ok">Нет замечаний</span>
            </span>
            <span className="kprv-flow-row">
              <span className="kprv-flow-arrow">→</span>
              <span className="kprv-flow-step is-warn">Есть замечания<small>аналитик</small></span>
              <span className="kprv-flow-arrow">→</span>
              <span className="kprv-flow-step is-sent">Отправлено контрагенту<small>инженер</small></span>
            </span>
          </span>
        </div>
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
          {tab === 'pending' ? 'Нет КП, ожидающих проверки.'
            : tab === 'remarks_pending' ? 'Нет замечаний, ожидающих отправки контрагенту.'
              : tab === 'remarks_sent' ? 'Нет отправленных контрагенту замечаний.'
                : tab === 'approved' ? 'Нет КП без замечаний.'
                  : 'Нет записей.'}
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
                <th>Кто проверил</th>
                <th className="kprv-col-action"></th>
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
                      <IconFile />
                      <span className="kprv-file-name">{r.s3?.file_name || '—'}</span>
                    </button>
                    {r.version_label && <span className="kprv-vlabel">{r.version_label}</span>}
                  </td>
                  <td className="kprv-col-date">{fmtDate(r.created_at)}</td>
                  <td>{r.tenders?.responsible_contact?.full_name || '—'}</td>
                  <td>
                    <KpReviewBadge file={r} canReview={canReview} onReview={setReviewFile} showRemarks />
                  </td>
                  <td className="kprv-col-reviewer">
                    {r.reviewed_by ? (
                      <>
                        <span className="kprv-reviewer-name">{r.reviewed_by}</span>
                        {r.reviewed_at && <span className="kprv-reviewer-date">{fmtDate(r.reviewed_at)}</span>}
                      </>
                    ) : <span className="kprv-muted">—</span>}
                  </td>
                  <td className="kprv-col-action">
                    <div className="kprv-actions">
                      {canReview && (
                        <button
                          type="button"
                          className="kprv-review-btn"
                          onClick={() => setReviewFile(r)}
                        >{r.review_status === 'pending' ? 'Проверить' : 'Изменить'}</button>
                      )}
                      {canSend && r.review_status === 'has_remarks' && (
                        r.remarks_sent ? (
                          <button
                            type="button"
                            className="kprv-send-btn is-undo"
                            onClick={() => handleSend(r, false)}
                          >Отменить отправку</button>
                        ) : (
                          <button
                            type="button"
                            className="kprv-send-btn"
                            onClick={() => handleSend(r, true)}
                          >Отправлено контрагенту</button>
                        )
                      )}
                    </div>
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
