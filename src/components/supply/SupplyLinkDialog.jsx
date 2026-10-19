import { useEffect, useRef, useState } from 'react'
import { normalizeLinkUrl } from '../../services/supplyPricing'

const LIST_MAX = 5

// Ссылка на документ (чек, счёт, КП поставщика) одной позиции или нескольким отмеченным сразу.
// targets — [{ key, name, estimateName, link }]: у кого ссылка уже есть — она заменяется. Одинаковая у всех —
// подставлена в поле. «Убрать ссылку» — у тех, у кого она есть.
export default function SupplyLinkDialog({ targets, busy, error, onSave, onRemove, onClose }) {
  const shared = targets.length && targets.every((t) => t.link?.url && t.link.url === targets[0].link?.url) ? targets[0].link.url : ''
  const [value, setValue] = useState(shared)
  const [invalid, setInvalid] = useState('')
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const withLink = targets.filter((t) => t.link)
  const docs = [...new Set(targets.map((t) => t.estimateName))]
  const submit = (e) => {
    e.preventDefault()
    const res = normalizeLinkUrl(value)
    if (res.error) { setInvalid(res.error); return }
    setInvalid('')
    onSave(res.url)
  }
  const one = targets.length === 1

  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <form className="sp-modal sp-modal-wide" role="dialog" aria-modal="true" aria-labelledby="sp-link-title" onSubmit={submit}>
        <h3 id="sp-link-title">{one ? 'Ссылка на документ' : `Ссылка на документ — ${targets.length} позициям`}</h3>
        <div className="sp-modal-body">
          {one
            ? <p className="sp-modal-lead">{targets[0].name} <span className="sp-muted">· ВОР «{targets[0].estimateName}»</span></p>
            : (
              <ul className="sp-link-targets">
                {targets.slice(0, LIST_MAX).map((t) => <li key={t.key}>{t.name}</li>)}
                {targets.length > LIST_MAX && <li className="sp-muted">и ещё {targets.length - LIST_MAX}</li>}
              </ul>
            )}
          {!one && docs.length > 1 && <p className="sp-muted">ВОР: {docs.map((d) => `«${d}»`).join(', ')}</p>}
          <label className="sp-link-field">
            <span>Чек, счёт или КП поставщика — ссылка https://… или сетевой путь \\сервер\папка</span>
            <input
              ref={inputRef}
              type="text"
              inputMode="url"
              value={value}
              onChange={(e) => { setValue(e.target.value); setInvalid('') }}
              placeholder="https://"
              aria-invalid={!!invalid}
              aria-describedby={invalid ? 'sp-link-invalid' : undefined}
              disabled={busy}
            />
          </label>
          {invalid && <p id="sp-link-invalid" className="sp-error-text" role="alert">{invalid}</p>}
          {error && <p className="sp-error-text" role="alert">{error}</p>}
          {!one && withLink.length > 0 && (
            <p className="sp-muted">У {withLink.length} из {targets.length} позиций ссылка уже есть — она будет заменена.</p>
          )}
        </div>
        <div className="sp-modal-actions">
          {withLink.length > 0 && (
            <button type="button" className="btn-secondary sp-link-remove" onClick={onRemove} disabled={busy}>
              {one ? 'Убрать ссылку' : `Убрать ссылку (${withLink.length})`}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Сохраняем…' : one ? 'Сохранить' : `Прикрепить к ${targets.length}`}</button>
        </div>
      </form>
    </div>
  )
}
