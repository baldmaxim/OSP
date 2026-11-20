import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconPencil, IconRefresh } from './icons/ActionIcons'
import { RESTART_STATUS } from '../utils/tenderStatuses'
import { RESTART_LINK_FIELD, buildRestartIndex, canPickRestartSources, hasRestartLink, restartTargetId } from '../utils/tenderRestart'
import { loadRestartRelated } from '../services/tenderRestart'
import './TenderRestart.css'

// Номер тендера — ссылкой в карточку (если её можно открыть), иначе текстом. Тендера нет в списке (другое направление) —
// «другим», ссылкой по id.
function NumLink({ id, tender, canOpen }) {
  const n = tender?.public_tender_number
  const text = n != null ? `№ ${n}` : 'другим'
  if (!canOpen) return <span className="trs-num">{text}</span>
  return (
    <Link to={`/tenders/${id}`} className="trs-num" title={n != null ? `Открыть тендер № ${n}` : 'Открыть тендер'}>
      {text}
    </Link>
  )
}

// Отметки «перезапуска» у номера тендера (решение пользователя 18.11.2026), мельче и тише самого номера:
//  • у нового — «перезапуск № 40» (какие тендеры он заменил), номер ведёт в прежний;
//  • у прежнего («Перезапуск») — «заменён № 984», только показ и НЕ в столбце «№» (решение пользователя 19.11.2026: «статус в № по
//    старому тендеру должен быть только у нового», затем «в перезапущенных должна быть отметка, просто не в столбце №»): в реестре
//    — под статусом (во вкладке «Перезапуск» — в столбце победителя), на телефоне — рядом со статусом, в карточке — под названием.
// part — что показать: 'from' (столбец «№»: «перезапуск № …», «+ перезапуск»), 'target' («заменён № …»), 'all' (оба).
// onEdit(тендер) — правка у НОВОГО (19.11.2026: «указывать в № тот тендер, который перезапускается, а не наоборот»): карандаш
// у «перезапуск № …» или «+ перезапуск», если прежние не указаны; у тендера в «Перезапуске» «+ перезапуск» нет (он закончен).
// index — buildRestartIndex(список тендеров).
export default function TenderRestartMark({ tender, index, canOpen = true, onEdit = null, part = 'all', className = '' }) {
  if (!tender || !index) return null
  const from = part === 'target' ? [] : index.restartedFrom.get(tender.id) || []
  const targetId = part === 'from' ? null : restartTargetId(tender)
  const target = targetId ? index.byId.get(targetId) : null
  const canPick = part !== 'target' && !!onEdit && canPickRestartSources(tender)
  const canAdd = canPick && !from.length && tender.status !== RESTART_STATUS
  if (!from.length && !targetId && !canAdd) return null
  const fromTitle = `Перезапуск тендера ${from.map(t => `№ ${t.public_tender_number ?? '—'}`).join(', ')}`

  return (
    <span className={`trs-marks ${className}`.trim()}>
      {from.length > 0 && (
        <span className="trs-mark trs-mark--from" title={fromTitle}>
          <IconRefresh size={11} />
          <span>перезапуск</span>
          {from.map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 && <span aria-hidden="true">,</span>}
              <NumLink id={t.id} tender={t} canOpen={canOpen} />
            </Fragment>
          ))}
          {canPick && (
            <button
              type="button"
              className="trs-edit"
              aria-label="Изменить, какой тендер перезапускается"
              title="Изменить или снять"
              onClick={(e) => { e.stopPropagation(); onEdit(tender) }}
            ><IconPencil size={11} /></button>
          )}
        </span>
      )}
      {targetId && (
        <span className="trs-mark trs-mark--to" title="Тендер перезапущен — его заменил новый">
          <span>заменён</span>
          <NumLink id={targetId} tender={target} canOpen={canOpen} />
        </span>
      )}
      {canAdd && (
        <button
          type="button"
          className="trs-add"
          title="Указать тендер, который перезапускается этим"
          onClick={(e) => { e.stopPropagation(); onEdit(tender) }}
        >+ перезапуск</button>
      )}
    </span>
  )
}

// Карточка тендера: отметки строкой под названием (у нового — «перезапуск № 40», у прежнего — «заменён № 984»); связанные тендеры
// читаются сами (только показ, правка — в реестре).
export function TenderRestartHeaderMark({ tender, canOpen = true }) {
  const [related, setRelated] = useState([])
  const id = tender?.id
  const status = tender?.status
  const target = tender?.[RESTART_LINK_FIELD]
  const known = hasRestartLink(tender)
  useEffect(() => {
    let alive = true
    if (!id || !known) { setRelated([]); return undefined }
    loadRestartRelated({ id, status, [RESTART_LINK_FIELD]: target })
      .then((rows) => { if (alive) setRelated(rows) })
      .catch((err) => console.error('Перезапуск тендера:', err.message))
    return () => { alive = false }
  }, [id, status, target, known])
  const index = useMemo(() => buildRestartIndex(tender ? [tender, ...related] : related), [tender, related])
  if (!tender) return null
  return <TenderRestartMark tender={tender} index={index} canOpen={canOpen} className="trs-marks--header" />
}
