// «Администрирование» → «Добавить пользователя» без сервера. Роли — в порядке справочника базы: первым администратор.
//   addUserNoGuest=1 — роли «Гость» в справочнике нет (она не системная, её можно удалить).
// window.__createdUsers — что ушло на сервер (adminCreateUser в fake-role.jsx).
import '../../../src/pages/AdminPage.css'
import { AddUserDrawer } from '../../../src/components/admin/AccountModals'

const noGuest = new URLSearchParams(window.location.search).get('addUserNoGuest') === '1'
const ROLE_OPTIONS = [
  { key: 'admin', label: 'Администратор' },
  { key: 'engineer', label: 'Инженер ОСП' },
  { key: 'lawyer', label: 'Юрист ОСП' },
  ...(noGuest ? [] : [{ key: 'guest', label: 'Гость' }]),
  { key: 'smetno', label: 'Сметно-технический отдел' },
]

export default function AddUserStand() {
  return <AddUserDrawer roleOptions={ROLE_OPTIONS} onClose={() => {}} onCreated={() => {}} />
}
