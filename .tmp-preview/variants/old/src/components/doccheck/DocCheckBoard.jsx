import { useState } from 'react'
import DocCheckCard from './DocCheckCard'
import { DOC_CHECK_STATUSES, DOC_CHECK_STATUS_CLASS, compareForBoard } from '../../utils/docCheckHelpers'

// Канбан-доска заявок на проверку ДП/ДС.
//
// Колонки = статусы, порядок задан в DOC_CHECK_STATUSES: от «Новой заявки» до
// «Ожидаем скан». Механика перетаскивания повторяет доску задач
// ([TaskBoard.jsx](src/components/tasks/TaskBoard.jsx)): нативный HTML5
// draggable без библиотек, бросок на карточку вставляет ПЕРЕД ней, бросок на
// пустое место колонки — в конец.

function DocCheckBoard({ requests, onOpen, onMove, canEdit }) {
  const [dragged, setDragged] = useState(null)       // перетаскиваемая заявка
  const [overColumn, setOverColumn] = useState(null) // подсветка колонки-приёмника

  const columns = DOC_CHECK_STATUSES

  const byColumn = new Map(columns.map(c => [c.value, []]))
  for (const r of requests) {
    // Статус вне справочника (например, после ручной правки в БД) не должен
    // прятать заявку — заводим для него колонку на лету.
    if (!byColumn.has(r.status)) byColumn.set(r.status, [])
    byColumn.get(r.status).push(r)
  }
  for (const list of byColumn.values()) list.sort(compareForBoard)

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
    if (!request) return
    const list = (byColumn.get(columnKey) || []).filter(r => r.id !== request.id)
    const idx = beforeId ? list.findIndex(r => r.id === beforeId) : -1
    const orderedIds = list.map(r => r.id)
    orderedIds.splice(idx >= 0 ? idx : orderedIds.length, 0, request.id)
    onMove(request, columnKey, orderedIds)
  }

  return (
    <div className="dc-board">
      {columns.map(col => {
        const list = byColumn.get(col.value) || []
        return (
          <section
            key={col.value}
            className={`dc-column${overColumn === col.value ? ' is-over' : ''}`}
            onDragOver={(e) => { if (dragged) { e.preventDefault(); setOverColumn(col.value) } }}
            onDragLeave={(e) => {
              // Игнорируем переходы между дочерними элементами внутри колонки.
              if (!e.currentTarget.contains(e.relatedTarget)) setOverColumn(null)
            }}
            onDrop={(e) => { e.preventDefault(); handleDrop(col.value) }}
          >
            <header className={`dc-column-head ${DOC_CHECK_STATUS_CLASS[col.value] || ''}`}>
              <span className="dc-column-title" title={col.label}>{col.label}</span>
              <span className="dc-column-count">{list.length}</span>
            </header>

            <div className="dc-column-body">
              {list.map(request => (
                <div
                  key={request.id}
                  onDragOver={(e) => { if (dragged) e.preventDefault() }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col.value, request.id) }}
                >
                  <DocCheckCard
                    request={request}
                    onOpen={onOpen}
                    onDragStart={handleDragStart}
                    onDragEnd={() => { setDragged(null); setOverColumn(null) }}
                    isDragging={dragged?.id === request.id}
                  />
                </div>
              ))}
              {list.length === 0 && <p className="dc-column-empty">Пусто</p>}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export default DocCheckBoard
