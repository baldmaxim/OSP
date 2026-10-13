// Онлайн-обновление счётчиков участников в реестре тендеров («участвует / КП предоставлено»).
//
// Раньше любое событие по tender_counterparties — в том числе правка примечания или порядка участника у
// чужого тендера — заставляло каждую открытую вкладку реестра перечитывать участников ВСЕХ тендеров:
// дюжина запросов на событие, сразу и без паузы. При серии правок это давало лавину запросов.
// Теперь перечитываются только затронутые тендеры и одним запросом на серию событий.

// Меняет ли правка участника счётчики реестра. Они зависят только от статуса и от того, чей участник.
// Прежней строки в событии может не быть (или в ней только ключ) — тогда считаем, что меняет.
export function participantChangeAffectsCounts(newRow, oldRow) {
  if (!newRow) return false
  if (!oldRow || !('status' in oldRow) || !('tender_id' in oldRow)) return true
  return oldRow.status !== newRow.status || oldRow.tender_id !== newRow.tender_id
}

// Копит id и отдаёт их одной пачкой через delayMs после первого. Повторы в пачке схлопываются.
// flush(ids) вызывается не чаще раза в delayMs; cancel() — отменить ожидание (уход со страницы).
export function createIdBatcher(flush, delayMs) {
  const ids = new Set()
  let timer = null
  return {
    add(id) {
      if (id == null || id === '') return
      ids.add(id)
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const batch = [...ids]
        ids.clear()
        if (batch.length) flush(batch)
      }, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      ids.clear()
    },
  }
}
