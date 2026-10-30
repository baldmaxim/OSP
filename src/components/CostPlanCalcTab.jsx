import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import S3DocumentPreview from './S3DocumentPreview'
import { downloadS3File } from './FileDownload'
import { IconDownload, IconPencil, IconTrash } from './icons/ActionIcons'
import { deleteDocument } from '../services/s3'
import {
  deleteCompensation, fetchCalcAnchors, fetchCalcFiles, fetchCompensation, fetchObjectDocOptions, fetchObjectDocsByIds,
  saveCompensation, uploadInstructionFile, uploadObjectCalcFile,
} from '../services/costPlanCalc'
import { fetchEconomistObjects } from '../services/costPlanEconomists'
import {
  COMPENSATION_ITEMS, COMPENSATION_NOTE_MAX, COST_PLAN_CALC_FILES_HINT, COST_PLAN_CALC_SECTIONS,
  COST_PLAN_COMPENSATION_HINT, COST_PLAN_COMPENSATION_LEGACY_HINT, calcObjectCards, compensationForm, formatPercent,
  objectDocHref, objectDocLabel, objectDocOptions, objectMatches, parseCompensation,
} from '../utils/costPlanCalc'
import { describeSupabaseError } from '../utils/supabaseError'
import './CostPlanCalcTab.css'

// «Планы затрат» → «Документы» → «Расчёт ПЗ» (миграции 20261116_cost_plan_calc, 20261121_cost_plan_calc_objects;
// решение пользователя 30.10 — схема с фото, компенсация больше не повторяется под каждой подвкладкой):
//   • «Инструкции» — общие файлы «Прямые затраты» и «КП до перекидок» (якоря section_templates);
//   • «По объектам» — карточка на объект: слева документы объекта «Прямые затраты» и «КП до перекидок», справа
//     «Компенсация НДС» и под ней «Инфляция»: да / нет, процент, подтверждающий документ из «Документов» карточки
//     объекта (ссылка открывает его там) и примечание.
// Смотрит и скачивает каждый; загружает, удаляет и вносит администратор (canEdit). Объекты — основного строительства
// и любые со сведениями или документами; без права правки — только те, где что-то внесено.

const STATES = [
  { value: '', label: 'Не указано' },
  { value: 'yes', label: 'Да' },
  { value: 'no', label: 'Нет' },
]
const SEARCH_FROM = 6 // карточек больше — поиск по объекту

const ruDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '')
const ruDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

// Тип файла — цветом значка: таблица, PDF, Word, прочее.
function fileKind(name) {
  const ext = /\.([^.\s]{1,5})$/.exec(name || '')?.[1]?.toLowerCase() || ''
  if (/^(xlsx?|xlsm|xlsb|csv|ods)$/.test(ext)) return 'sheet'
  if (ext === 'pdf') return 'pdf'
  if (/^(docx?|docm|odt|rtf)$/.test(ext)) return 'doc'
  return 'file'
}
const FileIcon = ({ name }) => (
  <svg className={`cpc-ftype is-${fileKind(name)}`} width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
      fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
)

// Список файлов ячейки: имя — просмотр, значки — скачать и (администратору) удалить, «+ Документ» — загрузить.
function CalcFiles({ title, label, files, canEdit, emptyText, onUpload, onDelete, onPreview }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)

  const pick = async (e) => {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    if (!list.length) return
    setUploading(true)
    try {
      await onUpload(list)
    } finally {
      setUploading(false)
    }
  }
  const download = async (f) => {
    try {
      await downloadS3File(f.s3_key, f.file_name)
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  return (
    <div className="cpc-files">
      <div className="cpc-cell-head">
        <span className="cpc-cell-title">{title}</span>
        {canEdit && (
          <>
            <input ref={inputRef} type="file" multiple hidden onChange={pick} aria-label={`Загрузить: ${label}`} />
            <button type="button" className="cpc-add" onClick={() => inputRef.current?.click()} disabled={uploading}>
              {uploading ? 'Загрузка…' : '+ Документ'}
            </button>
          </>
        )}
      </div>
      {files.length === 0 ? (
        <p className="cpc-none cpc-files-empty">{emptyText}</p>
      ) : (
        <ul className="cpc-file-list">
          {files.map(f => (
            <li key={f.id} className="cpc-file">
              <FileIcon name={f.file_name} />
              <button
                type="button"
                className="cpc-file-name"
                onClick={() => onPreview(f)}
                title={`${f.file_name}\nЗагружен ${ruDateTime(f.created_at)}${f.uploaded_by_name ? `, ${f.uploaded_by_name}` : ''}`}
              >{f.file_name}</button>
              <span className="cpc-file-date">{ruDate(f.created_at)}</span>
              <button type="button" className="cpc-icon" onClick={() => download(f)} title="Скачать" aria-label={`Скачать: ${f.file_name}`}>
                <IconDownload size={14} />
              </button>
              {canEdit && (
                <button type="button" className="cpc-icon is-danger" onClick={() => onDelete(f)} title="Удалить" aria-label={`Удалить: ${f.file_name}`}>
                  <IconTrash size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Пункт компенсации в карточке: да / нет с процентом, подтверждающий документ (ссылка в карточку объекта), примечание.
function ItemView({ item, value, objectId, docs, detailed }) {
  const doc = value.documentId ? docs.get(value.documentId) : null
  return (
    <div className="cpc-item">
      <div className="cpc-cell-head"><span className="cpc-cell-title">{item.label}</span></div>
      {detailed && (
        <div className="cpc-item-value">
          {value.compensated === true ? (
            <span className="cpc-badge is-yes">Да{value.percent != null ? ` · ${formatPercent(value.percent)}` : ''}</span>
          ) : value.compensated === false ? (
            <span className="cpc-badge is-no">Нет</span>
          ) : (
            <span className="cpc-none">не указано</span>
          )}
        </div>
      )}
      {detailed && value.compensated === true && (
        <div className="cpc-item-doc">
          <span className="cpc-item-doc-label">{item.docLabel}:</span>{' '}
          {value.documentId ? (
            <a
              className="cpc-doc-link"
              href={objectDocHref(objectId, value.documentId)}
              target="_blank"
              rel="noopener noreferrer"
              title={doc?.notes ? `${doc.notes}\nОткроется в карточке объекта` : 'Откроется в карточке объекта'}
            >{doc ? objectDocLabel(doc) : 'открыть в карточке объекта'}</a>
          ) : (
            <span className="cpc-none">не указан</span>
          )}
        </div>
      )}
      {value.note ? <p className="cpc-note">{value.note}</p> : !detailed && <span className="cpc-none">не указано</span>}
    </div>
  )
}

// Тот же пункт в правке: «Не указано / Да / Нет», при «да» — процент и документ объекта; примечание — всегда.
function ItemForm({ item, value, objectId, objectName, options, optionsError, docs, detailed, disabled, onChange, onKeyDown, autoFocus }) {
  const name = `cpc-${item.key}-${objectId}`
  const known = !value.documentId || (options || []).some(d => d.id === value.documentId)
  return (
    <fieldset className="cpc-item cpc-item-form" aria-label={`${item.label}: ${objectName}`} disabled={disabled}>
      <div className="cpc-cell-head"><span className="cpc-cell-title">{item.label}</span></div>
      {detailed && (
        <div className="cpc-seg">
          {STATES.map((s, i) => (
            <label key={s.value} className={`cpc-seg-btn${value.state === s.value ? ' is-active' : ''}`}>
              <input
                type="radio"
                name={name}
                value={s.value}
                checked={value.state === s.value}
                onChange={() => onChange({ state: s.value })}
                onKeyDown={onKeyDown}
                autoFocus={autoFocus && (value.state === s.value || (!value.state && i === 0))}
              />
              {s.label}
            </label>
          ))}
        </div>
      )}
      {detailed && value.state === 'yes' && (
        <div className="cpc-item-fields">
          <label className="cpc-field cpc-field-pct">
            <span className="cpc-field-label">Процент</span>
            <span className="cpc-pct">
              <input
                type="text"
                inputMode="decimal"
                className="cpc-input"
                value={value.percent}
                onChange={(e) => onChange({ percent: e.target.value })}
                onKeyDown={onKeyDown}
                placeholder="2"
                aria-label={`${item.label}, процент: ${objectName}`}
              />
              <span aria-hidden="true">%</span>
            </span>
          </label>
          <label className="cpc-field cpc-field-doc">
            <span className="cpc-field-label">{item.docLabel}</span>
            <select
              className="cpc-input"
              value={value.documentId}
              onChange={(e) => onChange({ documentId: e.target.value })}
              onKeyDown={onKeyDown}
              disabled={options == null}
              aria-label={`${item.docLabel}: ${objectName}`}
            >
              <option value="">{options == null ? 'Загрузка документов объекта…' : 'не выбран'}</option>
              {(options || []).map(d => <option key={d.id} value={d.id}>{objectDocLabel(d)}</option>)}
              {options && !known && (
                <option value={value.documentId}>{docs.get(value.documentId) ? objectDocLabel(docs.get(value.documentId)) : 'прежний документ'} — нет в документах объекта</option>
              )}
            </select>
          </label>
          {optionsError && <p className="tdm-site-error" role="alert">Документы объекта не загрузились: {optionsError}</p>}
          {options && options.length === 0 && (
            <p className="cpc-hint">
              В «Документах» объекта нет ни договора генподряда, ни ДС —{' '}
              <a href={objectDocHref(objectId)} target="_blank" rel="noopener noreferrer">добавить в карточке объекта</a>.
            </p>
          )}
        </div>
      )}
      <label className="cpc-field">
        <span className="cpc-field-label">Примечание</span>
        <textarea
          className="cpc-input"
          rows={2}
          maxLength={COMPENSATION_NOTE_MAX}
          value={value.note}
          onChange={(e) => onChange({ note: e.target.value })}
          onKeyDown={onKeyDown}
          aria-label={`${item.label}, примечание: ${objectName}`}
          autoFocus={autoFocus && !detailed}
        />
      </label>
    </fieldset>
  )
}

export default function CostPlanCalcTab({ canEdit = false }) {
  const [state, setState] = useState({
    loading: true, error: null, anchors: new Map(), objects: [], rows: [], compSupported: true, detailed: true,
    instructionFiles: [], objectFiles: [],
  })
  const [docs, setDocs] = useState(() => new Map()) // id → документ объекта: названия подтверждающих
  const triedDocs = useRef(new Set())
  const [query, setQuery] = useState('')
  const [previewDoc, setPreviewDoc] = useState(null)
  const [editing, setEditing] = useState(null) // { objectId, label, form, options, optionsError }
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null)

  const load = useCallback(async () => {
    try {
      const anchorsP = fetchCalcAnchors(COST_PLAN_CALC_SECTIONS.map(s => s.code))
      const [anchors, comp, objects, files] = await Promise.all([
        anchorsP,
        fetchCompensation(),
        fetchEconomistObjects(),
        anchorsP.then(a => fetchCalcFiles([...a.ids.values()])),
      ])
      setState({
        loading: false, error: null, anchors: anchors.ids, objects, rows: comp.rows,
        compSupported: comp.supported, detailed: comp.detailed,
        instructionFiles: files.instructions, objectFiles: files.objects,
      })
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: describeSupabaseError(err) }))
    }
  }, [])

  useEffect(() => { load() }, [load])

  const rememberDocs = useCallback((list) => {
    if (!list.length) return
    setDocs(prev => {
      const next = new Map(prev)
      for (const d of list) next.set(d.id, d)
      return next
    })
  }, [])

  // Названия выбранных подтверждающих документов — одним запросом на новые; не видна строка — останется ссылка.
  const linkedIds = useMemo(() => state.rows.flatMap(r => [r.vat_document_id, r.inflation_document_id]).filter(Boolean), [state.rows])
  useEffect(() => {
    const missing = linkedIds.filter(id => !triedDocs.current.has(id))
    if (!missing.length) return
    for (const id of missing) triedDocs.current.add(id)
    fetchObjectDocsByIds(missing).then(rememberDocs).catch(() => { /* без названий — ссылка «открыть в карточке объекта» */ })
  }, [linkedIds, rememberDocs])

  const cards = useMemo(() => calcObjectCards(state.objects, state.rows, state.objectFiles), [state.objects, state.rows, state.objectFiles])
  const visibleCards = canEdit ? cards : cards.filter(c => c.filled || c.hasFiles)
  const shownCards = visibleCards.filter(c => objectMatches(c.label, query))
  const instructionsBy = useMemo(() => {
    const map = new Map()
    for (const f of state.instructionFiles) {
      if (!map.has(f.owner_id)) map.set(f.owner_id, [])
      map.get(f.owner_id).push(f)
    }
    return map
  }, [state.instructionFiles])

  // Загрузка по одному файлу: загруженные до сбоя остаются в списке.
  const uploadFiles = async (files, upload, listKey) => {
    const added = []
    try {
      for (const file of files) added.push(await upload(file))
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      if (added.length) setState(prev => ({ ...prev, [listKey]: [...added.reverse(), ...prev[listKey]] }))
    }
  }
  const removeFile = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    try {
      await deleteDocument(doc)
      setState(prev => ({
        ...prev,
        instructionFiles: prev.instructionFiles.filter(d => d.id !== doc.id),
        objectFiles: prev.objectFiles.filter(d => d.id !== doc.id),
      }))
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const startEdit = (card) => {
    setFormError(null)
    setEditing({ objectId: card.id, label: card.label, form: compensationForm(card), options: state.detailed ? null : [], optionsError: null })
    if (!state.detailed) return
    fetchObjectDocOptions(card.id)
      .then((list) => {
        const options = objectDocOptions(list)
        rememberDocs(options)
        setEditing(prev => (prev?.objectId === card.id ? { ...prev, options } : prev))
      })
      .catch((err) => setEditing(prev => (prev?.objectId === card.id ? { ...prev, options: [], optionsError: describeSupabaseError(err) } : prev)))
  }
  const cancelEdit = () => { setEditing(null); setFormError(null) }
  const changeItem = (key, patch) => setEditing(prev => ({ ...prev, form: { ...prev.form, [key]: { ...prev.form[key], ...patch } } }))

  const submit = async () => {
    if (!editing || busy) return
    const parsed = parseCompensation(editing.form, { detailed: state.detailed })
    if (parsed.error) { setFormError(parsed.error); return }
    const { objectId } = editing
    setBusy(true)
    setFormError(null)
    try {
      if (parsed.empty) {
        if (state.rows.some(r => r.object_id === objectId)) await deleteCompensation(objectId)
        setState(prev => ({ ...prev, rows: prev.rows.filter(r => r.object_id !== objectId) }))
      } else {
        const row = await saveCompensation(objectId, parsed.value, { detailed: state.detailed })
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

  if (state.loading) return <div className="tdm-body cpc"><p className="tdm-site-empty-state">Загрузка…</p></div>
  if (state.error) {
    return (
      <div className="tdm-body cpc">
        <p className="tdm-site-alert is-error" role="alert">
          Не удалось загрузить расчёт ПЗ: {state.error}{' '}
          <button type="button" className="tdm-site-link" onClick={() => { setState(p => ({ ...p, loading: true, error: null })); load() }}>
            Повторить
          </button>
        </p>
      </div>
    )
  }

  const instructions = COST_PLAN_CALC_SECTIONS.map(s => ({ ...s, anchorId: state.anchors.get(s.code) || null }))
  const compEditable = canEdit && state.compSupported

  return (
    <div className="tdm-body cpc">
      <p className="tdm-lead">
        Инструкции — общие для всех объектов. Ниже по каждому объекту: документы расчёта, компенсация НДС и инфляция с
        подтверждающим документом из карточки объекта. Смотреть и скачивать может каждый, загружает и вносит
        администратор.
      </p>

      <section className="cpc-block" aria-labelledby="cpc-instr-title">
        <h4 id="cpc-instr-title" className="cpc-block-title">Инструкции</h4>
        {instructions.every(s => !s.anchorId) ? (
          <p className="tdm-note">{COST_PLAN_CALC_FILES_HINT}</p>
        ) : (
          <div className="cpc-instr-grid">
            {instructions.filter(s => s.anchorId).map(s => (
              <div key={s.key} className="cpc-instr" data-section={s.key}>
                <CalcFiles
                  title={s.label}
                  label={`инструкция «${s.label}»`}
                  files={instructionsBy.get(s.anchorId) || []}
                  canEdit={canEdit}
                  emptyText="Инструкция не загружена"
                  onUpload={(files) => uploadFiles(files, (file) => uploadInstructionFile(file, s.anchorId), 'instructionFiles')}
                  onDelete={removeFile}
                  onPreview={setPreviewDoc}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="cpc-block" aria-labelledby="cpc-obj-title">
        <div className="cpc-block-head">
          <h4 id="cpc-obj-title" className="cpc-block-title">По объектам</h4>
          {visibleCards.length > SEARCH_FROM && (
            <input
              type="search"
              className="cpc-search"
              placeholder="Найти объект"
              aria-label="Найти объект"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </div>
        {!state.compSupported && <p className="tdm-note">{COST_PLAN_COMPENSATION_HINT}</p>}
        {state.compSupported && !state.detailed && <p className="tdm-note">{COST_PLAN_COMPENSATION_LEGACY_HINT}</p>}

        {visibleCards.length === 0 ? (
          <p className="tdm-site-empty-state">
            {canEdit ? 'Объектов основного строительства нет.' : 'Документы и сведения по объектам ещё не внесены.'}
          </p>
        ) : shownCards.length === 0 ? (
          <p className="tdm-site-empty-state">По запросу «{query}» объектов нет.</p>
        ) : (
          <div className="cpc-cards">
            {shownCards.map(card => {
              const isEditing = editing?.objectId === card.id
              return (
                <article key={card.id} className={`cpc-card${isEditing ? ' is-editing' : ''}`} data-object-id={card.id} aria-labelledby={`cpc-card-${card.id}`}>
                  <header className="cpc-card-head">
                    <h5 id={`cpc-card-${card.id}`} className="cpc-card-title">{card.label}</h5>
                    {compEditable && !isEditing && (
                      <button
                        type="button"
                        className="ui-btn is-icon-only cpc-edit"
                        onClick={() => startEdit(card)}
                        disabled={busy || Boolean(editing)}
                        title="Изменить компенсацию НДС и инфляцию"
                        aria-label={`Изменить компенсацию НДС и инфляцию: ${card.label}`}
                      ><IconPencil size={14} /></button>
                    )}
                  </header>
                  <div className="cpc-card-grid">
                    {COST_PLAN_CALC_SECTIONS.map((s, i) => {
                      const item = COMPENSATION_ITEMS[i]
                      return [
                        <div key={s.key} className={`cpc-cell cpc-area-${s.key}`}>
                          <CalcFiles
                            title={s.label}
                            label={`${s.label} — ${card.label}`}
                            files={card.files[s.key]}
                            canEdit={canEdit}
                            emptyText="Документа нет"
                            onUpload={(files) => uploadFiles(files, (file) => uploadObjectCalcFile(file, card.id, s.category), 'objectFiles')}
                            onDelete={removeFile}
                            onPreview={setPreviewDoc}
                          />
                        </div>,
                        <div key={item.key} className={`cpc-cell cpc-area-${item.key}`}>
                          {isEditing ? (
                            <ItemForm
                              item={item}
                              value={editing.form[item.key]}
                              objectId={card.id}
                              objectName={card.label}
                              options={editing.options}
                              optionsError={editing.optionsError}
                              docs={docs}
                              detailed={state.detailed}
                              disabled={busy}
                              onChange={(patch) => changeItem(item.key, patch)}
                              onKeyDown={onFieldKeyDown}
                              autoFocus={i === 0}
                            />
                          ) : (
                            <ItemView item={item} value={card[item.key]} objectId={card.id} docs={docs} detailed={state.detailed} />
                          )}
                        </div>,
                      ]
                    })}
                  </div>
                  {isEditing && (
                    <div className="cpc-edit-bar">
                      {formError && <p className="tdm-site-error" role="alert">{formError}</p>}
                      <span className="cpc-hint">Ничего не указано — сведения объекта удаляются. Документы слева сохраняются сразу.</span>
                      <button type="button" className="btn-secondary" onClick={cancelEdit} disabled={busy}>Отмена</button>
                      <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
                        {busy ? 'Сохранение…' : 'Сохранить'}
                      </button>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {previewDoc && <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}
