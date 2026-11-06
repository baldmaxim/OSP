import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import ClampText from '../components/ClampText'
import FilterDropdown from '../components/FilterDropdown'
import IconTile from '../components/IconTile'
import PersonName from '../components/PersonName'
import S3DocumentPreview from '../components/S3DocumentPreview'
import DpFileList from '../components/dpRequests/DpFileList'
import DpRecipientsModal from '../components/dpRequests/DpRecipientsModal'
import DpRequestFormModal from '../components/dpRequests/DpRequestFormModal'
import { IconDpRequest, IconNotifications } from '../components/icons/NavIcons'
import { IconObject, IconSearch } from '../components/icons/ToolbarIcons'
import { IconPencil, IconRestore, IconTrash } from '../components/icons/ActionIcons'
import useBodyClass from '../hooks/useBodyClass'
import { useIsPhone } from '../hooks/useMediaQuery'
import { formatAmount } from '../utils/money'
import {
  DP_ALERTS_EVENT, DP_CONCEPT_CATEGORY, DP_CREATED_EVENT, DP_DOCS_CATEGORY, DP_MIGRATION_HINT, DP_REQUEST_PARAM, DP_ROLE_LABEL,
  DP_STATUS_LABEL, DP_STATUS_OPTIONS, DP_TABS, canChangeDpRequest, countDpTabs, dpErrorText, filterDpRequests, isDpMigrationMissing,
} from '../utils/dpRequests'
import {
  loadDpDocs, loadDpObjects, loadDpRequests, loadDpStaff, restoreDpRequest, setDpStatus, softDeleteDpRequest,
} from '../services/dpRequests'
import '../components/ContractRegistry.css'
import '../components/MobileCards.css'
import './DpRequestsPage.css'
// Общий рабочий стиль разделов (docs/UI_GUIDELINES.md) — после стилей страницы.
import '../styles/fonts.css'
import '../styles/workUi.css'

// «Заявка на заключение ДП» (миграции 20261227, 20261231; решения пользователя 05.11.2026). По аналогии с «Заявкой на ДС», только договоры.
// Подают экономист объекта и руководитель строительства (право dp_requests_create): понятийное соглашение (обязательно), документы и примечание;
// привязанный к объектам в «Ролях» — и свой объект (один — стоит сам, несколько — выбирает).
// Объект, договор, сумму и ответственного заполняют те, кто работает с заявками (правка раздела dp_requests).
// О новой заявке всплывает большое окно (components/dpRequests/DpRequestAlert.jsx — на всех страницах).

const formatDay = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU') : '')

function DpStatus({ req, canWork, onChange }) {
  const option = DP_STATUS_OPTIONS.find((o) => o.value === req.status)
  const stamp = req.status_changed_by_name ? `Сменил(а): ${req.status_changed_by_name}, ${formatDay(req.status_changed_at)}` : undefined
  if (req.deleted_at) {
    return <span className="status-badge status-deleted" title={req.deleted_by_name ? `Удалил(а): ${req.deleted_by_name}, ${formatDay(req.deleted_at)}` : undefined}>Удалена</span>
  }
  if (!canWork) return <span className={`status-badge ${option?.className || ''}`} title={stamp}>{DP_STATUS_LABEL[req.status] || req.status}</span>
  return (
    <select
      className={`dpr-status-select ${option?.className || ''}`}
      value={req.status}
      title={stamp}
      aria-label={`Статус заявки № ${req.request_number}`}
      onChange={(e) => onChange(req, e.target.value)}
    >
      {DP_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export default function DpRequestsPage() {
  const { user, userProfile, role, roleLabels, canEdit, scopedObjectIds } = useRole()
  useBodyClass('ui-work-portal')
  const isPhone = useIsPhone()
  const userId = user?.id || null
  const canWork = canEdit('dp_requests')
  const canCreate = canEdit('dp_requests_create')
  const canManageRecipients = canEdit('admin')
  const me = useMemo(() => ({ role, name: userProfile?.full_name || '' }), [role, userProfile?.full_name])

  const [requests, setRequests] = useState(null)
  const [docs, setDocs] = useState([])
  const [objects, setObjects] = useState([])
  const [ownObjects, setOwnObjects] = useState(null)
  const [ownObjectsFailed, setOwnObjectsFailed] = useState(false)
  const [staff, setStaff] = useState([])
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [objectIds, setObjectIds] = useState([])
  const [formFor, setFormFor] = useState(null) // { request: строка | null }
  const [previewDoc, setPreviewDoc] = useState(null)
  const [showRecipients, setShowRecipients] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const openedId = searchParams.get(DP_REQUEST_PARAM)
  const [highlightId, setHighlightId] = useState(null)
  const rowsRef = useRef(new Map())
  const openRetried = useRef(null)

  // Чтение, начатое до записи, не должно затереть её результат.
  const readEpoch = useRef(0)
  const reload = useCallback(async () => {
    const epoch = ++readEpoch.current
    try {
      const [rows, files] = await Promise.all([loadDpRequests(), loadDpDocs()])
      if (epoch !== readEpoch.current) return
      setRequests(rows)
      setDocs(files)
      setError('')
    } catch (err) {
      if (epoch !== readEpoch.current) return
      if (isDpMigrationMissing(err)) setMissing(true)
      else setError(`Заявки не загрузились: ${dpErrorText(err)}`)
      setRequests((prev) => prev || [])
    }
  }, [])

  const scopeKey = (scopedObjectIds || []).join(',')
  // Подающий, привязанный к объектам в «Ролях» (рукстрой, экономист объекта), указывает свой объект сам (06.11.2026, решение
  // пользователя): форме нужны названия его объектов. Работающий с заявками выбирает объект в своём блоке формы.
  const pickOwnObject = !canWork && canCreate && scopeKey !== ''
  useEffect(() => {
    reload()
    let alive = true
    if (pickOwnObject) {
      setOwnObjects(null)
      setOwnObjectsFailed(false)
      loadDpObjects(scopedObjectIds).then((rows) => { if (alive) setOwnObjects(rows) }).catch((err) => {
        if (!alive) return
        setOwnObjectsFailed(true)
        setError(`Ваши объекты не загрузились: ${dpErrorText(err)}`)
      })
    }
    // Все объекты и сотрудники — только форме того, кто заполняет заявку.
    if (canWork) {
      loadDpObjects(scopedObjectIds).then(setObjects).catch((err) => setError(`Объекты не загрузились: ${dpErrorText(err)}`))
      loadDpStaff().then(setStaff).catch((err) => setError(`Сотрудники объектов не загрузились: ${dpErrorText(err)}`))
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, reload, canWork, pickOwnObject])

  // Заявки коллег — при возврате на вкладку; у получателя — сразу, как только пришло окно.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(DP_ALERTS_EVENT, reload)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(DP_ALERTS_EVENT, reload)
    }
  }, [reload])

  // Заявка из окна уведомления: показать строку и подсветить, что бы ни было выбрано в фильтрах.
  useEffect(() => {
    if (!openedId || !requests) return
    const target = requests.find((r) => r.id === openedId)
    if (!target && openRetried.current !== openedId) {
      // Реестр прочитан раньше, чем подали заявку: перечитываем один раз, ответ снова приведёт сюда.
      openRetried.current = openedId
      reload()
      return
    }
    if (target) {
      setTab(target.deleted_at ? 'deleted' : 'all')
      setQuery('')
      setObjectIds([])
      setHighlightId(openedId)
    } else {
      setError('Заявка из уведомления не найдена в реестре: возможно, её удалили или она не на ваших объектах.')
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete(DP_REQUEST_PARAM)
      return next
    }, { replace: true })
  }, [openedId, requests, setSearchParams, reload])

  useEffect(() => {
    if (!highlightId) return undefined
    rowsRef.current.get(highlightId)?.scrollIntoView?.({ block: 'center' })
    const t = setTimeout(() => setHighlightId(null), 4000)
    return () => clearTimeout(t)
  }, [highlightId])

  const docsByRequest = useMemo(() => {
    const map = new Map()
    for (const d of docs) {
      if (!map.has(d.owner_id)) map.set(d.owner_id, [])
      map.get(d.owner_id).push(d)
    }
    return map
  }, [docs])

  const filtered = useMemo(() => filterDpRequests(requests, { tab, query, objectIds }), [requests, tab, query, objectIds])
  const counts = useMemo(() => countDpTabs(requests, { query, objectIds }), [requests, query, objectIds])
  const filterObjects = useMemo(() => {
    const seen = new Map()
    for (const r of requests || []) if (r.object_id && !seen.has(r.object_id)) seen.set(r.object_id, r.objects?.name || 'Объект')
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  }, [requests])

  const act = async (action) => {
    setError('')
    try {
      await action()
    } catch (err) {
      setError(dpErrorText(err))
    }
    await reload()
  }

  const changeStatus = (req, status) => act(() => setDpStatus(req.id, status))
  const remove = (req) => {
    if (!window.confirm(`Перенести заявку № ${req.request_number} в «Удалённые»?`)) return
    act(() => softDeleteDpRequest(req.id))
  }
  const restore = (req) => act(() => restoreDpRequest(req.id))

  const onSaved = async (created) => {
    setFormFor(null)
    await reload()
    if (created?.id) {
      setTab('all')
      setHighlightId(created.id)
      window.dispatchEvent(new CustomEvent(DP_CREATED_EVENT))
    }
  }

  const fileProps = (req, category) => {
    const all = docsByRequest.get(req.id) || []
    return {
      requestId: req.id,
      category,
      docs: all.filter((d) => d.doc_category === category),
      canChange: !req.deleted_at && canChangeDpRequest(req, { canWork, canCreate, userId }),
      onChanged: reload,
      onPreview: setPreviewDoc,
      onError: setError,
    }
  }

  const actions = (req) => {
    const editable = canChangeDpRequest(req, { canWork, canCreate, userId })
    if (!editable) return null
    if (req.deleted_at) {
      return (
        <button type="button" className="btn-icon" aria-label={`Восстановить заявку № ${req.request_number}`} title="Восстановить" onClick={() => restore(req)}>
          <IconRestore size={15} />
        </button>
      )
    }
    return (
      <>
        <button type="button" className="btn-icon" aria-label={`Изменить заявку № ${req.request_number}`} title="Изменить" onClick={() => setFormFor({ request: req })}>
          <IconPencil size={15} />
        </button>
        <button type="button" className="btn-icon btn-delete" aria-label={`Удалить заявку № ${req.request_number}`} title="В «Удалённые»" onClick={() => remove(req)}>
          <IconTrash size={15} />
        </button>
      </>
    )
  }

  // Поле ещё не заполнено: работающему с заявками — напоминание, остальным — прочерк.
  const unfilled = <span className="dpr-empty">{canWork ? 'не заполнено' : '—'}</span>

  const responsible = (req) => (
    <>
      {req.responsible_name ? <PersonName full={req.responsible_name} /> : unfilled}
      {DP_ROLE_LABEL[req.responsible_role] && <small className="dpr-sub">{DP_ROLE_LABEL[req.responsible_role]}</small>}
    </>
  )

  const created = (req) => (
    <small className="dpr-sub">{formatDay(req.created_at)}{req.created_by_name ? ` · ${req.created_by_name}` : ''}</small>
  )

  const emptyText = query || objectIds.length ? 'Ничего не найдено.' : (tab === 'deleted' ? 'Нет удалённых заявок.' : 'Заявок пока нет.')

  return (
    <div className="dp-requests-page contract-registry ui-work">
      <div className="registry-header">
        <h2>
          <IconTile tone="coral" className="dpr-title-icon"><IconDpRequest /></IconTile>
          Заявка на заключение ДП
        </h2>
        <div className="dpr-header-actions">
          {canManageRecipients && !missing && (
            <button type="button" className="ui-btn" onClick={() => setShowRecipients(true)} title="Кому всплывает окно о новой заявке">
              <span className="dpr-bell"><IconNotifications /></span>
              <span>Уведомления</span>
            </button>
          )}
          {canCreate && !missing && (
            <button type="button" className="btn-primary" onClick={() => setFormFor({ request: null })}>+ Новая заявка</button>
          )}
        </div>
      </div>

      {missing ? <div className="no-data">{DP_MIGRATION_HINT}</div> : (
        <>
          <div className="status-tabs" role="tablist">
            {DP_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`status-tab${tab === t.key ? ' active' : ''}${t.key === 'deleted' ? ' tab-deleted' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <span className="tab-count">{counts[t.key]}</span>
              </button>
            ))}
          </div>

          <div className="dcr-toolbar dpr-toolbar">
            <div className="ui-search">
              <IconSearch />
              <input
                type="search"
                className="dcr-search"
                placeholder="№, объект, договор, ответственный"
                aria-label="Поиск по номеру заявки, объекту, договору, ответственному и примечанию"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <FilterDropdown
              label=""
              multiple
              searchable
              searchPlaceholder="Поиск объекта…"
              allLabel="Все объекты"
              icon={<IconObject size={15} />}
              value={objectIds}
              onChange={setObjectIds}
              options={filterObjects}
              disabled={filterObjects.length === 0}
            />
            {(query || objectIds.length > 0) && (
              <button type="button" className="ui-btn" onClick={() => { setQuery(''); setObjectIds([]) }}>Сбросить</button>
            )}
          </div>

          {error && <p className="dpr-error dpr-page-error" role="alert">{error}</p>}

          {requests == null ? <div className="loading">Загрузка...</div> : isPhone ? (
            filtered.length === 0 ? <div className="no-data">{emptyText}</div> : (
              <div className="mcard-list">
                {filtered.map((req) => (
                  <div key={req.id} ref={(el) => { rowsRef.current.set(req.id, el) }} className={`mcard${req.deleted_at ? ' row-deleted' : ''}${highlightId === req.id ? ' dpr-highlight' : ''}`}>
                    <div className="mcard-head">
                      <span className="mcard-num">№ {req.request_number}</span>
                      <DpStatus req={req} canWork={canWork} onChange={changeStatus} />
                    </div>
                    <div className="mcard-title">{req.objects?.name || unfilled}</div>
                    <div className="mcard-rows">
                      {/* Строки с файлами — столбцом: в правой части карточки имя файла обрезалось до «Договор 4.d…». */}
                      <div className="mcard-row dpr-mrow-stack"><span className="mcard-label">Договор и документы</span><span className="mcard-value">{req.contract_title || unfilled}<DpFileList {...fileProps(req, DP_DOCS_CATEGORY)} /></span></div>
                      <div className="mcard-row dpr-mrow-stack"><span className="mcard-label">Понятийное соглашение</span><span className="mcard-value"><DpFileList {...fileProps(req, DP_CONCEPT_CATEGORY)} /></span></div>
                      <div className="mcard-row"><span className="mcard-label">Сумма</span><span className="mcard-value dpr-amount">{req.amount == null ? unfilled : `${formatAmount(Number(req.amount))} ₽`}</span></div>
                      <div className="mcard-row"><span className="mcard-label">Ответственный</span><span className="mcard-value">{responsible(req)}</span></div>
                      <div className="mcard-row"><span className="mcard-label">Примечание</span><span className="mcard-value"><ClampText text={req.reason} lines={4} /></span></div>
                    </div>
                    {created(req)}
                    <div className="dpr-row-actions">{actions(req)}</div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="table-container">
              <table className="dcr-table dpr-table">
                <colgroup>
                  <col className="dpr-col-num" />
                  <col className="dpr-col-object" />
                  <col className="dpr-col-contract" />
                  <col className="dpr-col-concept" />
                  <col className="dpr-col-amount" />
                  <col className="dpr-col-resp" />
                  <col className="dpr-col-reason" />
                  <col className="dpr-col-status" />
                  <col className="dpr-col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Объект</th>
                    <th>Договор и документы</th>
                    <th>Понятийное соглашение</th>
                    <th className="dpr-num-cell">Сумма, ₽</th>
                    <th>Ответственный</th>
                    <th>Примечание</th>
                    <th>Статус</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && <tr><td colSpan={9} className="no-data">{emptyText}</td></tr>}
                  {filtered.map((req) => (
                    <tr key={req.id} ref={(el) => { rowsRef.current.set(req.id, el) }} className={`${req.deleted_at ? 'row-deleted' : ''}${highlightId === req.id ? ' dpr-highlight' : ''}`}>
                      <td className="dpr-number">{req.request_number}</td>
                      <td>
                        {req.objects?.name || unfilled}
                        {created(req)}
                      </td>
                      <td>
                        <div className="dpr-contract-title">{req.contract_title || unfilled}</div>
                        <DpFileList {...fileProps(req, DP_DOCS_CATEGORY)} />
                      </td>
                      <td><DpFileList {...fileProps(req, DP_CONCEPT_CATEGORY)} /></td>
                      <td className="dpr-num-cell dpr-amount">{req.amount == null ? unfilled : formatAmount(Number(req.amount))}</td>
                      <td>{responsible(req)}</td>
                      <td><ClampText text={req.reason} /></td>
                      <td><DpStatus req={req} canWork={canWork} onChange={changeStatus} /></td>
                      <td><div className="dpr-row-actions">{actions(req)}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {formFor && (
        <DpRequestFormModal
          request={formFor.request}
          objects={objects}
          staff={staff}
          me={me}
          canWork={canWork}
          ownObjects={pickOwnObject ? ownObjects : undefined}
          ownObjectsFailed={ownObjectsFailed}
          onClose={() => setFormFor(null)}
          onSaved={onSaved}
        />
      )}
      {showRecipients && <DpRecipientsModal roleLabels={roleLabels} onClose={() => setShowRecipients(false)} />}
      {previewDoc && <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}
