// Работа с календарной неделей. Используется там, где что-то происходит «раз в
// неделю»: ротация ответственного по тендерам и вторничное напоминание об
// обзвоне. Неделя считается с понедельника, время — локальное.

// Понедельник недели для даты (00:00 локального времени).
export function mondayOf(dateInput) {
  const d = new Date(dateInput)
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7 // 0=Пн … 6=Вс
  d.setDate(d.getDate() - dow)
  return d
}

// Ключ недели 'YYYY-MM-DD' (дата понедельника). Сравнивая ключи, можно понять,
// та же это неделя или уже следующая, без возни с номерами недель ISO.
export function weekKey(dateInput) {
  const m = mondayOf(dateInput)
  const p = (x) => String(x).padStart(2, '0')
  return `${m.getFullYear()}-${p(m.getMonth() + 1)}-${p(m.getDate())}`
}

// Вторник ли сегодня. Отдельной функцией, чтобы условие читалось словами.
export function isTuesday(date = new Date()) {
  return date.getDay() === 2
}
