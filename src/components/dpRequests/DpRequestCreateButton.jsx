import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext'
import DocCheckFormModal from '../doccheck/DocCheckFormModal'
import { IconClose } from '../icons/ToolbarIcons'
import { fetchPickerCounterparties } from '../../services/counterpartyPicker'
import {
  createDocCheckRequest, failedFilesText, hasTenderColumn, loadPickerObjects, loadPickerTenders, topSortOrder,
} from '../../services/docCheckRequests'
import { counterpartyNumbers } from '../../utils/counterpartyFilters'
import { counterpartyPickerOptions, isPickableCounterparty } from '../../utils/counterpartyPicker'
import { DP_CONCLUSION } from '../../utils/docCheckHelpers'
import { DP_CREATED_EVENT } from '../../utils/dpRequests'
import '../../styles/workUi.css'
import '../../pages/DocCheckRequestsPage.css'
import './DpRequestCreateButton.css'

// «+ Заявка на заключение ДП» в «Реестре по договорам» (10.11.2026 — плюсиком у вкладок, с 11.11.2026 — среди действий шапки).
// С 19.11.2026 (решение пользователя) заявка на заключение ДП — карточка доски «Заявки на проверку ДП/ДС» (doc_type 'dp_conclusion',
// светло-фиолетовая), отдельного раздела /dp-requests нет. Окно — форма доски с заданным типом: объект (свой — из «Ролей»),
// контрагент (если известен), примечание, понятийное соглашение (обязательно) и документы. Заявка встаёт в «Новые заявки».
// Кнопка — у права создания заявок доски (doc_check_requests_create: руководитель строительства и экономист объекта; администратор
// всегда) — у тех же ролей, что раньше было право «Заявка на заключение ДП: создание». Запреты — в базе (20270102, 20270219).
// После подачи — плашка со ссылкой на заявку на доске; окно о новой заявке у получателей заводит база.
// Тендер (необязательно, 19.11.2026) — когда у заявок есть колонка (миграция 20270221): проверка колонки и список тендеров — при
// открытии окна.
const NOTE_MS = 15000

export default function DpRequestCreateButton() {
  const { userProfile, user, canEdit, canView, scopedObjectIds } = useRole()
  const canCreate = canEdit('doc_check_requests_create')
  const scopeKey = (scopedObjectIds || []).join(',')

  const [open, setOpen] = useState(false)
  const [objects, setObjects] = useState(null)
  const [objectsFailed, setObjectsFailed] = useState(false)
  const [counterparties, setCounterparties] = useState([])
  const [loadError, setLoadError] = useState('')
  const [created, setCreated] = useState(null) // { id }
  const [hasTender, setHasTender] = useState(false)
  const [tenders, setTenders] = useState(null)
  const [tendersFailed, setTendersFailed] = useState(false)

  // Справочники — при открытии окна, а не с реестром договоров: кнопку нажимают редко.
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setLoadError('')
    setObjects(null)
    setObjectsFailed(false)
    loadPickerObjects(scopeKey ? scopeKey.split(',') : []).then((rows) => { if (alive) setObjects(rows) }).catch((err) => {
      if (!alive) return
      setObjectsFailed(true)
      setLoadError(`Объекты не загрузились: ${err?.message || err}`)
    })
    fetchPickerCounterparties().then((rows) => { if (alive) setCounterparties(rows || []) })
      .catch((err) => { if (alive) setLoadError(`Контрагенты не загрузились: ${err?.message || err}`) })
    setHasTender(false)
    setTenders(null)
    setTendersFailed(false)
    hasTenderColumn().then((ok) => {
      if (!alive || !ok) return
      setHasTender(true)
      loadPickerTenders().then((rows) => { if (alive) setTenders(rows) }).catch((err) => {
        if (!alive) return
        console.warn('Тендеры не загрузились:', err?.message || err)
        setTendersFailed(true)
      })
    })
    return () => { alive = false }
  }, [open, scopeKey])

  useEffect(() => {
    if (!created) return undefined
    const t = setTimeout(() => setCreated(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [created])

  const counterpartyOptions = useMemo(() => {
    const numbers = counterpartyNumbers(counterparties)
    return counterpartyPickerOptions(counterparties.filter(isPickableCounterparty), numbers)
  }, [counterparties])
  const employees = useMemo(() => new Map(), [])

  if (!canCreate) return null

  const onSave = async (payload, files = []) => {
    try {
      const sortOrder = await topSortOrder('new').catch(() => 1)
      const { id, failed } = await createDocCheckRequest({
        payload: { ...payload, doc_type: DP_CONCLUSION },
        status: 'new',
        sortOrder,
        author: userProfile?.full_name || user?.email || 'Пользователь',
        files,
      })
      setOpen(false)
      setCreated({ id })
      window.dispatchEvent(new CustomEvent(DP_CREATED_EVENT, { detail: { id } }))
      if (failed.length) alert(failedFilesText(failed))
    } catch (err) {
      alert('Заявка не подана: ' + (err?.message || err))
    }
  }

  return (
    <>
      <button
        type="button"
        className="cr-dp-add"
        title="Подать заявку на заключение договора подряда: понятийное соглашение, документы, примечание"
        onClick={() => { setCreated(null); setOpen(true) }}
      >
        <span className="cr-dp-add-plus" aria-hidden="true">+</span>
        Заявка на заключение ДП
      </button>
      {(open || created) && createPortal(
        // Окно — форма доски: её стили — под корнем страницы доски (doc-check-page). Обёртка без своего бокса: оверлей — fixed.
        <div className="ui-work doc-check-page dpr-portal" style={{ display: 'contents' }}>
          {open && (
            <DocCheckFormModal
              request={null}
              status="new"
              objects={objects || []}
              counterpartyOptions={counterpartyOptions}
              employees={employees}
              labelSuggestions={[]}
              hasBoardFields
              hasCardFields={false}
              canEditCreated={false}
              creatorOnly
              ownObjects={scopeKey ? objects : undefined}
              ownObjectsFailed={objectsFailed}
              fixedType={DP_CONCLUSION}
              hasTenderField={hasTender}
              tenders={tenders}
              tendersFailed={tendersFailed}
              onSave={onSave}
              onClose={() => setOpen(false)}
            />
          )}
          {open && loadError && <p className="cr-dp-load-error" role="alert">{loadError}</p>}
          {created && (
            <div className="cr-dp-created" role="status">
              <span>
                Заявка на заключение ДП подана: «Заявки на проверку ДП/ДС», колонка «Новые заявки».
              </span>
              {canView('doc_check_requests') && (
                <Link to={`/doc-check-requests?request=${encodeURIComponent(created.id)}`} onClick={() => setCreated(null)}>
                  Открыть заявку
                </Link>
              )}
              <button type="button" className="cr-dp-created-x" aria-label="Закрыть" onClick={() => setCreated(null)}>
                <IconClose size={14} />
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
