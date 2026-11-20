import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { RESTART_STATUS } from '../utils/tenderStatuses'
import { restartSourceOptions, restartedSources } from '../utils/tenderRestart'
import { tenderObjectName } from '../utils/tenderDepartments'
import './TenderRestart.css'

const SHOWN = 60

const num = (t) => `№ ${t?.public_tender_number ?? '—'}`

// Окно «Тендер № N — перезапуск каких тендеров» у номера НОВОГО тендера (решение пользователя 19.11.2026: «указывать в № тот
// тендер, который перезапускается, а не наоборот»). Отметки — прежние тендеры, которые он перезапускает (один новый может
// заменить несколько: 733 ← 73, 81). Отмеченным при сохранении ставится статус «Перезапуск» и ссылка на этот тендер; со снятых
// снимается только ссылка — статус остаётся, его меняют в реестре.
// tender — новый тендер; tenders — список раздела. Уже отмеченные читаются из живого списка: после частичного сбоя страница
// перечитывает его, и повторное «Сохранить» дописывает только незаписанное.
// onSave({ add, remove }) — строки прежних тендеров; исключение — ошибка в окне, окно остаётся открытым.
export default function TenderRestartDialog({ tender, tenders, onSave, onCancel }) {
  const titleId = useId()
  const number = tender.public_tender_number
  const [query, setQuery] = useState('')
  const linked = useMemo(() => restartedSources(tender, tenders), [tender, tenders])
  const [picked, setPicked] = useState(() => new Set(linked.map((t) => t.id)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const found = useMemo(() => restartSourceOptions(tender, tenders, query), [tender, tenders, query])
  // Отмеченные остаются видны, даже если поиск их не находит.
  const pinned = useMemo(() => {
    const shownIds = new Set(found.map((c) => c.tender.id))
    return (tenders || []).filter((t) => picked.has(t.id) && !shownIds.has(t.id)).map((t) => ({ tender: t, rank: 0 }))
  }, [picked, found, tenders])
  const shown = [...pinned, ...found].slice(0, Math.max(SHOWN, pinned.length))

  const linkedIds = useMemo(() => new Set(linked.map((t) => t.id)), [linked])
  const byId = useMemo(() => new Map((tenders || []).map((t) => [t.id, t])), [tenders])
  const add = [...picked].filter((id) => !linkedIds.has(id)).map((id) => byId.get(id)).filter(Boolean)
  const remove = linked.filter((t) => !picked.has(t.id))
  // Кому статус сменится на «Перезапуск» — сказать до сохранения (бывает и «Завершен» с победителем).
  const flips = add.filter((t) => t.status !== RESTART_STATUS)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, saving])

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave({ add, remove })
    } catch (err) {
      setError(err?.message || String(err))
      setSaving(false)
    }
  }

  const changed = add.length > 0 || remove.length > 0

  return createPortal(
    <div className="trs-overlay">
      <div className="trs-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="trs-head">
          <div>
            <h3 id={titleId}>{`Тендер № ${number ?? '—'} — перезапуск тендера`}</h3>
            <p className="trs-sub">{tenderObjectName(tender, 'Объект не указан')}{tender.work_description ? ` · ${tender.work_description}` : ''}</p>
          </div>
          <button type="button" className="trs-close" aria-label="Закрыть" onClick={onCancel} disabled={saving}>×</button>
        </div>

        <div className="trs-body">
          <p className="trs-lead">
            Отметьте тендер, который перезапускается этим. Ему ставится статус «{RESTART_STATUS}», у номера этого тендера появится
            «перезапуск № …». Снятая отметка убирает только связь — статус прежнего не меняется.
          </p>
          <input
            type="search"
            className="trs-search"
            placeholder="Номер, объект или описание"
            aria-label="Найти тендер, который перезапускается"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="trs-list" role="group" aria-label="Тендеры, которые перезапускаются">
            {shown.map(({ tender: t, rank }) => (
              <label key={t.id} className={`trs-opt${picked.has(t.id) ? ' is-picked' : ''}`}>
                <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} />
                <span className="trs-opt-body">
                  <span className="trs-opt-head">
                    <span className="trs-opt-num">{num(t)}</span>
                    {t.status && <span className="trs-opt-status">{t.status}</span>}
                    {rank === 1 && <span className="trs-opt-hint">назван у № {number}</span>}
                    {rank === 2 && <span className="trs-opt-hint">тот же объект</span>}
                  </span>
                  <span className="trs-opt-obj">{tenderObjectName(t, 'Объект не указан')}</span>
                  {t.work_description && <span className="trs-opt-desc">{t.work_description}</span>}
                </span>
              </label>
            ))}
            {shown.length === 0 && <div className="trs-empty">{query.trim() ? 'Ничего не найдено' : 'Других тендеров нет'}</div>}
            {pinned.length + found.length > shown.length && (
              <div className="trs-more">Показаны первые {shown.length} — уточните поиск</div>
            )}
          </div>
          {flips.length > 0 && (
            <p className="trs-warn" role="status">
              {`Статус станет «${RESTART_STATUS}»: `}
              {flips.map((t) => `${num(t)}${t.status ? ` (сейчас «${t.status}»)` : ''}`).join(', ')}
            </p>
          )}
          {error && <p className="trs-error" role="alert">Не сохранено: {error}</p>}
        </div>

        <div className="trs-actions">
          <button type="button" className="trs-btn" onClick={onCancel} disabled={saving}>Отмена</button>
          <button type="button" className="trs-btn trs-btn--primary" onClick={save} disabled={saving || !changed}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
