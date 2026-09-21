import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import DocCheckBoard from '../components/doccheck/DocCheckBoard'
import DocCheckFormModal from '../components/doccheck/DocCheckFormModal'
import DocCheckDetailModal from '../components/doccheck/DocCheckDetailModal'
import FilterDropdown from '../components/FilterDropdown'
import IconTile from '../components/IconTile'
import { IconObject, IconUser } from '../components/icons/ToolbarIcons'
import { IconDocCheck } from '../components/icons/NavIcons'
import { fetchAllRows, fetchAllActiveCounterparties } from '../utils/fetchAllRows'
import {
  DOC_CHECK_STATUS_CLASS,
  DOC_CHECK_STATUS_LABEL,
  DOC_TYPES,
  DOC_TYPE_LABEL,
  docTitle,
  fmtDocDate,
} from '../utils/docCheckHelpers'
import '../components/MobileCards.css'
import './DocCheckRequestsPage.css'

// Раздел «Заявки на проверку ДП/ДС».
//
// Раньше проверка договоров и допсоглашений шла письмами: заявку слали почтой,
// статус узнавали перепиской. Здесь заявка — карточка, которая идёт по колонкам
// от «Новой заявки» до «Ожидаем скан ДП/ДС».
//
// Заявка НЕ привязана к записи реестра «Договоры и ДС»: проверка идёт до того,
// как договор туда заводят, поэтому объект, контрагент, тип, № и дата вводятся
// руками.

const SELECT = `
  id, object_id, counterparty_id, doc_type, doc_number, doc_date, status, notes,
  sort_order, deleted_at, created_at, updated_at, created_by_name,
  objects(id, name, status),
  counterparties(id, name)
`

export default function DocCheckRequestsPage() {
  const { canEdit, role, userProfile } = useRole()
  const canEditSection = canEdit('doc_check_requests')

  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [view, setView] = useState(() => localStorage.getItem('docCheckView') || 'board')
  const [showDeleted, setShowDeleted] = useState(false)
  const [search, setSearch] = useState('')
  const [filterObjectIds, setFilterObjectIds] = useState([])
  const [filterCounterpartyIds, setFilterCounterpartyIds] = useState([])
  const [filterTypes, setFilterTypes] = useState([])

  const [formFor, setFormFor] = useState(null)   // { request } | { request: null } | null
  const [detailId, setDetailId] = useState(null)

  useEffect(() => { localStorage.setItem('docCheckView', view) }, [view])

  const author = userProfile?.full_name || 'Пользователь'

  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true)
      const rows = await fetchAllRows((from, to) => supabase
        .from('doc_check_requests')
        .select(SELECT)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
        .range(from, to))
      setRequests(rows)
      setError(null)
    } catch (err) {
      console.error('Ошибка загрузки заявок на проверку ДП/ДС:', err.message)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRequests()
    // Объекты обоих отделов и контрагенты — для формы и фильтров.
    supabase.from('objects').select('id, name, status')
      .order('status', { ascending: true }).order('name', { ascending: true })
      .then(({ data, error: e }) => { if (!e) setObjects(data || []) })
    fetchAllActiveCounterparties()
      .then(setCounterparties)
      .catch(err => console.warn('Не удалось загрузить контрагентов:', err.message))
  }, [fetchRequests])

  // ── История ───────────────────────────────────────────────────────────────
  const logEvent = useCallback(async (requestId, entry) => {
    try {
      await supabase.from('doc_check_request_audit_log').insert({
        request_id: requestId,
        changed_by_role: role,
        changed_by_name: author,
        ...entry,
      })
    } catch (err) {
      // История не должна ронять основное действие.
      console.warn('Не удалось записать историю заявки:', err.message)
    }
  }, [role, author])

  // ── Действия ──────────────────────────────────────────────────────────────
  const handleSave = async (payload) => {
    try {
      if (formFor?.request) {
        const prev = formFor.request
        const { error: e } = await supabase
          .from('doc_check_requests')
          .update(payload)
          .eq('id', prev.id)
        if (e) throw e
        // Пишем в историю только реально изменившиеся поля.
        for (const [field, value] of Object.entries(payload)) {
          if ((prev[field] ?? null) === (value ?? null)) continue
          await logEvent(prev.id, {
            event_type: 'field_updated',
            field_name: field,
            old_value: prev[field] ?? null,
            new_value: value ?? null,
          })
        }
      } else {
        // Новая заявка всегда попадает в первую колонку и в её конец.
        const maxOrder = requests
          .filter(r => r.status === 'new' && !r.deleted_at)
          .reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
        const { data, error: e } = await supabase
          .from('doc_check_requests')
          .insert({ ...payload, status: 'new', sort_order: maxOrder + 1, created_by_name: author })
          .select('id')
          .single()
        if (e) throw e
        await logEvent(data.id, { event_type: 'created', description: 'Заявка создана' })
      }
      setFormFor(null)
      await fetchRequests()
    } catch (err) {
      alert('Не удалось сохранить заявку: ' + (err.message || err))
    }
  }

  const handleStatusChange = async (request, status) => {
    if (request.status === status) return
    try {
      const { error: e } = await supabase
        .from('doc_check_requests')
        .update({ status })
        .eq('id', request.id)
      if (e) throw e
      await logEvent(request.id, {
        event_type: 'status_changed',
        field_name: 'status',
        old_value: request.status,
        new_value: status,
      })
      await fetchRequests()
    } catch (err) {
      alert('Не удалось изменить статус: ' + (err.message || err))
    }
  }

  // Перетаскивание на доске: смена колонки + перенумерация порядка внутри неё.
  const handleMove = async (request, status, orderedIds) => {
    const statusChanged = request.status !== status
    // Оптимистично двигаем карточку: ждать круга к серверу на каждый бросок —
    // заметно и раздражает.
    setRequests(prev => prev.map(r => {
      if (r.id === request.id) return { ...r, status, sort_order: orderedIds.indexOf(r.id) + 1 }
      const idx = orderedIds.indexOf(r.id)
      return idx >= 0 ? { ...r, sort_order: idx + 1 } : r
    }))
    try {
      if (statusChanged) {
        const { error: e } = await supabase
          .from('doc_check_requests').update({ status }).eq('id', request.id)
        if (e) throw e
        await logEvent(request.id, {
          event_type: 'status_changed',
          field_name: 'status',
          old_value: request.status,
          new_value: status,
        })
      }
      await Promise.all(orderedIds.map((id, i) => supabase
        .from('doc_check_requests').update({ sort_order: i + 1 }).eq('id', id)))
    } catch (err) {
      alert('Не удалось переместить заявку: ' + (err.message || err))
      await fetchRequests()
    }
  }

  const handleDelete = async (request) => {
    if (!confirm(`Удалить заявку «${docTitle(request)}»?`)) return
    try {
      const { error: e } = await supabase
        .from('doc_check_requests')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', request.id)
      if (e) throw e
      await logEvent(request.id, { event_type: 'soft_deleted', description: 'Заявка удалена' })
      setDetailId(null)
      await fetchRequests()
    } catch (err) {
      alert('Не удалось удалить заявку: ' + (err.message || err))
    }
  }

  const handleRestore = async (request) => {
    try {
      const { error: e } = await supabase
        .from('doc_check_requests').update({ deleted_at: null }).eq('id', request.id)
      if (e) throw e
      await logEvent(request.id, { event_type: 'restored', description: 'Заявка восстановлена' })
      await fetchRequests()
    } catch (err) {
      alert('Не удалось восстановить заявку: ' + (err.message || err))
    }
  }

  // ── Фильтрация ────────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return requests.filter(r => {
      if (showDeleted ? !r.deleted_at : !!r.deleted_at) return false
      if (filterObjectIds.length && !filterObjectIds.includes(r.object_id)) return false
      if (filterCounterpartyIds.length && !filterCounterpartyIds.includes(r.counterparty_id)) return false
      if (filterTypes.length && !filterTypes.includes(r.doc_type)) return false
      if (!q) return true
      return [
        r.doc_number, r.notes, r.objects?.name, r.counterparties?.name,
        DOC_TYPE_LABEL[r.doc_type],
      ].some(v => (v || '').toLowerCase().includes(q))
    })
  }, [requests, showDeleted, filterObjectIds, filterCounterpartyIds, filterTypes, search])

  const detail = detailId ? requests.find(r => r.id === detailId) : null
  const hasFilters = filterObjectIds.length > 0 || filterCounterpartyIds.length > 0
    || filterTypes.length > 0 || search.trim() !== ''
  const deletedCount = requests.filter(r => r.deleted_at).length

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div className="doc-check-page">
      <div className="page-header">
        <h2>
          {/* Тон тот же, что у пункта меню, — раздел узнаётся по цвету. */}
          <IconTile tone="violet" className="page-icon-tile"><IconDocCheck /></IconTile>
          Заявки на проверку ДП/ДС
        </h2>
        <div className="dc-header-actions">
          <div className="dc-view-switch" role="tablist" aria-label="Вид">
            {[{ key: 'board', label: 'Доска' }, { key: 'list', label: 'Реестр' }].map(v => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                className={`dc-view-btn${view === v.key ? ' is-active' : ''}`}
                onClick={() => setView(v.key)}
              >{v.label}</button>
            ))}
          </div>
          {canEditSection && (
            <button className="btn-primary" onClick={() => setFormFor({ request: null })}>
              + Новая заявка
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dc-error">
          Не удалось загрузить заявки: {error}. Возможно, не применена миграция
          <code> 20260905_doc_check_requests.sql</code>.
        </div>
      )}

      <div className="dc-toolbar">
        <input
          type="search"
          className="dc-search"
          placeholder="Поиск: номер, контрагент, объект, примечание…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Поиск объекта…" allLabel="Все объекты"
          icon={<IconObject size={15} />}
          value={filterObjectIds} onChange={setFilterObjectIds}
          options={objects.map(o => ({ value: o.id, label: o.name }))}
        />
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Поиск контрагента…" allLabel="Все контрагенты"
          icon={<IconUser size={15} />}
          value={filterCounterpartyIds} onChange={setFilterCounterpartyIds}
          options={counterparties.map(c => ({ value: c.id, label: c.name }))}
        />
        <FilterDropdown
          label="" multiple allLabel="ДП и ДС"
          value={filterTypes} onChange={setFilterTypes}
          options={DOC_TYPES.map(t => ({ value: t.value, label: `${t.label} — ${t.title}` }))}
        />
        {hasFilters && (
          <button
            type="button"
            className="dc-reset"
            onClick={() => { setSearch(''); setFilterObjectIds([]); setFilterCounterpartyIds([]); setFilterTypes([]) }}
          >Сбросить</button>
        )}
        <button
          type="button"
          className={`dc-deleted-toggle${showDeleted ? ' is-active' : ''}`}
          onClick={() => setShowDeleted(v => !v)}
        >Удалённые{deletedCount > 0 ? ` (${deletedCount})` : ''}</button>
      </div>

      {visible.length === 0 ? (
        <div className="dc-empty">
          {showDeleted ? 'Удалённых заявок нет'
            : hasFilters ? 'Ничего не найдено — попробуйте изменить фильтры'
              : 'Заявок пока нет. Создайте первую — она попадёт в колонку «Новая заявка».'}
        </div>
      ) : view === 'board' && !showDeleted ? (
        <DocCheckBoard
          requests={visible}
          onOpen={setDetailId}
          onMove={handleMove}
          canEdit={canEditSection}
        />
      ) : (
        <div className="dc-table-wrap">
          <table className="dc-table">
            <thead>
              <tr>
                <th>Документ</th>
                <th>Контрагент</th>
                <th>Объект</th>
                <th>Дата</th>
                <th>Статус</th>
                <th>Создал</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id} onClick={() => setDetailId(r.id)} className="dc-row">
                  <td>
                    <span className={`dc-type dc-type--${r.doc_type}`}>{DOC_TYPE_LABEL[r.doc_type]}</span>
                    {r.doc_number ? ` № ${r.doc_number}` : ''}
                  </td>
                  <td>{r.counterparties?.name || '—'}</td>
                  <td>{r.objects?.name || '—'}</td>
                  <td>{fmtDocDate(r.doc_date) || '—'}</td>
                  <td>
                    <span className={`dc-status-chip ${DOC_CHECK_STATUS_CLASS[r.status] || ''}`}>
                      {DOC_CHECK_STATUS_LABEL[r.status] || r.status}
                    </span>
                  </td>
                  <td>{r.created_by_name || '—'}</td>
                  <td className="dc-row-action">
                    {showDeleted && canEditSection && (
                      <button
                        type="button"
                        className="dc-restore"
                        onClick={(e) => { e.stopPropagation(); handleRestore(r) }}
                      >Восстановить</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formFor && (
        <DocCheckFormModal
          request={formFor.request}
          objects={objects}
          counterparties={counterparties}
          onSave={handleSave}
          onClose={() => setFormFor(null)}
        />
      )}

      {detail && (
        <DocCheckDetailModal
          request={detail}
          canEdit={canEditSection}
          onStatusChange={handleStatusChange}
          onEdit={(r) => { setDetailId(null); setFormFor({ request: r }) }}
          onDelete={handleDelete}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
