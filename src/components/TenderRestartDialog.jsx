import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { RESTART_STATUS } from '../utils/tenderStatuses'
import { RESTART_LINK_FIELD, restartCandidates } from '../utils/tenderRestart'
import { tenderObjectName } from '../utils/tenderDepartments'
import './TenderRestart.css'

const SHOWN = 60

// Окно «Перезапуск тендера № N» (решение пользователя 18.11.2026): при выборе статуса «Перезапуск» — какой тендер его заменяет.
// Выбор необязателен: «Не указывать» ставит статус без ссылки, новый тендер указывают позже (у номера тендера в реестре).
// Тендер уже в «Перезапуске» — то же окно меняет или снимает ссылку, статус не трогает.
// tenders — список раздела (кандидаты: основные тендеры, кроме самого и удалённых); onSave(id нового | null) — запись,
// исключение — ошибка в окне, окно остаётся открытым.
export default function TenderRestartDialog({ tender, tenders, onSave, onCancel }) {
  const titleId = useId()
  const already = tender.status === RESTART_STATUS
  const number = tender.public_tender_number
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(tender[RESTART_LINK_FIELD] || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const found = useMemo(() => restartCandidates(tender, tenders, query), [tender, tenders, query])
  // Выбранный остаётся виден, даже если поиск его не находит.
  const pickedRow = useMemo(() => {
    if (!picked || found.some(c => c.tender.id === picked)) return null
    const t = (tenders || []).find(x => x.id === picked)
    return t ? { tender: t, rank: 3 } : null
  }, [picked, found, tenders])
  const shown = pickedRow ? [pickedRow, ...found.slice(0, SHOWN - 1)] : found.slice(0, SHOWN)
  const pickedTender = picked ? (tenders || []).find(x => x.id === picked) : null

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, saving])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(picked || null)
    } catch (err) {
      setError(err?.message || String(err))
      setSaving(false)
    }
  }

  const saveLabel = already
    ? 'Сохранить'
    : pickedTender
      ? `Перезапуск → № ${pickedTender.public_tender_number ?? '—'}`
      : 'Перезапуск без нового тендера'

  return createPortal(
    <div className="trs-overlay">
      <div className="trs-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="trs-head">
          <div>
            <h3 id={titleId}>
              {already ? `Тендер № ${number ?? '—'}: каким тендером перезапущен` : `Перезапуск тендера № ${number ?? '—'}`}
            </h3>
            <p className="trs-sub">{tenderObjectName(tender, 'Объект не указан')}{tender.work_description ? ` · ${tender.work_description}` : ''}</p>
          </div>
          <button type="button" className="trs-close" aria-label="Закрыть" onClick={onCancel} disabled={saving}>×</button>
        </div>

        <div className="trs-body">
          <p className="trs-lead">
            Какой тендер его заменяет? У нового рядом с номером появится «перезапуск № {number ?? '—'}» со ссылкой сюда.
            {!already && ' Можно не указывать — новый тендер выбирается и позже, у номера этого тендера.'}
          </p>
          <input
            type="search"
            className="trs-search"
            placeholder="Номер, объект или описание"
            aria-label="Найти новый тендер"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="trs-list" role="radiogroup" aria-label="Новый тендер">
            <label className={`trs-opt trs-opt--none${!picked ? ' is-picked' : ''}`}>
              <input type="radio" name={`${titleId}-target`} checked={!picked} onChange={() => setPicked('')} />
              <span className="trs-opt-body">{already ? 'Не указан' : 'Не указывать'}</span>
            </label>
            {shown.map(({ tender: t, rank }) => (
              <label key={t.id} className={`trs-opt${picked === t.id ? ' is-picked' : ''}`}>
                <input type="radio" name={`${titleId}-target`} checked={picked === t.id} onChange={() => setPicked(t.id)} />
                <span className="trs-opt-body">
                  <span className="trs-opt-head">
                    <span className="trs-opt-num">№ {t.public_tender_number ?? '—'}</span>
                    {t.status && <span className="trs-opt-status">{t.status}</span>}
                    {rank === 0 && <span className="trs-opt-hint">называет № {number}</span>}
                    {rank === 1 && <span className="trs-opt-hint">тот же объект</span>}
                  </span>
                  <span className="trs-opt-obj">{tenderObjectName(t, 'Объект не указан')}</span>
                  {t.work_description && <span className="trs-opt-desc">{t.work_description}</span>}
                </span>
              </label>
            ))}
            {found.length === 0 && <div className="trs-empty">{query.trim() ? 'Ничего не найдено' : 'Других тендеров нет'}</div>}
            {found.length > shown.length - (pickedRow ? 1 : 0) && (
              <div className="trs-more">Показаны первые {SHOWN} — уточните поиск</div>
            )}
          </div>
          {error && <p className="trs-error" role="alert">Не сохранено: {error}</p>}
        </div>

        <div className="trs-actions">
          <button type="button" className="trs-btn" onClick={onCancel} disabled={saving}>Отмена</button>
          <button type="button" className="trs-btn trs-btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Сохраняем…' : saveLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
