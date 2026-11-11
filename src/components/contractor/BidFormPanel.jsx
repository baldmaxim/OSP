import { useState } from 'react'
import { saveForm, saveCompanyAnswers } from '../../services/contractorBids'
import { VAT_FIELD_CODE } from '../../utils/bidForm'
import { companyFieldState, fieldGroups, isCompanyField, sourceOf } from '../../utils/bidFormLinks'

// Анкета «Квалификационная и контактная информация» по тендеру. Поля ведёт администратор (bid_form_fields): текст
// или выбор из списка (ставка НДС — как выпадающий список на «Главном листе» ВОР); их можно добавлять,
// переименовывать и скрывать — анкета строится по списку. Ответ пишется при уходе из поля, выбор из списка — сразу
// (bid_form_save). Ответы прошлого тендера организации — по кнопке «Подставить». Поля и ответы грузит BidWorkspace:
// ставка НДС нужна итогам расценки и до открытия анкеты.
//
// Анкета и «Моя компания» — одни сведения (миграция 20270115, просьба пользователя 11.11.2026): поля о компании — отдельной группой
// сверху. Связанное с карточкой компании поле, где в карточке есть значение, — только показ (карточку ведёт отдел); остальные поля
// о компании подрядчик заполняет один раз: ответ пишется и в «Мою компанию» (bid_company_save — она же поправляет анкеты идущих
// тендеров), и в анкету этого тендера. Без миграции — одна группа, как раньше.

const IconLock = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)

export default function BidFormPanel({
  tenderId, canEdit, fields, answers, card = null, companyAnswers = null, onCompanyAnswers,
  previous, error: loadError, onAnswers, onPreviousUsed,
}) {
  const [status, setStatus] = useState({}) // id поля → 'dirty' | 'saving' | 'saved' | 'error'
  const [error, setError] = useState('')
  const linked = (fields || []).some(isCompanyField)
  // Ответы о компании хранятся у организации, только если таблица есть (companyAnswers не null).
  const companyStore = linked && companyAnswers != null

  const commit = async (patch) => {
    const ids = Object.keys(patch)
    setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, 'saving'])) }))
    setError('')
    try {
      const own = companyStore ? Object.fromEntries(Object.entries(patch).filter(([id]) => isCompanyField(fields.find((f) => f.id === id)))) : {}
      await Promise.all([
        saveForm(tenderId, patch),
        Object.keys(own).length ? saveCompanyAnswers(own) : null,
      ])
      if (Object.keys(own).length) {
        onCompanyAnswers?.((prev) => {
          const next = { ...(prev || {}) }
          for (const [id, v] of Object.entries(own)) {
            if (String(v ?? '').trim()) next[id] = { label: fields.find((f) => f.id === id)?.label, value: String(v).trim() }
            else delete next[id]
          }
          return next
        })
      }
      setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, 'saved'])) }))
    } catch (e) {
      setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, 'error'])) }))
      setError(e.message || String(e))
    }
  }

  // Ответы прошлой анкеты — только на поля по тендеру: поля о компании и так стоят сами.
  const fillFromPrevious = async () => {
    const active = new Map((fields || []).map((f) => [f.id, f]))
    const patch = {}
    for (const [id, v] of Object.entries(previous?.answers || {})) {
      const f = active.get(id)
      if (!f || !v?.value || answers[id] || (linked && isCompanyField(f))) continue
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
  const stateText = (f) => {
    const st = status[f.id]
    if (st === 'saving') return 'сохраняем…'
    if (st === 'error') return 'не сохранено'
    if (st === 'saved') return companyStore && isCompanyField(f) ? 'сохранено — и в «Моей компании», и во всех ваших идущих тендерах' : 'сохранено'
    return ''
  }
  const tenderFieldsLeft = fields.some((f) => !(linked && isCompanyField(f)))
  const showPrevious = canEdit && previous && tenderFieldsLeft

  const input = (f) => (f.kind === 'select' ? (
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
  ))

  const row = (f) => {
    const company = linked && isCompanyField(f)
    const st = company ? companyFieldState(f, card, companyAnswers) : null
    const empty = !String(answers[f.id] || '').trim()
    return (
      <li key={f.id} className={`bid-form-row${f.code === VAT_FIELD_CODE ? ' is-vat' : ''}${company && empty ? ' is-empty-company' : ''}`}>
        <label className="bid-form-label" htmlFor={`bid-f-${f.id}`}>
          {f.label}
          {f.hint && <span className="bid-form-hint">{f.hint}</span>}
        </label>
        <div className="bid-form-input">
          {st?.locked ? (
            <>
              <div className="bid-form-value" id={`bid-f-${f.id}`}><IconLock />{st.value}</div>
              <span className="bid-form-from is-card">
                из «Моей компании» ({sourceOf(f)?.label || 'карточка компании'}) · изменить — письмом на tender.osp@su10.ru
              </span>
            </>
          ) : (
            <>
              {input(f)}
              <span className={`bid-form-state is-${status[f.id] || 'idle'}`} aria-live="polite">{stateText(f)}</span>
              {company && st?.cardRaw && (
                <span className="bid-form-from">В «Моей компании»: {st.cardRaw} — такого варианта в анкете нет{canEdit ? ', выберите подходящий' : ''}.</span>
              )}
              {company && canEdit && !st?.cardRaw && !status[f.id] && companyStore && (
                <span className="bid-form-from">
                  {sourceOf(f) ? 'В «Моей компании» не указано — ответ сохранится для всех тендеров.' : 'Один ответ на компанию: подставится в каждый тендер и виден в «Моей компании».'}
                </span>
              )}
            </>
          )}
        </div>
      </li>
    )
  }

  const { company, tender } = fieldGroups(fields)
  return (
    <div className="bid-form">
      <div className="bid-filters">
        <span className="bid-filters-total">Заполнено {filled} из {fields.length}</span>
        {showPrevious && (
          <button type="button" className="cab-btn" onClick={fillFromPrevious}>Подставить ответы из прошлой анкеты</button>
        )}
      </div>
      {(error || loadError) && <div className="bid-note is-warn">{error || loadError}</div>}
      {linked ? (
        <>
          {company.length > 0 && (
            <section className="bid-form-group is-company" aria-label="О компании">
              <div className="bid-form-group-head">
                <b>О компании</b>
                <span>одинаково во всех тендерах — из «Моей компании»; заполненное здесь сохраняется там же</span>
              </div>
              <ol className="bid-form-list">{company.map(row)}</ol>
            </section>
          )}
          {tender.length > 0 && (
            <section className="bid-form-group" aria-label="По этому тендеру">
              <div className="bid-form-group-head">
                <b>По этому тендеру</b>
                <span>свои ответы в каждом тендере</span>
              </div>
              <ol className="bid-form-list">{tender.map(row)}</ol>
            </section>
          )}
        </>
      ) : (
        <ol className="bid-form-list">{fields.map(row)}</ol>
      )}
    </div>
  )
}
