import { useCallback, useState } from 'react'
import DocCheckCard from './DocCheckCard'
import DocCheckCardMenu from './DocCheckCardMenu'
import FilterDropdown from '../FilterDropdown'
import { IconArchive, IconSliders } from '../icons/ActionIcons'
import {
  CLOSED_DOC_CHECK_STATUSES,
  DOC_CHECK_STATUSES,
  DOC_TYPES,
  SUMMARY_COLUMN,
  availableStatuses,
  boardColumns,
  compareForBoard,
  matchesSummary,
} from '../../utils/docCheckHelpers'

// Канбан-доска заявок на проверку ДП/ДС — по образцу доски, на которой отдел
// вёл проверку до сайта: колонки статусов с цветной полосой сверху и счётчиком,
// «+ Добавить заявку» в каждой, карточки с цветом, метками и исполнителями.
//
// «Сводка по ДП» — колонка-выборка: те же заявки из других колонок по отбору
// (тип документа, статусы), с подписью статуса на карточке. Бросить в неё
// нельзя — это не статус; вытащить карточку из неё в колонку можно.
//
// Механика перетаскивания — как у доски задач ([TaskBoard.jsx](src/components/tasks/TaskBoard.jsx)):
// нативный HTML5 draggable без библиотек, бросок на карточку вставляет ПЕРЕД
// ней, бросок на пустое место колонки — в конец.

function DocCheckBoard({
  requests, employees, canEdit, hasBoardFields, summary, onSummaryChange,
  onOpen, onMove, onAdd, onToggleDone, onCardAction, onArchiveDone,
}) {
  const [dragged, setDragged] = useState(null)       // перетаскиваемая заявка
  const [overColumn, setOverColumn] = useState(null) // подсветка колонки-приёмника
  const [menu, setMenu] = useState(null)             // { request, anchor }
  const [summaryOpen, setSummaryOpen] = useState(false)
  const closeMenu = useCallback(() => setMenu(null), [])

  const columns = boardColumns(hasBoardFields)
  const statuses = availableStatuses(hasBoardFields)

  const byColumn = new Map(columns.map(c => [c.value, []]))
  for (const r of requests) {
    // Статус вне справочника (например, после ручной правки в БД) не должен
    // прятать заявку — заводим для него колонку на лету.
    if (!byColumn.has(r.status)) byColumn.set(r.status, [])
    byColumn.get(r.status).push(r)
    if (matchesSummary(r, summary)) byColumn.get(SUMMARY_COLUMN).push(r)
  }
  for (const list of byColumn.values()) list.sort(compareForBoard)
  const extra = [...byColumn.keys()].filter(k => !columns.some(c => c.value === k))
  const allColumns = [...columns, ...extra.map(value => ({ value, label: value, className: '', kind: 'status' }))]

  const handleDragStart = (e, request) => {
    if (!canEdit) { e.preventDefault(); return }
    setDragged(request)
    e.dataTransfer.effectAllowed = 'move'
    // Без setData Firefox не начинает перетаскивание.
    try { e.dataTransfer.setData('text/plain', request.id) } catch { /* noop */ }
  }

  const handleDrop = (columnKey, beforeId) => {
    setOverColumn(null)
    const request = dragged
    setDragged(null)
    if (!request || columnKey === SUMMARY_COLUMN) return
    const list = (byColumn.get(columnKey) || []).filter(r => r.id !== request.id)
    const idx = beforeId ? list.findIndex(r => r.id === beforeId) : -1
    const orderedIds = list.map(r => r.id)
    orderedIds.splice(idx >= 0 ? idx : orderedIds.length, 0, request.id)
    onMove(request, columnKey, orderedIds)
  }

  const statusOptions = DOC_CHECK_STATUSES
    .filter(s => hasBoardFields || !s.board)
    .map(s => ({ value: s.value, label: s.label }))

  return (
    <div className="dc-board" aria-label="Доска заявок">
      {allColumns.map(col => {
        const list = byColumn.get(col.value) || []
        const isSummary = col.kind === 'summary'
        const droppable = !isSummary
        return (
          <section
            key={col.value}
            className={`dc-column ${col.className || ''}${isSummary ? ' dc-column--summary' : ''}${overColumn === col.value ? ' is-over' : ''}`}
            data-status={col.value}
            onDragOver={(e) => { if (dragged && droppable) { e.preventDefault(); setOverColumn(col.value) } }}
            onDragLeave={(e) => {
              // Игнорируем переходы между дочерними элементами внутри колонки.
              if (!e.currentTarget.contains(e.relatedTarget)) setOverColumn(null)
            }}
            onDrop={(e) => { e.preventDefault(); handleDrop(col.value) }}
          >
            <header className="dc-column-head">
              {isSummary && <div className="dc-column-kind">Сводка</div>}
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
              {!isSummary && canEdit && statuses.some(s => s.value === col.value) && (
                <button type="button" className="dc-column-add" onClick={() => onAdd(col.value)}>
                  + Добавить заявку
                </button>
              )}
            </header>

            <div className="dc-column-body">
              {list.map(request => (
                <div
                  key={request.id}
                  onDragOver={(e) => { if (dragged && droppable) e.preventDefault() }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col.value, request.id) }}
                >
                  <DocCheckCard
                    request={request}
                    employees={employees}
                    canEdit={canEdit}
                    showStatus={isSummary}
                    onOpen={onOpen}
                    onToggleDone={onToggleDone}
                    onMenu={(r, anchor) => setMenu({ request: r, anchor })}
                    onDragStart={handleDragStart}
                    onDragEnd={() => { setDragged(null); setOverColumn(null) }}
                    isDragging={dragged?.id === request.id}
                  />
                </div>
              ))}
              {list.length === 0 && <p className="dc-column-empty">{isSummary ? 'Нет заявок по отбору' : 'Пусто'}</p>}
            </div>
          </section>
        )
      })}

      {menu && (
        <DocCheckCardMenu
          request={requests.find(r => r.id === menu.request.id) || menu.request}
          anchor={menu.anchor}
          statuses={statuses}
          hasBoardFields={hasBoardFields}
          onAction={onCardAction}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

export default DocCheckBoard
