import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './TenderRdCodesTab.css'

// Вкладка «Шифр РД» внутри тендера: перечень шифров рабочей документации,
// по которой идёт тендер. Шифров у тендера обычно несколько (АР, КЖ, ОВ…),
// поэтому это список, а не одно поле. Заполняется вручную инженером.
//
// Порядок строк ручной (sort_order с шагом 10): разделы РД перечисляют в
// принятой последовательности, а не по алфавиту.

const SORT_STEP = 10
const EMPTY_FORM = { code: '', title: '', notes: '' }

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function TenderRdCodesTab({ tenderId, canEdit = false, onCountChange }) {
  const { userProfile } = useRole()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // { id } | 'new' | null
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('tender_rd_codes')
        .select('*')
        .eq('tender_id', tenderId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
      if (err) throw err
      setRows(data || [])
      onCountChange?.(data?.length || 0)
    } catch (err) {
      console.error('Ошибка загрузки шифров РД:', err.message)
      // 42P01 — таблицы нет: миграция ещё не применена. Говорим об этом прямо,
      // иначе пустая вкладка выглядит как «шифров не завели».
      setError(String(err.message || '').includes('42P01') || String(err.message || '').includes('does not exist')
        ? 'Раздел недоступен: не применена миграция 20260901_tender_rd_codes.'
        : err.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [tenderId, onCountChange])

  useEffect(() => { load() }, [load])

  const startAdd = () => { setEditing('new'); setForm(EMPTY_FORM) }
  const startEdit = (row) => {
    setEditing({ id: row.id })
    setForm({ code: row.code || '', title: row.title || '', notes: row.notes || '' })
  }
  const cancel = () => { setEditing(null); setForm(EMPTY_FORM) }

  const save = async () => {
    const code = form.code.trim()
    if (!code) { alert('Укажите шифр РД'); return }
    setSaving(true)
    try {
      if (editing === 'new') {
        // Новая строка встаёт в конец: sort_order считаем от максимума среди
        // уже существующих, а не от их количества — иначе после удалений
        // строки начали бы конфликтовать по порядку.
        const maxSort = rows.reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
        const { error: err } = await supabase.from('tender_rd_codes').insert([{
          tender_id: tenderId,
          code,
          title: form.title.trim() || null,
          notes: form.notes.trim() || null,
          sort_order: maxSort + SORT_STEP,
          created_by_name: userProfile?.full_name || null,
        }])
        if (err) throw err
      } else {
        const { error: err } = await supabase
          .from('tender_rd_codes')
          .update({
            code,
            title: form.title.trim() || null,
            notes: form.notes.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editing.id)
        if (err) throw err
      }
      cancel()
      await load()
    } catch (err) {
      console.error('Ошибка сохранения шифра РД:', err.message)
      alert('Не удалось сохранить: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row) => {
    if (!window.confirm(`Удалить шифр «${row.code}»?`)) return
    try {
      const { error: err } = await supabase.from('tender_rd_codes').delete().eq('id', row.id)
      if (err) throw err
      await load()
    } catch (err) {
      console.error('Ошибка удаления шифра РД:', err.message)
      alert('Не удалось удалить: ' + err.message)
    }
  }

  // Перестановка соседних строк. Полноценный drag-and-drop здесь избыточен:
  // шифров единицы, а стрелки работают и с клавиатуры.
  const move = async (index, delta) => {
    const target = index + delta
    if (target < 0 || target >= rows.length) return
    const a = rows[index]
    const b = rows[target]
    try {
      const { error: e1 } = await supabase.from('tender_rd_codes')
        .update({ sort_order: b.sort_order }).eq('id', a.id)
      const { error: e2 } = await supabase.from('tender_rd_codes')
        .update({ sort_order: a.sort_order }).eq('id', b.id)
      if (e1 || e2) throw (e1 || e2)
      await load()
    } catch (err) {
      console.error('Ошибка изменения порядка шифров РД:', err.message)
      alert('Не удалось изменить порядок: ' + err.message)
    }
  }

  if (loading) return <div className="trd-empty">Загрузка…</div>
  if (error) return <div className="trd-error">{error}</div>

  return (
    <div className="trd-tab">
      <div className="trd-head">
        <div>
          <h3 className="trd-title">Шифр РД</h3>
          <p className="trd-hint">Шифры рабочей документации, по которой идёт тендер.</p>
        </div>
        {canEdit && editing !== 'new' && (
          <button type="button" className="btn-primary" onClick={startAdd}>+ Добавить шифр</button>
        )}
      </div>

      {editing === 'new' && (
        <RdForm form={form} setForm={setForm} onSave={save} onCancel={cancel} saving={saving} />
      )}

      {rows.length === 0 && editing !== 'new' ? (
        <div className="trd-empty">
          Шифры РД не указаны.
          {canEdit && ' Нажмите «Добавить шифр», чтобы внести первый.'}
        </div>
      ) : rows.length > 0 && (
        <div className="trd-table-wrap">
          <table className="trd-table">
            <thead>
              <tr>
                <th className="trd-col-num">№</th>
                <th className="trd-col-code">Шифр</th>
                <th>Наименование раздела</th>
                <th>Примечание</th>
                <th className="trd-col-meta">Добавлено</th>
                {canEdit && <th className="trd-col-actions"></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                editing?.id === row.id ? (
                  <tr key={row.id}>
                    <td colSpan={canEdit ? 6 : 5}>
                      <RdForm form={form} setForm={setForm} onSave={save} onCancel={cancel} saving={saving} />
                    </td>
                  </tr>
                ) : (
                  <tr key={row.id}>
                    <td className="trd-col-num">{i + 1}</td>
                    <td className="trd-col-code"><span className="trd-code">{row.code}</span></td>
                    <td>{row.title || <span className="trd-muted">—</span>}</td>
                    <td className="trd-notes">{row.notes || <span className="trd-muted">—</span>}</td>
                    <td className="trd-col-meta">
                      <span className="trd-meta-date">{formatDateTime(row.created_at)}</span>
                      {row.created_by_name && <span className="trd-meta-who">{row.created_by_name}</span>}
                    </td>
                    {canEdit && (
                      <td className="trd-col-actions">
                        <div className="trd-actions">
                          <button type="button" className="trd-icon-btn" title="Выше"
                            disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                          <button type="button" className="trd-icon-btn" title="Ниже"
                            disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                          <button type="button" className="trd-icon-btn" title="Редактировать"
                            onClick={() => startEdit(row)}>✎</button>
                          <button type="button" className="trd-icon-btn trd-icon-danger" title="Удалить"
                            onClick={() => remove(row)}>×</button>
                        </div>
                      </td>
                    )}
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RdForm({ form, setForm, onSave, onCancel, saving }) {
  return (
    <div className="trd-form">
      <div className="trd-form-row">
        <label className="trd-field">
          <span className="trd-field-label">Шифр *</span>
          <input
            type="text"
            autoFocus
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave() } }}
            placeholder="2024-15-АР"
          />
        </label>
        <label className="trd-field trd-field-wide">
          <span className="trd-field-label">Наименование раздела</span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave() } }}
            placeholder="Архитектурные решения"
          />
        </label>
      </div>
      <label className="trd-field">
        <span className="trd-field-label">Примечание</span>
        <input
          type="text"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave() } }}
          placeholder="Необязательно"
        />
      </label>
      <div className="trd-form-actions">
        <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>Отмена</button>
      </div>
    </div>
  )
}
