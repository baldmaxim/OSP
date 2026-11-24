import { useEffect, useRef, useState } from 'react'
import { IconAlert, IconDownload, IconTrash } from '../icons/ActionIcons'
import { IconClose } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import DocListZipButton from '../DocListZipButton'
import { downloadS3File } from '../FileDownload'
import { formatAmount } from '../../utils/money'
import { DOC_READ_PROBLEM } from '../../utils/supplyDocPrice'
import { offerVatMode } from '../../utils/supplyOffers'

const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')
const fmtSize = (bytes) => {
  const n = Number(bytes) || 0
  if (!n) return ''
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`
}
const positive = (v) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
const newestFirst = (a, b) => String(b.doc.created_at || '').localeCompare(String(a.doc.created_at || ''))

// Что требует действия человека: цены в валюте ждут курса (до него не предлагаются), удалённый файл, чьи цены ещё стоят.
export const filesAttention = (docs, removed) => docs.filter((x) => x.offer.currency).length + removed.length

// Документы окна «Счета и КП тендера» (24.11.2026, просьба пользователя: плашки файлов над таблицей — с повторами и причинами, почему
// цены не прочитаны, — занимали место; вместо них — кнопка-значок и это окно): все файлы тендера одной таблицей, новые первыми — открыть,
// скачать по одному или все одним ZIP, удалить; у прочитанных — сколько строк с ценами, НДС и курс; у повторов и непрочитанных — почему
// цен нет. Ниже — удалённые файлы, чьи цены ещё стоят: снять цены или оставить. Окно лежит поверх «Счетов и КП»: Escape и щелчок мимо
// закрывают только его (Escape ловит окно «Счета и КП»), просмотр файла и окно удаления открываются поверх.
// docs — [{ doc, offer }], dupes — [{ doc, of }], others — [{ doc, failed, progress }], removed — [{ docId, name, at, rows }].
// busy — идёт запись (кнопки правки закрыты); archiveOwner — начало имени архива («Тендер № 291»); note, error — строка состояния
// окна «Счета и КП». onOpenFile(doc), onDelete(doc), onSetRate(doc, rate), onSetVat(doc, mode), onClearRemoved(entry),
// onKeepRemoved(entry), onClose.
export default function SupplyTenderFilesDialog({
  docs, dupes, others, removed, busy, archiveOwner, note = '', error = '', onOpenFile, onDelete, onSetRate, onSetVat,
  onClearRemoved, onKeepRemoved, onClose,
}) {
  const closeRef = useRef(null)
  const [downloadError, setDownloadError] = useState('')
  useEffect(() => { closeRef.current?.focus() }, [])
  const rows = [
    ...docs.map((x) => ({ ...x, kind: 'offer' })),
    ...dupes.map((x) => ({ ...x, kind: 'dup' })),
    ...others.map((x) => ({ ...x, kind: x.failed ? 'failed' : 'reading' })),
  ].sort(newestFirst)
  // Локальные файлы (на сервере не применено обновление базы) в хранилище не лежат — скачивать нечего.
  const stored = rows.map((r) => r.doc).filter((d) => d.s3_key)
  const unread = rows.filter((r) => r.kind === 'failed').length
  const download = async (doc) => {
    setDownloadError('')
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (e) {
      setDownloadError(`«${doc.file_name}» не скачался: ${e.message || e}`)
    }
  }

  return (
    <div className="sp-modal-backdrop sp-tf-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sp-modal sp-tf" role="dialog" aria-modal="true" aria-labelledby="sp-tf-title">
        <div className="sp-tf-head">
          <h3 id="sp-tf-title">Документы тендера</h3>
          <span className="sp-td-meta ui-num">
            файлов: {rows.length}{dupes.length ? ` · повторов: ${dupes.length}` : ''}{unread ? ` · цены не прочитаны: ${unread}` : ''}
          </span>
          {stored.length > 0 && <DocListZipButton docs={stored} ownerName={archiveOwner} title="Счета и КП" className="btn-secondary sp-tf-zip" />}
          <button ref={closeRef} type="button" className="sp-icon-btn sp-tf-close" onClick={onClose} aria-label="Закрыть окно документов" title="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="sp-modal-body sp-tf-body">
          {rows.length > 0 ? (
            <table className="data-table sp-tf-table">
              <colgroup>
                <col className="sp-tf-c-name" /><col className="sp-tf-c-date" /><col className="sp-tf-c-state" /><col className="sp-tf-c-act" />
              </colgroup>
              <thead>
                <tr><th>Файл</th><th>Дата документа</th><th>Цены</th><th><span className="ui-sr-only">Действия</span></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.doc.id} className={r.kind === 'failed' ? 'is-off' : r.kind === 'dup' ? 'is-dup' : undefined}>
                    <td className="sp-tf-name">
                      <button type="button" className="sp-td-file" onClick={() => onOpenFile(r.doc)} title="Открыть файл">
                        <PaperclipIcon size={13} /> {r.doc.file_name}
                      </button>
                      <span className="sp-td-meta ui-num">
                        загружен {fmtDay(r.doc.created_at)}{r.doc.uploaded_by_name ? ` · ${r.doc.uploaded_by_name}` : ''}{fmtSize(r.doc.size_bytes) ? ` · ${fmtSize(r.doc.size_bytes)}` : ''}
                      </span>
                    </td>
                    <td className="ui-num sp-tf-date">{r.kind === 'offer' && r.offer.date ? fmtDay(r.offer.date) : <span className="sp-muted">—</span>}</td>
                    <td className="sp-tf-state"><FileState row={r} busy={busy} onSetRate={onSetRate} onSetVat={onSetVat} /></td>
                    <td className="sp-tf-act">
                      <button type="button" className="sp-icon-btn" onClick={() => download(r.doc)} disabled={!r.doc.s3_key}
                        aria-label={`Скачать «${r.doc.file_name}»`} title="Скачать файл"><IconDownload size={16} /></button>
                      <button type="button" className="sp-icon-btn sp-td-del" onClick={() => onDelete(r.doc)} disabled={busy}
                        aria-label={`Удалить файл «${r.doc.file_name}»`}
                        title={r.kind === 'dup' ? 'Удалить повтор — пропадёт у всех позиций, где он документ' : 'Удалить файл — пропадёт у всех позиций, где он документ'}>
                        <IconTrash size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="sp-td-empty">Файлов у тендера нет.</p>}

          {removed.length > 0 && (
            <section className="sp-tf-gone" aria-labelledby="sp-tf-gone-title">
              <h4 id="sp-tf-gone-title">Удалены, а цены из них стоят</h4>
              <ul aria-label="Удалённые файлы, чьи цены стоят">
                {removed.map((entry) => (
                  <li key={`gone-${entry.docId}`}>
                    <span className="sp-td-gone"><IconTrash size={12} /> {entry.name}</span>
                    <span className="sp-td-meta">удалён{entry.at ? ` ${fmtDay(entry.at)}` : ''} · его цены стоят у позиций: <b className="ui-num">{entry.rows.length}</b></span>
                    <span className="sp-tf-gone-act">
                      <button type="button" className="sp-link-btn is-danger" disabled={busy} onClick={() => onClearRemoved(entry)}
                        title="Снять цены, поставленные из этого файла. Цены, которые после удаления файла меняли, останутся.">снять цены</button>
                      <button type="button" className="sp-link-btn" disabled={busy} onClick={() => onKeepRemoved(entry)}
                        title="Оставить цены как обычные: строка удалённого файла пропадёт">оставить</button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {note && !error && !downloadError && <p className="sp-td-note" role="status">{note}</p>}
          {(error || downloadError) && <p className="sp-error-text" role="alert">{error || downloadError}</p>}
        </div>
      </div>
    </div>
  )
}

// Цены файла: прочитан — сколько строк, НДС (или курс валюты) и что проверить; повтор — чей; не прочитан — почему; читается — ход.
function FileState({ row, busy, onSetRate, onSetVat }) {
  if (row.kind === 'dup') return <span className="sp-td-meta">повтор «{row.of.file_name}» — цены не считаются второй раз</span>
  if (row.kind === 'reading') return <span className="sp-td-meta" role="status">{row.progress || 'читаем…'}</span>
  if (row.kind === 'failed') {
    return <span className="sp-tf-warn"><IconAlert size={13} /> {DOC_READ_PROBLEM[row.failed] || DOC_READ_PROBLEM.broken}</span>
  }
  const { doc, offer } = row
  const lines = offer.lines.filter((l) => !l.skip).length
  return (
    <span className="sp-tf-offer">
      <span className="ui-num">строк с ценами: {lines}</span>
      {offer.currency ? (
        <span className="sp-td-pack is-warn">
          цены в {offer.currency}, курс ₽:
          <input type="text" inputMode="decimal" className="sp-td-num" disabled={busy} aria-label={`Курс, ₽ за 1 ${offer.currency}: ${doc.file_name}`}
            onBlur={(e) => { const n = positive(e.target.value); if (n) onSetRate(doc, n) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        </span>
      ) : (
        <select className="sp-td-vat" value={offerVatMode(offer)} disabled={busy} aria-label={`НДС в ценах: ${doc.file_name}`} title="Какие цены в документе. Цена в расценке — с НДС."
          onChange={(e) => onSetVat(doc, e.target.value)}>
          <option value="gross">с НДС</option>
          <option value="net">без НДС, +{offer.vat?.rate ?? 22} %</option>
        </select>
      )}
      {offer.ocr && (
        <span className="sp-td-tag" title="Текст распознан со скана. Цену без сверки цена × кол-во = сумма расценка сама не отмечает.">со скана{offer.total?.ok ? ', итог сошёлся' : ''}</span>
      )}
      {offer.total && !offer.total.ok && (
        <span className="sp-td-tag is-warn" title={`Итог в документе ${formatAmount(offer.total.doc)} ₽, в прочитанных строках ${formatAmount(offer.total.read)} ₽: часть строк могла не прочитаться, или в документе скидка на весь заказ.`}>итог не сходится</span>
      )}
    </span>
  )
}
