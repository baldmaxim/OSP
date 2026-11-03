import { useEffect, useMemo, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { createWinnerCounterparty, fetchWinnerCandidates } from '../services/tenderConceptAgreement'
import { CP_STATUS_ACTIVE, CP_STATUS_BLACKLIST, cpStatusLabel } from '../utils/counterpartyStatus'
import { counterpartySearchIndex, searchCounterparties, searchKey } from '../utils/counterpartySearch'
import { innProblem } from '../utils/tenderConceptAgreement'
import { IconTrash } from './icons/ActionIcons'
import './ConceptAgreementStep.css'

const MAX_RESULTS = 8

// Победитель, который в тендере не участвовал: из базы контрагентов, а если там его нет — запись вручную. В участники
// тендера он не добавляется: КП он не присылал, и отчёты по участию это не должно исказить.
// selected — [{ counterparty_id, scope_note, name }], participantIds — Set участников (их выбирают в списке выше).
export default function WinnerFromBase({ selected, participantIds, tenderLabel, onAdd, onRemove, onScope }) {
  const { userProfile, user } = useRole()
  const [list, setList] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(null)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    fetchWinnerCandidates()
      .then((rows) => { if (alive) setList(rows) })
      .catch((err) => { if (alive) setLoadError(err.message) })
    return () => { alive = false }
  }, [])

  const index = useMemo(() => {
    const byId = new Map()
    return (cp) => {
      if (!byId.has(cp.id)) byId.set(cp.id, counterpartySearchIndex(cp))
      return byId.get(cp.id)
    }
  }, [])

  const typed = query.trim()
  const found = useMemo(() => (
    list && typed ? searchCounterparties(list, typed, index).items : []
  ), [list, typed, index])

  const selectedIds = new Set(selected.map((w) => w.counterparty_id))
  const extras = selected.filter((w) => !participantIds.has(w.counterparty_id))

  const pick = (cp) => {
    onAdd({ counterparty_id: cp.id, scope_note: '', name: cp.name })
    setQuery('')
  }

  const openForm = () => {
    setForm({ name: typed, inn: '' })
    setFormError('')
  }

  const submitForm = async () => {
    const name = form.name.trim()
    const inn = form.inn.trim()
    if (!name) { setFormError('Укажите название контрагента'); return }
    const badInn = innProblem(inn)
    if (badInn) { setFormError(badInn); return }
    if (!list) { setFormError('База контрагентов ещё загружается'); return }
    // Дубль ловим до записи: UNIQUE на названии нет. Один ИНН бывает и у разных записей (филиалы) — как в реестре контрагентов, по вопросу.
    const sameName = list.find((cp) => searchKey(cp.name) === searchKey(name))
    if (sameName) {
      setFormError(`«${sameName.name}» уже есть в базе: выберите его из списка`)
      setQuery(sameName.name)
      return
    }
    const sameInn = inn && list.find((cp) => (cp.inn || '').trim() === inn)
    if (sameInn && !window.confirm(`ИНН ${inn} уже указан у контрагента «${sameInn.name}». Всё равно добавить новую запись?`)) return

    setSaving(true)
    setFormError('')
    try {
      const cp = await createWinnerCounterparty({ name, inn }, {
        role: localStorage.getItem('userRole') || null,
        userName: userProfile?.full_name || user?.email || null,
        tenderLabel,
      })
      setList((prev) => [...(prev || []), cp])
      setForm(null)
      pick(cp)
    } catch (err) {
      setFormError(`Контрагент не добавлен: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="wfb">
      <p className="wfb-title">Победитель не участвовал в тендере?</p>

      {extras.map((w) => (
        <div className="wfb-chosen" key={w.counterparty_id}>
          <span className="wfb-chosen-name">{w.name || 'Контрагент'}</span>
          <input
            className="wfb-input"
            type="text"
            value={w.scope_note || ''}
            onChange={(e) => onScope(w.counterparty_id, e.target.value)}
            placeholder="Корпус / система (необязательно)"
            aria-label={`Корпус или система: ${w.name || 'контрагент'}`}
          />
          <button type="button" className="cas-remove" onClick={() => onRemove(w.counterparty_id)} aria-label={`Убрать победителя ${w.name || ''}`} title="Убрать">
            <IconTrash size={14} />
          </button>
        </div>
      ))}

      <input
        className="wfb-input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск в базе: название или ИНН"
        aria-label="Найти победителя в базе контрагентов"
      />

      {loadError && <p className="cas-error" role="alert">База контрагентов не загрузилась: {loadError}</p>}
      {!list && !loadError && typed && <p className="wfb-hint">Загружаем базу контрагентов…</p>}

      {found.length > 0 && (
        <ul className="wfb-results">
          {found.slice(0, MAX_RESULTS).map((cp) => {
            const chosen = selectedIds.has(cp.id)
            const participant = participantIds.has(cp.id)
            return (
              <li key={cp.id}>
                <button type="button" className="wfb-result" disabled={chosen} onClick={() => pick(cp)}>
                  <span className="wfb-result-name">{cp.name}</span>
                  <span className="wfb-result-meta">
                    {[cp.inn && `ИНН ${cp.inn}`, cp.work_type, chosen ? 'уже выбран' : participant && 'участник тендера'].filter(Boolean).join(' · ')}
                    {cp.status && cp.status !== CP_STATUS_ACTIVE && (
                      <span className={cp.status === CP_STATUS_BLACKLIST ? 'is-warning' : undefined}> · {cpStatusLabel(cp.status)}</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {found.length > MAX_RESULTS && <p className="wfb-hint">Показаны первые {MAX_RESULTS} из {found.length}: уточните запрос.</p>}
      {list && typed && found.length === 0 && <p className="wfb-hint">В базе контрагентов не нашлось.</p>}

      {form ? (
        <div className="wfb-form">
          <label>
            Название *
            <input
              className="wfb-input"
              type="text"
              value={form.name}
              maxLength={255}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label>
            ИНН
            <input
              className="wfb-input"
              type="text"
              inputMode="numeric"
              value={form.inn}
              maxLength={12}
              onChange={(e) => setForm((f) => ({ ...f, inn: e.target.value }))}
            />
          </label>
          {formError && <p className="cas-error" role="alert">{formError}</p>}
          <div className="wfb-form-actions">
            <button type="button" className="btn-primary" onClick={submitForm} disabled={saving}>{saving ? 'Добавляем…' : 'Добавить в базу и выбрать'}</button>
            <button type="button" className="btn-secondary" onClick={() => setForm(null)} disabled={saving}>Отмена</button>
          </div>
        </div>
      ) : (
        <button type="button" className="wfb-add" onClick={openForm}>+ Нет в базе: добавить вручную</button>
      )}
    </div>
  )
}
