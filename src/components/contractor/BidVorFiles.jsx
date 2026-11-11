import { useMemo, useState } from 'react'
import { uploadBidFile, removeBidFile, bidFileUrl, bidFileUrlAdmin } from '../../services/contractorBids'
import { bidFilesTable, summaryCounted, summaryIncomplete, coverageText, BID_FILE_ACCEPT, BID_FILE_MAX_MB, SUMMARY_ERROR_TEXT } from '../../utils/bidFiles'
import { vatIncluded } from '../../utils/bidForm'
import { formatAmount } from '../../utils/money'
import { downloadSignedFile } from '../FileDownload'
import { IconDownload } from '../icons/ActionIcons'

// Свой ВОР с расценками (миграция 20270113, решение пользователя 11.11.2026). Расценка на сайте временно скрыта: слева — ВОР отдела
// (пустой, «Скачать ВОР»), справа — ВОР подрядчика с расценками (загрузить, скачать, заменить, убрать). Под ними — сводка как в
// «Сравнении КП» карточки тендера (тендер № 38): строки — ведомости (корпуса), столбцы — материалы, работы, итого; внизу ИТОГО.
// Подрядчик видит только свои файлы и суммы: строки читаются с отбором по своей организации, а база отдаёт только их.
//
// Цены из файла читаются здесь же, в браузере, тем же разбором, что «Цены из файла» (utils/bidFileSummary.js); в базу уходит
// только сводка. Файл, где цен не нашлось, можно загрузить после вопроса — сумма у него не посчитается.

const fmtDateTime = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('ru-RU')}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}
const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`)
const money = (v) => formatAmount(Number(v || 0))
const vorTitle = (name) => String(name || '').replace(/\.(xlsx|xlsm|xls)$/i, '')

function summaryLine(s) {
  if (!s) return ''
  if (!summaryCounted(s)) return SUMMARY_ERROR_TEXT[s.error] || 'Сумма не посчитана.'
  return `Итого ${money(s.total)} ₽`
}

export default function BidVorFiles({
  tenderId, vorFiles, parsed, myFiles, canEdit, preview = false, ownVat = null, counterpartyName = '',
  onDownloadVor, vorError = '', onChanged,
}) {
  const [busy, setBusy] = useState({}) // id ведомости → 'reading' | 'uploading' | 'removing'
  const [notes, setNotes] = useState({}) // id ведомости → { kind, text }
  const table = useMemo(() => bidFilesTable(vorFiles, myFiles), [vorFiles, myFiles])

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

  const upload = async (row, file) => {
    const id = row.vor.id
    setNote(id, null)
    if (file.size > BID_FILE_MAX_MB * 1024 * 1024) { setNote(id, { kind: 'warn', text: `Файл больше ${BID_FILE_MAX_MB} МБ.` }); return }
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
      setNote(id, summaryCounted(summary)
        ? { kind: summaryIncomplete(summary, 'material') || summaryIncomplete(summary, 'work') ? 'warn' : 'ok',
            text: `Файл загружен: ${summaryLine(summary)}. ${[coverageText(summary, 'material'), coverageText(summary, 'work')].filter(Boolean).join('; ')}.` }
        : { kind: 'warn', text: 'Файл загружен, сумма не посчитана.' })
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

  const { rows, orphans, totals } = table
  const vatLine = ownVat?.exempt
    ? 'Суммы без НДС.'
    : ownVat?.rate
      ? `Суммы с НДС, в т. ч. НДС ${String(ownVat.rate).replace('.', ',')} %: ${money(vatIncluded(totals.total, ownVat))} ₽.`
      : 'Суммы с НДС — как в ваших файлах. Ставку НДС укажите в анкете ниже.'

  return (
    <div className="bid-files">
      <div className="bid-vor-head">
        <b>{rows.length > 1 ? 'Ведомости объёмов работ' : 'Ведомость объёмов работ'}</b>
        {canEdit && (
          <span>
            Скачайте ВОР, заполните цены за единицу на листах «Материалы» и «Работы» и загрузите файл рядом — к этой же ведомости.
            Суммы посчитаются сами, отдел увидит файл сразу. Новый файл заменяет прежний.
          </span>
        )}
      </div>

      <ul className="bid-pairs">
        {rows.map((row) => {
          const { vor, file, stale } = row
          const state = busy[vor.id]
          const note = notes[vor.id]
          const reading = parsed[vor.id]?.status === 'loading' || !parsed[vor.id]
          const s = file?.summary
          return (
            <li key={vor.id} className="bid-pair">
              <div className="bid-pair-side bid-pair-vor">
                <span className="bid-pair-label">ВОР отдела</span>
                <span className="bid-vor-name" title={vor.file_name}>{vorTitle(vor.file_name)}</span>
                <button type="button" className="cab-btn bid-vor-btn" aria-label={`Скачать ВОР «${vor.file_name}»`} onClick={() => onDownloadVor(vor)}>
                  <IconDownload size={14} />
                  Скачать ВОР
                </button>
              </div>
              <div className={`bid-pair-side bid-pair-mine${file ? ' has-file' : ''}`}>
                <span className="bid-pair-label">Ваш ВОР с расценками</span>
                {file ? (
                  <>
                    <span className="bid-file-name" title={file.file_name}>{file.file_name}</span>
                    <span className="bid-file-meta">загружен {fmtDateTime(file.updated_at || file.created_at)}{file.size_bytes != null ? ` · ${fmtSize(file.size_bytes)}` : ''}</span>
                    <span className={`bid-file-sum${summaryCounted(s) ? '' : ' is-warn'}`}>{summaryLine(s)}</span>
                    {stale && <span className="bid-file-stale">Отдел обновил ВОР после загрузки — проверьте расценку и загрузите файл заново.</span>}
                    <div className="bid-file-actions">
                      <button type="button" className="cab-btn-small" onClick={() => download(file, vor.id)} aria-label={`Скачать свой файл «${file.file_name}»`}>Скачать</button>
                      {canEdit && (
                        <label className={`cab-btn-small${state ? ' is-busy' : ''}`}>
                          {state === 'reading' ? 'Читаем файл…' : state === 'uploading' ? 'Загружаем…' : 'Заменить'}
                          <input type="file" accept={BID_FILE_ACCEPT} hidden disabled={!!state || reading} onChange={pick(row)} />
                        </label>
                      )}
                      {canEdit && (
                        <button type="button" className="cab-btn-small bid-file-remove" disabled={!!state} onClick={() => remove(vor.id, file)}>Убрать</button>
                      )}
                    </div>
                  </>
                ) : canEdit ? (
                  <label className={`cab-btn cab-btn-primary bid-upload-btn${state ? ' is-busy' : ''}`}
                    title={reading ? 'Читаем ВОР отдела — подождите несколько секунд' : undefined}>
                    {state === 'reading' ? 'Читаем файл…' : state === 'uploading' ? 'Загружаем…' : 'Загрузить ВОР с расценками'}
                    <input type="file" accept={BID_FILE_ACCEPT} hidden disabled={!!state || reading} onChange={pick(row)}
                      aria-label={`Загрузить свой ВОР с расценками к «${vor.file_name}»`} />
                  </label>
                ) : (
                  <span className="bid-muted">{preview ? 'Файл не загружен.' : 'Не загружен.'}</span>
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
          <div className="bid-pair-label">Файлы к ведомостям, которых в тендере больше нет (в итог не входят)</div>
          <ul>
            {orphans.map((f) => (
              <li key={f.id}>
                <span className="bid-file-name">{f.file_name}</span>
                <span className="bid-file-meta">к ВОР «{f.vor_name}» · {fmtDateTime(f.updated_at || f.created_at)}</span>
                <button type="button" className="cab-btn-small" onClick={() => download(f, f.id)}>Скачать</button>
                {canEdit && <button type="button" className="cab-btn-small bid-file-remove" disabled={!!busy[f.id]} onClick={() => remove(f.id, f)}>Убрать</button>}
                {notes[f.id] && <div className="bid-note is-warn">{notes[f.id].text}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
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
                {rows.map(({ vor, file }) => {
                  const s = file?.summary
                  const counted = summaryCounted(s)
                  const matWarn = summaryIncomplete(s, 'material')
                  const workWarn = summaryIncomplete(s, 'work')
                  const tip = [coverageText(s, 'material'), coverageText(s, 'work')].filter(Boolean).join('; ')
                  return (
                    <tr key={vor.id}>
                      <td className="bm-td-doc" title={vor.file_name}>{vorTitle(vor.file_name)}</td>
                      <td className={`bm-td-num bm-td-mat${matWarn ? ' is-incomplete' : ''}`} title={matWarn ? coverageText(s, 'material') : undefined}>
                        {counted ? money(s.materials) : '—'}
                      </td>
                      <td className={`bm-td-num${workWarn ? ' is-incomplete' : ''}`} title={workWarn ? coverageText(s, 'work') : undefined}>
                        {counted ? money(s.works) : '—'}
                      </td>
                      <td className={`bm-td-num bm-td-total${matWarn || workWarn ? ' is-incomplete' : ''}`}
                        title={matWarn || workWarn ? `Итог неполный: ${tip}` : file && !counted ? summaryLine(s) : undefined}>
                        {counted ? money(s.total) : file ? 'не посчитано' : '—'}
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
            {vatLine} Загружено {totals.uploaded} из {rows.length} {rows.length === 1 ? 'ведомости' : 'ведомостей'}.
            {totals.uploaded < rows.length && ' Итог — только по загруженным.'}
          </p>
        </div>
      )}
    </div>
  )
}
