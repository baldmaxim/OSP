import { useCallback, useEffect, useMemo, useState } from 'react'
import PersonName from './PersonName'
import { fetchCalcAnchors, fetchCalcFileLog } from '../services/costPlanCalc'
import { COST_PLAN_CALC_LOG_HINT, COST_PLAN_CALC_SECTIONS, calcFileLogEntry } from '../utils/costPlanCalc'
import { describeSupabaseError } from '../utils/supabaseError'
import './CostPlanCalcTab.css'

// «Планы затрат» → «Документы» → «Журнал» (миграция 20261130): кто и когда прикрепил и открепил файлы «Расчёта ПЗ».
// Только чтение, записи пишет триггер базы. Вкладка монтируется при каждом открытии, поэтому показывает свежее.

const PAGE = 50

export default function CostPlanCalcLogTab() {
  const [state, setState] = useState({ loading: true, error: null, supported: true, rows: [], more: false, anchors: new Map() })
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    try {
      const [log, anchors] = await Promise.all([
        fetchCalcFileLog(0, PAGE),
        fetchCalcAnchors(COST_PLAN_CALC_SECTIONS.map(s => s.code)),
      ])
      setState({
        loading: false, error: null, supported: log.supported, rows: log.rows, more: log.rows.length === PAGE, anchors: anchors.ids,
      })
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: describeSupabaseError(err) }))
    }
  }, [])

  useEffect(() => { load() }, [load])

  const showMore = async () => {
    setLoadingMore(true)
    try {
      const { rows } = await fetchCalcFileLog(state.rows.length, PAGE)
      // Пока журнал открыт, сверху могли появиться записи — страница сдвигается, повторы отбрасываем.
      setState(prev => {
        const known = new Set(prev.rows.map(r => r.id))
        return { ...prev, rows: [...prev.rows, ...rows.filter(r => !known.has(r.id))], more: rows.length === PAGE }
      })
    } catch (err) {
      alert('Журнал не загрузился: ' + describeSupabaseError(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const entries = useMemo(() => state.rows.map(r => calcFileLogEntry(r, state.anchors)), [state.rows, state.anchors])

  if (state.loading) return <div className="tdm-body cpc"><p className="tdm-site-empty-state">Загрузка…</p></div>
  if (state.error) {
    return (
      <div className="tdm-body cpc">
        <p className="tdm-site-alert is-error" role="alert">
          Не удалось загрузить журнал: {state.error}{' '}
          <button type="button" className="tdm-site-link" onClick={() => { setState(p => ({ ...p, loading: true, error: null })); load() }}>
            Повторить
          </button>
        </p>
      </div>
    )
  }
  if (!state.supported) return <div className="tdm-body cpc"><p className="tdm-note">{COST_PLAN_CALC_LOG_HINT}</p></div>

  return (
    <div className="tdm-body cpc">
      <p className="tdm-lead">Кто и когда прикрепил и открепил файлы «Расчёта ПЗ». Записи делает сама база, изменить их нельзя.</p>
      {entries.length === 0 ? (
        <p className="tdm-site-empty-state">Файлы ещё не прикрепляли.</p>
      ) : (
        <div className="cpc-log-wrap">
          <table className="cpc-log">
            <colgroup>
              <col className="cpc-log-col-when" />
              <col className="cpc-log-col-who" />
              <col className="cpc-log-col-action" />
              <col className="cpc-log-col-place" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Когда</th>
                <th scope="col">Кто</th>
                <th scope="col">Действие</th>
                <th scope="col">Где</th>
                <th scope="col">Файл</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td className="cpc-log-when">{e.when}</td>
                  <td className="cpc-log-who">{e.who ? <PersonName full={e.who} /> : <span className="cpc-none">не записан</span>}</td>
                  <td className="cpc-log-action"><span className={`cpc-badge ${e.attached ? 'is-yes' : 'is-detached'}`}>{e.attached ? 'Прикреплён' : 'Откреплён'}</span></td>
                  <td className="cpc-log-place">
                    {e.place}
                    {e.kind && <div className="cpc-log-kind">{e.kind}</div>}
                  </td>
                  <td className="cpc-log-file">{e.fileName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state.more && (
        <button type="button" className="btn-secondary cpc-log-more" onClick={showMore} disabled={loadingMore}>
          {loadingMore ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </div>
  )
}
