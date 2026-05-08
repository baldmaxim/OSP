import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import './DocumentCheckPage.css'

const COLUMNS = [
  { key: 'new', label: 'Новая заявка', accent: '#6366f1' },
  { key: 'in_progress', label: 'В работе', accent: '#0891b2' },
  { key: 'edo_export', label: 'Выгрузка по ЭДО', accent: '#ca8a04' },
  { key: '1c_entry', label: 'Занесение в 1С', accent: '#9333ea' },
  { key: 'completed', label: 'Завершено', accent: '#16a34a' },
]

const COLUMN_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]))

const emptyForm = () => ({
  object_id: '',
  counterparty_id: '',
  doc_type: 'ДП',
  doc_number: '',
  doc_date: new Date().toISOString().slice(0, 10),
  notes: '',
})

function DocumentCheckPage() {
  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyForm())
  const [dragOverColumn, setDragOverColumn] = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true)
      const [reqRes, objRes, cpRes] = await Promise.all([
        supabase
          .from('document_check_requests')
          .select('*, objects(name), counterparties(name)')
          .order('created_at', { ascending: true }),
        supabase.from('objects').select('id, name').order('name'),
        supabase.from('counterparties').select('id, name').eq('status', 'active').order('name'),
      ])
      if (reqRes.error) throw reqRes.error
      setRequests(reqRes.data || [])
      setObjects(objRes.data || [])
      setCounterparties(cpRes.data || [])
    } catch (err) {
      console.error('Ошибка загрузки данных проверки документов:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const handleOpenAdd = () => {
    setEditing(null)
    setForm(emptyForm())
    setShowModal(true)
  }

  const handleOpenEdit = (req) => {
    setEditing(req)
    setForm({
      object_id: req.object_id || '',
      counterparty_id: req.counterparty_id || '',
      doc_type: req.doc_type,
      doc_number: req.doc_number,
      doc_date: req.doc_date,
      notes: req.notes || '',
    })
    setShowModal(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.doc_number.trim()) {
      alert('Укажите № документа')
      return
    }
    if (!form.doc_date) {
      alert('Укажите дату документа')
      return
    }
    const payload = {
      object_id: form.object_id || null,
      counterparty_id: form.counterparty_id || null,
      doc_type: form.doc_type,
      doc_number: form.doc_number.trim(),
      doc_date: form.doc_date,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editing) {
        const { error } = await supabase
          .from('document_check_requests')
          .update(payload)
          .eq('id', editing.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('document_check_requests')
          .insert([{ ...payload, status: 'new' }])
        if (error) throw error
      }
      setShowModal(false)
      setEditing(null)
      setForm(emptyForm())
      fetchAll()
    } catch (err) {
      console.error('Ошибка сохранения заявки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleDelete = async (req) => {
    if (!window.confirm(`Удалить заявку «${req.doc_type} № ${req.doc_number}»?`)) return
    try {
      const { error } = await supabase
        .from('document_check_requests')
        .delete()
        .eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.filter(r => r.id !== req.id))
    } catch (err) {
      console.error('Ошибка удаления заявки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleMove = async (reqId, newStatus) => {
    try {
      const { error } = await supabase
        .from('document_check_requests')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', reqId)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === reqId ? { ...r, status: newStatus } : r))
    } catch (err) {
      console.error('Ошибка перемещения заявки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleDragStart = (e, reqId) => {
    e.dataTransfer.setData('text/plain', reqId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e, columnKey) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverColumn !== columnKey) setDragOverColumn(columnKey)
  }

  const handleDragLeave = () => {
    setDragOverColumn(null)
  }

  const handleDrop = (e, columnKey) => {
    e.preventDefault()
    setDragOverColumn(null)
    const reqId = e.dataTransfer.getData('text/plain')
    if (!reqId) return
    const req = requests.find(r => r.id === reqId)
    if (req && req.status !== columnKey) handleMove(reqId, columnKey)
  }

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('ru-RU') : '—'

  const requestsByColumn = COLUMNS.reduce((acc, col) => {
    acc[col.key] = requests.filter(r => r.status === col.key)
    return acc
  }, {})

  return (
    <div className="document-check-page">
      <div className="page-header page-header-doc-check">
        <h2><span className="page-icon" aria-hidden>📑</span> Проверка ДП/ДС</h2>
        <button className="btn-primary" onClick={handleOpenAdd}>
          + Новая заявка
        </button>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <div className="kanban-board">
          {COLUMNS.map(col => {
            const items = requestsByColumn[col.key]
            return (
              <div
                key={col.key}
                className={`kanban-column ${dragOverColumn === col.key ? 'drag-over' : ''}`}
                onDragOver={(e) => handleDragOver(e, col.key)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.key)}
              >
                <div className="kanban-column-header" style={{ borderTopColor: col.accent }}>
                  <span className="kanban-column-title">{col.label}</span>
                  <span className="kanban-column-count">{items.length}</span>
                </div>
                <div className="kanban-column-body">
                  {items.length === 0 ? (
                    <div className="kanban-empty">Пусто</div>
                  ) : (
                    items.map(req => {
                      const colIdx = COLUMNS.findIndex(c => c.key === req.status)
                      const prevKey = colIdx > 0 ? COLUMNS[colIdx - 1].key : null
                      const nextKey = colIdx < COLUMNS.length - 1 ? COLUMNS[colIdx + 1].key : null
                      return (
                        <div
                          key={req.id}
                          className="kanban-card"
                          draggable
                          onDragStart={(e) => handleDragStart(e, req.id)}
                        >
                          <div className="kanban-card-top">
                            <span className={`doc-type-badge doc-type-${req.doc_type === 'ДП' ? 'dp' : 'ds'}`}>
                              {req.doc_type}
                            </span>
                            <span className="kanban-card-number">№ {req.doc_number}</span>
                            <span className="kanban-card-date">от {formatDate(req.doc_date)}</span>
                          </div>
                          {req.counterparties?.name && (
                            <div className="kanban-card-row">
                              <span className="kanban-card-label">Контрагент:</span>
                              <span>{req.counterparties.name}</span>
                            </div>
                          )}
                          {req.objects?.name && (
                            <div className="kanban-card-row">
                              <span className="kanban-card-label">Объект:</span>
                              <span>{req.objects.name}</span>
                            </div>
                          )}
                          {req.notes && (
                            <div className="kanban-card-notes">{req.notes}</div>
                          )}
                          <div className="kanban-card-actions">
                            <button
                              className="kanban-btn"
                              disabled={!prevKey}
                              onClick={() => prevKey && handleMove(req.id, prevKey)}
                              title={prevKey ? `← ${COLUMN_BY_KEY[prevKey].label}` : 'Первая колонка'}
                            >←</button>
                            <button
                              className="kanban-btn kanban-btn-edit"
                              onClick={() => handleOpenEdit(req)}
                              title="Редактировать"
                            >✏️</button>
                            <button
                              className="kanban-btn kanban-btn-delete"
                              onClick={() => handleDelete(req)}
                              title="Удалить"
                            >🗑️</button>
                            <button
                              className="kanban-btn"
                              disabled={!nextKey}
                              onClick={() => nextKey && handleMove(req.id, nextKey)}
                              title={nextKey ? `${COLUMN_BY_KEY[nextKey].label} →` : 'Последняя колонка'}
                            >→</button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? 'Редактировать заявку' : 'Новая заявка на проверку'}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group">
                  <label>Тип *</label>
                  <select
                    value={form.doc_type}
                    onChange={(e) => setForm({ ...form, doc_type: e.target.value })}
                    required
                  >
                    <option value="ДП">ДП — Договор подряда</option>
                    <option value="ДС">ДС — Дополнительное соглашение</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>№ документа *</label>
                  <input
                    type="text"
                    value={form.doc_number}
                    onChange={(e) => setForm({ ...form, doc_number: e.target.value })}
                    required
                    placeholder="Например, 12-А-2026"
                  />
                </div>
                <div className="form-group">
                  <label>Дата документа *</label>
                  <input
                    type="date"
                    value={form.doc_date}
                    onChange={(e) => setForm({ ...form, doc_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Контрагент</label>
                  <select
                    value={form.counterparty_id}
                    onChange={(e) => setForm({ ...form, counterparty_id: e.target.value })}
                  >
                    <option value="">— не выбран —</option>
                    {counterparties.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group full-width">
                  <label>Объект</label>
                  <select
                    value={form.object_id}
                    onChange={(e) => setForm({ ...form, object_id: e.target.value })}
                  >
                    <option value="">— не выбран —</option>
                    {objects.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group full-width">
                  <label>Примечание</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={3}
                    placeholder="Особенности проверки, ответственный, и т.д."
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editing ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentCheckPage
