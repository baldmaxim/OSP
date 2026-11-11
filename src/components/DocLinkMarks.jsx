import { useRef, useState } from 'react'
import AnchoredPopover from './AnchoredPopover'
import { openFolder } from './FolderOpen'
import { copyWithToast } from './CopyToast'
import { LARIX_LINK_FIELD, LARIX_NAME, larixCode, larixLink } from '../utils/contractLarix'
import './DocLinkMarks.css'

// Пути договора или ДС в «Реестре по договорам» — значками (11.11.2026, решение пользователя: «Signal — просто зелёной
// маленькой иконкой, если есть ссылка, красной, если нет; у Larix — либо „нет“, либо код с конца ссылки, полную ссылку
// не надо; путь к шаре — либо указан, либо нет»). Раньше каждый заполненный путь занимал в ячейке свою строку с адресом.
//
// Нажатие на заполненный значок — переход: папка открывается в проводнике (помощник, FolderOpen; без него путь
// копируется), Signal и Larix — в новой вкладке (не адрес — копируется). Полный путь — в подсказке. Правка — одним
// окном на все три пути: карандаш (если что-то уже указано) или пустой красный значок — у права правки «Договоров»;
// без права пустой значок — только отметка.
//
// onSave(поле, значение) — промис; false — не сохранилось (сообщение показал вызывающий), окно остаётся открытым.

const FIELDS = [
  { key: 'folder_path', label: 'Путь к папке', placeholder: '\\\\su10-fs\\Договоры\\ЖК Алия\\СУ-2-АЛ' },
  { key: 'signal_link', label: 'Ссылка на Signal', placeholder: 'https://… папка договора в Signal' },
  { key: LARIX_LINK_FIELD, label: `Ссылка на ${LARIX_NAME}`, placeholder: 'https://cpm.su10.larix.ru/contract/…' },
]

const isWebUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim())
const valueOf = (doc, key) => String(doc?.[key] ?? '').trim()

const Svg = ({ children, width = 2 }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconFolder = () => (
  <Svg><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>
)
const IconCloud = () => <Svg><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></Svg>
const IconPencil = () => <Svg width={1.8}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>

// Значок одного пути: заполнен — ссылка или кнопка перехода, пуст — кнопка «указать» (с правом правки) или отметка.
function Mark({ kind, on, title, href, onActivate, onAdd, children }) {
  const cls = `dlm dlm-${kind} ${on ? 'is-on' : 'is-off'}`
  const stop = (e) => e.stopPropagation()
  if (on && href) {
    return <a className={cls} href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} onClick={stop}>{children}</a>
  }
  if (on) {
    return <button type="button" className={cls} title={title} aria-label={title} onClick={(e) => { stop(e); onActivate() }}>{children}</button>
  }
  if (onAdd) {
    return <button type="button" className={cls} title={title} aria-label={title} onClick={(e) => { stop(e); onAdd() }}>{children}</button>
  }
  return <span className={cls} role="img" title={title} aria-label={title}>{children}</span>
}

export default function DocLinkMarks({ doc, canEdit = false, onSave, label = 'документа' }) {
  const groupRef = useRef(null)
  const [editor, setEditor] = useState(null) // { anchor, focus }
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)

  const folder = valueOf(doc, 'folder_path')
  const signal = valueOf(doc, 'signal_link')
  const larix = larixLink(doc)
  const anyFilled = !!(folder || signal || larix)

  const openEditor = (focus) => {
    if (!canEdit || editor) return
    setDraft(Object.fromEntries(FIELDS.map(f => [f.key, valueOf(doc, f.key)])))
    setEditor({ anchor: groupRef.current, focus })
  }
  const add = (key) => (canEdit ? () => openEditor(key) : null)
  const dirty = !!editor && FIELDS.some(f => (draft[f.key] || '').trim() !== valueOf(doc, f.key))
  const close = () => { if (!saving) setEditor(null) }

  const save = async (e) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      for (const f of FIELDS) {
        const next = (draft[f.key] || '').trim()
        if (next === valueOf(doc, f.key)) continue
        if (await onSave(f.key, next) === false) return
      }
      setEditor(null)
    } finally {
      setSaving(false)
    }
  }

  const copy = (value, what) => copyWithToast(value, `${what} скопирован`)

  return (
    <span className="dlm-group" ref={groupRef}>
      <Mark
        kind="folder"
        on={!!folder}
        title={folder ? `Папка: ${folder}\nНажмите — открыть в проводнике` : `Путь к папке не указан${canEdit ? ' — нажмите, чтобы указать' : ''}`}
        onActivate={() => { if (!openFolder(folder)) copy(folder, 'Путь к папке') }}
        onAdd={add('folder_path')}
      ><IconFolder /></Mark>
      <Mark
        kind="signal"
        on={!!signal}
        href={isWebUrl(signal) ? signal : null}
        title={signal ? `Signal: ${signal}` : `Ссылки на Signal нет${canEdit ? ' — нажмите, чтобы указать' : ''}`}
        onActivate={() => copy(signal, 'Путь к Signal')}
        onAdd={add('signal_link')}
      ><IconCloud /></Mark>
      <Mark
        kind="larix"
        on={!!larix}
        href={isWebUrl(larix) ? larix : null}
        title={larix ? `${LARIX_NAME}: ${larix}` : `Не внесён в ${LARIX_NAME}${canEdit ? ' — нажмите, чтобы указать ссылку' : ''}`}
        onActivate={() => copy(larix, `Путь к ${LARIX_NAME}`)}
        onAdd={add(LARIX_LINK_FIELD)}
      >
        <span className="dlm-larix-name">Larix</span>
        <span className="dlm-larix-code">{larix ? larixCode(larix) : 'нет'}</span>
      </Mark>
      {canEdit && anyFilled && (
        <button
          type="button"
          className="dlm dlm-edit"
          title="Изменить пути: папка, Signal, Larix.CPM"
          aria-label={`Изменить пути ${label}`}
          aria-expanded={!!editor}
          onClick={(e) => { e.stopPropagation(); if (editor) close(); else openEditor(null) }}
        ><IconPencil /></button>
      )}
      {editor && (
        <AnchoredPopover anchor={editor.anchor} onClose={close} canClose={() => !dirty && !saving} label={`Пути ${label}`} className="dlm-pop">
          <form onSubmit={save}>
            <div className="dlm-pop-title">Пути {label}</div>
            {FIELDS.map((f, i) => (
              <label key={f.key} className="dlm-pop-field">
                <span className="dlm-pop-label">{f.label}</span>
                <input
                  type="text"
                  className="dlm-pop-input"
                  value={draft[f.key] || ''}
                  onChange={(e) => setDraft(prev => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  autoFocus={editor.focus ? editor.focus === f.key : i === 0}
                  disabled={saving}
                  spellCheck={false}
                />
              </label>
            ))}
            <div className="dlm-pop-actions">
              <button type="submit" className="dlm-pop-save" disabled={saving || !dirty}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
              <button type="button" className="dlm-pop-cancel" onClick={close} disabled={saving}>Отмена</button>
              <span className="dlm-pop-hint">Пустое поле — путь не указан</span>
            </div>
          </form>
        </AnchoredPopover>
      )}
    </span>
  )
}
