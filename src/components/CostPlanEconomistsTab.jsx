import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteCostPlanEconomist, fetchCostPlanEconomists, fetchEconomistCandidates, fetchEconomistObjects,
  saveCostPlanEconomist,
} from '../services/costPlanEconomists'
import {
  COST_PLAN_ECONOMISTS_MIGRATION_HINT, economistOptions, groupByEconomist, objectLabel,
} from '../utils/costPlanEconomists'
import { phoneHref } from '../utils/siteContacts'
import { describeSupabaseError } from '../utils/supabaseError'
import './CostPlanEconomistsTab.css'

// «Документы» → «Экономисты ОСП» («Планы затрат» и «Общая информация → Отделы»): кто из экономистов ОСП отвечает
// за планы затрат каких объектов. Сверху — карточка на экономиста со списком его объектов, под ними — объекты
// основного строительства без экономиста. Администратор назначает и меняет экономиста объекта в списке ниже.
// Новому тендеру основного строительства экономист объекта сразу ставится ответственным за план затрат (форма
// тендера, TendersPage); уже созданные тендеры не меняются.

function OptionList({ options }) {
  return options.map(c => (
    <option key={c.id} value={c.id}>{c.full_name}{c.position ? ` — ${c.position}` : ''}</option>
  ))
}

export default function CostPlanEconomistsTab({ canEdit = false }) {
  const [state, setState] = useState({ loading: true, rows: [], objects: [], supported: true, error: null })
  const [candidates, setCandidates] = useState([])
  const [savingId, setSavingId] = useState(null)
  const [saveError, setSaveError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [assigned, objects] = await Promise.all([fetchCostPlanEconomists(), fetchEconomistObjects()])
      setState({ loading: false, rows: assigned.rows, objects, supported: assigned.supported, error: null })
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: describeSupabaseError(err) }))
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Справочник сотрудников нужен только тому, кто назначает.
  useEffect(() => {
    if (!canEdit || !state.supported) return undefined
    let alive = true
    fetchEconomistCandidates()
      .then(list => { if (alive) setCandidates(list) })
      .catch(err => { if (alive) setSaveError('Список сотрудников не загрузился: ' + describeSupabaseError(err)) })
    return () => { alive = false }
  }, [canEdit, state.supported])

  const { groups, unassigned } = useMemo(() => groupByEconomist(state.rows, state.objects), [state.rows, state.objects])
  const assignedByObject = useMemo(() => new Map(state.rows.map(r => [r.object_id, r.contact_id])), [state.rows])
  const options = useMemo(() => economistOptions(candidates, state.rows.map(r => r.contact_id)), [candidates, state.rows])
  // Назначать — объектам основного строительства; объект гарантийного отдела в списке, только если ему уже назначен.
  const editableObjects = useMemo(() => state.objects
    .filter(o => o.status === 'main_construction' || assignedByObject.has(o.id))
    .map(o => ({ ...o, label: objectLabel(o.name) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru')), [state.objects, assignedByObject])

  const handleChange = async (objectId, contactId) => {
    setSavingId(objectId)
    setSaveError(null)
    try {
      if (contactId) {
        const row = await saveCostPlanEconomist(objectId, contactId)
        setState(prev => ({ ...prev, rows: [...prev.rows.filter(r => r.object_id !== objectId), row] }))
      } else {
        await deleteCostPlanEconomist(objectId)
        setState(prev => ({ ...prev, rows: prev.rows.filter(r => r.object_id !== objectId) }))
      }
    } catch (err) {
      setSaveError('Не сохранено: ' + describeSupabaseError(err))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="tdm-body cpe">
      <p className="tdm-lead">
        Экономист ОСП отвечает за планы затрат объекта. Новому тендеру основного строительства он сразу ставится
        ответственным за план затрат — сменить можно в форме тендера, в «Планах затрат» и в карточке тендера.
      </p>

      {state.loading ? (
        <p className="tdm-site-empty-state">Загрузка…</p>
      ) : state.error ? (
        <p className="tdm-site-alert is-error" role="alert">
          Не удалось загрузить экономистов: {state.error}{' '}
          <button type="button" className="tdm-site-link" onClick={() => { setState(p => ({ ...p, loading: true })); load() }}>
            Повторить
          </button>
        </p>
      ) : !state.supported ? (
        <p className="tdm-note">{COST_PLAN_ECONOMISTS_MIGRATION_HINT}</p>
      ) : (
        <>
          {groups.length === 0 ? (
            <p className="tdm-site-empty-state">Экономисты ОСП объектам ещё не назначены.</p>
          ) : (
            <div className="cpe-cards">
              {groups.map(g => {
                const tel = phoneHref(g.contact.phone)
                return (
                  <section key={g.contact.id || g.contact.full_name} className="cpe-card"
                    aria-label={`Экономист ${g.contact.full_name}`}>
                    <span className="cpe-role">Экономист</span>
                    <span className="tdm-person">{g.contact.full_name || 'Сотрудник удалён из справочника'}</span>
                    {g.contact.phone && (
                      <span className="cpe-phone">
                        {tel ? <a href={tel}>{g.contact.phone}</a> : g.contact.phone}
                      </span>
                    )}
                    <ul className="cpe-objects">
                      {g.objects.map(o => <li key={o.id}>{o.name}</li>)}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}

          {unassigned.length > 0 && (
            <p className="tdm-note cpe-unassigned">
              Без экономиста ОСП ({unassigned.length}): {unassigned.map(o => o.name).join(', ')}.
              {canEdit ? ' Назначить — в списке ниже.' : ' Назначает администратор.'}
            </p>
          )}

          {canEdit && (
            <>
              <p className="tdm-label">Назначение по объектам</p>
              {saveError && <p className="tdm-site-alert is-error" role="alert">{saveError}</p>}
              <ul className="tdm-site-list cpe-assign">
                {editableObjects.map(o => {
                  const value = assignedByObject.get(o.id) || ''
                  return (
                    <li key={o.id} className="tdm-site-row cpe-assign-row">
                      <span className="tdm-site-div">{o.label}</span>
                      <select
                        value={value}
                        disabled={savingId === o.id}
                        onChange={(e) => handleChange(o.id, e.target.value)}
                        aria-label={`Экономист ОСП: ${o.label}`}
                      >
                        <option value="">Не назначен</option>
                        {options.osp.length > 0 && (
                          <optgroup label="ОСП"><OptionList options={options.osp} /></optgroup>
                        )}
                        {options.others.length > 0 && (
                          <optgroup label="Остальные сотрудники"><OptionList options={options.others} /></optgroup>
                        )}
                      </select>
                      <span className="cpe-saving" aria-live="polite">{savingId === o.id ? 'Сохраняем…' : ''}</span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
