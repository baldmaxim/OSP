import { Fragment, memo, useState } from 'react'
import DocCheckCard from './DocCheckCard'
import FilterDropdown from '../FilterDropdown'
import { IconArchive, IconSliders } from '../icons/ActionIcons'
import { CLOSED_DOC_CHECK_STATUSES, DOC_TYPES } from '../../utils/docCheckHelpers'

// Значение slotBefore «встанет последней»: id карточки им быть не может.
export const SLOT_AT_END = 'end'

// Колонка доски. memo: перетаскивание меняет заглушку в одной-двух колонках, остальные не перерисовываются.
// slotBefore — перед какой карточкой заглушка места (SLOT_AT_END — в конце), liftedId — карточка, которую сейчас несут: её
// место занимает заглушка; sourceId — та же карточка в «Сводке»: остаётся видна, но блёкло.
function DocCheckColumn({
  col, list, employees, canEdit, hasBoardFields, statusOptions, summary, canAdd, isOver, slotBefore, liftedId, sourceId,
  onSummaryChange, onOpen, onAdd, onToggleDone, onMenu, onArchiveDone,
}) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const isSummary = col.kind === 'summary'
  const shown = list.filter(r => r.id !== liftedId).length
  const classes = ['dc-column', col.className, isSummary && 'dc-column--summary', isOver && 'is-over'].filter(Boolean).join(' ')
  const slot = <div className="dc-card-slot" aria-hidden="true" />

  return (
    <section className={classes} data-status={col.value} data-droppable={isSummary ? 'false' : 'true'}>
      <header className="dc-column-head">
        <div className="dc-column-top">
          <h3 className="dc-column-title" title={col.label}>{col.label}</h3>
          <span className="dc-column-count">{list.length}</span>
          {isSummary && (
            <button
              type="button"
              className={`dc-icon-btn${summaryOpen ? ' is-active' : ''}`}
              aria-label="Настроить сводку"
              aria-expanded={summaryOpen}
              title="Что показывать в сводке"
              onClick={() => setSummaryOpen(v => !v)}
            ><IconSliders size={15} /></button>
          )}
          {CLOSED_DOC_CHECK_STATUSES.has(col.value) && canEdit && hasBoardFields && list.length > 0 && (
            <button
              type="button"
              className="dc-icon-btn"
              aria-label="Отправить завершённые в архив"
              title="Отправить завершённые в архив"
              onClick={() => onArchiveDone(list)}
            ><IconArchive size={15} /></button>
          )}
          {canAdd && (
            <button
              type="button"
              className="dc-icon-btn dc-column-add"
              aria-label={`Добавить заявку: ${col.label}`}
              title="Добавить заявку"
              onClick={() => onAdd(col.value)}
            >+</button>
          )}
        </div>
        {isSummary && summaryOpen && (
          <div className="dc-summary-settings">
            <FilterDropdown
              label="" multiple allLabel="ДП и ДС"
              value={summary.types}
              onChange={(types) => onSummaryChange({ ...summary, types })}
              options={DOC_TYPES.map(t => ({ value: t.value, label: `${t.label} — ${t.title}` }))}
            />
            <FilterDropdown
              label="" multiple allLabel="Все статусы"
              value={summary.statuses}
              onChange={(st) => onSummaryChange({ ...summary, statuses: st })}
              options={statusOptions}
            />
          </div>
        )}
      </header>

      <div className="dc-column-body">
        {list.map(request => (
          <Fragment key={request.id}>
            {slotBefore === request.id && slot}
            <div
              className={`dc-card-wrap${request.id === sourceId ? ' is-source' : ''}`}
              data-card={request.id}
              hidden={request.id === liftedId}
            >
              <DocCheckCard
                request={request}
                employees={employees}
                canEdit={canEdit}
                showStatus={isSummary}
                onOpen={onOpen}
                onToggleDone={onToggleDone}
                onMenu={onMenu}
              />
            </div>
          </Fragment>
        ))}
        {slotBefore === SLOT_AT_END && slot}
        {shown === 0 && !slotBefore && <p className="dc-column-empty">{isSummary ? 'Нет заявок по отбору' : 'Пусто'}</p>}
      </div>
    </section>
  )
}

export default memo(DocCheckColumn)
