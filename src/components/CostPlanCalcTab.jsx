import { useCallback, useEffect, useMemo, useState } from 'react'
import S3DocumentList from './S3DocumentList'
import { IconPencil } from './icons/ActionIcons'
import { deleteCompensation, fetchCalcAnchors, fetchCompensation, saveCompensation } from '../services/costPlanCalc'
import { fetchEconomistObjects } from '../services/costPlanEconomists'
import {
  COMPENSATION_NOTE_MAX, COST_PLAN_CALC_CATEGORY, COST_PLAN_CALC_FILES_HINT, COST_PLAN_CALC_SECTIONS,
  COST_PLAN_COMPENSATION_HINT, compensationTable, parseCompensation,
} from '../utils/costPlanCalc'
import { describeSupabaseError } from '../utils/supabaseError'
import './CostPlanCalcTab.css'

// «Планы затрат» → «Документы» → «Расчёт ПЗ» (миграция 20261116_cost_plan_calc):
//   • подвкладки «Прямые затраты» и «КП до перекидок» — у каждой свой список файлов (шаблоны, образцы расчёта):
//     скачивает и смотрит каждый, загружает и удаляет администратор (canEdit);
//   • внизу, под обеими подвкладками, — «Компенсация НДС и инфляции по объектам»: по строке на объект основного
//     строительства, сведения по НДС и по инфляции рядом, текстом; учитываются в каждом плане затрат объекта.
//     Вносит и меняет администратор.

function CompensationSection({ canEdit }) {
  const [state, setState] = useState({ loading: true, rows: [], objects: [], supported: true, error: null })
  const [editing, setEditing] = useState(null) // { objectId, label, vat, inflation }
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [comp, objects] = await Promise.all([fetchCompensation(), fetchEconomistObjects()])
      setState({ loading: false, rows: comp.rows, objects, supported: comp.supported, error: null })
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: describeSupabaseError(err) }))
    }
  }, [])

  useEffect(() => { load() }, [load])

  const table = useMemo(() => compensationTable(state.objects, state.rows), [state.objects, state.rows])
  const anyFilled = table.some(r => r.filled)

  const startEdit = (r) => {
    setFormError(null)
    setEditing({ objectId: r.id, label: r.label, vat: r.vat || '', inflation: r.inflation || '' })
  }
  const cancelEdit = () => { setEditing(null); setFormError(null) }

  const submit = async () => {
    const parsed = parseCompensation(editing)
    if (parsed.error) { setFormError(parsed.error); return }
    const { objectId } = editing
    setBusy(true)
    setFormError(null)
    try {
      if (parsed.empty) {
        if (state.rows.some(r => r.object_id === objectId)) await deleteCompensation(objectId)
        setState(prev => ({ ...prev, rows: prev.rows.filter(r => r.object_id !== objectId) }))
      } else {
        const row = await saveCompensation(objectId, parsed.value)
        setState(prev => ({ ...prev, rows: [...prev.rows.filter(r => r.object_id !== objectId), row] }))
      }
      setEditing(null)
    } catch (err) {
      setFormError('Не сохранено: ' + describeSupabaseError(err))
    } finally {
      setBusy(false)
    }
  }

  // Escape — отменить правку, а не закрыть окно; Ctrl+Enter — сохранить.
  const onFieldKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancelEdit() }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
  }
  const field = (name, title) => (
    <textarea
      className="cpc-input"
      rows={3}
      maxLength={COMPENSATION_NOTE_MAX}
      value={editing[name]}
      onChange={(e) => setEditing(prev => ({ ...prev, [name]: e.target.value }))}
      onKeyDown={onFieldKeyDown}
      disabled={busy}
      aria-label={`${title}: ${editing.label}`}
      autoFocus={name === 'vat'}
    />
  )
  const cols = canEdit ? 4 : 3

  return (
    <section className="cpc-comp" aria-labelledby="cpc-comp-title">
      <h4 id="cpc-comp-title" className="cpc-comp-title">Компенсация НДС и инфляции по объектам</h4>
      <p className="cpc-comp-lead">Учитывайте в каждом плане затрат объекта. Сведения вносит администратор.</p>

      {state.loading ? (
        <p className="tdm-site-empty-state">Загрузка…</p>
      ) : state.error ? (
        <p className="tdm-site-alert is-error" role="alert">
          Не удалось загрузить сведения о компенсации: {state.error}{' '}
          <button type="button" className="tdm-site-link" onClick={() => { setState(p => ({ ...p, loading: true })); load() }}>
            Повторить
          </button>
        </p>
      ) : !state.supported ? (
        <p className="tdm-note">{COST_PLAN_COMPENSATION_HINT}</p>
      ) : !canEdit && !anyFilled ? (
        <p className="tdm-site-empty-state">Сведения о компенсации ещё не внесены.</p>
      ) : table.length === 0 ? (
        <p className="tdm-site-empty-state">Объектов основного строительства нет.</p>
      ) : (
        <div className="cpc-table-wrap">
          <table className="cpc-table">
            <colgroup>
              <col className="cpc-col-obj" />
              <col />
              <col />
              {canEdit && <col className="cpc-col-act" />}
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Объект</th>
                <th scope="col">Компенсация НДС</th>
                <th scope="col">Инфляция</th>
                {canEdit && <th scope="col"><span className="cpc-sr">Действия</span></th>}
              </tr>
            </thead>
            <tbody>
              {table.map(r => {
                const isEditing = editing?.objectId === r.id
                return [
                  <tr key={r.id} className={`cpc-row${isEditing ? ' is-editing' : ''}${r.filled ? '' : ' is-empty'}`} data-object-id={r.id}>
                    <th scope="row" className="cpc-obj">{r.label}</th>
                    {isEditing ? (
                      <>
                        <td data-label="Компенсация НДС">{field('vat', 'Компенсация НДС')}</td>
                        <td data-label="Инфляция">{field('inflation', 'Инфляция')}</td>
                        {canEdit && <td className="cpc-act" />}
                      </>
                    ) : (
                      <>
                        <td className="cpc-note" data-label="Компенсация НДС">{r.vat || <span className="cpc-none">не указано</span>}</td>
                        <td className="cpc-note" data-label="Инфляция">{r.inflation || <span className="cpc-none">не указано</span>}</td>
                        {canEdit && (
                          <td className="cpc-act">
                            <button
                              type="button"
                              className="ui-btn is-icon-only cpc-edit"
                              onClick={() => startEdit(r)}
                              disabled={busy || Boolean(editing)}
                              title="Изменить сведения"
                              aria-label={`Изменить сведения о компенсации: ${r.label}`}
                            ><IconPencil size={14} /></button>
                          </td>
                        )}
                      </>
                    )}
                  </tr>,
                  isEditing && (
                    <tr key={`${r.id}:actions`} className="cpc-row-actions">
                      <td colSpan={cols}>
                        <div className="cpc-edit-bar">
                          {formError && <p className="tdm-site-error" role="alert">{formError}</p>}
                          <span className="cpc-hint">Оба поля пустые — сведения объекта удаляются.</span>
                          <button type="button" className="btn-secondary" onClick={cancelEdit} disabled={busy}>Отмена</button>
                          <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
                            {busy ? 'Сохранение…' : 'Сохранить'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function CostPlanCalcTab({ canEdit = false }) {
  const [section, setSection] = useState(COST_PLAN_CALC_SECTIONS[0].key)
  const [anchors, setAnchors] = useState({ loading: true, ids: new Map(), error: null })

  const loadAnchors = useCallback(async () => {
    try {
      const { ids } = await fetchCalcAnchors(COST_PLAN_CALC_SECTIONS.map(s => s.code))
      setAnchors({ loading: false, ids, error: null })
    } catch (err) {
      setAnchors(prev => ({ ...prev, loading: false, error: describeSupabaseError(err) }))
    }
  }, [])

  useEffect(() => { loadAnchors() }, [loadAnchors])

  const current = COST_PLAN_CALC_SECTIONS.find(s => s.key === section)
  const ownerId = anchors.ids.get(current.code) || null

  return (
    <div className="tdm-body cpc">
      <p className="tdm-lead">
        Файлы для расчёта плана затрат: шаблоны и образцы. Посмотреть и скачать может каждый, загружает и удаляет
        администратор.
      </p>

      <div className="cpc-subtabs" role="tablist" aria-label="Расчёт ПЗ">
        {COST_PLAN_CALC_SECTIONS.map(s => (
          <button
            key={s.key}
            type="button"
            role="tab"
            id={`cpc-tab-${s.key}`}
            aria-selected={s.key === section}
            aria-controls="cpc-panel"
            className={`cpc-subtab${s.key === section ? ' is-active' : ''}`}
            onClick={() => setSection(s.key)}
          >{s.label}</button>
        ))}
      </div>

      <div className="cpc-panel" id="cpc-panel" role="tabpanel" aria-labelledby={`cpc-tab-${section}`}>
        {anchors.loading ? (
          <p className="tdm-site-empty-state">Загрузка…</p>
        ) : anchors.error ? (
          <p className="tdm-site-alert is-error" role="alert">
            Не удалось загрузить список файлов: {anchors.error}{' '}
            <button type="button" className="tdm-site-link" onClick={() => { setAnchors(p => ({ ...p, loading: true })); loadAnchors() }}>
              Повторить
            </button>
          </p>
        ) : !ownerId ? (
          <p className="tdm-note">{COST_PLAN_CALC_FILES_HINT}</p>
        ) : (
          <S3DocumentList
            key={current.key}
            ownerType="general"
            ownerId={ownerId}
            title={current.label}
            category={COST_PLAN_CALC_CATEGORY}
            canEdit={canEdit}
          />
        )}
      </div>

      <CompensationSection canEdit={canEdit} />
    </div>
  )
}
