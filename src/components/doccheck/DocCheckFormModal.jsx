import { useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import DocCheckLabelsInput from './DocCheckLabelsInput'
import { IconObject, IconUser } from '../icons/ToolbarIcons'
import { safeHttpUrl } from '../../utils/publicTenders'
import {
  DOC_CHECK_COLORS,
  DOC_CHECK_PRIORITIES,
  DOC_CHECK_STATUS_LABEL,
  DOC_TYPES,
  MAX_CREATOR_NAME,
  assigneeIdsToSave,
  assigneeStaffOptions,
  createdFieldsPatch,
  normalizeLabels,
  shownAssigneeIds,
  toDateTimeInput,
} from '../../utils/docCheckHelpers'

// Форма заявки на проверку ДП/ДС.
//
// Объект и контрагент вводятся руками и НЕ привязаны к реестру «Договоры и ДС»:
// проверка идёт как раз до того, как договор туда заводят, поэтому выбирать
// там нечего. Контрагента может не быть (заявка по письму) — тогда нужно
// примечание: по нему карточку и узнают на доске.
//
// Статуса в форме нет: новая заявка встаёт в колонку, где нажали «+ Добавить
// заявку» (по кнопке в шапке — в «Новые заявки»), дальше её двигают по доске.
// Исполнители, срок, приоритет, цвет и метки — только при колонках 20261113
// (hasBoardFields); без них форма прежняя. Ссылка на письмо — только при колонках
// 20261124 (hasCardFields). Исполнителем выбирают только юриста ОСП. Дату создания и
// автора заявки меняет только администратор, у созданной заявки (canEditCreated).

const EMPTY = {
  object_id: '', counterparty_id: '', doc_type: 'ds', doc_number: '', doc_date: '', notes: '',
  assignee_ids: [], due_date: '', priority: '', color: '', labels: [], email_link: '',
}

export default function DocCheckFormModal({
  request, status, objects, counterparties, employees, labelSuggestions,
  hasBoardFields, hasCardFields, canEditCreated, onSave, onClose,
}) {
  const [form, setForm] = useState(() => (request
    ? {
      object_id: request.object_id || '',
      counterparty_id: request.counterparty_id || '',
      doc_type: request.doc_type || 'ds',
      doc_number: request.doc_number || '',
      doc_date: request.doc_date || '',
      notes: request.notes || '',
      assignee_ids: shownAssigneeIds(request, employees),
      due_date: request.due_date || '',
      priority: request.priority || '',
      color: request.color || '',
      labels: request.labels || [],
      email_link: request.email_link || '',
      created_at: toDateTimeInput(request.created_at),
      created_by_name: request.created_by_name || '',
    }
    : EMPTY))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (patch) => { setForm(f => ({ ...f, ...patch })); setError('') }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.counterparty_id && !form.notes.trim()) {
      setError('Укажите контрагента или опишите заявку в примечании')
      return
    }
    const emailLink = form.email_link.trim()
    if (hasCardFields && emailLink && !safeHttpUrl(emailLink)) {
      setError('Ссылка на письмо — адрес вида https://…')
      return
    }
    const created = request && canEditCreated ? createdFieldsPatch(request, form.created_at, form.created_by_name) : { patch: {} }
    if (created.error) {
      setError(created.error)
      return
    }
    setSaving(true)
    try {
      const payload = {
        object_id: form.object_id || null,
        counterparty_id: form.counterparty_id || null,
        doc_type: form.doc_type,
        doc_number: form.doc_number.trim() || null,
        doc_date: form.doc_date || null,
        notes: form.notes.trim() || null,
      }
      if (hasBoardFields) {
        Object.assign(payload, {
          assignee_ids: assigneeIdsToSave(request?.assignee_ids, form.assignee_ids, employees),
          due_date: form.due_date || null,
          priority: form.priority || null,
          color: form.color || null,
          labels: normalizeLabels(form.labels),
        })
      }
      if (hasCardFields) {
        payload.email_link = emailLink || null
      }
      Object.assign(payload, created.patch)
      await onSave(payload)
    } finally {
      setSaving(false)
    }
  }

  // Кого подсказать в «Кто создал»: любой сотрудник, не только юрист. Ввод свободный: автор мог уже уйти из компании.
  const creatorNames = [...new Set([...employees.values()].map(e => e.display_name || e.full_name || e.email).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dc-form-modal" role="dialog" aria-modal="true" aria-label={request ? 'Изменить заявку' : 'Новая заявка'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{request ? 'Изменить заявку' : 'Новая заявка на проверку'}</h3>
            {!request && status && (
              <p className="dc-detail-sub">Колонка: {DOC_CHECK_STATUS_LABEL[status] || status}</p>
            )}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <form className="dc-form" onSubmit={handleSubmit}>
          <div className="dc-form-row">
            <span className="dc-form-label">Тип документа</span>
            <div className="dc-type-switch">
              {DOC_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`dc-type-opt${form.doc_type === t.value ? ' is-active' : ''}`}
                  aria-pressed={form.doc_type === t.value}
                  onClick={() => set({ doc_type: t.value })}
                  title={t.title}
                >{t.label} — {t.title}</button>
              ))}
            </div>
          </div>

          <div className="dc-form-grid">
            <div className="dc-form-row">
              <label htmlFor="dc-num">Номер документа</label>
              <input
                id="dc-num"
                type="text"
                value={form.doc_number}
                onChange={(e) => set({ doc_number: e.target.value })}
                placeholder="СУ-10-001"
              />
            </div>
            <div className="dc-form-row">
              <label htmlFor="dc-date">Дата документа</label>
              <input
                id="dc-date"
                type="date"
                value={form.doc_date}
                onChange={(e) => set({ doc_date: e.target.value })}
              />
            </div>
          </div>

          <div className="dc-form-grid">
            <div className="dc-form-row">
              <span className="dc-form-label">Контрагент</span>
              <FilterDropdown
                label=""
                searchable
                searchPlaceholder="Поиск контрагента…"
                allLabel="Не выбран"
                icon={<IconUser size={15} />}
                value={form.counterparty_id}
                onChange={(v) => set({ counterparty_id: v || '' })}
                options={counterparties.map(c => ({ value: c.id, label: c.name }))}
              />
            </div>
            <div className="dc-form-row">
              <span className="dc-form-label">Объект</span>
              <FilterDropdown
                label=""
                searchable
                searchPlaceholder="Поиск объекта…"
                allLabel="Не выбран"
                icon={<IconObject size={15} />}
                value={form.object_id}
                onChange={(v) => set({ object_id: v || '' })}
                options={objects.map(o => ({ value: o.id, label: o.name }))}
              />
            </div>
          </div>

          <div className="dc-form-row">
            <label htmlFor="dc-notes">Примечание</label>
            <textarea
              id="dc-notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder="Что проверить, что запросили и у кого — видно на карточке"
            />
          </div>

          {hasCardFields && (
            <div className="dc-form-row">
              <label htmlFor="dc-email-link">Ссылка на письмо</label>
              <input
                id="dc-email-link"
                type="text"
                inputMode="url"
                value={form.email_link}
                onChange={(e) => set({ email_link: e.target.value })}
                placeholder="https://…"
              />
            </div>
          )}

          {hasBoardFields && (
            <>
              <div className="dc-form-grid">
                <div className="dc-form-row">
                  <span className="dc-form-label">Исполнители</span>
                  <FilterDropdown
                    label=""
                    multiple
                    searchable
                    searchPlaceholder="Поиск юриста…"
                    allLabel="Не назначены"
                    icon={<IconUser size={15} />}
                    value={form.assignee_ids}
                    onChange={(v) => set({ assignee_ids: v })}
                    options={assigneeStaffOptions(employees)}
                    className="dc-form-assignees"
                  />
                </div>
                <div className="dc-form-row">
                  <label htmlFor="dc-due">Срок</label>
                  <input
                    id="dc-due"
                    type="date"
                    value={form.due_date}
                    onChange={(e) => set({ due_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="dc-form-grid dc-form-grid--wide">
                <div className="dc-form-row">
                  <span className="dc-form-label">Приоритет</span>
                  <div className="dc-type-switch">
                    {[{ value: '', label: 'Не указан' }, ...DOC_CHECK_PRIORITIES].map(p => (
                      <button
                        key={p.value || 'none'}
                        type="button"
                        className={`dc-type-opt${form.priority === p.value ? ' is-active' : ''}`}
                        aria-pressed={form.priority === p.value}
                        onClick={() => set({ priority: p.value })}
                      >{p.label}</button>
                    ))}
                  </div>
                </div>
                <div className="dc-form-row">
                  <span className="dc-form-label">Цвет карточки</span>
                  <div className="dc-menu-colors">
                    <button
                      type="button"
                      className={`dc-swatch dc-swatch--none${!form.color ? ' is-current' : ''}`}
                      aria-label="Без цвета"
                      aria-pressed={!form.color}
                      title="Без цвета"
                      onClick={() => set({ color: '' })}
                    />
                    {DOC_CHECK_COLORS.map(c => (
                      <button
                        key={c.value}
                        type="button"
                        className={`dc-swatch dc-c-${c.value}${form.color === c.value ? ' is-current' : ''}`}
                        aria-label={c.label}
                        aria-pressed={form.color === c.value}
                        title={c.label}
                        onClick={() => set({ color: c.value })}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="dc-form-row">
                <span className="dc-form-label">Метки</span>
                <DocCheckLabelsInput
                  value={form.labels}
                  onChange={(labels) => set({ labels })}
                  suggestions={labelSuggestions}
                />
              </div>
            </>
          )}

          {request && canEditCreated && (
            <div className="dc-form-admin">
              <p className="dc-form-admin-title">Создание заявки — меняет только администратор</p>
              <div className="dc-form-grid">
                <div className="dc-form-row">
                  <label htmlFor="dc-created-at">Дата создания</label>
                  <input
                    id="dc-created-at"
                    type="datetime-local"
                    value={form.created_at}
                    onChange={(e) => set({ created_at: e.target.value })}
                  />
                </div>
                <div className="dc-form-row">
                  <label htmlFor="dc-created-by">Кто создал</label>
                  <input
                    id="dc-created-by"
                    type="text"
                    list="dc-created-by-names"
                    maxLength={MAX_CREATOR_NAME}
                    value={form.created_by_name}
                    onChange={(e) => set({ created_by_name: e.target.value })}
                    placeholder="ФИО"
                  />
                  <datalist id="dc-created-by-names">
                    {creatorNames.map(name => <option key={name} value={name} />)}
                  </datalist>
                </div>
              </div>
            </div>
          )}

          {error && <p className="dc-form-error" role="alert">{error}</p>}

          <div className="dc-form-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : (request ? 'Сохранить' : 'Создать заявку')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
