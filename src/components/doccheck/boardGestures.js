// Жесты доски заявок мышью: прокрутка удержанием и перетаскивание карточки. Сенсорный экран сюда не попадает: там палец
// прокручивает доску сам, а колонку заявке меняют в меню карточки.
//
// Обе функции работают на указателе, а не на HTML5-перетаскивании (03.11.2026): у него нет своего предпросмотра — браузер
// показывает блёклый снимок; нет автопрокрутки к колонке за краем экрана; нет отмены и порога: дрогнувшая при щелчке рука
// уже была броском. Состояние — вне React: сдвиг указателя не перерисовывает доску, на ней сотни карточек.

// Меньше этого сдвига — щелчок, а не жест.
const MOVE_THRESHOLD = 5
// Автопрокрутка: зона у края области и наибольший шаг за кадр (у самого края — быстрее).
const EDGE_ZONE_X = 64
const EDGE_ZONE_Y = 40
const MAX_STEP = 18

// Нажали на полосу прокрутки самого элемента: её двигает браузер.
export function pressedScrollbar(e) {
  const el = e.target
  if (!el?.clientWidth) return false
  return e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight
}

// Шторка на время жеста: курсор «держу» и никаких :hover под указателем — правило на весь документ пересчитывало бы стили
// всех карточек на каждое движение.
function addVeil(parent) {
  const veil = document.createElement('div')
  veil.className = 'dc-gesture-veil'
  parent.appendChild(veil)
  return veil
}

// Отпускание после жеста браузер считает щелчком: он открыл бы карточку под указателем. Такой щелчок приходит не всегда
// (шторка под указателем уже убрана), поэтому ждём его недолго и не дольше следующего нажатия: настоящий щелчок съедать нельзя.
function swallowClick() {
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); stop() }
  const stop = () => {
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('pointerdown', stop, true)
  }
  window.addEventListener('click', swallow, true)
  window.addEventListener('pointerdown', stop, true)
  setTimeout(stop, 100)
}

function listenPointer(e, onMove, onUp, onCancel) {
  const own = (fn) => (ev) => { if (ev.pointerId === e.pointerId) fn(ev) }
  // Кнопки уже нет, а отпускания не было: его съело другое окно (Alt+Tab посреди жеста).
  const move = own((ev) => (ev.buttons === 0 ? onCancel(ev) : onMove(ev)))
  const up = own(onUp)
  const cancel = own(onCancel)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  return () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
  }
}

// Прокрутка удержанием: нажать и вести влево-вправо. onEnd — кнопку отпустили. Возвращает отмену (страницу закрыли посреди
// жеста).
export function panByDrag(e, box, onEnd) {
  const startX = e.clientX
  const startLeft = box.scrollLeft
  let veil = null
  let unlisten = () => {}
  const finish = () => {
    unlisten()
    veil?.remove()
    box.classList.remove('is-panning')
    onEnd()
  }
  unlisten = listenPointer(e, (ev) => {
    const dx = ev.clientX - startX
    if (!veil) {
      if (Math.abs(dx) < MOVE_THRESHOLD) return
      veil = addVeil(box)
      box.classList.add('is-panning')
    }
    box.scrollLeft = startLeft - dx
  }, () => {
    if (veil) swallowClick()
    finish()
  }, finish)
  return finish
}

// Колонка под указателем и место в ней. Над колонкой, в которую нельзя бросить, и вне доски — null: карточка вернётся на место.
function findTarget(box, x, y, draggedId) {
  const rect = box.getBoundingClientRect()
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null
  const columns = box.querySelectorAll(':scope > .dc-column')
  let column = null
  for (const col of columns) {
    const r = col.getBoundingClientRect()
    if (x <= r.right) { column = col; break }
  }
  column ||= columns[columns.length - 1]
  if (!column || column.dataset.droppable !== 'true') return null
  const body = column.querySelector('.dc-column-body')
  const bodyRect = body.getBoundingClientRect()
  const py = Math.min(Math.max(y, bodyRect.top), bodyRect.bottom)
  const cards = [...body.children].filter(el => el.dataset.card && el.dataset.card !== draggedId)
  // Первая карточка, чья середина ниже указателя: над верхней половиной — перед ней, над нижней — после. Заглушка места и
  // промежутки между карточками ничего не меняют, поэтому бросок на прежнее место — это прежнее место.
  let lo = 0
  let hi = cards.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = cards[mid].getBoundingClientRect()
    if (r.top + r.height / 2 < py) lo = mid + 1
    else hi = mid
  }
  return { column: column.dataset.status, beforeId: cards[lo]?.dataset.card ?? null }
}

const sameTarget = (a, b) => a === b || (!!a && !!b && a.column === b.column && a.beforeId === b.beforeId)

const edgeStep = (pos, from, to, zone) => {
  const size = Math.min(zone, (to - from) / 4)
  const depth = pos < from + size ? pos - (from + size) : pos > to - size ? pos - (to - size) : 0
  return depth ? Math.sign(depth) * Math.min(MAX_STEP, Math.ceil((Math.abs(depth) / size) * MAX_STEP)) : 0
}

// Перетаскивание карточки: за указателем едет её копия, колонка показывает заглушкой, куда она встанет.
// onStart — порог пройден, onTarget(место | null) — место сменилось, onDrop(место | null) — отпустили; onCancel — отмена
// (Escape, потеря указателя); onEnd — кнопку отпустили, был жест или нет. Возвращает отмену (страницу закрыли посреди жеста).
export function dragCard(e, { box, card, draggedId, onStart, onTarget, onDrop, onCancel, onEnd }) {
  const startX = e.clientX
  const startY = e.clientY
  let x = startX
  let y = startY
  let ghost = null
  let veil = null
  let frame = 0
  let target = null
  let offsetX = 0
  let offsetY = 0
  let unlisten = () => {}

  const clear = () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('keydown', onKey, true)
    ghost?.remove()
    veil?.remove()
    ghost = null
    veil = null
  }
  const finish = () => { unlisten(); clear(); onEnd() }
  const updateTarget = () => {
    const next = findTarget(box, x, y, draggedId)
    if (!sameTarget(next, target)) {
      target = next
      onTarget(next)
    }
  }
  const tick = () => {
    ghost.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px) rotate(1.5deg)`
    const rect = box.getBoundingClientRect()
    const stepX = edgeStep(x, rect.left, rect.right, EDGE_ZONE_X)
    if (stepX) box.scrollLeft += stepX
    if (target) {
      const body = box.querySelector(`:scope > .dc-column[data-status="${CSS.escape(target.column)}"] .dc-column-body`)
      if (body && body.scrollHeight > body.clientHeight) {
        const r = body.getBoundingClientRect()
        const stepY = edgeStep(y, r.top, r.bottom, EDGE_ZONE_Y)
        if (stepY) body.scrollTop += stepY
      }
    }
    updateTarget()
    frame = requestAnimationFrame(tick)
  }
  const begin = () => {
    const rect = card.getBoundingClientRect()
    offsetX = startX - rect.left
    offsetY = startY - rect.top
    box.style.setProperty('--dc-slot-h', `${rect.height}px`)
    ghost = card.cloneNode(true)
    ghost.classList.add('dc-drag-ghost')
    ghost.removeAttribute('data-id')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.style.width = `${rect.width}px`
    ghost.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px) rotate(1.5deg)`
    veil = addVeil(box)
    box.appendChild(ghost)
    window.addEventListener('keydown', onKey, true)
    onStart()
    frame = requestAnimationFrame(tick)
  }
  // Escape посреди жеста: кнопка ещё нажата, и её отпускание — щелчок, которого никто не хотел.
  let aborted = false
  function onKey(ev) {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    aborted = true
    clear()
    onCancel()
  }

  unlisten = listenPointer(e, (ev) => {
    x = ev.clientX
    y = ev.clientY
    if (!ghost && !aborted && Math.hypot(x - startX, y - startY) >= MOVE_THRESHOLD) begin()
  }, (ev) => {
    x = ev.clientX
    y = ev.clientY
    const dragged = !!ghost
    // Последнее положение могло не дойти до кадра.
    if (dragged) updateTarget()
    if (dragged || aborted) swallowClick()
    finish()
    if (dragged) onDrop(target)
  }, () => {
    const dragged = !!ghost
    finish()
    if (dragged) onCancel()
  })
  return finish
}
