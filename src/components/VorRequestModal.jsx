import { useState } from 'react'
import FilterDropdown from './FilterDropdown'
import S3DocumentList from './S3DocumentList'
import {
  createVorRequest, updateVorRequest, isMissingVorRequestsTable, VOR_REQUESTS_MIGRATION_HINT,
  REQUEST_OWNER_TYPE, REQUEST_RD_CATEGORY, REQUEST_VOR_CATEGORY,
} from '../services/vorRequests'
import './S3DocumentList.css'
import './VorRequestModal.css'

// Заявка на подготовку ВОР без привязки к тендеру.
//   request = null — создание новой заявки (направление — текущее на странице);
//   request задан — просмотр: описание, примечание, файлы РД и ВОР, удаление.
// Статус, подразделение, ответственного СТО, срок и ссылку заявки правят прямо в
// строке таблицы — так же, как у тендеров.

const DEPARTMENT_LABEL = { construction: 'основное строительство', joint: 'совместные тендеры' }

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU')
}

export default function VorRequestModal({
  request = null, department = 'construction', canEdit = false,
  objects = [], stoEmployees = [], divisions = [], byName = null,
  onClose, onCreated, onUpdated, onDocsChanged,
}) {
  const isCreate = !request
  const [form, setForm] = useState(() => ({
    object_id: request?.object_id || '',
    work_description: request?.work_description || '',
    notes: request?.notes || '',
    vor_division: request?.vor_division || '',
    vor_sto_user_id: request?.vor_sto_user_id || '',
    vor_end_date: request?.vor_end_date || '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const describe = (err) => (isMissingVorRequestsTable(err) ? VOR_REQUESTS_MIGRATION_HINT : (err?.message || String(err)))

  const handleCreate = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.object_id) { setError('Выберите объект'); return }
    if (!form.work_description.trim()) { setError('Опишите, какие работы нужно посчитать'); return }
    const emp = form.vor_sto_user_id ? stoEmployees.find((x) => x.user_id === form.vor_sto_user_id) : null
    setSaving(true)
    try {
      const row = await createVorRequest({
        department,
        object_id: form.object_id,
        work_description: form.work_description.trim(),
        notes: form.notes.trim() || null,
        vor_division: form.vor_division || null,
        vor_sto_user_id: emp ? emp.user_id : null,
        vor_sto_name: emp ? emp.display_name : null,
        vor_end_date: form.vor_end_date || null,
        created_by_name: byName,
      })
      onCreated?.(row)
    } catch (err) {
      setError(describe(err))
    } finally {
      setSaving(false)
    }
  }

  const saveTexts = async () => {
    const description = form.work_description.trim()
    if (!description) { setError('Описание работ не может быть пустым'); return }
    const patch = { work_description: description, notes: form.notes.trim() || null }
    setSaving(true)
    setError('')
    try {
      await updateVorRequest(request.id, patch)
      onUpdated?.(request.id, patch)
    } catch (err) {
      setError(describe(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleDeleted = async () => {
    const deleting = !request.deleted_at
    if (deleting && !window.confirm(`Удалить заявку на ВОР № ${request.request_number}? Её можно будет восстановить во вкладке «Удалённые».`)) return
    const patch = { deleted_at: deleting ? new Date().toISOString() : null }
    setSaving(true)
    try {
      await updateVorRequest(request.id, patch)
      onUpdated?.(request.id, patch)
      if (deleting) onClose?.()
    } catch (err) {
      setError(describe(err))
    } finally {
      setSaving(false)
    }
  }

  const textsChanged = !isCreate && (
    form.work_description.trim() !== (request.work_description || '')
    || (form.notes.trim() || '') !== (request.notes || ''))

  const objectOptions = objects.map((o) => ({ value: o.id, label: o.name }))

  return (
    <div className="s3-doc-modal-overlay">
      <div className="s3-doc-modal vrq-modal" role="dialog" aria-modal="true" style={{ height: 'auto', maxHeight: '92vh' }}>
        <div className="s3-doc-modal-header">
          <span className="s3-doc-modal-title">
            {isCreate
              ? `Новая заявка на ВОР — ${DEPARTMENT_LABEL[department] || ''}`
              : `Заявка на ВОР № ${request.request_number}${request.objects?.name ? ` — ${request.objects.name}` : ''}`}
          </span>
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>

        <div className="s3-doc-modal-body vrq-body">
          {isCreate ? (
            <form className="vrq-form" onSubmit={handleCreate}>
              <p className="vrq-hint">
                Заявка без тендера: ВОР нужен заранее или тендер не планируется. Начало срока — дата
                создания заявки; статус, ответственного и ссылку можно менять в строке таблицы.
              </p>
              <label className="vrq-field">
                <span>Объект *</span>
                <FilterDropdown
                  className="vrq-fdrop"
                  label="" searchable
                  searchPlaceholder="Поиск объекта…"
                  allLabel="— выберите объект —"
                  value={form.object_id}
                  onChange={(v) => set({ object_id: v || '' })}
                  options={objectOptions}
                />
              </label>
              <label className="vrq-field">
                <span>Описание работ *</span>
                <textarea
                  rows={3}
                  value={form.work_description}
                  onChange={(e) => set({ work_description: e.target.value })}
                  placeholder="Какие работы нужно посчитать"
                  autoFocus
                />
              </label>
              <div className="vrq-row">
                <label className="vrq-field">
                  <span>Подразделение</span>
                  <select value={form.vor_division} onChange={(e) => set({ vor_division: e.target.value })}>
                    <option value="">— не указано —</option>
                    {divisions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </label>
                <label className="vrq-field">
                  <span>Срок подготовки (до)</span>
                  <input
                    type="date"
                    value={form.vor_end_date}
                    onChange={(e) => set({ vor_end_date: e.target.value })}
                    min={new Date().toISOString().slice(0, 10)}
                  />
                </label>
              </div>
              <label className="vrq-field">
                <span>Ответственный СТО</span>
                <select value={form.vor_sto_user_id} onChange={(e) => set({ vor_sto_user_id: e.target.value })}>
                  <option value="">— не назначен —</option>
                  {stoEmployees.map((emp) => <option key={emp.user_id} value={emp.user_id}>{emp.display_name}</option>)}
                </select>
              </label>
              <label className="vrq-field">
                <span>Примечание</span>
                <textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
              </label>
              {error && <div className="vrq-error">{error}</div>}
              <div className="vrq-actions">
                <button type="button" className="vrq-secondary" onClick={onClose} disabled={saving}>Отмена</button>
                <button type="submit" className="s3-doc-btn-primary" disabled={saving}>
                  {saving ? 'Создание…' : 'Создать заявку'}
                </button>
              </div>
            </form>
          ) : (
            <div className="vrq-view">
              <div className="vrq-meta">
                <span>Создана {formatDate(request.created_at)}{request.created_by_name ? ` · ${request.created_by_name}` : ''}</span>
                {request.deleted_at && <span className="vrq-deleted">Удалена {formatDate(request.deleted_at)}</span>}
              </div>
              <label className="vrq-field">
                <span>Описание работ</span>
                <textarea
                  rows={3}
                  value={form.work_description}
                  onChange={(e) => set({ work_description: e.target.value })}
                  readOnly={!canEdit}
                />
              </label>
              <label className="vrq-field">
                <span>Примечание</span>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => set({ notes: e.target.value })}
                  readOnly={!canEdit}
                />
              </label>
              {error && <div className="vrq-error">{error}</div>}
              {canEdit && (
                <div className="vrq-actions">
                  <button type="button" className="vrq-danger" onClick={toggleDeleted} disabled={saving}>
                    {request.deleted_at ? 'Восстановить заявку' : 'Удалить заявку'}
                  </button>
                  <button type="button" className="s3-doc-btn-primary" onClick={saveTexts} disabled={saving || !textsChanged}>
                    {saving ? 'Сохранение…' : 'Сохранить'}
                  </button>
                </div>
              )}

              <section className="vrq-docs">
                <h3 className="vrq-docs-title">Рабочая документация</h3>
                <S3DocumentList
                  ownerType={REQUEST_OWNER_TYPE}
                  ownerId={request.id}
                  category={REQUEST_RD_CATEGORY}
                  title="Файлы РД"
                  canEdit={canEdit}
                  onChange={onDocsChanged}
                />
              </section>
              <section className="vrq-docs">
                <h3 className="vrq-docs-title">Ведомость объёмов работ</h3>
                <S3DocumentList
                  ownerType={REQUEST_OWNER_TYPE}
                  ownerId={request.id}
                  category={REQUEST_VOR_CATEGORY}
                  title="Файлы ВОР"
                  canEdit={canEdit}
                  onChange={onDocsChanged}
                />
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
