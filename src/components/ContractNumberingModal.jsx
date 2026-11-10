import { useEffect, useMemo, useRef, useState } from 'react'
import { IconPencil } from './icons/ActionIcons'
import {
  CODE_MAX_LENGTH, cleanCode, codeKey, codeProblem, formatContractNumber, isCodeTaken, lastIssued, moscowYear,
  nextContractNumber,
} from '../utils/contractNumbering'
import { saveObjectContractCode } from '../services/contractNumbering'
import './TenderDocsModal.css'
import './ContractNumberingModal.css'

// «Документы раздела» → «Нумерация договоров» (решение пользователя 10.11.2026, файл «Нумерация_договоров_по_объектам.xlsx»):
// правила номера и коды объектов — по строке на объект: код, последний выданный номер этого года и следующий. Код задаёт
// и меняет администратор прямо в строке; остальные смотрят. Каркас окна — tdm-* (свой оверлей, не зависит от стилей
// других разделов), таблица — ContractNumberingModal.css.

const isWarranty = (o) => o.status === 'warranty_service'

// supported — нумерация есть в базе (миграция 20270110); countersReady — счётчики прочитаны (пока нет — номера «…»).
export default function ContractNumberingModal({
  objects = [], counters = [], supported = true, countersReady = true, canEdit = false, onClose, onCodeSaved,
}) {
  const year = moscowYear()
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    // Escape в поле кода отменяет правку (обработчик поля останавливает событие), иначе закрывает окно.
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  useEffect(() => { if (editingId) inputRef.current?.focus() }, [editingId])

  // ОС первыми, затем ГО; внутри — по названию (так их отдаёт и страница).
  const rows = useMemo(() => [...objects].sort((a, b) => (
    Number(isWarranty(a)) - Number(isWarranty(b)) || String(a.name).localeCompare(String(b.name), 'ru')
  )), [objects])
  const withCode = rows.filter((o) => codeKey(o.contract_code)).length

  const startEdit = (o) => {
    setEditingId(o.id)
    setDraft(o.contract_code || '')
    setError('')
  }
  const cancelEdit = () => { setEditingId(null); setError('') }

  const save = async (o) => {
    const code = cleanCode(draft)
    if (code === (o.contract_code || null)) { cancelEdit(); return }
    const problem = codeProblem(code)
    if (problem) { setError(problem); return }
    const key = codeKey(code)
    const twin = key && objects.find((x) => x.id !== o.id && codeKey(x.contract_code) === key)
    if (twin) { setError(`Этот код уже у объекта «${twin.name}»`); return }
    const oldKey = codeKey(o.contract_code)
    const issuedOld = oldKey && counters.some((c) => c.code_key === oldKey)
    if (oldKey && !window.confirm(code
      ? `Сменить код «${o.contract_code}» на «${code}»?\n\n${issuedOld ? 'Выданные номера с прежним кодом не меняются. ' : ''}`
        + `Новые договоры по объекту получат номера ${formatContractNumber(code, year, lastIssued(counters, key, year) + 1)} и далее.`
      : `Убрать код «${o.contract_code}» у объекта «${o.name}»?\n\nНомер нового договора по объекту перестанет подставляться — его нужно будет вводить вручную.`)) return
    setSaving(true)
    try {
      const saved = await saveObjectContractCode(o.id, code)
      onCodeSaved?.(o.id, saved.contract_code ?? null)
      setEditingId(null)
      setError('')
    } catch (err) {
      if (isCodeTaken(err)) setError('Этот код уже у другого объекта')
      else if (err?.code === '42501') setError('Код объекта задаёт администратор')
      else if (err?.code === '23514') setError('Код не подходит: только буквы, цифры, точка и дефис')
      else setError(err?.message || 'Код не сохранён')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay tdm-overlay" onClick={onClose}>
      <div className="modal tdm-modal tdm-modal--fit cnum-modal" role="dialog" aria-modal="true" aria-labelledby="cnum-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="tdm-head">
          <div>
            <h3 id="cnum-title">Нумерация договоров</h3>
            <p className="tdm-sub">Номер договора подряда по объекту: код объекта, год и порядковый номер</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="tdm-body cnum-body">
          <ul className="cnum-rules">
            <li>
              Формат — <b>КОД-ДП-ГГ-НОМЕР</b>, например <span className="cnum-mono">АЛИЯ-ДП-26-001</span>:
              код объекта, ДП — договор подряда, год регистрации, порядковый номер.
            </li>
            <li>
              Счётчик — у каждого объекта свой на год, общий для всех подрядчиков: новый договор получает следующий номер,
              в том числе повторный договор с тем же подрядчиком. В новом году — снова с 001.
            </li>
            <li>
              Номер подставляется в форму нового договора по выбранному объекту; его можно заменить своим. Номер по схеме
              не повторяется, номер удалённого договора снова не выдаётся.
            </li>
            <li>ДС нумеруются внутри договора: ДС № 1 к договору № АЛИЯ-ДП-26-001, затем ДС № 2.</li>
          </ul>

          {!supported ? (
            <p className="cnum-note" role="status">
              {canEdit
                ? 'Нумерация по схеме ещё не включена: в базе нет кодов объектов и счётчика (миграция 20270110). Пока номер договора вводится вручную.'
                : 'Нумерация по схеме ещё не включена — пока номер договора вводится вручную.'}
            </p>
          ) : (
            <>
              <p className="cnum-summary">
                Код задан у {withCode} из {rows.length} объектов.
                {canEdit ? ' Код меняется карандашом в строке.' : ' Коды задаёт администратор.'}
              </p>
              <div className="cnum-table-wrap">
                <table className="cnum-table">
                  <colgroup>
                    <col /><col className="cnum-col-code" /><col className="cnum-col-num" /><col className="cnum-col-num" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Объект</th>
                      <th scope="col">Код</th>
                      <th scope="col">Последний в {year}</th>
                      <th scope="col">Следующий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => {
                      const key = codeKey(o.contract_code)
                      const last = key ? lastIssued(counters, key, year) : 0
                      const next = nextContractNumber(o, counters, year)
                      const editing = editingId === o.id
                      return (
                        <tr key={o.id} className={editing ? 'is-editing' : ''} data-object-id={o.id}>
                          <td className="cnum-cell-obj">
                            <span className="cnum-obj">
                              <span className="cnum-obj-name">{o.name}</span>
                              <span className={`cnum-dept ${isWarranty(o) ? 'is-go' : 'is-os'}`}
                                title={isWarranty(o) ? 'Гарантийное обслуживание' : 'Основное строительство'}>
                                {isWarranty(o) ? 'ГО' : 'ОС'}
                              </span>
                            </span>
                          </td>
                          <td className="cnum-code" data-label="Код">
                            {editing ? (
                              <form className="cnum-edit" onSubmit={(e) => { e.preventDefault(); save(o) }}>
                                <input
                                  ref={inputRef}
                                  value={draft}
                                  maxLength={CODE_MAX_LENGTH + 10}
                                  onChange={(e) => { setDraft(e.target.value); setError('') }}
                                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); cancelEdit() } }}
                                  placeholder="Например, АЛИЯ"
                                  aria-label={`Код объекта «${o.name}»`}
                                  aria-invalid={!!error}
                                  disabled={saving}
                                />
                                <button type="submit" className="cnum-btn is-primary" disabled={saving}>Сохранить</button>
                                <button type="button" className="cnum-btn" onClick={cancelEdit} disabled={saving}>Отмена</button>
                                {error && <span className="cnum-error" role="alert">{error}</span>}
                              </form>
                            ) : (
                              <span className="cnum-code-view">
                                {o.contract_code
                                  ? <span className="cnum-mono">{o.contract_code}</span>
                                  : <span className="cnum-muted">нет кода</span>}
                                {canEdit && (
                                  <button type="button" className="cnum-icon-btn" onClick={() => startEdit(o)}
                                    aria-label={o.contract_code ? `Изменить код объекта «${o.name}»` : `Задать код объекта «${o.name}»`}
                                    title={o.contract_code ? 'Изменить код' : 'Задать код'}>
                                    <IconPencil size={14} />
                                  </button>
                                )}
                              </span>
                            )}
                          </td>
                          <td className="cnum-num" data-label={`Последний в ${year}`}>
                            {!key ? <span className="cnum-muted">—</span>
                              : !countersReady ? <span className="cnum-muted" title="Счётчики номеров загружаются">…</span>
                                : last ? <span className="cnum-mono">{formatContractNumber(o.contract_code, year, last)}</span>
                                  : <span className="cnum-muted">не было</span>}
                          </td>
                          <td className="cnum-num" data-label="Следующий">
                            {!next ? <span className="cnum-muted">—</span>
                              : !countersReady ? <span className="cnum-muted" title="Счётчики номеров загружаются">…</span>
                                : <span className="cnum-mono">{next.number}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="tdm-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
