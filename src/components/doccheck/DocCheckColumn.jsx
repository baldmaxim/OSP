import { Fragment, memo } from 'react'
import DocCheckCard from './DocCheckCard'
import { IconArchive, IconSortManual, IconSortNewest, IconSortOldest } from '../icons/ActionIcons'
import { CLOSED_DOC_CHECK_STATUSES, COLUMN_SORTS, nextColumnSort } from '../../utils/docCheckHelpers'

// Значение slotBefore «встанет последней»: id карточки им быть не может.
export const SLOT_AT_END = 'end'

const SORT_ICON = { manual: IconSortManual, newest: IconSortNewest, oldest: IconSortOldest }

// Кнопка порядка в шапке колонки: нажатие — следующий порядок по кругу. По дате — значок с подписью, заметно; свой порядок
// (по умолчанию) — тихим значком.
function SortButton({ column, sort, onSortChange }) {
  const Icon = SORT_ICON[sort]
  const { label, short } = COLUMN_SORTS[sort]
  const next = COLUMN_SORTS[nextColumnSort({ [column]: sort }, column)].label.toLowerCase()
  const hint = `Порядок: ${label.toLowerCase()}${sort === 'manual' ? ' (как расставили мышью)' : ''}. Нажмите — ${next}`
  return (
    <button
      type="button"
      className={`dc-icon-btn dc-sort-btn${sort === 'manual' ? '' : ' is-by-date'}`}
      aria-label={hint}
      title={hint}
      data-sort={sort}
      onClick={() => onSortChange(column)}
    >
      <Icon size={14} />
      {short && <span className="dc-sort-btn-text">{short}</span>}
    </button>
  )
}

// Колонка доски. memo: перетаскивание меняет заглушку в одной-двух колонках, остальные не перерисовываются.
// slotBefore — перед какой карточкой заглушка места (SLOT_AT_END — в конце), liftedId — карточка, которую сейчас несут: её
// место занимает заглушка. Колонка статуса вне справочника (kind 'extra' — убранная «Проверка документов» и т. п.) карточки не
// принимает: вытащить из неё можно, бросить в неё — нет.
function DocCheckColumn({
  col, sort, list, employees, canEdit, hasBoardFields, canAdd, isOver, slotBefore, liftedId,
  onSortChange, onOpen, onAdd, onToggleDone, onMenu, onArchiveDone,
}) {
  const shown = list.filter(r => r.id !== liftedId).length
  const classes = ['dc-column', col.className, isOver && 'is-over'].filter(Boolean).join(' ')
  const slot = <div className="dc-card-slot" aria-hidden="true" />

  return (
    <section className={classes} data-status={col.value} data-droppable={col.kind === 'status' ? 'true' : 'false'}>
      <header className="dc-column-head">
        <div className="dc-column-top">
          <h3 className="dc-column-title" title={col.label}>{col.label}</h3>
          <SortButton column={col.value} sort={sort} onSortChange={onSortChange} />
          <span className="dc-column-count">{list.length}</span>
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
      </header>

      <div className="dc-column-body">
        {list.map(request => (
          <Fragment key={request.id}>
            {slotBefore === request.id && slot}
            <div
              className="dc-card-wrap"
              data-card={request.id}
              hidden={request.id === liftedId}
            >
              <DocCheckCard
                request={request}
                employees={employees}
                canEdit={canEdit}
                onOpen={onOpen}
                onToggleDone={onToggleDone}
                onMenu={onMenu}
              />
            </div>
          </Fragment>
        ))}
        {slotBefore === SLOT_AT_END && slot}
        {shown === 0 && !slotBefore && <p className="dc-column-empty">Пусто</p>}
      </div>
    </section>
  )
}

export default memo(DocCheckColumn)
