import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { getColumnPreviews } from '../../utils/parseProposalExcel'
import { normName } from '../../utils/supplyRateHelpers'
import { buildSupplyPositions, positionsFromEstimate } from '../../utils/vorMaterials'
import { targetNameForFile } from '../../utils/supplyAutoImport'
import { MATERIALS_COLUMN_FIELDS, readMaterialsFromWorkbook } from '../../utils/vorMaterialsSheet'
import {
  estimateSignatures, estimateVersion, fetchVorWorkbook, fileVersion, loadEstimateItems, saveSource,
} from '../../services/supplyPricing'

const COLUMN_COUNT = 26
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

// Разница нового списка позиций с прежним: добавятся / пропадут / изменится объём (по ключу наименования).
export function positionsDiff(oldPositions, newPositions) {
  const before = new Map((oldPositions || []).map((p) => [p.k || normName(p.name), p]))
  const after = new Map(newPositions.map((p) => [normName(p.name), p]))
  let added = 0
  let removed = 0
  let changed = 0
  for (const [k, p] of after) {
    const o = before.get(k)
    if (!o) added += 1
    else if (Number(o.volume ?? NaN) !== Number(p.volume ?? NaN) && !(o.volume == null && p.volume == null)) changed += 1
  }
  for (const k of before.keys()) if (!after.has(k)) removed += 1
  return { added, removed, changed }
}

// Окно «Загрузить позиции из ВОР». Сначала — файлы из «ВОРов и РД» основного тендера (лист «Материалы»);
// если ни в одном файле листа нет — ВОР из вкладки «ВОР» карточки. Каждый ВОР привязывается к имени ВОР
// карточки (estimate_name): по нему карточка сопоставит цены со своими строками. Цены не трогаются.
export default function SupplyImportDialog({ mainId, files, sources, onClose, onSaved }) {
  const [items, setItems] = useState(() => files.map((doc) => ({ doc, status: 'pending', selected: false })))
  const [estimate, setEstimate] = useState({ loading: true, docs: new Map(), signatures: new Map(), error: '' })
  const [tabSelected, setTabSelected] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const workbooks = useRef(new Map())
  const closeRef = useRef(null)

  const sourceByName = useMemo(() => new Map(sources.map((s) => [s.estimate_name, s])), [sources])
  const cardDocNames = useMemo(() => [...estimate.docs.keys()], [estimate.docs])
  const nameOptions = useMemo(
    () => [...new Set([...cardDocNames, ...sources.map((s) => s.estimate_name)])].sort((a, b) => a.localeCompare(b, 'ru')),
    [cardDocNames, sources],
  )

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  // ВОР карточки: имена документов (для привязки) и позиции на случай, если файлов с листом «Материалы» нет.
  useEffect(() => {
    let alive = true
    loadEstimateItems(mainId)
      .then((rows) => {
        if (!alive) return
        setEstimate({ loading: false, docs: positionsFromEstimate(rows), signatures: estimateSignatures(rows), error: '' })
      })
      .catch((e) => { if (alive) setEstimate({ loading: false, docs: new Map(), signatures: new Map(), error: e.message || 'не загрузился' }) })
    return () => { alive = false }
  }, [mainId])

  // Имя ВОР для файла — как у автозагрузки (utils/supplyAutoImport).
  const defaultName = (doc) => targetNameForFile(doc, sources, cardDocNames)

  // Разбор файлов по очереди (книги бывают тяжёлыми). Сохранённое сопоставление колонок того же ВОР —
  // если шапка не распознаётся сама.
  useEffect(() => {
    if (estimate.loading) return undefined
    let alive = true
    ;(async () => {
      for (const doc of files) {
        if (!alive) return
        setItems((prev) => prev.map((it) => (it.doc.id === doc.id && it.status === 'pending' ? { ...it, status: 'loading' } : it)))
        try {
          const wb = await fetchVorWorkbook(doc)
          workbooks.current.set(doc.id, wb)
          const estimateName = defaultName(doc)
          let result = readMaterialsFromWorkbook(wb)
          const saved = sourceByName.get(estimateName)?.column_map
          if (result.error === 'no_header' && saved?.columns && wb.Sheets[saved.sheetName]) result = readMaterialsFromWorkbook(wb, saved)
          const positions = result.error ? [] : buildSupplyPositions(result.rows)
          const current = sourceByName.get(estimateName)
          const fresh = !current || current.source_version !== fileVersion(doc)
          if (!alive) return
          setItems((prev) => prev.map((it) => (it.doc.id !== doc.id ? it : {
            ...it, status: result.error || (positions.length ? 'ok' : 'empty'), result, positions, estimateName,
            selected: !result.error && positions.length > 0 && fresh,
            manual: { sheetName: result.sheetName || result.map?.sheetName || wb.SheetNames[0], startRow: '', endRow: '', columns: result.map?.columns || { name: null, unit: null, volume: null } },
          })))
        } catch (e) {
          if (!alive) return
          setItems((prev) => prev.map((it) => (it.doc.id === doc.id ? { ...it, status: 'error', message: e.message || 'файл не открылся' } : it)))
        }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- разбор один раз, когда загрузились имена ВОР карточки
  }, [estimate.loading])

  const update = (docId, patch) => setItems((prev) => prev.map((it) => (it.doc.id === docId ? { ...it, ...patch } : it)))

  const applyManual = (it) => {
    const wb = workbooks.current.get(it.doc.id)
    if (!wb) return
    const m = it.manual
    const result = readMaterialsFromWorkbook(wb, {
      sheetName: m.sheetName,
      startRow: Number(m.startRow) || null,
      endRow: Number(m.endRow) || null,
      columns: m.columns,
    })
    const positions = result.error ? [] : buildSupplyPositions(result.rows)
    update(it.doc.id, { result, positions, status: result.error || (positions.length ? 'ok' : 'empty'), selected: positions.length > 0 })
  }

  const parsing = estimate.loading || items.some((it) => it.status === 'pending' || it.status === 'loading')
  const filesUsable = items.some((it) => ['ok', 'no_header', 'empty'].includes(it.status))
  // Решение пользователя: сначала файлы из «ВОРов и РД», вкладка «ВОР» — только если файлов с листом нет.
  const showTab = !parsing && !filesUsable && estimate.docs.size > 0

  const chosen = [
    ...items.filter((it) => it.selected && it.status === 'ok').map((it) => ({ kind: 'file', name: (it.estimateName || '').trim(), it })),
    ...(showTab ? [...tabSelected].map((name) => ({ kind: 'tab', name })) : []),
  ]
  const nameCounts = chosen.reduce((m, c) => m.set(c.name, (m.get(c.name) || 0) + 1), new Map())
  const duplicateNames = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([n]) => n)
  const emptyName = chosen.some((c) => !c.name)

  const save = async () => {
    setSaving(true)
    setError('')
    const failed = []
    for (const c of chosen) {
      try {
        if (c.kind === 'file') {
          await saveSource({
            existing: sourceByName.get(c.name) || null, mainId, estimateName: c.name, source: 'vor_file', doc: c.it.doc,
            sheetName: c.it.result.sheetName, columnMap: c.it.result.map, sourceVersion: fileVersion(c.it.doc), positions: c.it.positions,
          })
        } else {
          await saveSource({
            existing: sourceByName.get(c.name) || null, mainId, estimateName: c.name, source: 'vor_tab', doc: null,
            sourceVersion: estimateVersion(estimate.signatures.get(c.name) || { count: 0 }), positions: estimate.docs.get(c.name) || [],
          })
        }
      } catch (e) {
        failed.push(`${c.name}: ${e.message}`)
      }
    }
    setSaving(false)
    if (failed.length) setError(`Не загрузилось: ${failed.join('; ')}`)
    onSaved({ failed: failed.length, saved: chosen.length - failed.length, close: failed.length === 0 })
  }

  const statusText = (it) => {
    switch (it.status) {
      case 'pending': return 'в очереди'
      case 'loading': return 'читаем файл…'
      case 'no_sheet': return 'нет листа «Материалы»'
      case 'no_header': return 'шапка листа не распознана — укажите колонки'
      case 'empty': return 'на листе нет позиций (проверьте колонки)'
      case 'error': return `не открылся: ${it.message}`
      default: {
        const s = it.result?.skipped || {}
        const m = it.result?.map?.columns || {}
        const col = (i) => (i == null ? '—' : XLSX.utils.encode_col(i))
        const skipped = [s.sections ? `разделов ${s.sections}` : '', s.totals ? `«Итого» ${s.totals}` : ''].filter(Boolean).join(', ')
        return `лист «${it.result.sheetName}»: ${col(m.name)} — наименование, ${col(m.unit)} — ед. изм., ${col(m.volume)} — объём · `
          + `${it.positions.length} поз.${skipped ? ` (пропущено: ${skipped})` : ''}`
      }
    }
  }

  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div className="sp-modal sp-modal-import" role="dialog" aria-modal="true" aria-labelledby="sp-import-title">
        <h3 id="sp-import-title">Позиции из ВОР</h3>
        <div className="sp-modal-body">
          <p className="sp-muted">
            Позиции берутся с листа «Материалы» файлов ВОР из «ВОРов и РД»: наименование, ед. изм., объём.
            Введённые цены не меняются: цена позиции, которой нет в новом ВОР, останется в блоке «Цены без позиции».
          </p>
          {estimate.error && <p className="sp-error-text">ВОР карточки не загрузился ({estimate.error}) — имена ВОР подставлены по файлам.</p>}

          {files.length === 0 && <p className="sp-muted">В «ВОРах и РД» этого тендера нет файлов ВОР в Excel.</p>}
          <ul className="sp-import-list">
            {items.map((it) => {
              const existing = sourceByName.get((it.estimateName || '').trim())
              const diff = it.status === 'ok' && existing ? positionsDiff(existing.positions, it.positions) : null
              const cardMatch = it.estimateName && cardDocNames.includes(it.estimateName.trim())
              return (
                <li key={it.doc.id} className={`sp-import-item is-${it.status}`}>
                  <label className="sp-import-head">
                    <input
                      type="checkbox"
                      checked={!!it.selected}
                      disabled={it.status !== 'ok' || saving}
                      onChange={(e) => update(it.doc.id, { selected: e.target.checked })}
                    />
                    <span className="sp-import-file">{it.doc.file_name}</span>
                    <span className="sp-muted ui-num">{fmtDate(it.doc.created_at)}{it.doc.uploaded_by_name ? ` · ${it.doc.uploaded_by_name}` : ''}</span>
                  </label>
                  <div className={`sp-import-status${['no_sheet', 'error', 'no_header', 'empty'].includes(it.status) ? ' is-warn' : ''}`}>{statusText(it)}</div>
                  {it.status === 'ok' && (
                    <div className="sp-import-target">
                      <label>
                        <span>ВОР</span>
                        <input
                          type="text"
                          list="sp-import-names"
                          value={it.estimateName || ''}
                          disabled={saving}
                          onChange={(e) => update(it.doc.id, { estimateName: e.target.value })}
                        />
                      </label>
                      <span className="sp-muted">
                        {cardMatch ? 'совпадает с ВОР карточки — цены будут видны во вкладке «Расценки снабжения»' : 'такого ВОР в карточке нет — выберите из списка, чтобы карточка увидела цены'}
                      </span>
                      {diff && (
                        <span className="sp-import-diff ui-num">
                          к прежнему списку: +{diff.added} / −{diff.removed}{diff.changed ? ` / объём у ${diff.changed}` : ''}
                        </span>
                      )}
                    </div>
                  )}
                  {['ok', 'no_header', 'empty'].includes(it.status) && (
                    <details className="sp-import-manual" open={it.status !== 'ok'}>
                      <summary>Колонки листа</summary>
                      <ManualMapping
                        workbook={workbooks.current.get(it.doc.id)}
                        value={it.manual}
                        onChange={(manual) => update(it.doc.id, { manual })}
                        onApply={() => applyManual(it)}
                        disabled={saving}
                      />
                    </details>
                  )}
                </li>
              )
            })}
          </ul>
          <datalist id="sp-import-names">{nameOptions.map((n) => <option key={n} value={n} />)}</datalist>

          {showTab && (
            <div className="sp-import-tab">
              <p>Листа «Материалы» в файлах ВОР нет — можно взять материалы из вкладки «ВОР» карточки тендера:</p>
              <ul className="sp-import-list">
                {[...estimate.docs.entries()].map(([name, positions]) => {
                  const existing = sourceByName.get(name)
                  const diff = existing ? positionsDiff(existing.positions, positions) : null
                  return (
                    <li key={name} className="sp-import-item">
                      <label className="sp-import-head">
                        <input
                          type="checkbox"
                          checked={tabSelected.has(name)}
                          disabled={saving || positions.length === 0}
                          onChange={(e) => setTabSelected((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(name); else next.delete(name)
                            return next
                          })}
                        />
                        <span className="sp-import-file">{name}</span>
                        <span className="sp-muted ui-num">{positions.length} поз.</span>
                      </label>
                      {diff && <div className="sp-import-diff ui-num">к прежнему списку: +{diff.added} / −{diff.removed}{diff.changed ? ` / объём у ${diff.changed}` : ''}</div>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {!parsing && !filesUsable && estimate.docs.size === 0 && !estimate.loading && (
            <p className="sp-error-text">Взять позиции неоткуда: нет ни файлов ВОР с листом «Материалы», ни ВОР во вкладке «ВОР» карточки тендера.</p>
          )}
          {duplicateNames.length > 0 && <p className="sp-error-text">В один ВОР выбрано несколько источников: {duplicateNames.join(', ')}.</p>}
          {emptyName && <p className="sp-error-text">Укажите имя ВОР у каждого выбранного файла.</p>}
          {error && <p className="sp-error-text">{error}</p>}
        </div>
        <div className="sp-modal-actions">
          <button ref={closeRef} type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={saving || parsing || chosen.length === 0 || duplicateNames.length > 0 || emptyName}
          >
            {saving ? 'Загрузка…' : parsing ? 'Читаем файлы…' : `Загрузить позиции${chosen.length ? ` (ВОР: ${chosen.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// Ручное сопоставление: лист, строки и три колонки (наименование, ед. изм., объём) с превью первых строк.
function ManualMapping({ workbook, value, onChange, onApply, disabled }) {
  const previews = useMemo(() => getColumnPreviews(workbook, value?.sheetName, COLUMN_COUNT), [workbook, value?.sheetName])
  if (!workbook || !value) return null
  const setColumn = (key, v) => onChange({ ...value, columns: { ...value.columns, [key]: v === '' ? null : Number(v) } })
  const ready = value.columns?.name != null && value.columns?.volume != null
  return (
    <div className="sp-manual">
      <label>
        <span>Лист</span>
        <select value={value.sheetName || ''} disabled={disabled} onChange={(e) => onChange({ ...value, sheetName: e.target.value })}>
          {workbook.SheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label>
        <span>Данные со строки</span>
        <input type="number" min="1" value={value.startRow} disabled={disabled} placeholder="после шапки"
          onChange={(e) => onChange({ ...value, startRow: e.target.value })} />
      </label>
      <label>
        <span>по строку</span>
        <input type="number" min="1" value={value.endRow} disabled={disabled} placeholder="до конца"
          onChange={(e) => onChange({ ...value, endRow: e.target.value })} />
      </label>
      {MATERIALS_COLUMN_FIELDS.map((f) => (
        <label key={f.key}>
          <span>{f.label}{f.required ? '' : ' (необяз.)'}</span>
          <select value={value.columns?.[f.key] ?? ''} disabled={disabled} onChange={(e) => setColumn(f.key, e.target.value)}>
            <option value="">—</option>
            {previews.map((p, i) => (
              <option key={i} value={i}>{XLSX.utils.encode_col(i)}{p ? ` — ${p}` : ''}</option>
            ))}
          </select>
        </label>
      ))}
      <button type="button" className="btn-secondary" onClick={onApply} disabled={disabled || !ready}>Распознать</button>
    </div>
  )
}
