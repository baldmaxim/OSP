// «Администрирование» → «Права доступа» без сервера: роли и права — в таблицах стенда. Контрагенты и объекты — как их
// передаёт AdminPage. window.__rolePreview — с чем включили просмотр от имени роли (fake-role.jsx).
import '../../../src/pages/AdminPage.css'
import { useState } from 'react'
import AccessRightsTab from '../../../src/components/admin/AccessRightsTab'

const db = window.__fakeDb
db.roles = [
  { key: 'admin', label: 'Администратор', is_system: true },
  { key: 'engineer', label: 'Инженер ОСП', is_system: true },
  { key: 'contractor', label: 'Подрядчик', is_system: true },
  { key: 'smetno', label: 'Сметно-технический отдел', is_system: false },
]
db.role_permissions = [{ id: 'rp-1', role: 'engineer', section: 'tenders', can_view: true, can_edit: false }]
db.user_roles = db.user_roles || []
window.__fakeUnique = { ...(window.__fakeUnique || {}), roles: ['key'] }

const OBJECTS = [{ id: 'obj-1', name: 'ЖК «Северный квартал»' }, { id: 'obj-2', name: 'Бизнес-центр «Нурлы»' }]
const COUNTERPARTIES = [{ id: 'cp-1', name: 'ООО Подрядчик Один' }, { id: 'cp-2', name: 'ООО Подрядчик Два' }]

export default function AccessRightsStand() {
  const [counterparties, setCounterparties] = useState([])
  return (
    <div className="admin-page">
      <div className="admin-panel">
        <div className="admin-tabpane">
          <AccessRightsTab
            objects={OBJECTS}
            counterparties={counterparties}
            onNeedCounterparties={() => {
              window.__counterpartiesRequested = (window.__counterpartiesRequested || 0) + 1
              setCounterparties(COUNTERPARTIES)
            }}
          />
        </div>
      </div>
    </div>
  )
}
