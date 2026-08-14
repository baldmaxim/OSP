import { useState, useEffect } from 'react'
import { userStatus } from './StatusBadge'
import FilterDropdown from '../FilterDropdown'

// Правая выдвижная панель редактирования пользователя — единственная поверхность правки
// (никаких постоянных select в строках таблицы). Сохранение идёт через onSave(form),
// который возвращает Promise; ошибки и индикатор загрузки показываем здесь.
export default function UserEditDrawer({ user, roleOptions, objectOptions, counterpartyOptions = [], onClose, onSave }) {
  const current = user ? userStatus(user) : 'active'
  const [form, setForm] = useState(() => ({
    full_name: user?.full_name || '',
    work_phone: user?.work_phone || '',
    work_email: user?.work_email || '',
    role: user?.role || 'engineer',
    // Несколько объектов на пользователя. Откат на одиночный object_id (до миграции).
    object_ids: Array.isArray(user?.object_ids)
      ? user.object_ids
      : (user?.object_id ? [user.object_id] : []),
    // Привязка логина к контрагенту → кабинет подрядчика (пусто = сотрудник СУ-10).
    counterparty_id: user?.counterparty_id || '',
    status: current,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Escape закрывает панель (если не идёт сохранение). Блокируем прокрутку фона.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, saving])

  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const statusOptions = current === 'pending'
    ? [{ v: 'pending', l: 'Приглашён (ожидает подтверждения)' }, { v: 'active', l: 'Активен' }]
    : [{ v: 'active', l: 'Активен' }, { v: 'blocked', l: 'Заблокирован' }]

  const submit = async (e) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await onSave({
        full_name: form.full_name.trim() || null,
        work_phone: form.work_phone.trim() || null,
        work_email: form.work_email.trim() || null,
        role: form.role,
        object_ids: form.object_ids || [],
        counterparty_id: form.counterparty_id || null,
        // Активен → подтверждён; иначе доступ снят (pending/blocked).
        is_approved: form.status === 'active',
      })
    } catch (err) {
      setError(err.message || 'Не удалось сохранить изменения')
      setSaving(false)
    }
  }

  return (
    <div className="adm-drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <aside className="adm-drawer" role="dialog" aria-modal="true" aria-label="Редактирование пользователя">
        <header className="adm-drawer-header">
          <div>
            <h3>Редактирование пользователя</h3>
            <p className="adm-drawer-sub">{user?.email || 'учётная запись без email'}</p>
          </div>
          <button type="button" className="adm-drawer-close" onClick={onClose} aria-label="Закрыть" disabled={saving}>×</button>
        </header>

        <form className="adm-drawer-body" onSubmit={submit}>
          <label className="adm-drawer-field">
            <span>ФИО</span>
            <input type="text" value={form.full_name} autoFocus
              onChange={(e) => set({ full_name: e.target.value })} placeholder="Фамилия Имя Отчество" />
          </label>

          <label className="adm-drawer-field">
            <span>Email (учётная запись)</span>
            <input type="email" value={user?.email || ''} readOnly disabled title="Логин-email не редактируется" />
          </label>

          <div className="adm-drawer-row">
            <label className="adm-drawer-field">
              <span>Телефон</span>
              <input type="tel" value={form.work_phone}
                onChange={(e) => set({ work_phone: e.target.value })} placeholder="+7 ..." />
            </label>
            <label className="adm-drawer-field">
              <span>Рабочая почта</span>
              <input type="email" value={form.work_email}
                onChange={(e) => set({ work_email: e.target.value })} placeholder="name@su10.ru" />
            </label>
          </div>

          <div className="adm-drawer-row">
            <label className="adm-drawer-field">
              <span>Роль</span>
              <select value={form.role} onChange={(e) => set({ role: e.target.value })}>
                {roleOptions.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
            </label>
            <div className="adm-drawer-field">
              <span>Подразделения / объекты</span>
              <FilterDropdown
                label=""
                multiple
                searchable
                searchPlaceholder="Поиск объекта…"
                allLabel="Офис (все объекты)"
                value={form.object_ids}
                onChange={(v) => set({ object_ids: v })}
                options={objectOptions.map(o => ({ value: o.id, label: o.name }))}
              />
            </div>
          </div>

          <div className="adm-drawer-field">
            <span>Контрагент (кабинет подрядчика)</span>
            <FilterDropdown
              label=""
              searchable
              searchPlaceholder="Поиск контрагента…"
              allLabel="— сотрудник СУ-10 —"
              value={form.counterparty_id || ''}
              onChange={(v) => set({ counterparty_id: v || '' })}
              options={counterpartyOptions.map(c => ({ value: c.id, label: c.name }))}
            />
            <small className="adm-drawer-hint">
              Если выбрать контрагента — этот логин становится кабинетом подрядчика и видит только договоры этой организации (согласование условий). Пусто = сотрудник СУ-10.
            </small>
          </div>

          <label className="adm-drawer-field">
            <span>Статус</span>
            <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {statusOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </label>

          <p className="adm-drawer-note">Логин-email (учётная запись) здесь не меняется — это авторизационные данные.</p>

          {error && <div className="adm-drawer-error">{error}</div>}

          <footer className="adm-drawer-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить изменения'}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  )
}
