import { useRef, useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import DocCheckLabelsInput from './DocCheckLabelsInput'
import renderCounterpartyOption from './DocCheckCounterpartyOption'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconTrash } from '../icons/ActionIcons'
import { IconObject, IconUser } from '../icons/ToolbarIcons'
import { safeHttpUrl } from '../../utils/publicTenders'
import { filterCounterpartyOptions } from '../../utils/counterpartyPicker'
import { ownObjectChoice } from '../../utils/ownObjectChoice'
import {
  DOC_CHECK_COLORS,
  DOC_CHECK_CONCEPT_CATEGORY,
  DOC_CHECK_PRIORITIES,
  DOC_CHECK_STATUS_LABEL,
  DOC_TYPES,
  MAX_CREATOR_NAME,
  assigneeIdsToSave,
  assigneeStaffOptions,
  createdFieldsPatch,
  normalizeLabels,
  shownAssigneeIds,
  toDateTimeInput,
} from '../../utils/docCheckHelpers'

// Форма заявки на проверку ДП/ДС.
//
// Объект и контрагент вводятся руками и НЕ привязаны к реестру «Договоры и ДС»:
// проверка идёт как раз до того, как договор туда заводят, поэтому выбирать
// там нечего. Контрагента может не быть (заявка по письму) — тогда нужно
// примечание: по нему карточку и узнают на доске.
//
// Контрагента ищут по названию, ИНН и постоянному номеру реестра контрагентов (06.11.2026; правила — utils/counterpartyPicker.js,
// опции собирает страница: counterpartyOptions).
//
// Статуса в форме нет: новая заявка встаёт в колонку, где нажали «+ Добавить
// заявку» (по кнопке в шапке — в «Новые заявки»), дальше её двигают по доске.
// Исполнители, срок, приоритет, цвет и метки — только при колонках 20261113
// (hasBoardFields); без них форма прежняя. Ссылки на письмо при создании нет (11.11.2026,
// решение пользователя); у прежней заявки, где она стоит, поле остаётся в правке — поправить
// или убрать (колонки 20261124, hasCardFields). Исполнителем выбирают только юриста ОСП. Дату
// создания и автора заявки меняет только администратор, у созданной заявки (canEditCreated).
//
// Объект новой заявки у сотрудника, привязанного к объектам в «Ролях» (ownObjects — его объекты; null — читаются; undefined —
// привязки нет): один — стоит серым, несколько — выбор обязателен (ownObjectChoice, как в «Заявке на заключение ДП»; без объекта
// такую заявку не примет и база). creatorOnly — право только создавать (20270102, руководитель строительства, экономист объекта):
// исполнителей, срока, приоритета, цвета и меток нет (их ставит отдел, база их у автора снимает), зато сразу — файлы, двумя
// частями, как «Документы» в окне заявки: понятийное соглашение и документы на проверку. После создания автор их не меняет.

const EMPTY = {
  object_id: '', counterparty_id: '', doc_type: 'ds', doc_number: '', doc_date: '', notes: '',
  assignee_ids: [], due_date: '', priority: '', color: '', labels: [], email_link: '',
}

// Файл, брошенный мимо частей с файлами, браузер не открывает вместо страницы: набранная форма не теряется. Части ловят файл
// раньше (preventDefault), им это не мешает.
const withFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
const blockStrayDrop = {
  onDragOver: (e) => { if (withFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none' } },
  onDrop: (e) => { if (withFiles(e) && !e.defaultPrevented) e.preventDefault() },
}

// Файлы новой заявки: уходят на сервер вместе с ней (строки ещё нет).
function StagedFiles({ id, label, hint, testId, files, onFiles }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const add = (list) => {
    const known = new Set(files.map((f) => `${f.name}:${f.size}`))
    onFiles([...files, ...Array.from(list || []).filter((f) => !known.has(`${f.name}:${f.size}`))])
  }
  return (
    <div className="dc-form-row">
      <span className="dc-form-label" id={`${id}-label`}>{label}</span>
      <div
        className={`dc-drop${dragging ? ' is-over' : ''}`}
        data-testid={testId}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); add(e.dataTransfer?.files) }}
      >
        {files.map((file) => (
          <div key={`${file.name}:${file.size}`} className="dc-drop-file">
            <PaperclipIcon size={14} />
            <span className="dc-drop-name" title={file.name}>{file.name}</span>
            <button
              type="button"
              className="dc-icon-btn"
              aria-label={`Убрать ${file.name}`}
              title="Убрать"
              onClick={() => onFiles(files.filter((f) => f !== file))}
            ><IconTrash size={14} /></button>
          </div>
        ))}
        <button type="button" className="dc-drop-add" aria-labelledby={`${id}-label`} onClick={() => inputRef.current?.click()}>
          {files.length ? '+ ещё файл' : 'Выбрать файл'}
        </button>
        <span className="dc-drop-hint">{hint}</span>
        <input ref={inputRef} type="file" hidden multiple onChange={(e) => { add(e.target.files); e.target.value = '' }} />
      </div>
    </div>
  )
}

export default function DocCheckFormModal({
  request, status, objects, counterpartyOptions, employees, labelSuggestions,
  hasBoardFields, hasCardFields, canEditCreated, creatorOnly = false, ownObjects, ownObjectsFailed = false, onSave, onClose,
}) {
  const [form, setForm] = useState(() => (request
    ? {
      object_id: request.object_id || '',
      counterparty_id: request.counterparty_id || '',
      doc_type: request.doc_type || 'ds',
      doc_number: request.doc_number || '',
      doc_date: request.doc_date || '',
      notes: request.notes || '',
      assignee_ids: shownAssigneeIds(request, employees),
      due_date: request.due_date || '',
      priority: request.priority || '',
      color: request.color || '',
      labels: request.labels || [],
      email_link: request.email_link || '',
      created_at: toDateTimeInput(request.created_at),
      created_by_name: request.created_by_name || '',
    }
    : EMPTY))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conceptFiles, setConceptFiles] = useState([])
  const [files, setFiles] = useState([])
  const set = (patch) => { setForm(f => ({ ...f, ...patch })); setError('') }
  const showWorkFields = hasBoardFields && !creatorOnly
  // Ссылка на письмо — только в правке заявки, где она уже стоит (при создании её не вводят).
  const showEmailLink = hasCardFields && !!request?.email_link
  const ownChoice = !request && ownObjects !== undefined
    ? ownObjectChoice({ ownObjects, failed: ownObjectsFailed, objectId: form.object_id })
    : null
  const ownPick = ownChoice && !(ownObjects && ownObjects.length === 0)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (ownChoice?.problem) {
      setError(ownChoice.problem[0].toUpperCase() + ownChoice.problem.slice(1))
      return
    }
    if (!form.counterparty_id && !form.notes.trim()) {
      setError('Укажите контрагента или опишите заявку в примечании')
      return
    }
    const emailLink = form.email_link.trim()
    if (showEmailLink && emailLink && !safeHttpUrl(emailLink)) {
      setError('Ссылка на письмо — адрес вида https://…')
      return
    }
    const created = request && canEditCreated ? createdFieldsPatch(request, form.created_at, form.created_by_name) : { patch: {} }
    if (created.error) {
      setError(created.error)
      return
    }
    setSaving(true)
    try {
      const payload = {
        object_id: (ownChoice ? ownChoice.objectId : form.object_id) || null,
        counterparty_id: form.counterparty_id || null,
        doc_type: form.doc_type,
        doc_number: form.doc_number.trim() || null,
        doc_date: form.doc_date || null,
        notes: form.notes.trim() || null,
      }
      if (showWorkFields) {
        Object.assign(payload, {
          assignee_ids: assigneeIdsToSave(request?.assignee_ids, form.assignee_ids, employees),
          due_date: form.due_date || null,
          priority: form.priority || null,
          color: form.color || null,
          labels: normalizeLabels(form.labels),
        })
      }
      if (showEmailLink) {
        payload.email_link = emailLink || null
      }
      Object.assign(payload, created.patch)
      const staged = creatorOnly && !request
        ? [...conceptFiles.map(file => ({ file, category: DOC_CHECK_CONCEPT_CATEGORY })), ...files.map(file => ({ file, category: null }))]
        : []
      await onSave(payload, staged)
    } finally {
      setSaving(false)
    }
  }

  // Кого подсказать в «Кто создал»: любой сотрудник, не только юрист. Ввод свободный: автор мог уже уйти из компании.
  const creatorNames = [...new Set([...employees.values()].map(e => e.display_name || e.full_name || e.email).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'))

  return (
    <div className="modal-overlay" onClick={onClose} {...blockStrayDrop}>
      <div className="modal dc-form-modal" role="dialog" aria-modal="true" aria-label={request ? 'Изменить заявку' : 'Новая заявка'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{request ? 'Изменить заявку' : 'Новая заявка на проверку'}</h3>
            {!request && status && (
              <p className="dc-detail-sub">Колонка: {DOC_CHECK_STATUS_LABEL[status] || status}</p>
            )}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <form className="dc-form" onSubmit={handleSubmit}>
          <div className="dc-form-row">
            <span className="dc-form-label">Тип документа</span>
            <div className="dc-type-switch">
              {DOC_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`dc-type-opt${form.doc_type === t.value ? ' is-active' : ''}`}
                  aria-pressed={form.doc_type === t.value}
                  onClick={() => set({ doc_type: t.value })}
                  title={t.title}
                >{t.label} — {t.title}</button>
              ))}
            </div>
          </div>

          <div className="dc-form-grid">
            <div className="dc-form-row">
              <label htmlFor="dc-num">Номер документа</label>
              <input
                id="dc-num"
                type="text"
                value={form.doc_number}
                onChange={(e) => set({ doc_number: e.target.value })}
                placeholder="СУ-10-001"
              />
            </div>
            <div className="dc-form-row">
              <label htmlFor="dc-date">Дата документа</label>
              <input
                id="dc-date"
                type="date"
                value={form.doc_date}
                onChange={(e) => set({ doc_date: e.target.value })}
              />
            </div>
          </div>

          <div className="dc-form-grid">
            <div className="dc-form-row">
              <span className="dc-form-label">Контрагент</span>
              <FilterDropdown
                label=""
                searchable
                searchPlaceholder="Название, ИНН или №"
                allLabel="Не выбран"
                icon={<IconUser size={15} />}
                value={form.counterparty_id}
                onChange={(v) => set({ counterparty_id: v || '' })}
                options={counterpartyOptions}
                filterOptions={filterCounterpartyOptions}
                renderOption={renderCounterpartyOption}
              />
            </div>
            {ownPick ? (
              <div className="dc-form-row">
                <label htmlFor="dc-own-object">Объект{!ownChoice.single && <b className="dc-form-req" title="Обязательно"> *</b>}</label>
                {ownChoice.single ? (
                  <select id="dc-own-object" className="dc-form-select" value={ownChoice.single.id} disabled title="Ваш объект в «Ролях» — выбирать не нужно">
                    <option value={ownChoice.single.id}>{ownChoice.single.name}</option>
                  </select>
                ) : ownObjects?.length ? (
                  <select id="dc-own-object" className="dc-form-select" value={ownChoice.objectId} onChange={(e) => set({ object_id: e.target.value })}>
                    <option value="">— Выберите объект —</option>
                    {ownObjects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                ) : (
                  <select id="dc-own-object" className="dc-form-select" value="" disabled>
                    <option value="">{ownObjectsFailed ? 'Объекты не загрузились' : 'Загрузка объектов…'}</option>
                  </select>
                )}
              </div>
            ) : (
              <div className="dc-form-row">
                <span className="dc-form-label">Объект</span>
                <FilterDropdown
                  label=""
                  searchable
                  searchPlaceholder="Поиск объекта…"
                  allLabel="Не выбран"
                  icon={<IconObject size={15} />}
                  value={form.object_id}
                  onChange={(v) => set({ object_id: v || '' })}
                  options={objects.map(o => ({ value: o.id, label: o.name }))}
                />
              </div>
            )}
          </div>

          <div className="dc-form-row">
            <label htmlFor="dc-notes">Примечание</label>
            <textarea
              id="dc-notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder="Что проверить, что запросили и у кого — видно на карточке"
            />
          </div>

          {showEmailLink && (
            <div className="dc-form-row">
              <label htmlFor="dc-email-link">Ссылка на письмо</label>
              <input
                id="dc-email-link"
                type="text"
                inputMode="url"
                value={form.email_link}
                onChange={(e) => set({ email_link: e.target.value })}
                placeholder="https://…"
              />
            </div>
          )}

          {creatorOnly && !request && (
            <>
              <StagedFiles
                id="dc-concept-files"
                label="Понятийное соглашение"
                hint="Если есть. Можно перетащить сюда."
                testId="dc-concept-files"
                files={conceptFiles}
                onFiles={setConceptFiles}
              />
              <StagedFiles
                id="dc-files"
                label="Документы на проверку"
                hint="ДП или ДС, приложения. Можно перетащить сюда. Пока заявка в «Новых», файлы можно добавить и удалить в её окне."
                testId="dc-files"
                files={files}
                onFiles={setFiles}
              />
            </>
          )}

          {showWorkFields && (
            <>
              <div className="dc-form-grid">
                <div className="dc-form-row">
                  <span className="dc-form-label">Исполнители</span>
                  <FilterDropdown
                    label=""
                    multiple
                    searchable
                    searchPlaceholder="Поиск юриста…"
                    allLabel="Не назначены"
                    icon={<IconUser size={15} />}
                    value={form.assignee_ids}
                    onChange={(v) => set({ assignee_ids: v })}
                    options={assigneeStaffOptions(employees)}
                    className="dc-form-assignees"
                  />
                </div>
                <div className="dc-form-row">
                  <label htmlFor="dc-due">Срок</label>
                  <input
                    id="dc-due"
                    type="date"
                    value={form.due_date}
                    onChange={(e) => set({ due_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="dc-form-grid dc-form-grid--wide">
                <div className="dc-form-row">
                  <span className="dc-form-label">Приоритет</span>
                  <div className="dc-type-switch">
                    {[{ value: '', label: 'Не указан' }, ...DOC_CHECK_PRIORITIES].map(p => (
                      <button
                        key={p.value || 'none'}
                        type="button"
                        className={`dc-type-opt${form.priority === p.value ? ' is-active' : ''}`}
                        aria-pressed={form.priority === p.value}
                        onClick={() => set({ priority: p.value })}
                      >{p.label}</button>
                    ))}
                  </div>
                </div>
                <div className="dc-form-row">
                  <span className="dc-form-label">Цвет карточки</span>
                  <div className="dc-menu-colors">
                    <button
                      type="button"
                      className={`dc-swatch dc-swatch--none${!form.color ? ' is-current' : ''}`}
                      aria-label="Без цвета"
                      aria-pressed={!form.color}
                      title="Без цвета"
                      onClick={() => set({ color: '' })}
                    />
                    {DOC_CHECK_COLORS.map(c => (
                      <button
                        key={c.value}
                        type="button"
                        className={`dc-swatch dc-c-${c.value}${form.color === c.value ? ' is-current' : ''}`}
                        aria-label={c.label}
                        aria-pressed={form.color === c.value}
                        title={c.label}
                        onClick={() => set({ color: c.value })}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="dc-form-row">
                <span className="dc-form-label">Метки</span>
                <DocCheckLabelsInput
                  value={form.labels}
                  onChange={(labels) => set({ labels })}
                  suggestions={labelSuggestions}
                />
              </div>
            </>
          )}

          {request && canEditCreated && (
            <div className="dc-form-admin">
              <p className="dc-form-admin-title">Создание заявки — меняет только администратор</p>
              <div className="dc-form-grid">
                <div className="dc-form-row">
                  <label htmlFor="dc-created-at">Дата создания</label>
                  <input
                    id="dc-created-at"
                    type="datetime-local"
                    value={form.created_at}
                    onChange={(e) => set({ created_at: e.target.value })}
                  />
                </div>
                <div className="dc-form-row">
                  <label htmlFor="dc-created-by">Кто создал</label>
                  <input
                    id="dc-created-by"
                    type="text"
                    list="dc-created-by-names"
                    maxLength={MAX_CREATOR_NAME}
                    value={form.created_by_name}
                    onChange={(e) => set({ created_by_name: e.target.value })}
                    placeholder="ФИО"
                  />
                  <datalist id="dc-created-by-names">
                    {creatorNames.map(name => <option key={name} value={name} />)}
                  </datalist>
                </div>
              </div>
            </div>
          )}

          {error && <p className="dc-form-error" role="alert">{error}</p>}

          <div className="dc-form-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : (request ? 'Сохранить' : 'Создать заявку')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
