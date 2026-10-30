import { useEffect, useMemo, useRef, useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconClose } from '../icons/ToolbarIcons'
import { formatAmountLive } from '../../utils/money'
import { moscowToday, tenderLabel, validateManualRate } from '../../utils/kpRegistrySources'
import { loadDocument, loadManualOptions, loadManualRate, saveManualRate } from '../../services/kpManualRates'
import './KpRates.css'

// Справочники окна — один раз на вкладку браузера: подрядчиков и тендеров — сотни, а окно открывают часто.
let optionsCache = null
export function loadOptionsOnce() {
  if (!optionsCache) optionsCache = loadManualOptions().catch((e) => { optionsCache = null; throw e })
  return optionsCache
}

const EMPTY = { item_type: 'material', item_name: '', unit: '', price: '', counterparty_id: '', object_id: '', tender_id: '', rate_date: '', doc_url: '', note: '' }

// Расценка подрядчика, добавленная в реестр вручную (миграция 20261122): вид, наименование, ед. изм., цена за единицу
// с НДС, подрядчик, тендер и объект (по желанию), день расценки, документ — ссылка или файл, примечание. manualId —
// правка своей строки, иначе — новая. defaults — начальные поля новой (например, вид открытой подвкладки).
// onSaved({ fileError }) — сохранено (окно закрывает вызывающий).
export default function KpManualRateDialog({ manualId = null, defaults = null, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...EMPTY, rate_date: moscowToday(), ...(defaults || {}) }))
  const [options, setOptions] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [docMode, setDocMode] = useState('none') // none | link | file
  const [currentDoc, setCurrentDoc] = useState(null) // прикреплённый файл (правка)
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(!manualId)
  const fileRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    loadOptionsOnce()
      .then((o) => { if (!cancelled) setOptions(o) })
      .catch((e) => { if (!cancelled) setLoadError(`Справочники не загрузились: ${e.message || e}`) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!manualId) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const r = await loadManualRate(manualId)
        if (cancelled) return
        if (!r) { setLoadError('Расценка не найдена — возможно, её уже удалили'); return }
        setForm({
          item_type: r.item_type, item_name: r.item_name, unit: r.unit || '', price: formatAmountLive(String(r.price).replace('.', ',')),
          counterparty_id: r.counterparty_id, object_id: r.object_id || '', tender_id: r.tender_id || '', rate_date: r.rate_date,
          doc_url: r.doc_url || '', note: r.note || '',
        })
        if (r.s3_document_id) {
          setDocMode('file')
          const doc = await loadDocument(r.s3_document_id).catch(() => null)
          if (!cancelled) setCurrentDoc(doc || { id: r.s3_document_id, file_name: 'файл' })
        } else if (r.doc_url) setDocMode('link')
        setLoaded(true)
      } catch (e) {
        if (!cancelled) setLoadError(e.message || String(e))
      }
    })()
    return () => { cancelled = true }
  }, [manualId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || saving || document.querySelector('.fdrop-panel')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))
  const tenderById = useMemo(() => new Map((options?.tenders || []).map((t) => [t.id, t])), [options])
  const cpOptions = useMemo(() => [{ value: '', label: 'Выберите подрядчика' },
    ...(options?.counterparties || []).map((c) => ({ value: c.id, label: c.name }))], [options])
  const tenderOptions = useMemo(() => [{ value: '', label: 'Без тендера' },
    ...(options?.tenders || []).map((t) => ({ value: t.id, label: tenderLabel(t) }))], [options])
  const objectOptions = useMemo(() => [{ value: '', label: form.tender_id ? 'Объект тендера' : 'Без объекта' },
    ...(options?.objects || []).map((o) => ({ value: o.id, label: o.name }))], [options, form.tender_id])

  // Тендер выбран, объект не указан — объект тендера.
  const pickTender = (id) => setForm((f) => {
    const t = tenderById.get(id)
    return { ...f, tender_id: id, object_id: f.object_id || (t?.object_id ?? '') }
  })

  const save = async () => {
    setError('')
    const v = validateManualRate({ ...form, doc_url: docMode === 'link' ? form.doc_url : '' })
    if (v.error) { setError(v.error); return }
    if (docMode === 'link' && !v.rate.doc_url) { setError('Вставьте ссылку на документ или выберите «нет документа»'); return }
    if (docMode === 'file' && !file && !currentDoc) { setError('Выберите файл документа или «нет документа»'); return }
    setSaving(true)
    try {
      const res = await saveManualRate(v.rate, {
        id: manualId,
        file: docMode === 'file' ? file : null,
        removeFile: docMode !== 'file' && !!currentDoc,
        previousDocId: currentDoc?.id || null,
      })
      onSaved({ fileError: res.fileError })
    } catch (e) {
      setError(e.message || String(e))
      setSaving(false)
    }
  }

  const busy = saving || !loaded
  return (
    <div className="kpr-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div className="kpr-modal" role="dialog" aria-modal="true" aria-labelledby="kpr-manual-title">
        <div className="kpr-modal-head">
          <h3 id="kpr-manual-title">{manualId ? 'Расценка, добавленная вручную' : 'Добавить расценку подрядчика'}</h3>
          <button type="button" className="kpr-icon-btn" onClick={onClose} disabled={saving} aria-label="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="kpr-modal-body">
          <p className="kpr-muted">
            Расценка появится в реестре сразу, с пометкой «добавлено вручную». Цена — за единицу с НДС, как у КП в реестре.
          </p>
          {loadError && <p className="kpr-error" role="alert">{loadError}</p>}
          <div className="kpr-form">
            <div className="kpr-field is-wide">
              <span className="kpr-label">Вид</span>
              <div className="kpr-radios" role="radiogroup" aria-label="Вид расценки">
                <label><input type="radio" name="kpr-kind" checked={form.item_type === 'material'} disabled={busy} onChange={() => set('item_type')('material')} /> Материал</label>
                <label><input type="radio" name="kpr-kind" checked={form.item_type === 'work'} disabled={busy} onChange={() => set('item_type')('work')} /> Работа</label>
              </div>
            </div>
            <div className="kpr-field is-wide">
              <label htmlFor="kpr-name">Наименование</label>
              <textarea id="kpr-name" rows={2} value={form.item_name} disabled={busy} maxLength={1000}
                onChange={(e) => set('item_name')(e.target.value)} placeholder={form.item_type === 'work' ? 'Например: Устройство стяжки пола' : 'Например: Грунтовка глубокого проникновения'} />
            </div>
            <div className="kpr-field">
              <label htmlFor="kpr-unit">Ед. изм.</label>
              <input id="kpr-unit" type="text" value={form.unit} disabled={busy} maxLength={50} onChange={(e) => set('unit')(e.target.value)} placeholder="м2, шт, т…" />
            </div>
            <div className="kpr-field">
              <label htmlFor="kpr-price">Цена за единицу с НДС, ₽</label>
              <input id="kpr-price" type="text" inputMode="decimal" className="kpr-num" value={form.price} disabled={busy}
                onChange={(e) => set('price')(formatAmountLive(e.target.value))} placeholder="0,00" />
            </div>
            <div className="kpr-field is-wide">
              <span className="kpr-label">Подрядчик</span>
              <FilterDropdown label="" searchable searchPlaceholder="Поиск подрядчика…" allLabel="Выберите подрядчика"
                value={form.counterparty_id} onChange={set('counterparty_id')} options={cpOptions} disabled={busy || !options} />
            </div>
            <div className="kpr-field">
              <span className="kpr-label">Тендер (необязательно)</span>
              <FilterDropdown label="" searchable searchPlaceholder="Номер или описание…" allLabel="Без тендера"
                value={form.tender_id} onChange={pickTender} options={tenderOptions} disabled={busy || !options} />
            </div>
            <div className="kpr-field">
              <span className="kpr-label">Объект (необязательно)</span>
              <FilterDropdown label="" searchable searchPlaceholder="Поиск объекта…" allLabel={form.tender_id ? 'Объект тендера' : 'Без объекта'}
                value={form.object_id} onChange={set('object_id')} options={objectOptions} disabled={busy || !options} />
            </div>
            <div className="kpr-field">
              <label htmlFor="kpr-date">Дата расценки</label>
              <input id="kpr-date" type="date" value={form.rate_date} disabled={busy} onChange={(e) => set('rate_date')(e.target.value)} />
            </div>
            <div className="kpr-field is-wide">
              <span className="kpr-label">Документ, откуда взята расценка</span>
              <div className="kpr-radios" role="radiogroup" aria-label="Документ">
                <label><input type="radio" name="kpr-doc" checked={docMode === 'none'} disabled={busy} onChange={() => setDocMode('none')} /> нет документа</label>
                <label><input type="radio" name="kpr-doc" checked={docMode === 'link'} disabled={busy} onChange={() => setDocMode('link')} /> ссылка или сетевой путь</label>
                <label><input type="radio" name="kpr-doc" checked={docMode === 'file'} disabled={busy} onChange={() => setDocMode('file')} /> файл</label>
              </div>
              {docMode === 'link' && (
                <input type="text" className="kpr-input" value={form.doc_url} disabled={busy} onChange={(e) => set('doc_url')(e.target.value)}
                  placeholder="https://… или \\сервер\папка\КП.pdf" aria-label="Ссылка на документ" />
              )}
              {docMode === 'file' && (
                <div className="kpr-file-row">
                  <input ref={fileRef} type="file" hidden onChange={(e) => { setFile(e.target.files?.[0] || null); e.target.value = '' }} />
                  {file ? <span className="kpr-file-name"><PaperclipIcon size={14} /> {file.name}</span>
                    : currentDoc ? <span className="kpr-file-name"><PaperclipIcon size={14} /> {currentDoc.file_name}</span>
                      : <span className="kpr-muted">файл не выбран</span>}
                  <button type="button" className="kpr-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                    {file || currentDoc ? 'Заменить файл' : 'Выбрать файл'}
                  </button>
                </div>
              )}
            </div>
            <div className="kpr-field is-wide">
              <label htmlFor="kpr-note">Примечание</label>
              <textarea id="kpr-note" rows={2} value={form.note} disabled={busy} maxLength={2000} onChange={(e) => set('note')(e.target.value)}
                placeholder="Условия, срок действия цены, что входит в цену…" />
            </div>
          </div>
          {error && <p className="kpr-error" role="alert">{error}</p>}
        </div>
        <div className="kpr-modal-foot">
          <button type="button" className="kpr-btn" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="button" className="kpr-btn kpr-btn-primary" onClick={save} disabled={busy || !!loadError}>
            {saving ? 'Сохраняем…' : manualId ? 'Сохранить' : 'Добавить в реестр'}
          </button>
        </div>
      </div>
    </div>
  )
}
