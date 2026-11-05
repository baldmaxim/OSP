import { useEffect, useMemo, useRef, useState } from 'react'
import { IconClose } from '../icons/ToolbarIcons'
import { IconAlert, IconTrash } from '../icons/ActionIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, formatAmountLive } from '../../utils/money'
import {
  DP_FILE_ACCEPT, DP_ROLE_LABEL, EMPTY_DP_FORM, dpErrorText, dpFileProblem, dpFormFields, dpFormProblems, pickResponsibleKey, responsibleOptions,
} from '../../utils/dpRequests'
import { createDpRequest, updateDpRequest } from '../../services/dpRequests'
import { SECTION_TEMPLATE_LINK_KEY, fetchTemplateLinks, isWebLink } from '../../services/sectionTemplates'

// Файлы, выбранные в окне новой заявки: на сервер уходят только вместе с заявкой (строки ещё нет).
function StagedFiles({ id, label, hint, files, onFiles, required, error }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const add = (list) => onFiles(Array.from(list || []))
  return (
    <div className="dpr-field">
      <span className="dpr-label" id={`${id}-label`}>{label}{required && <b className="dpr-req" title="Обязательно"> *</b>}</span>
      <div
        className={`dpr-drop${dragging ? ' is-over' : ''}${required && !files.length ? ' is-required' : ''}`}
        data-testid={id}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); add(e.dataTransfer?.files) }}
      >
        {files.map((file) => (
          <div key={`${file.name}:${file.size}`} className="dpr-file">
            <span className="dpr-file-name is-static" title={file.name}><PaperclipIcon size={14} /><span>{file.name}</span></span>
            <button
              type="button"
              className="dpr-file-btn is-danger"
              aria-label={`Убрать ${file.name}`}
              title="Убрать"
              onClick={() => onFiles(null, file)}
            ><IconTrash size={14} /></button>
          </div>
        ))}
        <button type="button" className="dpr-file-add" aria-labelledby={`${id}-label`} onClick={() => inputRef.current?.click()}>
          {files.length ? '+ ещё файл' : 'Выбрать файл'}
        </button>
        <span className="dpr-hint">{hint}</span>
        <input ref={inputRef} type="file" hidden multiple accept={DP_FILE_ACCEPT} onChange={(e) => { add(e.target.files); e.target.value = '' }} />
      </div>
      {error && <span className="dpr-error-line">{error}</span>}
    </div>
  )
}

// Окно новой заявки и правки. Поля — по решению пользователя: объект, договор и его документ, понятийное соглашение (без этих двух
// файлов заявку не создать), сумма, ответственный (экономист объекта или руководитель строительства), причина создания ДП. Файлы уже созданной
// заявки меняются в её строке, здесь — только при создании. Закрывается только кнопками: щелчок мимо унёс бы заполненное.
export default function DpRequestFormModal({ request, objects, staff, me, onClose, onSaved }) {
  const editing = !!request
  const [form, setForm] = useState(() => (editing
    ? {
      object_id: request.object_id,
      contract_title: request.contract_title,
      amount: formatAmount(Number(request.amount)),
      responsibleKey: request.responsible_contact_id
        ? `${request.responsible_contact_id}:${request.responsible_role}`
        : (request.responsible_name ? 'keep' : ''),
      reason: request.reason,
    }
    : EMPTY_DP_FORM))
  const [conceptFiles, setConceptFiles] = useState([])
  const [contractFiles, setContractFiles] = useState([])
  const [fileError, setFileError] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [templateLink, setTemplateLink] = useState(null)

  useEffect(() => {
    if (editing) return undefined
    let alive = true
    // Шаблон — необязательная подсказка, та же ссылка, что у тендеров и договоров: не загрузился — окно работает без него.
    const key = SECTION_TEMPLATE_LINK_KEY.conceptAgreement
    fetchTemplateLinks([key]).then((map) => { if (alive) setTemplateLink(map.get(key) || null) }).catch(() => {})
    return () => { alive = false }
  }, [editing])

  const { options, fallback } = useMemo(() => {
    const base = responsibleOptions({ staff, objectId: form.object_id, me })
    // Прежний ответственный заявки мог уйти с объекта или быть без контакта — в окне он остаётся, пока его не сменят.
    if (editing && request.responsible_name && form.object_id === request.object_id) {
      const key = request.responsible_contact_id ? `${request.responsible_contact_id}:${request.responsible_role}` : 'keep'
      if (!base.options.some((o) => o.key === key)) {
        return {
          ...base,
          options: [{ key, contactId: request.responsible_contact_id, name: request.responsible_name, role: request.responsible_role }, ...base.options],
        }
      }
    }
    return base
  }, [staff, form.object_id, me, editing, request])

  // Сменили объект — список другой: подставляем подходящего, чтобы не выбирать себя каждый раз.
  useEffect(() => {
    setForm((prev) => {
      const next = pickResponsibleKey({ options, current: prev.responsibleKey, myName: me?.name })
      return next === prev.responsibleKey ? prev : { ...prev, responsibleKey: next }
    })
  }, [options, me?.name])

  const set = (name) => (e) => setForm((prev) => ({ ...prev, [name]: e.target.value }))

  // Добавить выбранные (проверка типа и размера) или убрать один файл из списка.
  const changeFiles = (setter, slot) => (list, removed) => {
    if (removed) {
      setter((prev) => prev.filter((f) => f !== removed))
      return
    }
    const problems = []
    const good = []
    for (const file of list) {
      const problem = dpFileProblem(file)
      if (problem) problems.push(`${file.name}: ${problem}`)
      else good.push(file)
    }
    setFileError((prev) => ({ ...prev, [slot]: problems.join('; ') }))
    setter((prev) => {
      const known = new Set(prev.map((f) => `${f.name}:${f.size}`))
      return [...prev, ...good.filter((f) => !known.has(`${f.name}:${f.size}`))]
    })
  }

  const problems = dpFormProblems(form, editing ? {} : { conceptCount: conceptFiles.length, contractCount: contractFiles.length })

  const submit = async (e) => {
    e.preventDefault()
    if (problems.length || saving) return
    const option = options.find((o) => o.key === form.responsibleKey)
    const fields = dpFormFields(form, option)
    setSaving(true)
    setError('')
    try {
      if (editing) {
        await updateDpRequest(request.id, fields)
        await onSaved()
      } else {
        const created = await createDpRequest({ fields, conceptFiles, contractFiles })
        await onSaved(created)
      }
    } catch (err) {
      setError(dpErrorText(err))
      setSaving(false)
    }
  }

  return (
    <div className="dpr-overlay">
      <form className="dpr-dialog" role="dialog" aria-modal="true" aria-labelledby="dpr-form-title" onSubmit={submit}>
        <header className="dpr-dialog-head">
          <h3 id="dpr-form-title">{editing ? `Заявка на ДП № ${request.request_number}` : 'Новая заявка на ДП'}</h3>
          <button type="button" className="dpr-x" aria-label="Закрыть" disabled={saving} onClick={onClose}><IconClose size={18} /></button>
        </header>

        <div className="dpr-dialog-body">
          <div className="dpr-field">
            <label className="dpr-label" htmlFor="dpr-f-object">Объект<b className="dpr-req"> *</b></label>
            <select id="dpr-f-object" value={form.object_id} onChange={set('object_id')} autoFocus={!editing}>
              <option value="">— Выберите объект —</option>
              {objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>

          <div className="dpr-field">
            <label className="dpr-label" htmlFor="dpr-f-contract">Договор<b className="dpr-req"> *</b></label>
            <input id="dpr-f-contract" type="text" maxLength={500} value={form.contract_title} onChange={set('contract_title')} placeholder="Номер или название договора, подрядчик" />
          </div>

          {!editing && (
            <>
              <StagedFiles
                id="dpr-contract-files"
                label="Документ договора"
                required
                hint="Без него заявку не создать. PDF, Word или скан, до 50 МБ. Можно перетащить сюда."
                files={contractFiles}
                onFiles={changeFiles(setContractFiles, 'contract')}
                error={fileError.contract}
              />
              <StagedFiles
                id="dpr-concept-files"
                label="Понятийное соглашение"
                required
                hint="Без него заявку не создать. PDF, Word или скан, до 50 МБ. Можно перетащить сюда."
                files={conceptFiles}
                onFiles={changeFiles(setConceptFiles, 'concept')}
                error={fileError.concept}
              />
              {isWebLink(templateLink) && (
                <a className="dpr-template-link" href={templateLink} target="_blank" rel="noopener noreferrer">Открыть шаблон понятийного соглашения</a>
              )}
            </>
          )}

          <div className="dpr-field">
            <label className="dpr-label" htmlFor="dpr-f-amount">Сумма, ₽<b className="dpr-req"> *</b></label>
            <input
              id="dpr-f-amount"
              type="text"
              inputMode="decimal"
              className="dpr-amount-input"
              value={form.amount}
              onChange={(e) => setForm((prev) => ({ ...prev, amount: formatAmountLive(e.target.value) }))}
              placeholder="0,00"
            />
          </div>

          <div className="dpr-field">
            <label className="dpr-label" htmlFor="dpr-f-resp">Ответственный<b className="dpr-req"> *</b></label>
            <select id="dpr-f-resp" value={form.responsibleKey} onChange={set('responsibleKey')} disabled={!form.object_id}>
              <option value="">{form.object_id ? '— Выберите ответственного —' : 'Сначала выберите объект'}</option>
              {options.map((o) => <option key={o.key} value={o.key}>{o.name} · {DP_ROLE_LABEL[o.role] || 'ответственный'}</option>)}
            </select>
            {fallback && (
              <span className="dpr-hint">
                В карточке объекта не указаны экономист и руководитель строительства — показаны такие сотрудники других объектов.
              </span>
            )}
            {form.object_id && !options.length && (
              <span className="dpr-error-line">Нет ни одного экономиста или руководителя строительства: их указывают в карточке объекта.</span>
            )}
          </div>

          <div className="dpr-field">
            <label className="dpr-label" htmlFor="dpr-f-reason">Комментарий: причина создания ДП<b className="dpr-req"> *</b></label>
            <textarea id="dpr-f-reason" rows={4} maxLength={4000} value={form.reason} onChange={set('reason')} placeholder="Зачем нужен договор подряда" />
          </div>
        </div>

        <footer className="dpr-dialog-foot">
          {error && <p className="dpr-error" role="alert"><IconAlert size={15} /> {error}</p>}
          {!error && problems.length > 0 && <p className="dpr-problems">Чтобы {editing ? 'сохранить' : 'создать заявку'}: {problems.join(', ')}.</p>}
          <div className="dpr-dialog-buttons">
            <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving || problems.length > 0}>
              {saving ? 'Сохранение…' : (editing ? 'Сохранить' : 'Создать заявку')}
            </button>
          </div>
        </footer>
      </form>
    </div>
  )
}
