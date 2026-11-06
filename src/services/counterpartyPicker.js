import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { isMissingBoardColumn } from '../utils/docCheckHelpers'

// Контрагенты для выбора в списке с поиском по названию, ИНН и постоянному номеру (utils/counterpartyPicker.js).
// Читается весь реестр, а не только действующие: без колонки counterparty_number (база раньше миграции 20261225) номер
// считается тем же порядком, что в реестре контрагентов, а он идёт по всем строкам — с чёрным списком и удалёнными.
// Кого предлагать — решает isPickableCounterparty.
const BASE = 'id, name, inn, status, deleted_at'

export async function fetchPickerCounterparties() {
  const read = (select) => fetchAllRows((from, to) => db
    .from('counterparties')
    .select(select)
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
  try {
    return await read(`${BASE}, counterparty_number`)
  } catch (err) {
    if (!isMissingBoardColumn(err)) throw err
    return read(BASE)
  }
}
