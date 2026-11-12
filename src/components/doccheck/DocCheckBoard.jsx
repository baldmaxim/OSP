import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import DocCheckCardMenu from './DocCheckCardMenu'
import DocCheckColumn, { SLOT_AT_END } from './DocCheckColumn'
import { dragCard, panByDrag, pressedScrollbar } from './boardGestures'
import {
  COLUMN_SORTS,
  availableStatuses,
  boardColumns,
  columnSortOf,
  datePlaceBefore,
  extraColumn,
  nextColumnSort,
  normalizeColumnSorts,
  withColumnSort,
} from '../../utils/docCheckHelpers'

// Канбан-доска заявок на проверку ДП/ДС — по образцу доски, на которой отдел
// вёл проверку до сайта: колонки статусов с цветной полосой сверху и счётчиком,
// «+» в каждой, карточки с цветом, метками и исполнителями. «Сводки по ДП» и «Проверки документов (исключение налоговой
// оговорки)» нет (решение пользователя 10.11.2026; статус убран и из базы — миграция 20270202). Заявка со статусом вне
// справочника не прячется: стоит в своей колонке без «+», бросить туда нельзя, вытащить — можно (extraColumn).
//
// Мышью (жесты — boardGestures.js, решение пользователя 03.11.2026): карточку тащат за любое место — за указателем едет
// её копия, заглушка показывает, куда она встанет, у края окна доска и колонка едут сами, Escape отменяет. Нажать и вести
// по любому другому месту — прокрутка влево-вправо; так же и по карточке у того, кому менять заявки нельзя.
//
// Порядок в колонке (06.11.2026) — кнопка в шапке: свой (как расставили мышью), новые сверху, старые сверху; выбор у каждой
// колонки свой и хранится в браузере. В колонке, показанной по дате, место решает дата: заглушка стоит там, куда карточка
// встанет, бросок в ту же колонку ничего не меняет, в другую — меняет колонку, а в своём порядке карточка встаёт наверх (как
// перенос из меню). Свой порядок при этом не трогается — вернули «Свой порядок», и он прежний.

// Нажатие сюда — действие этого элемента, а не жест. Заголовок карточки — кнопка для клавиатуры, а ссылка на письмо по
// щелчку открывается, но потянуть карточку за них можно: щелчок от сдвига отличает порог.
const CONTROLS = 'button:not(.dc-card-title), input, select, textarea, label, .fdrop'
const SCROLL_KEY = 'docCheckBoardScroll'
const SORT_KEY = 'docCheckColumnSort'
const EMPTY = []

function readSorts() {
  try { return normalizeColumnSorts(JSON.parse(localStorage.getItem(SORT_KEY) || 'null')) } catch { return {} }
}

const findRequest = (byColumn, id) => {
  for (const list of byColumn.values()) {
    const found = list.find(r => r.id === id)
    if (found) return found
  }
  return null
}

// Откуда взяли: следующая карточка в колонке её статуса. Бросок сюда же — ничего не меняет.
const placeOf = (byColumn, status, id) => {
  const list = byColumn.get(status) || []
  const at = list.findIndex(r => r.id === id)
  return { column: status, beforeId: at >= 0 ? (list[at + 1]?.id ?? null) : null }
}

// addOnly — колонка, куда может добавлять тот, у кого нет права правки, а есть право создания (20270102: только «Новые заявки»).
function DocCheckBoard({
  requests, employees, canEdit, addOnly = null, hasBoardFields,
  onOpen, onMove, onAdd, onToggleDone, onCardAction, onArchiveDone,
}) {
  // { id, origin: { column, beforeId }, target: { column, beforeId } | null }
  const [drag, setDrag] = useState(null)
  const [menu, setMenu] = useState(null)             // { request, anchor }
  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenu = useCallback((r, anchor) => setMenu({ request: r, anchor }), [])
  const boardRef = useRef(null)
  const stopGesture = useRef(null)
  const [sorts, setSorts] = useState(readSorts)
  const changeSort = useCallback((column) => setSorts(prev => withColumnSort(prev, column, nextColumnSort(prev, column))), [])
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, JSON.stringify(sorts)) } catch { /* приватный режим */ }
  }, [sorts])

  const statuses = availableStatuses(hasBoardFields)

  // Раскладка считается заново только при новых заявках: перетаскивание меняет лишь подсветку.
  const { byColumn, allColumns } = useMemo(() => {
    const columns = boardColumns(hasBoardFields)
    const map = new Map(columns.map(c => [c.value, []]))
    for (const r of requests) {
      // Статус вне справочника (убранная колонка, ручная правка в БД) не должен
      // прятать заявку — заводим для него колонку на лету.
      if (!map.has(r.status)) map.set(r.status, [])
      map.get(r.status).push(r)
    }
    for (const [value, list] of map) list.sort(COLUMN_SORTS[columnSortOf(sorts, value)].compare)
    const extra = [...map.keys()].filter(k => !columns.some(c => c.value === k))
    return {
      byColumn: map,
      allColumns: [...columns, ...extra.map(extraColumn)],
    }
  }, [requests, hasBoardFields, sorts])

  // Пока несут карточку, заявки могли перечитаться: бросок решается по свежим данным.
  const latest = useRef(null)
  latest.current = { byColumn, onMove, onCardAction, sorts }

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0 || e.pointerType !== 'mouse' || stopGesture.current || e.target.closest(CONTROLS)) return
    const box = boardRef.current
    const onEnd = () => { stopGesture.current = null }
    const card = canEdit ? e.target.closest('.dc-card') : null
    if (!card) {
      if (!pressedScrollbar(e)) stopGesture.current = panByDrag(e, box, onEnd)
      return
    }
    const id = card.dataset.id
    const request = findRequest(latest.current.byColumn, id)
    if (!request) return
    stopGesture.current = dragCard(e, {
      box,
      card,
      draggedId: id,
      onStart: () => setDrag({ id, origin: placeOf(latest.current.byColumn, request.status, id), target: null }),
      onTarget: (target) => setDrag(prev => (prev ? { ...prev, target } : prev)),
      onDrop: (target) => {
        setDrag(null)
        const { byColumn: columns, onMove: move, onCardAction: cardAction, sorts: current } = latest.current
        const fresh = findRequest(columns, id)
        if (!target || !fresh) return
        const place = placeOf(columns, fresh.status, id)
        if (target.column === place.column && target.beforeId === place.beforeId) return
        // Колонка по дате: место решает дата, в своём порядке — наверх (moveTo страницы); своя колонка — без изменений.
        if (columnSortOf(current, target.column) !== 'manual') {
          if (target.column !== fresh.status) cardAction(fresh, 'status', target.column)
          return
        }
        move(fresh, target.column, target.beforeId)
      },
      onCancel: () => setDrag(null),
      onEnd,
    })
  }, [canEdit])

  // Страницу закрыли посреди жеста.
  useEffect(() => () => stopGesture.current?.(), [])

  // Положение доски переживает переход в реестр, архив и обратно и обновление страницы.
  useLayoutEffect(() => {
    const box = boardRef.current
    try {
      const left = Number(sessionStorage.getItem(SCROLL_KEY))
      if (left > 0) box.scrollLeft = left
    } catch { /* приватный режим */ }
    let timer = null
    const save = () => {
      timer = null
      try { sessionStorage.setItem(SCROLL_KEY, String(Math.round(box.scrollLeft))) } catch { /* приватный режим */ }
    }
    const onScroll = () => { if (!timer) timer = setTimeout(save, 150) }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      box.removeEventListener('scroll', onScroll)
      if (timer) { clearTimeout(timer); save() }
    }
  }, [])

  const slot = drag ? (drag.target || drag.origin) : null
  const dragged = drag ? findRequest(byColumn, drag.id) : null
  // Заглушка места: в своём порядке — где указатель, в колонке по дате — где карточка встанет по дате.
  // Из другой колонки карточка придёт с номером «наверх» (больше всех в колонке): при равной дате он и решает место.
  const slotIn = (col, mode) => {
    if (slot?.column !== col.value) return null
    if (mode === 'manual' || !dragged) return slot.beforeId ?? SLOT_AT_END
    const arriving = dragged.status === col.value ? dragged : { ...dragged, sort_order: Number.MAX_SAFE_INTEGER }
    return datePlaceBefore(byColumn.get(col.value) || EMPTY, arriving, COLUMN_SORTS[mode].compare) ?? SLOT_AT_END
  }

  return (
    <div
      ref={boardRef}
      className={`dc-board${drag ? ' is-dragging' : ''}`}
      aria-label="Доска заявок"
      onPointerDown={handlePointerDown}
      onDragStart={(e) => e.preventDefault()}
    >
      {allColumns.map(col => {
        const sort = columnSortOf(sorts, col.value)
        return (
          <DocCheckColumn
            key={col.value}
            col={col}
            sort={sort}
            onSortChange={changeSort}
            list={byColumn.get(col.value) || EMPTY}
            employees={employees}
            canEdit={canEdit}
            hasBoardFields={hasBoardFields}
            canAdd={col.kind === 'status' && (canEdit ? statuses.some(s => s.value === col.value) : addOnly === col.value)}
            isOver={drag?.target?.column === col.value}
            slotBefore={slotIn(col, sort)}
            liftedId={drag?.origin.column === col.value ? drag.id : null}
            onOpen={onOpen}
            onAdd={onAdd}
            onToggleDone={onToggleDone}
            onMenu={openMenu}
            onArchiveDone={onArchiveDone}
          />
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

// memo: окно заявки открывается состоянием страницы — доска при этом не перерисовывается.
export default memo(DocCheckBoard)
