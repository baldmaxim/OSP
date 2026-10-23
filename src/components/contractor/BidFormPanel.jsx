import { useState } from 'react'
import { saveForm } from '../../services/contractorBids'
import { VAT_FIELD_CODE } from '../../utils/bidForm'

// Анкета «Квалификационная и контактная информация» по тендеру. Поля ведёт администратор (bid_form_fields): текст
// или выбор из списка (ставка НДС — как выпадающий список на «Главном листе» ВОР); их можно добавлять,
// переименовывать и скрывать — анкета строится по списку. Ответ пишется при уходе из поля, выбор из списка — сразу
// (bid_form_save). Ответы прошлого тендера организации — по кнопке «Подставить». Поля и ответы грузит BidWorkspace:
// ставка НДС нужна итогам расценки и до открытия анкеты.

export default function BidFormPanel({ tenderId, canEdit, fields, answers, previous, error: loadError, onAnswers, onPreviousUsed }) {
  const [status, setStatus] = useState({}) // id поля → 'dirty' | 'saving' | 'saved' | 'error'
  const [error, setError] = useState('')

  const commit = async (patch) => {
    const ids = Object.keys(patch)
    setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, 'saving'])) }))
    setError('')
    try {
      await saveForm(tenderId, patch)
      setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, 'saved'])) }))
    } catch (e) {
      setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, 'error'])) }))
      setError(e.message || String(e))
    }
  }

  const fillFromPrevious = async () => {
    const active = new Map((fields || []).map((f) => [f.id, f]))
    const patch = {}
    for (const [id, v] of Object.entries(previous?.answers || {})) {
      const f = active.get(id)
      if (!f || !v?.value || answers[id]) continue
      if (f.kind === 'select' && !(f.options || []).includes(v.value)) continue
      patch[id] = v.value
    }
    onPreviousUsed?.()
    if (!Object.keys(patch).length) return
    onAnswers((a) => ({ ...a, ...patch }))
    await commit(patch)
  }

  if (fields === null) return <div className="bid-state">Загрузка анкеты…</div>
  if (!fields.length) return <div className="bid-state">{loadError ? `Анкета не загрузилась: ${loadError}` : 'Анкета пока не настроена.'}</div>

  const filled = fields.filter((f) => String(answers[f.id] || '').trim()).length
  const stateText = (id) => (status[id] === 'saving' ? 'сохраняем…' : status[id] === 'saved' ? 'сохранено' : status[id] === 'error' ? 'не сохранено' : '')
  return (
    <div className="bid-form">
      <div className="bid-filters">
        <span className="bid-filters-total">Заполнено {filled} из {fields.length}</span>
        {canEdit && previous && (
          <button type="button" className="cab-btn" onClick={fillFromPrevious}>Подставить ответы из прошлой анкеты</button>
        )}
      </div>
      {(error || loadError) && <div className="bid-note is-warn">{error || loadError}</div>}
      <ol className="bid-form-list">
        {fields.map((f) => (
          <li key={f.id} className={`bid-form-row${f.code === VAT_FIELD_CODE ? ' is-vat' : ''}`}>
            <label className="bid-form-label" htmlFor={`bid-f-${f.id}`}>
              {f.label}
              {f.hint && <span className="bid-form-hint">{f.hint}</span>}
            </label>
            <div className="bid-form-input">
              {f.kind === 'select' ? (
                <select
                  id={`bid-f-${f.id}`}
                  className="bid-select bid-form-select"
                  value={answers[f.id] || ''}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const v = e.target.value
                    onAnswers((a) => ({ ...a, [f.id]: v }))
                    commit({ [f.id]: v })
                  }}
                >
                  <option value="">— выберите —</option>
                  {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  {answers[f.id] && !(f.options || []).includes(answers[f.id]) && <option value={answers[f.id]}>{answers[f.id]}</option>}
                </select>
              ) : (
                <textarea
                  id={`bid-f-${f.id}`}
                  rows={1}
                  maxLength={2000}
                  value={answers[f.id] || ''}
                  disabled={!canEdit}
                  placeholder={canEdit ? (f.hint || 'ответ') : ''}
                  onChange={(e) => {
                    const v = e.target.value
                    onAnswers((a) => ({ ...a, [f.id]: v }))
                    setStatus((s) => ({ ...s, [f.id]: 'dirty' }))
                  }}
                  onBlur={() => { if (status[f.id] === 'dirty') commit({ [f.id]: answers[f.id] || '' }) }}
                />
              )}
              <span className={`bid-form-state is-${status[f.id] || 'idle'}`} aria-live="polite">{stateText(f.id)}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
