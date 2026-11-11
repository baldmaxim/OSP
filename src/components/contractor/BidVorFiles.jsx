import { useMemo, useState } from 'react'
import { uploadBidFile, removeBidFile, bidFileUrl, bidFileUrlAdmin } from '../../services/contractorBids'
import { bidFilesTable, summaryCounted, summaryIncomplete, coverageText, BID_FILE_ACCEPT, BID_FILE_MAX_MB, SUMMARY_ERROR_TEXT } from '../../utils/bidFiles'
import { vatIncluded } from '../../utils/bidForm'
import { formatAmount } from '../../utils/money'
import { downloadSignedFile } from '../FileDownload'
import { IconDownload, IconCheck, IconAlert } from '../icons/ActionIcons'

// Свой ВОР с расценками (миграция 20270113, решение пользователя 11.11.2026). Расценка на сайте временно скрыта: слева — ВОР отдела
// (пустой, «Скачать ВОР»), справа — ВОР подрядчика с расценками (загрузить, скачать, заменить, убрать). Под ними — сводка как в
// «Сравнении КП» карточки тендера (тендер № 38): строки — ведомости (корпуса), столбцы — материалы, работы, итого; внизу ИТОГО.
// Подрядчик видит только свои файлы и суммы: строки читаются с отбором по своей организации, а база отдаёт только их.
//
// Цены из файла читаются здесь же, в браузере, тем же разбором, что «Цены из файла» (utils/bidFileSummary.js); в базу уходит
// только сводка. Файл, где цен не нашлось, можно загрузить после вопроса — сумма у него не посчитается.
//
// Просьба пользователя 11.11.2026 (позже): «визуально очень понятно, всё подсвечено как надо». Поэтому: три шага сверху; у каждой
// ведомости — состояние своего файла цветом и словами (ждёт файла / загружен / не все позиции с ценой / цены не распознаны / отдел
// обновил ВОР); файл можно перетащить на место загрузки; сверху — сколько ведомостей уже с расценкой. Ведомость, заменённая новой
// версией (миграция 20270114, тендер № 847), не показывается: файл к ней — у новой версии, с просьбой загрузить заново, в итог не входит.

const fmtDateTime = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('ru-RU')}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}
const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`)
const money = (v) => formatAmount(Number(v || 0))
const vorTitle = (name) => String(name || '').replace(/\.(xlsx|xlsm|xls)$/i, '')
const withFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

const IconUpload = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
  </svg>
)
const IconArrowRight = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
  </svg>
)

// Состояние своего файла у ведомости: empty | ok | partial | nosum | stale.
function rowState(row) {
  if (!row.file) return 'empty'
  if (row.stale) return 'stale'
  const s = row.file.summary
  if (!summaryCounted(s)) return 'nosum'
  return summaryIncomplete(s, 'material') || summaryIncomplete(s, 'work') ? 'partial' : 'ok'
}
const STATE_CHIP = {
  empty: { cls: 'is-empty', text: 'Ждёт вашего файла' },
  ok: { cls: 'is-ok', text: 'Загружен, сумма посчитана' },
  partial: { cls: 'is-partial', text: 'Не у всех позиций есть цена' },
  nosum: { cls: 'is-bad', text: 'Цены не распознаны' },
  stale: { cls: 'is-bad', text: 'Отдел обновил ВОР — загрузите заново' },
}

function summaryLine(s) {
  if (!s) return ''
  if (!summaryCounted(s)) return SUMMARY_ERROR_TEXT[s.error] || 'Сумма не посчитана.'
  return `Итого ${money(s.total)} ₽`
}
const coverage = (s) => [coverageText(s, 'material'), coverageText(s, 'work')].filter(Boolean)
  .map((t, i) => (i ? t.charAt(0).toLowerCase() + t.slice(1) : t)).join('; ')

export default function BidVorFiles({
  tenderId, vorFiles, priorOf = null, parsed, myFiles, canEdit, preview = false, ownVat = null, counterpartyName = '',
  onDownloadVor, vorError = '', onChanged,
}) {
  const [busy, setBusy] = useState({}) // id ведомости → 'reading' | 'uploading' | 'removing'
  const [notes, setNotes] = useState({}) // id ведомости → { kind, text }
  const [dragOver, setDragOver] = useState(null) // id ведомости, над которой несут файл
  const table = useMemo(() => bidFilesTable(vorFiles, myFiles, priorOf), [vorFiles, myFiles, priorOf])

  const setNote = (id, note) => setNotes((n) => ({ ...n, [id]: note }))
  const setBusyOf = (id, value) => setBusy((b) => {
    const next = { ...b }
    if (value) next[id] = value
    else delete next[id]
    return next
  })

  const positionsOf = (vorId) => {
    const p = parsed[vorId]
    return p?.status === 'ok' ? [...(p.result.materials || []), ...(p.result.works || [])] : null
  }
  // ВОР отдела ещё читается (по нему считается сумма) — загрузку придерживаем, иначе сумма вышла бы «не по чему».
  const vorReading = (vorId) => !parsed[vorId] || parsed[vorId].status === 'loading' || parsed[vorId].status === 'pending'

  const upload = async (row, file) => {
    const id = row.vor.id
    if (busy[id] || !canEdit) return
    setNote(id, null)
    if (!/\.(xlsx|xlsm|xls|pdf)$/i.test(file.name || '')) {
      setNote(id, { kind: 'warn', text: `«${file.name}» — не Excel и не PDF. Загрузите заполненный ВОР (.xlsx, .xls) или КП в PDF.` })
      return
    }
    if (file.size > BID_FILE_MAX_MB * 1024 * 1024) { setNote(id, { kind: 'warn', text: `Файл больше ${BID_FILE_MAX_MB} МБ.` }); return }
    if (!file.size) { setNote(id, { kind: 'warn', text: 'Файл пустой.' }); return }
    setBusyOf(id, 'reading')
    try {
      // Разбор и сопоставление — только при загрузке: библиотеки Excel и PDF подгружаются здесь.
      const { readBidFileSummary } = await import('../../utils/bidFileSummary')
      const summary = await readBidFileSummary(file, positionsOf(id), ownVat)
      if (!summaryCounted(summary)) {
        const why = SUMMARY_ERROR_TEXT[summary.error] || 'Цены в файле не распознались.'
        if (!window.confirm(`${why}\n\nЗагрузить файл всё равно? Отдел его увидит, но сумма по этой ведомости не посчитается.`)) return
      }
      setBusyOf(id, 'uploading')
      await uploadBidFile({ tenderId, vorFileId: id, file, summary })
      // Расценка лежала у прежней версии ВОР — новый файл её заменяет.
      if (row.stale && row.file) await removeBidFile(row.file.id).catch(() => {})
      setNote(id, !summaryCounted(summary)
        ? { kind: 'warn', text: 'Файл загружен, но цены в нём не распознались — сумма не посчитана. Проверьте, что цены стоят в колонке цены за единицу.' }
        : summaryIncomplete(summary, 'material') || summaryIncomplete(summary, 'work')
          ? { kind: 'warn', text: 'Файл загружен. У части позиций цены нет (пусто или ноль) — проверьте файл и загрузите его заново.' }
          : { kind: 'ok', text: 'Файл загружен, сумма посчитана. Отдел видит его уже сейчас.' })
      await onChanged?.()
    } catch (e) {
      setNote(id, { kind: 'warn', text: `Файл не загрузился: ${e.message || e}` })
    } finally {
      setBusyOf(id, null)
    }
  }

  const remove = async (id, file) => {
    if (!window.confirm(`Убрать файл «${file.file_name}»? Отдел его больше не увидит.`)) return
    setBusyOf(id, 'removing')
    setNote(id, null)
    try {
      await removeBidFile(file.id)
      await onChanged?.()
    } catch (e) {
      setNote(id, { kind: 'warn', text: `Не удалось убрать файл: ${e.message || e}` })
    } finally {
      setBusyOf(id, null)
    }
  }

  const download = (file, noteId) => downloadSignedFile(`bidfile:${file.id}`, file.file_name,
    () => (preview ? bidFileUrlAdmin(file.id) : bidFileUrl(file.id)))
    .catch((e) => setNote(noteId, { kind: 'warn', text: `«${file.file_name}» не скачался: ${e.message || e}` }))

  const pick = (row) => (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) upload(row, file)
  }
  // Перетаскивание файла на место загрузки своего ВОР.
  const dropProps = (row) => (!canEdit ? {} : {
    onDragOver: (e) => {
      if (!withFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = busy[row.vor.id] || vorReading(row.vor.id) ? 'none' : 'copy'
      if (dragOver !== row.vor.id) setDragOver(row.vor.id)
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null) },
    onDrop: (e) => {
      if (!withFiles(e)) return
      e.preventDefault()
      setDragOver(null)
      const file = e.dataTransfer.files?.[0]
      if (file && !vorReading(row.vor.id)) upload(row, file)
    },
  })

  const uploadButton = (row, { label, primary }) => {
    const id = row.vor.id
    const state = busy[id]
    const reading = vorReading(id)
    const text = state === 'reading' ? 'Читаем ваш файл…' : state === 'uploading' ? 'Загружаем…' : reading ? 'Готовим ВОР отдела…' : label
    return (
      <label className={`${primary ? 'cab-btn cab-btn-primary bid-upload-btn' : 'cab-btn-small bid-replace-btn'}${state || reading ? ' is-busy' : ''}`}
        title={reading ? 'Читаем ВОР отдела — по нему считается сумма. Несколько секунд.' : undefined}>
        {primary && !state && !reading && <IconUpload size={15} />}
        {text}
        <input type="file" accept={BID_FILE_ACCEPT} hidden disabled={!!state || reading} onChange={pick(row)}
          aria-label={`${label} к «${row.vor.file_name}»`} />
      </label>
    )
  }

  const { rows, orphans, totals } = table
  const done = totals.uploaded
  const allDone = rows.length > 0 && done === rows.length && totals.stale === 0
  const anyFile = rows.some((r) => r.file) || orphans.length > 0
  const vatLine = ownVat?.exempt
    ? 'Суммы без НДС.'
    : ownVat?.rate
      ? `Суммы с НДС, в т. ч. НДС ${String(ownVat.rate).replace('.', ',')} %: ${money(vatIncluded(totals.total, ownVat))} ₽.`
      : 'Суммы с НДС — как в ваших файлах. Ставку НДС укажите в анкете ниже.'

  // Файл бросили мимо места загрузки — браузер не открывает его вместо кабинета (набранное в анкете не теряется).
  const strayDrop = canEdit ? {
    onDragOver: (e) => { if (withFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none' } },
    onDrop: (e) => { if (withFiles(e) && !e.defaultPrevented) e.preventDefault() },
  } : {}

  return (
    <div className="bid-files" {...strayDrop}>
      <div className="bid-files-head">
        <b>{rows.length > 1 ? 'Ведомости объёмов работ' : 'Ведомость объёмов работ'}</b>
        {rows.length > 0 && (
          <span className={`bid-progress${allDone ? ' is-done' : done || totals.stale ? ' is-part' : ''}`} role="status">
            {allDone && <IconCheck size={13} />}
            С расценкой: {done} из {rows.length}
            <span className="bid-progress-bar" aria-hidden="true"><span style={{ width: `${rows.length ? Math.round((done / rows.length) * 100) : 0}%` }} /></span>
          </span>
        )}
      </div>

      {canEdit && rows.length > 0 && (
        <ol className="bid-steps" aria-label="Как сдать расценку">
          <li><span className="bid-step-n">1</span><span>Скачайте <b>ВОР отдела</b></span></li>
          <li><span className="bid-step-n">2</span><span>Впишите цены за единицу на листах «Материалы» и «Работы»</span></li>
          <li><span className="bid-step-n">3</span><span>Загрузите заполненный файл <b>справа от этой же ведомости</b> — сумма посчитается сама, отдел увидит файл сразу</span></li>
        </ol>
      )}

      <ul className="bid-pairs">
        {rows.map((row) => {
          const { vor, file, stale } = row
          const st = rowState(row)
          const chip = STATE_CHIP[st]
          const state = busy[vor.id]
          const note = notes[vor.id]
          const s = file?.summary
          const vorParsed = parsed[vor.id]
          return (
            <li key={vor.id} className={`bid-pair is-${st}`}>
              <div className="bid-pair-side bid-pair-vor">
                <span className="bid-pair-label">ВОР отдела</span>
                <span className="bid-vor-name" title={vor.file_name}>{vorTitle(vor.file_name)}</span>
                {vorParsed?.status === 'error' && <span className="bid-file-stale">Не читается сайтом — сумма не посчитается; сообщите ответственному.</span>}
                <button type="button" className="cab-btn bid-vor-btn" aria-label={`Скачать ВОР «${vor.file_name}»`} onClick={() => onDownloadVor(vor)}>
                  <IconDownload size={14} />
                  Скачать ВОР
                </button>
              </div>
              <div className="bid-pair-arrow" aria-hidden="true"><IconArrowRight /></div>
              <div className={`bid-pair-side bid-pair-mine${dragOver === vor.id ? ' is-drag' : ''}`} {...dropProps(row)}>
                <div className="bid-pair-top">
                  <span className="bid-pair-label">Ваш ВОР с расценками</span>
                  <span className={`bid-state-chip ${chip.cls}`}>
                    {st === 'ok' ? <IconCheck size={12} /> : st !== 'empty' ? <IconAlert size={12} /> : null}
                    {st === 'empty' && !canEdit ? 'Не загружен' : chip.text}
                  </span>
                </div>
                {file ? (
                  <>
                    <span className="bid-file-name" title={file.file_name}>{file.file_name}</span>
                    <span className="bid-file-meta">загружен {fmtDateTime(file.updated_at || file.created_at)}{file.size_bytes != null ? ` · ${fmtSize(file.size_bytes)}` : ''}</span>
                    {stale ? (
                      <span className="bid-file-stale">
                        Файл — к прежней версии ведомости{file.vor_name && vorTitle(file.vor_name) !== vorTitle(vor.file_name) ? ` («${file.vor_name}»)` : ''}: объёмы могли
                        измениться. Скачайте новый ВОР, перенесите цены и загрузите файл заново — до этого он не входит в итог.
                      </span>
                    ) : (
                      <>
                        <span className={`bid-file-sum${summaryCounted(s) ? '' : ' is-warn'}`}>{summaryLine(s)}</span>
                        {st === 'partial' && <span className="bid-file-cover">{coverage(s)}</span>}
                      </>
                    )}
                    <div className="bid-file-actions">
                      {stale && canEdit && uploadButton(row, { label: 'Загрузить заново', primary: true })}
                      <button type="button" className="cab-btn-small" onClick={() => download(file, vor.id)} aria-label={`Скачать свой файл «${file.file_name}»`}>
                        Скачать
                      </button>
                      {canEdit && !stale && uploadButton(row, { label: 'Заменить', primary: false })}
                      {canEdit && (
                        <button type="button" className="cab-btn-small bid-file-remove" disabled={!!state} onClick={() => remove(vor.id, file)}>Убрать</button>
                      )}
                    </div>
                  </>
                ) : canEdit ? (
                  <div className="bid-drop">
                    {uploadButton(row, { label: 'Загрузить ВОР с расценками', primary: true })}
                    <span className="bid-drop-hint">или перетащите файл сюда · Excel или PDF, до {BID_FILE_MAX_MB} МБ</span>
                  </div>
                ) : (
                  <span className="bid-muted">{preview ? 'Подрядчик файл ещё не загрузил.' : 'Файл не загружен.'}</span>
                )}
                {note && <div className={`bid-note${note.kind === 'warn' ? ' is-warn' : ' is-ok'}`} role="status">{note.text}</div>}
              </div>
            </li>
          )
        })}
      </ul>
      {vorError && <div className="bid-note is-warn" role="alert">{vorError}</div>}

      {orphans.length > 0 && (
        <div className="bid-orphans">
          <div className="bid-pair-label">Ваши прежние файлы — к ведомостям, которых в тендере больше нет, или к их старым версиям (в итог не входят)</div>
          <ul>
            {orphans.map((f) => (
              <li key={f.id}>
                <span className="bid-file-name">{f.file_name}</span>
                <span className="bid-file-meta">
                  {priorOf?.has(f.vor_file_id) ? 'к прежней версии' : 'к'} ВОР «{f.vor_name}» · {fmtDateTime(f.updated_at || f.created_at)}
                </span>
                <button type="button" className="cab-btn-small" onClick={() => download(f, f.id)}>Скачать</button>
                {canEdit && <button type="button" className="cab-btn-small bid-file-remove" disabled={!!busy[f.id]} onClick={() => remove(f.id, f)}>Убрать</button>}
                {notes[f.id] && <div className="bid-note is-warn">{notes[f.id].text}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && anyFile && (
        <div className="bid-matrix-block">
          <div className="bid-matrix-wrap">
            <table className="bid-matrix" aria-label="Ваша расценка по ведомостям">
              <thead>
                <tr>
                  <th rowSpan={2} className="bm-th-doc">ВОР</th>
                  <th colSpan={3} className="bm-th-cp">
                    <span className="bm-th-cp-name" title={counterpartyName}>{counterpartyName || 'Ваша организация'}</span>
                    <span className="bm-th-cp-sub">ваш ВОР с расценками</span>
                  </th>
                </tr>
                <tr>
                  <th className="bm-th-sub">Материалы, ₽</th>
                  <th className="bm-th-sub">Работы, ₽</th>
                  <th className="bm-th-sub bm-th-total">Итого, ₽</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ vor, file, stale }) => {
                  const s = file?.summary
                  const counted = summaryCounted(s) && !stale
                  const matWarn = counted && summaryIncomplete(s, 'material')
                  const workWarn = counted && summaryIncomplete(s, 'work')
                  return (
                    <tr key={vor.id} className={stale ? 'is-stale' : undefined}>
                      <td className="bm-td-doc" title={vor.file_name}>
                        {vorTitle(vor.file_name)}
                        {stale && <span className="bm-td-note">по прежней версии ВОР — не в итоге</span>}
                      </td>
                      <td className={`bm-td-num bm-td-mat${matWarn ? ' is-incomplete' : ''}`} title={matWarn ? coverageText(s, 'material') : undefined}>
                        {counted ? money(s.materials) : '—'}
                      </td>
                      <td className={`bm-td-num${workWarn ? ' is-incomplete' : ''}`} title={workWarn ? coverageText(s, 'work') : undefined}>
                        {counted ? money(s.works) : '—'}
                      </td>
                      <td className={`bm-td-num bm-td-total${matWarn || workWarn ? ' is-incomplete' : ''}`}
                        title={matWarn || workWarn ? `Итог неполный: ${coverage(s)}` : file && !counted && !stale ? summaryLine(s) : undefined}>
                        {counted ? money(s.total) : file && !stale ? 'не посчитано' : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="bm-tf-label">ИТОГО, ₽</td>
                  <td className="bm-tf-num bm-td-mat">{totals.counted ? money(totals.materials) : '—'}</td>
                  <td className="bm-tf-num">{totals.counted ? money(totals.works) : '—'}</td>
                  <td className={`bm-tf-num bm-tf-total${totals.incomplete ? ' is-incomplete' : ''}`}
                    title={totals.incomplete ? 'Итог неполный: не у всех позиций есть цена' : undefined}>
                    {totals.counted ? money(totals.total) : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="bid-muted">
            {totals.counted === 0
              ? 'Итог появится, когда загрузите расценку к ведомости.'
              : <>
                {vatLine} {done < rows.length
                  ? `Итог — только по ${done} ${done === 1 ? 'ведомости' : 'ведомостям'} из ${rows.length} с загруженной расценкой.`
                  : rows.length === 1 ? 'Итог — по ведомости целиком.' : `Итог — по всем ${rows.length} ведомостям.`}
                {totals.incomplete && ' Жёлтым — суммы, где цены есть не у всех позиций.'}
              </>}
          </p>
        </div>
      )}
    </div>
  )
}
