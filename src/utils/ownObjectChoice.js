// Объект новой заявки у сотрудника, привязанного к объектам в «Ролях» (решения пользователя 06.11.2026: «Заявка на заключение ДП»,
// затем «Заявки на проверку ДП/ДС»). Один объект — он и стоит, выбирать нечего (поле серое); несколько — выбор обязателен. Без
// привязки — правило не действует: у каждого раздела своё (ДП — объект ставит отдел, проверка — необязательный выбор из всех).
// ownObjects: null — список ещё читается, массив — свои объекты; failed — не прочитался.
export function ownObjectChoice({ ownObjects, failed = false, objectId = '' }) {
  if (failed) return { objectId: '', single: null, problem: 'список ваших объектов не загрузился — обновите страницу' }
  if (ownObjects == null) return { objectId: '', single: null, problem: 'дождитесь списка ваших объектов' }
  if (ownObjects.length === 1) return { objectId: ownObjects[0].id, single: ownObjects[0], problem: null }
  // Объектов из привязки в базе нет (удалены) — правило молчит: что делать без объекта, решает раздел.
  if (ownObjects.length === 0) return { objectId: '', single: null, problem: null }
  const picked = ownObjects.some((o) => o.id === objectId) ? objectId : ''
  return { objectId: picked, single: null, problem: picked ? null : 'выберите объект' }
}
