import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconClose, IconFileText } from '../icons/ToolbarIcons'
import { isWebLink } from '../../utils/kpRegistrySources'
import { fmtMoney, fmtMoscowDate } from '../../utils/ratesRegistry'
import { loadImportInfo } from '../../services/supplyRegistryImport'
import { isSupplyDocRow, loadDocLineStatus, loadTenderNumber } from '../../services/supplyRegistryDocs'
import './KpRates.css'
import './SupplyRateDetails.css'

const fmtStamp = (iso) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

function Field({ label, children, empty = 'Не указан' }) {
  const has = children != null && children !== '' && children !== false
  return (
    <>
      <dt>{label}</dt>
      <dd>{has ? children : <span className="srd-empty">{empty}</span>}</dd>
    </>
  )
}

// Сетевой путь или имя файла: адрес http/https — ссылкой, иначе текстом с «Скопировать» (браузер сетевой путь не откроет).
function SourceFile({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  if (isWebLink(value)) return <a href={value} target="_blank" rel="noopener noreferrer" className="srd-path">{value}</a>
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* без доступа к буферу — путь виден и выделяется */ }
  }
  return (
    <span className="srd-path-row">
      <span className="srd-path">{value}</span>
      <button type="button" className="kpr-link-btn" onClick={copy}>{copied ? 'Скопировано' : 'Скопировать'}</button>
    </span>
  )
}

// Реестр расценок → «Расценки от снабжения СУ-10» → нажатие на строку (миграция 20270227): всё, что известно о расценке.
// Строка уже прочитана страницей (поля подробностей — в той же выборке), здесь дочитывается только загрузка (файл, кто,
// когда) — одним запросом по id и только для загруженных из Excel. hasDetails — в базе есть колонки подробностей
// (миграция 20270227): нет — их строк в окне нет вовсе, а не «Не указан».
// Номер тендера — одним запросом по tender_id (у строк всех видов). Строка счёта / КП тендера (миграция 20270306): файл
// (onOpenFile — открыть, если он есть), «файл удалён из тендера», статус «применена / не применена в тендере» — applied
// со страницы (undefined — окно спросит само, null — неизвестно).
export default function SupplyRateDetailsDialog({ row, hasDetails = true, onClose, applied, onOpenFile = null }) {
  const imported = row.source_type === 'supply_import'
  const fromDoc = isSupplyDocRow(row)
  const [info, setInfo] = useState(undefined) // undefined — читаем, null — нет, объект — загрузка
  const [infoError, setInfoError] = useState('')
  const [tenderNo, setTenderNo] = useState(null)
  const [status, setStatus] = useState(applied)

  useEffect(() => {
    if (!row.tender_id) return undefined
    let cancelled = false
    loadTenderNumber(row.tender_id)
      .then((n) => { if (!cancelled) setTenderNo(n) })
      .catch(() => {}) // без номера окно показывает описание, как раньше
    return () => { cancelled = true }
  }, [row.tender_id])

  useEffect(() => {
    setStatus(applied)
    if (!fromDoc || applied !== undefined) return undefined
    let cancelled = false
    loadDocLineStatus([row]).then((m) => { if (!cancelled) setStatus(m ? (m.has(row.id) ? m.get(row.id) : null) : null) })
    return () => { cancelled = true }
  }, [fromDoc, applied, row])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!imported || !row.import_id) return undefined
    let cancelled = false
    loadImportInfo(row.import_id)
      .then((r) => { if (!cancelled) setInfo(r) })
      .catch((err) => { if (!cancelled) { setInfo(null); setInfoError(err.message || String(err)) } })
    return () => { cancelled = true }
  }, [imported, row.import_id])

  const objectFromFile = imported && row.object_label && norm(row.object_label) !== norm(row.object_name) ? row.object_label : ''
  const tenderFromFile = imported && row.tender_label && norm(row.tender_label) !== norm(row.tender_desc) ? row.tender_label : ''
  const hasInvoice = isWebLink(row.invoice_url)

  return (
    <div className="kpr-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="kpr-modal srd-modal" role="dialog" aria-modal="true" aria-labelledby="srd-title">
        <div className="kpr-modal-head">
          <h3 id="srd-title">Расценка</h3>
          <button type="button" className="kpr-icon-btn" onClick={onClose} aria-label="Закрыть" autoFocus><IconClose size={16} /></button>
        </div>
        <div className="kpr-modal-body">
          <div className="srd-head">
            <p className="srd-name">{row.item_name}</p>
            <p className="srd-price">
              <b className="srd-money">{row.price != null ? `${fmtMoney(row.price)} ₽` : '—'}</b>
              <span> за {row.unit || 'ед.'}</span>
              <span className="srd-date"> · {fmtMoscowDate(row.rate_date)}</span>
            </p>
          </div>

          <dl className="srd-list">
            <Field label="Источник">
              {fromDoc && row.doc_deleted_at ? (
                <span className="srd-deleted">
                  {row.source_name} — файл удалён из тендера {fmtMoscowDate(row.doc_deleted_at)}
                </span>
              ) : (row.source_name || 'СУ-10')}
            </Field>
            <Field label="Объект">
              {(row.object_name || objectFromFile) && (
                <>
                  {row.object_name || objectFromFile}
                  {objectFromFile && row.object_name && <span className="srd-file">в файле: «{objectFromFile}»</span>}
                </>
              )}
            </Field>
            <Field label="Тендер">
              {(row.tender_desc || tenderFromFile || tenderNo != null) && (
                <>
                  {tenderNo != null && <span className="srd-tender-no">№ {tenderNo}</span>}
                  {row.tender_id && row.tender_desc
                    ? <Link to={`/tenders/${row.tender_id}`} className="srd-link">{row.tender_desc}</Link>
                    : (row.tender_desc || tenderFromFile)}
                  {tenderFromFile && row.tender_desc && <span className="srd-file">в файле: «{tenderFromFile}»</span>}
                </>
              )}
            </Field>
            {fromDoc && (
              <Field label="Статус" empty={status === undefined ? 'Проверяем…' : 'Не удалось проверить'}>
                {status === true ? <span className="srd-status is-applied">Применена в тендере</span>
                  : status === false ? (
                    <span className="srd-status is-idle">
                      Не применена в тендере
                      <span className="srd-file">цена этой строки не стоит ни у одной позиции тендера</span>
                    </span>
                  ) : null}
              </Field>
            )}
            {fromDoc && (
              <Field label="Документ">
                {row.doc_deleted_at ? (
                  <span className="srd-invoice is-missing">
                    <IconFileText size={16} /> «{row.source_file || 'без имени'}» — удалён из тендера {fmtMoscowDate(row.doc_deleted_at)}
                  </span>
                ) : (
                  <span className="srd-path-row">
                    <span className="srd-invoice is-linked"><IconFileText size={16} /> «{row.source_file || 'без имени'}»</span>
                    {onOpenFile && <button type="button" className="kpr-link-btn" onClick={onOpenFile}>Открыть</button>}
                  </span>
                )}
              </Field>
            )}
            {imported && hasDetails && (
              <>
                <Field label="Подрядчик по папке">{row.contractor_label}</Field>
                <Field label="№ документа из имени файла">{row.doc_number}</Field>
                <Field label="№ заявки / заказа">{row.order_number}</Field>
                <Field label="Файл-источник" empty="Не указан"><SourceFile value={row.source_file} /></Field>
              </>
            )}
            {hasDetails && !fromDoc && <Field label="Счёт">
              {hasInvoice ? (
                <a href={row.invoice_url} target="_blank" rel="noopener noreferrer" className="srd-invoice is-linked" title={row.invoice_url}>
                  <IconFileText size={16} /> Открыть счёт
                </a>
              ) : (
                <span className="srd-invoice is-missing"><IconFileText size={16} /> Ссылки на счёт нет</span>
              )}
            </Field>}
            {imported && row.import_id && (
              <Field label="Загружено" empty={info === undefined ? 'Читаем…' : 'Загрузка не найдена'}>
                {info && (
                  <>
                    «{info.file_name}», {fmtStamp(info.created_at)}{info.created_by_name ? `, ${info.created_by_name}` : ''}
                    {row.row_no ? <span className="srd-file">строка файла {row.row_no}</span> : null}
                  </>
                )}
              </Field>
            )}
          </dl>
          {infoError && <p className="kpr-error" role="alert">{infoError}</p>}
          {!imported && !fromDoc && (
            <p className="kpr-muted">
              Цена снабжения из тендера: документы и цены поставщиков — в карточке тендера, вкладка «Расценки снабжения».
            </p>
          )}
          {fromDoc && (
            <p className="kpr-muted">
              Строка счёта / КП, загруженного в тендер на материалы: цена — как её прочитало окно «Счета и КП тендера», дата —
              дата документа (не нашлась в файле — день загрузки).
            </p>
          )}
        </div>
        <div className="kpr-modal-foot">
          <button type="button" className="kpr-btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
