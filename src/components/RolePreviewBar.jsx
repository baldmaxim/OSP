import { useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import './RolePreviewBar.css'

// Полоса режима «посмотреть глазами роли». Живёт поверх всех страниц (включая
// кабинет подрядчика), поэтому подключается в App, а не внутри layout'а
// сотрудника: из предпросмотра подрядчика иначе было бы не выйти.
//
// Честно предупреждаем, что это предпросмотр интерфейса: запросы уходят под
// реальным пользователем, поэтому ограничения БД остаются администраторскими.
function RolePreviewBar() {
  const { previewActive, previewInfo, roleLabels, stopRolePreview } = useRole()
  const [collapsed, setCollapsed] = useState(false)

  if (!previewActive) return null

  const roleLabel = roleLabels?.[previewInfo.role] || previewInfo.role
  const objectsCount = previewInfo.objectIds?.length || 0

  return (
    <div className={`role-preview-bar${collapsed ? ' is-collapsed' : ''}`} role="status">
      <div className="rpb-main">
        <span className="rpb-dot" aria-hidden />
        <span className="rpb-text">
          Просмотр интерфейса от имени: <strong>{roleLabel}</strong>
          {previewInfo.counterparty?.name && <> · {previewInfo.counterparty.name}</>}
          {objectsCount > 0 && <> · объектов: {objectsCount}</>}
        </span>
      </div>
      {!collapsed && (
        <span className="rpb-note">
          Меню, разделы и кнопки — как у роли. Доступ к данным остаётся вашим: запросы
          в базу идут под вашей учётной записью, изменения сохранятся от вашего имени.
        </span>
      )}
      <div className="rpb-actions">
        <button
          type="button"
          className="rpb-collapse"
          onClick={() => setCollapsed(v => !v)}
          title={collapsed ? 'Показать пояснение' : 'Свернуть'}
        >{collapsed ? '▴' : '▾'}</button>
        <button type="button" className="rpb-exit" onClick={stopRolePreview}>
          Вернуться к своей роли
        </button>
      </div>
    </div>
  )
}

export default RolePreviewBar
