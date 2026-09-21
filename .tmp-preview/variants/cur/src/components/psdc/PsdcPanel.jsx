import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyPsdc, cancelPsdc, comparePsdc, deletePsdc, downloadPsdcErrorCopy, downloadPsdcTemplate, exportPsdc,
  getDocumentPsdcState, getPsdcRows, stagePsdcFile,
} from '../../services/psdc'
import { formatDecimal } from '../../utils/psdcWorkbook'
import { IconDownload, IconFileSpreadsheet, IconUpload } from '../icons/BsmIcons'
import PsdcIssues from './PsdcIssues'
import PsdcRowsTable from './PsdcRowsTable'
import './Psdc.css'

// Блок «ПСДЦ / ВОР» в карточке договора или ДС. Документ известен из контекста
// карточки — в файл и у пользователя он не запрашивается.
//
// Порядок работы: Импорт ВОР → проверка базой и предпросмотр → Применить ВОР.
// До применения сумма документа не меняется.

const formatDateTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.toLocaleDateString('ru-RU')}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

function Totals({ psdc, label }) {
  const vatLabel = psdc.vat_rate != null && Number(psdc.vat_rate) > 0 && psdc.vat_included !== false
    ? `В том числе НДС ${formatDecimal(psdc.vat_rate, 2).replace(/,00$/, '')}%`
    : 'В том числе НДС'
  return (
    <div className="psdc-totals" aria-label={label}>
      <div className="psdc-total"><span>Секций</span><strong>{psdc.section_count ?? '—'}</strong></div>
      <div className="psdc-total"><span>Комплексных процессов</span><strong>{psdc.process_count ?? '—'}</strong></div>
      <div className="psdc-total"><span>Материалы</span><strong>{formatDecimal(psdc.total_material) || '—'}</strong></div>
      <div className="psdc-total"><span>Работы</span><strong>{formatDecimal(psdc.total_work) || '—'}</strong></div>
      <div className="psdc-total is-main"><span>Итого ПСДЦ</span><strong>{formatDecimal(psdc.total) || '—'}</strong></div>
      <div className="psdc-total"><span>{vatLabel}</span><strong>{psdc.vat_amount != null ? formatDecimal(psdc.vat_amount) : '—'}</strong></div>
      {psdc.dm_material_excluded != null && Number(psdc.dm_material_excluded) !== 0 && (
        <div className="psdc-total is-info" title="Стоимость давальческих материалов рассчитана информационно и в итог не входит">
          <span>Давальческие материалы, не включены</span><strong>{formatDecimal(psdc.dm_material_excluded)}</strong>
        </div>
      )}
      {psdc.legacy_deleted_count > 0 && (
        <div className="psdc-total is-info"><span>Строк deleted (не в расчёте)</span><strong>{psdc.legacy_deleted_count}</strong></div>
      )}
    </div>
  )
}

function PsdcPanel({ documentId, displayId, onChanged }) {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null) // { kind: 'error'|'warning'|'success', text }
  const [viewer, setViewer] = useState(null) // { psdcId, rows, compare, onlyChanges }
  const localBytes = useRef(new Map())       // psdcId → байты файла этой сессии
  const fileInput = useRef(null)

  const load = useCallback(async () => {
    try {
      setLoadError('')
      setState(await getDocumentPsdcState(documentId))
    } catch (e) {
      setLoadError(/psdc_document_state|does not exist|schema cache/i.test(e.message)
        ? 'ПСДЦ недоступна: в базе не применена миграция 20260908_psdc.'
        : e.message)
    } finally {
      setLoading(false)
    }
  }, [documentId])

  useEffect(() => {
    setLoading(true)
    setViewer(null)
    setNotice(null)
    load()
  }, [load])

  const run = async (key, fn, { success, refreshDocument = false } = {}) => {
    setBusy(key)
    setNotice(null)
    try {
      const out = await fn()
      await load()
      if (refreshDocument) onChanged?.()
      if (out?.notice) setNotice(out.notice)
      else if (success) setNotice({ kind: 'success', text: success })
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
      await load()
    } finally {
      setBusy('')
    }
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setViewer(null)
    await run('import', async () => {
      const result = await stagePsdcFile(file, { documentId })
      if (result.bytes) localBytes.current.set(result.psdcId, result.bytes)
      return result.sourceWarning ? { notice: { kind: 'warning', text: result.sourceWarning } } : null
    })
  }

  const openViewer = async (psdc, withCompare) => {
    if (viewer?.psdcId === psdc.id) { setViewer(null); return }
    setBusy(`rows-${psdc.id}`)
    try {
      const [rows, compare] = await Promise.all([
        getPsdcRows(psdc.id),
        withCompare && psdc.previous_psdc_id ? comparePsdc(psdc.id) : Promise.resolve(null),
      ])
      setViewer({ psdcId: psdc.id, rows, compare, onlyChanges: false })
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    } finally {
      setBusy('')
    }
  }

  if (loading) return <div className="psdc-panel"><p className="psdc-hint">Загрузка ПСДЦ…</p></div>
  if (loadError) return <div className="psdc-panel"><div className="psdc-notice is-error">{loadError}</div></div>
  if (!state) return null

  const { applied, staging, previous, document: doc } = state
  const canEdit = state.can_edit
  const locked = !!state.lock_reason
  const financialDisabled = !canEdit || locked || !!busy

  const statusChip = applied
    ? { cls: 'is-applied', text: 'Применена' }
    : staging
      ? (staging.state === 'validated' ? { cls: 'is-validated', text: 'Проверена, не применена' } : { cls: 'is-invalid', text: 'Есть ошибки' })
      : { cls: 'is-empty', text: 'Не загружена' }

  return (
    <div className="psdc-panel">
      <div className="psdc-panel-head">
        <div className="psdc-panel-title">
          <IconFileSpreadsheet size={18} />
          <h3>ПСДЦ / ВОР</h3>
          <span className={`psdc-chip ${statusChip.cls}`}>{statusChip.text}</span>
        </div>
        <div className="psdc-actions">
          {canEdit && (
            <>
              <button type="button" className="btn-primary psdc-btn" disabled={!!busy || locked} onClick={() => fileInput.current?.click()}
                title={locked ? state.lock_reason : 'Загрузить XLSX ведомости. До применения сумма документа не меняется'}>
                <IconUpload size={15} /> {busy === 'import' ? 'Загрузка и проверка…' : 'Импорт ВОР'}
              </button>
              <input ref={fileInput} type="file" accept=".xlsx" hidden onChange={handleFile} />
            </>
          )}
          <button type="button" className="btn-secondary psdc-btn" onClick={downloadPsdcTemplate}>
            <IconDownload size={15} /> Скачать шаблон
          </button>
        </div>
      </div>

      {canEdit && locked && <div className="psdc-notice is-warning">{state.lock_reason}</div>}
      {notice && <div className={`psdc-notice is-${notice.kind}`}>{notice.text}</div>}

      <div className="psdc-amount-line">
        <span>Сумма документа: <strong>{formatDecimal(doc.psdc_total ?? doc.manual_amount) || 'не задана'}</strong></span>
        <span className="psdc-hint">
          {applied
            ? `по применённой ПСДЦ; ручная сумма ${doc.manual_amount != null ? formatDecimal(doc.manual_amount) : 'не задана'} сохранена и снова действует после удаления ПСДЦ`
            : 'ручная — ПСДЦ не применена'}
        </span>
      </div>

      {!applied && !staging && (
        <div className="psdc-empty-block">
          <p><strong>ПСДЦ не загружена</strong></p>
          <p className="psdc-hint">
            Загрузите однолистовой XLSX «Ведомость объёмов работ» со стандартной шапкой A:T. Менять файл старой системы не нужно:
            ID документа указывать в файле не требуется, расчёт выполняет система.
          </p>
          {state.pending_batch_files > 0 && (
            <p className="psdc-hint">Файлов массовой загрузки, сопоставленных с документом: {state.pending_batch_files}.</p>
          )}
        </div>
      )}

      {staging && (
        <section className={`psdc-card ${staging.state === 'validated' ? 'is-validated' : 'is-invalid'}`}>
          <div className="psdc-card-head">
            <div>
              <div className="psdc-card-title">Загрузка: {staging.source_filename}</div>
              <div className="psdc-hint">
                {staging.uploaded_by_name || 'Пользователь'} · {formatDateTime(staging.uploaded_at)}
                {previous ? ` · предыдущая ПСДЦ ветки: ID ${previous.display_id}, итого ${formatDecimal(previous.total)}` : ''}
              </div>
            </div>
            <div className="psdc-actions">
              <button
                type="button"
                className="btn-primary psdc-btn"
                disabled={financialDisabled || staging.state !== 'validated' || !!applied}
                title={applied ? 'Сначала удалите применённую ПСДЦ' : staging.state !== 'validated' ? 'Исправьте ошибки в файле и загрузите его заново' : 'Сделать ПСДЦ источником суммы документа'}
                onClick={() => {
                  if (!window.confirm(`Применить ВОР «${staging.source_filename}»?\n\nСумма документа станет ${formatDecimal(staging.total)}. Ручная сумма сохранится.`)) return
                  run('apply', () => applyPsdc(staging.id), { success: 'ВОР применена', refreshDocument: true })
                }}
              >
                {busy === 'apply' ? 'Применение…' : 'Применить ВОР'}
              </button>
              {staging.error_count > 0 && (
                <button type="button" className="btn-secondary psdc-btn" disabled={!!busy}
                  onClick={() => run('errcopy', () => downloadPsdcErrorCopy(staging, localBytes.current.get(staging.id)))}>
                  <IconDownload size={15} /> Файл с выделенными ошибками
                </button>
              )}
              <button type="button" className="btn-secondary psdc-btn" disabled={!!busy || !canEdit}
                onClick={() => run('cancel', () => cancelPsdc(staging.id), { success: 'Загрузка отменена, документ не изменён' })}>
                Отменить загрузку
              </button>
            </div>
          </div>
          {applied && staging.state === 'validated' && (
            <div className="psdc-notice is-warning">У документа уже есть применённая ПСДЦ. Чтобы применить новую, сначала удалите текущую.</div>
          )}
          {staging.process_count != null && <Totals psdc={staging} label="Итоги загрузки" />}
          <PsdcIssues issues={staging.issues} emptyText="Ошибок и предупреждений нет." />
          {staging.process_count != null && (
            <button type="button" className="psdc-link" onClick={() => openViewer(staging, true)} disabled={busy === `rows-${staging.id}`}>
              {viewer?.psdcId === staging.id ? 'Скрыть ведомость' : previous ? 'Показать ведомость и изменения' : 'Показать ведомость'}
            </button>
          )}
          {viewer?.psdcId === staging.id && (
            <>
              {viewer.compare?.previous && (
                <label className="psdc-toggle">
                  <input type="checkbox" checked={viewer.onlyChanges} onChange={(e) => setViewer((v) => ({ ...v, onlyChanges: e.target.checked }))} />
                  Только новые и изменённые строки
                </label>
              )}
              <PsdcRowsTable rows={viewer.rows} compare={viewer.compare} onlyChanges={viewer.onlyChanges} />
            </>
          )}
        </section>
      )}

      {applied && (
        <section className="psdc-card is-applied">
          <div className="psdc-card-head">
            <div>
              <div className="psdc-card-title">Применена: {applied.source_filename}</div>
              <div className="psdc-hint">
                {formatDateTime(applied.applied_at)}{applied.applied_by_name ? ` · ${applied.applied_by_name}` : ''}
              </div>
            </div>
            <div className="psdc-actions">
              <button type="button" className="btn-secondary psdc-btn" disabled={!!busy}
                onClick={() => run('export', () => exportPsdc(applied, { documentDisplayId: displayId ?? doc.display_id }))}>
                <IconDownload size={15} /> {busy === 'export' ? 'Экспорт…' : 'Экспорт ВОР'}
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="btn-danger psdc-btn"
                  disabled={financialDisabled}
                  title={locked ? state.lock_reason : undefined}
                  onClick={() => {
                    if (!window.confirm('Удалить применённую ВОР?\n\nСумма документа снова станет ручной. Сама ведомость останется в истории.')) return
                    run('delete', () => deletePsdc(applied.id), { success: 'ВОР удалена, действует ручная сумма', refreshDocument: true })
                  }}
                >
                  {busy === 'delete' ? 'Удаление…' : 'Удалить ВОР'}
                </button>
              )}
            </div>
          </div>
          <Totals psdc={applied} label="Итоги применённой ПСДЦ" />
          <button type="button" className="psdc-link" onClick={() => openViewer(applied, false)} disabled={busy === `rows-${applied.id}`}>
            {viewer?.psdcId === applied.id ? 'Скрыть ведомость' : 'Показать ведомость'}
          </button>
          {viewer?.psdcId === applied.id && <PsdcRowsTable rows={viewer.rows} />}
        </section>
      )}
    </div>
  )
}

export default PsdcPanel
