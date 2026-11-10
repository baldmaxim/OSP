import { useEffect, useMemo, useRef, useState } from 'react'
import { IconClose } from '../icons/ToolbarIcons'
import { IconAlert, IconTrash } from '../icons/ActionIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, formatAmountLive } from '../../utils/money'
import {
  DP_CONCEPT_CATEGORY, DP_DOCS_CATEGORY, DP_ROLE_LABEL, EMPTY_DP_FORM, dpErrorText, dpFileAccept, dpFileProblem, dpFormFields, dpFormProblems,
  ownObjectChoice, pickResponsibleKey, responsibleOptions,
} from '../../utils/dpRequests'
import { createDpRequest, updateDpRequest } from '../../services/dpRequests'
import { SECTION_TEMPLATE_LINK_KEY, fetchTemplateLinks, isWebLink } from '../../services/sectionTemplates'
// Стили окна — со страницы заявок: окно открывают и из «Реестра по договорам» (DpRequestCreateButton), куда страница не заходила.
import '../../pages/DpRequestsPage.css'

// Файлы, выбранные в окне новой заявки: на сервер уходят только вместе с заявкой (строки ещё нет).
function StagedFiles({ id, label, hint, accept, files, onFiles, required, error }) {
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
        <input ref={inputRef} type="file" hidden multiple accept={accept} onChange={(e) => { add(e.target.files); e.target.value = '' }} />
      </div>
      {error && <span className="dpr-error-line">{error}</span>}
    </div>
  )
}

// Окно новой заявки и правки (решение пользователя 05.11.2026). Подающий заполняет только понятийное соглашение (без него заявку не создать), документы и
// примечание. Объект, договор, сумму и ответственного (экономист объекта или руководитель строительства) видит и заполняет только тот, кто работает с
// заявками (canWork); они необязательны: заполняются по мере готовности. Файлы уже созданной заявки меняются в её строке, здесь — только при создании.
// Исключение — объект подающего, привязанного к объектам в «Ролях» (06.11.2026): ownObjects — его объекты (null — читаются, undefined —
// привязки нет или он сам работает с заявками). Один — стоит серым, несколько — выбор обязателен (ownObjectChoice). Только при создании:
// объект поданной заявки меняет отдел (запрет базы), автор при правке по-прежнему видит одно примечание.
// Закрывается только кнопками: щелчок мимо унёс бы заполненное.
export default function DpRequestFormModal({
  request, objects, staff, me, canWork = false, ownObjects, ownObjectsFailed = false, onClose, onSaved,
}) {
  const editing = !!request
  const [form, setForm] = useState(() => (editing
    ? {
      object_id: request.object_id || '',
      contract_title: request.contract_title || '',
      amount: request.amount == null ? '' : formatAmount(Number(request.amount)),
      responsibleKey: request.responsible_contact_id
        ? `${request.responsible_contact_id}:${request.responsible_role}`
        : (request.responsible_name ? 'keep' : ''),
      reason: request.reason || '',
    }
    : EMPTY_DP_FORM))
  const [conceptFiles, setConceptFiles] = useState([])
  const [docFiles, setDocFiles] = useState([])
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
    if (editing && request.responsible_name && form.object_id === (request.object_id || '')) {
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
  const changeFiles = (setter, category) => (list, removed) => {
    if (removed) {
      setter((prev) => prev.filter((f) => f !== removed))
      return
    }
    const problems = []
    const good = []
    for (const file of list) {
      const problem = dpFileProblem(file, category)
      if (problem) problems.push(`${file.name}: ${problem}`)
      else good.push(file)
    }
    setFileError((prev) => ({ ...prev, [category]: problems.join('; ') }))
    setter((prev) => {
      const known = new Set(prev.map((f) => `${f.name}:${f.size}`))
      return [...prev, ...good.filter((f) => !known.has(`${f.name}:${f.size}`))]
    })
  }

  const ownChoice = !canWork && !editing && ownObjects !== undefined
    ? ownObjectChoice({ ownObjects, failed: ownObjectsFailed, objectId: form.object_id })
    : null
  const problems = dpFormProblems(form, { canWork, conceptCount: editing ? null : conceptFiles.length, objectProblem: ownChoice?.problem })

  const submit = async (e) => {
    e.preventDefault()
    if (problems.length || saving) return
    const option = options.find((o) => o.key === form.responsibleKey)
    const fields = dpFormFields(form, option, { canWork, ownObjectId: ownChoice?.objectId })
    setSaving(true)
    setError('')
    try {
      if (editing) {
        await updateDpRequest(request.id, fields)
        await onSaved()
      } else {
        const created = await createDpRequest({ fields, conceptFiles, docFiles })
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
          <h3 id="dpr-form-title">{editing ? `Заявка на заключение ДП № ${request.request_number}` : 'Новая заявка на заключение ДП'}</h3>
          <button type="button" className="dpr-x" aria-label="Закрыть" disabled={saving} onClick={onClose}><IconClose size={18} /></button>
        </header>

        <div className="dpr-dialog-body">
          {ownChoice && !(ownObjects && ownObjects.length === 0) && (
            <div className="dpr-field">
              <label className="dpr-label" htmlFor="dpr-f-own-object">
                Объект{!ownChoice.single && <b className="dpr-req" title="Обязательно"> *</b>}
              </label>
              {ownChoice.single ? (
                <select id="dpr-f-own-object" value={ownChoice.single.id} disabled title="Ваш объект в «Ролях» — выбирать не нужно">
                  <option value={ownChoice.single.id}>{ownChoice.single.name}</option>
                </select>
              ) : ownObjects?.length ? (
                <select id="dpr-f-own-object" value={ownChoice.objectId} onChange={set('object_id')}>
                  <option value="">— Выберите объект —</option>
                  {ownObjects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <select id="dpr-f-own-object" value="" disabled>
                  <option value="">{ownObjectsFailed ? 'Объекты не загрузились' : 'Загрузка объектов…'}</option>
                </select>
              )}
            </div>
          )}
          {!editing && (
            <>
              <StagedFiles
                id="dpr-concept-files"
                label="Понятийное соглашение"
                required
                hint="Без него заявку не создать. PDF, Word или скан, до 50 МБ. Можно перетащить сюда."
                accept={dpFileAccept(DP_CONCEPT_CATEGORY)}
                files={conceptFiles}
                onFiles={changeFiles(setConceptFiles, DP_CONCEPT_CATEGORY)}
                error={fileError[DP_CONCEPT_CATEGORY]}
              />
              {isWebLink(templateLink) && (
                <a className="dpr-template-link" href={templateLink} target="_blank" rel="noopener noreferrer">Открыть шаблон понятийного соглашения</a>
              )}
              <StagedFiles
                id="dpr-doc-files"
                label="Документы (необязательно)"
                hint="PDF, Word, Excel или скан, до 50 МБ. Можно перетащить сюда."
                accept={dpFileAccept(DP_DOCS_CATEGORY)}
                files={docFiles}
                onFiles={changeFiles(setDocFiles, DP_DOCS_CATEGORY)}
                error={fileError[DP_DOCS_CATEGORY]}
              />
            </>
          )}

          <div className="dpr-field">
            <label className="dpr-label" htmlFor="dpr-f-reason">Примечание</label>
            <textarea id="dpr-f-reason" rows={4} maxLength={4000} value={form.reason} onChange={set('reason')} />
          </div>

          {canWork && (
            <fieldset className="dpr-work-fields">
              <legend>Заполняет отдел</legend>
              <div className="dpr-field">
                <label className="dpr-label" htmlFor="dpr-f-object">Объект</label>
                <select id="dpr-f-object" value={form.object_id} onChange={set('object_id')}>
                  <option value="">— Выберите объект —</option>
                  {objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>

              <div className="dpr-field">
                <label className="dpr-label" htmlFor="dpr-f-contract">Договор</label>
                <input id="dpr-f-contract" type="text" maxLength={500} value={form.contract_title} onChange={set('contract_title')} placeholder="Номер или название договора, подрядчик" />
              </div>

              <div className="dpr-field">
                <label className="dpr-label" htmlFor="dpr-f-amount">Сумма, ₽</label>
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
                <label className="dpr-label" htmlFor="dpr-f-resp">Ответственный</label>
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
            </fieldset>
          )}
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
