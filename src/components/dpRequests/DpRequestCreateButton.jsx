import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext'
import DpRequestFormModal from './DpRequestFormModal'
import { IconClose } from '../icons/ToolbarIcons'
import { loadDpObjects, loadDpStaff } from '../../services/dpRequests'
import { DP_CREATED_EVENT, DP_REQUEST_PARAM, dpErrorText } from '../../utils/dpRequests'
import './DpRequestCreateButton.css'

// «+ Заявка на заключение ДП» в «Реестре по договорам» (10.11.2026, решение пользователя: подать заявку — плюсиком рядом с
// вкладкой «Все», как «+ Новая заявка» на странице заявок; сама страница /dp-requests и блок хаба остаются). Окно — то же,
// что на странице (DpRequestFormModal), с теми же правами: кнопка — у права dp_requests_create, подающий с привязкой к объектам
// выбирает свой объект, работающий с заявками (dp_requests) видит ещё блок «Заполняет отдел». Запреты — в базе (20261227, 20261231).
// После подачи — плашка с номером и ссылкой на заявку (если раздел заявок открыт), окно о новой заявке у получателей — как со страницы.
const NOTE_MS = 15000

export default function DpRequestCreateButton() {
  const { role, userProfile, canEdit, canView, scopedObjectIds } = useRole()
  const canCreate = canEdit('dp_requests_create')
  const canWork = canEdit('dp_requests')
  const scopeKey = (scopedObjectIds || []).join(',')
  const pickOwnObject = !canWork && canCreate && scopeKey !== ''

  const [open, setOpen] = useState(false)
  const [objects, setObjects] = useState([])
  const [staff, setStaff] = useState([])
  const [ownObjects, setOwnObjects] = useState(null)
  const [ownObjectsFailed, setOwnObjectsFailed] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [created, setCreated] = useState(null) // { id, request_number }

  // Справочники — при открытии окна, а не с реестром договоров: кнопку нажимают редко.
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setLoadError('')
    if (pickOwnObject) {
      setOwnObjects(null)
      setOwnObjectsFailed(false)
      loadDpObjects(scopeKey.split(',')).then((rows) => { if (alive) setOwnObjects(rows) }).catch((err) => {
        if (!alive) return
        setOwnObjectsFailed(true)
        setLoadError(`Ваши объекты не загрузились: ${dpErrorText(err)}`)
      })
    }
    if (canWork) {
      const ids = scopeKey ? scopeKey.split(',') : []
      loadDpObjects(ids).then((rows) => { if (alive) setObjects(rows) })
        .catch((err) => { if (alive) setLoadError(`Объекты не загрузились: ${dpErrorText(err)}`) })
      loadDpStaff().then((rows) => { if (alive) setStaff(rows) })
        .catch((err) => { if (alive) setLoadError(`Сотрудники объектов не загрузились: ${dpErrorText(err)}`) })
    }
    return () => { alive = false }
  }, [open, pickOwnObject, canWork, scopeKey])

  useEffect(() => {
    if (!created) return undefined
    const t = setTimeout(() => setCreated(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [created])

  if (!canCreate) return null

  const onSaved = (row) => {
    setOpen(false)
    if (!row?.id) return
    setCreated(row)
    window.dispatchEvent(new CustomEvent(DP_CREATED_EVENT))
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
        // ui-work — тот же рабочий слой, что у страницы заявок: окно выглядит одинаково, откуда бы его ни открыли.
        <div className="ui-work dpr-portal">
          {open && (
            <DpRequestFormModal
              request={null}
              objects={objects}
              staff={staff}
              me={{ role, name: userProfile?.full_name || '' }}
              canWork={canWork}
              ownObjects={pickOwnObject ? ownObjects : undefined}
              ownObjectsFailed={ownObjectsFailed}
              onClose={() => setOpen(false)}
              onSaved={onSaved}
            />
          )}
          {open && loadError && <p className="dpr-error cr-dp-load-error" role="alert">{loadError}</p>}
          {created && (
            <div className="cr-dp-created" role="status">
              <span>
                Заявка на заключение ДП{created.request_number ? ` № ${created.request_number}` : ''} подана.
                {' '}Объект, договор и сумму заполнит отдел.
              </span>
              {canView('dp_requests') && (
                <Link to={`/dp-requests?${DP_REQUEST_PARAM}=${encodeURIComponent(created.id)}`} onClick={() => setCreated(null)}>
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
