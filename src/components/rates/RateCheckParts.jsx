import { useMemo, useRef, useState } from 'react'
import { IconUpload } from '../icons/BsmIcons'
import { DEFAULT_VAT_RATE } from '../../utils/supplierDoc'
import { BID_DOC_ACCEPT } from '../../utils/bidImport'
import { TOLERANCE_STEPS } from '../../utils/kpRateCheck'

// Общее у окон проверки цен по файлу (реестр КП и договорные расценки): выбор и перетаскивание файла, НДС цен файла,
// допуск. Стили — KpRates.css.

export const pct = (s) => `${Math.round(s * 100)} %`
export const fmtDev = (d) => (d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${String(Math.abs(d)).replace('.', ',')} %`)

// Файл можно бросить в любое место окна (мимо зоны браузер открыл бы его вместо портала и окно бы закрылось):
// dropProps — на подложку окна, over — файл над окном.
export function useFileDrop(onFiles) {
  const [over, setOver] = useState(false)
  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setOver(true) },
    onDragLeave: (e) => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setOver(false) },
    onDrop: (e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files) },
  }
  return { over, dropProps }
}

// Зона выбора файла.
export function RateFilePicker({ disabled, over, onFiles }) {
  const fileRef = useRef(null)
  return (
    <div className={`kpr-drop${over ? ' is-over' : ''}`}>
      <input ref={fileRef} type="file" accept={BID_DOC_ACCEPT} hidden onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} />
      <button type="button" className="kpr-btn kpr-btn-primary" onClick={() => fileRef.current?.click()} disabled={disabled}>
        <IconUpload size={16} /> Выбрать файл
      </button>
      <span className="kpr-muted">или перетащите сюда · Excel (.xlsx, .xls, .csv) или PDF</span>
    </div>
  )
}

const VAT_TEXT = { gross: 'цены с НДС', net: 'цены без НДС — НДС добавится', none: 'НДС не облагается — цены как есть' }

// НДС цен файла: выбор в окне и что из него следует для расчёта (vat — как в окне снабжения: { mode, rate, force }).
export function useVatChoice(doc) {
  const [vatMode, setVatMode] = useState('auto')
  const [vatRate, setVatRate] = useState(String(DEFAULT_VAT_RATE))
  const vat = useMemo(() => {
    if (!doc) return null
    if (vatMode === 'auto') return doc.vat
    const rate = Number(String(vatRate).replace(',', '.'))
    return { mode: vatMode, rate: Number.isFinite(rate) && rate >= 0 && rate < 100 ? rate : DEFAULT_VAT_RATE, force: true }
  }, [doc, vatMode, vatRate])
  const reset = (parsed) => {
    setVatMode('auto')
    setVatRate(String(parsed.vat?.rate ?? DEFAULT_VAT_RATE))
  }
  return { vat, vatMode, vatRate, setVatMode, setVatRate, reset }
}

export function VatFieldset({ doc, choice, disabled }) {
  const { vatMode, vatRate, setVatMode, setVatRate } = choice
  return (
    <fieldset disabled={disabled}>
      <legend>НДС цен файла</legend>
      <label>
        <input type="radio" name="kpr-vat" checked={vatMode === 'auto'} onChange={() => setVatMode('auto')} />
        как в документе{doc.vat?.mode ? ` — ${VAT_TEXT[doc.vat.mode]}` : ' — колонки «с НДС» / «без НДС», иначе как есть'}
        {doc.vat?.cue && <span className="kpr-muted"> (в документе: «{doc.vat.cue}»)</span>}
      </label>
      <label><input type="radio" name="kpr-vat" checked={vatMode === 'gross'} onChange={() => setVatMode('gross')} /> цены с НДС — как есть</label>
      <label>
        <input type="radio" name="kpr-vat" checked={vatMode === 'net'} onChange={() => setVatMode('net')} /> цены без НДС — добавить
        <input type="text" inputMode="decimal" className="kpr-rate" value={vatRate} onChange={(e) => setVatRate(e.target.value)}
          onFocus={() => setVatMode('net')} aria-label="Ставка НДС, %" /> %
      </label>
    </fieldset>
  )
}

export function ToleranceFieldset({ legend, tolerance, onChange, disabled }) {
  return (
    <fieldset disabled={disabled}>
      <legend>{legend}</legend>
      <label>
        ±
        <select value={tolerance} onChange={(e) => onChange(Number(e.target.value))} aria-label="Допуск, %">
          {TOLERANCE_STEPS.map((t) => <option key={t} value={t}>{t} %</option>)}
        </select>
        — «в рынке»
      </label>
    </fieldset>
  )
}
