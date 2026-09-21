import { useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import { IconObject, IconUser } from '../icons/ToolbarIcons'
import { DOC_TYPES } from '../../utils/docCheckHelpers'

// Форма заявки на проверку ДП/ДС.
//
// Объект и контрагент вводятся руками и НЕ привязаны к реестру «Договоры и ДС»:
// проверка идёт как раз до того, как договор туда заводят, поэтому выбирать
// там нечего.
//
// Статуса в форме нет намеренно — тот же приём, что в заявках на ДС: новая
// заявка всегда попадает в первую колонку, дальше её двигают по доске.

const EMPTY = { object_id: '', counterparty_id: '', doc_type: 'ds', doc_number: '', doc_date: '', notes: '' }

export default function DocCheckFormModal({ request, objects, counterparties, onSave, onClose }) {
  const [form, setForm] = useState(() => (request
    ? {
      object_id: request.object_id || '',
      counterparty_id: request.counterparty_id || '',
      doc_type: request.doc_type || 'ds',
      doc_number: request.doc_number || '',
      doc_date: request.doc_date || '',
      notes: request.notes || '',
    }
    : EMPTY))
  const [saving, setSaving] = useState(false)
  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.counterparty_id) { alert('Укажите контрагента'); return }
    setSaving(true)
    try {
      await onSave({
        object_id: form.object_id || null,
        counterparty_id: form.counterparty_id,
        doc_type: form.doc_type,
        doc_number: form.doc_number.trim() || null,
        doc_date: form.doc_date || null,
        notes: form.notes.trim() || null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dc-form-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{request ? 'Изменить заявку' : 'Новая заявка на проверку'}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <form className="dc-form" onSubmit={handleSubmit}>
          <div className="dc-form-row">
            <label>Тип документа</label>
            <div className="dc-type-switch">
              {DOC_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`dc-type-opt${form.doc_type === t.value ? ' is-active' : ''}`}
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

          <div className="dc-form-row">
            <label>Объект</label>
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

          <div className="dc-form-row">
            <label>Контрагент</label>
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
            <label htmlFor="dc-notes">Примечание</label>
            <textarea
              id="dc-notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder="Что именно проверить, на что обратить внимание"
            />
          </div>

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
