import { useEffect, useState } from 'react'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { priceInputText, priceSourceLines } from '../../utils/supplyPriceOrigin'
import { fmtPriceDate, rateUnitPrice } from '../../utils/supplyRateHelpers'
import { isWebLink, loadPriceOrigin } from '../../services/supplyPricing'

const FILES_SHOWN = 6

// Файл документа — открывается окном просмотра.
function FileButton({ doc, onOpenFile }) {
  return (
    <button type="button" className="sp-td-file" onClick={() => onOpenFile(doc)} title="Открыть файл">
      <PaperclipIcon size={12} /> {doc.file_name}
    </button>
  )
}

// Откуда цена, скопированная из другого тендера: нажали на строку «Похожая цена: …» под наименованием. Что за исходная позиция, в
// каком тендере и ВОР, и главное — из какого она документа. Документа нет — так и говорим, и почему (цену ввели вручную); цена не
// становится вернее от того, что мы промолчали. Автор исходной цены — только администратору (как в колонке «Дата цены»).
export default function SupplyPriceOriginDialog({ name, rate, origin, showAuthor, nameOf, onOpenFile, onClose }) {
  const [info, setInfo] = useState(null) // { source, offers, files } — исходная цена и файлы её тендера
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const tenderId = rate.source_tender_id || origin?.source_tender_id || null

  useEffect(() => {
    let live = true
    loadPriceOrigin(rate.source_rate_id, tenderId)
      .then((res) => { if (live) setInfo(res) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [rate.source_rate_id, tenderId])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const source = info?.source || null
  const sourceName = origin?.material_name || source?.material_name || null
  const sourcePrice = source ? rateUnitPrice(source) : null
  const unit = source?.unit || rate.unit || 'ед.'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin.url)
      setCopied(true)
    } catch { /* без доступа к буферу — путь виден в окне */ }
  }
  const attachedFile = origin?.doc_key ? { id: origin.doc_id, file_name: origin.doc_name, s3_key: origin.doc_key } : null
  const attached = !!attachedFile || !!origin?.url
  const lines = !attached && info && sourceName ? priceSourceLines(info.offers, { name: sourceName, price: sourcePrice }) : []
  const otherFiles = !attached && info ? (info.files || []).filter((d) => !lines.some((l) => l.doc.id === d.id)) : []
  const author = showAuthor && origin?.source_price_by ? nameOf(origin.source_price_by) : null

  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sp-modal sp-modal-wide" role="dialog" aria-modal="true" aria-labelledby="sp-origin-title">
        <h3 id="sp-origin-title">Откуда цена</h3>
        <p className="sp-modal-item">{name}</p>
        <div className="sp-modal-body">
          <dl className="sp-origin-facts">
            {sourceName && <><dt>Исходная позиция</dt><dd>{sourceName}</dd></>}
            <dt>Тендер</dt>
            <dd>
              {tenderId ? (
                <a className="link" href={`/tenders/materials/${tenderId}/pricing`} target="_blank" rel="noopener noreferrer" title="Открыть расценку этого тендера в новой вкладке">
                  {origin?.tender_number != null ? `№ ${origin.tender_number}` : 'открыть расценку'}
                </a>
              ) : '—'}
              {origin?.object_name ? ` · ${origin.object_name}` : ''}
            </dd>
            {origin?.estimate_name && <><dt>ВОР</dt><dd>{origin.estimate_name}</dd></>}
            <dt>Цена</dt>
            <dd>
              <span className="ui-num">{formatAmount(roundMoney(sourcePrice ?? rateUnitPrice(rate)))}</span> ₽ за {unit}
              {rate.price_date ? <> · день расценки <span className="ui-num">{fmtPriceDate(rate.price_date)}</span></> : ''}
            </dd>
            {author && <><dt>Поставил</dt><dd>{author}</dd></>}
          </dl>

          <h4 className="sp-origin-doc-title">Документ</h4>
          {attachedFile && <p><FileButton doc={attachedFile} onOpenFile={onOpenFile} /></p>}
          {!attachedFile && origin?.url && (
            <p>
              {isWebLink(origin.url)
                ? <a className="link" href={origin.url} target="_blank" rel="noopener noreferrer">Открыть документ</a>
                : <button type="button" className="link sp-doc-copy" onClick={copy} title={origin.url}>{copied ? 'Скопировано' : 'Скопировать путь к документу'}</button>}
            </p>
          )}
          {!attached && !info && !failed && <p className="sp-muted" role="status">Ищем в файлах тендера…</p>}
          {!attached && failed && <p className="sp-muted" role="alert">К цене документ не прикреплён. Файлы тендера не прочитались — посмотрите в его расценке.</p>}
          {!attached && info && lines.length > 0 && (
            <>
              <p>К цене документ не прикреплён, но в файлах тендера есть похожая строка:</p>
              <ul className="sp-origin-lines">
                {lines.slice(0, FILES_SHOWN).map(({ doc, line, samePrice }) => (
                  <li key={`${doc.id}:${line.name}:${line.price}`}>
                    <FileButton doc={doc} onOpenFile={onOpenFile} />
                    <span className="sp-td-meta">
                      {line.name} — <span className="ui-num">{formatAmount(line.price)}</span> ₽{line.unit ? ` за ${line.unit}` : ''}{samePrice ? ' · та же цена' : ' · другая цена'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!attached && info && !lines.length && (
            <p className="sp-origin-none" role="status">
              Документа нет: {source ? priceInputText(source.price_input) : 'исходная цена уже удалена'}{source ? ', документ к ней не прикрепляли' : ''}.
            </p>
          )}
          {otherFiles.length > 0 && (
            <>
              <p className="sp-muted">{lines.length ? 'Другие файлы' : 'Файлы'} счетов и КП этого тендера:</p>
              <ul className="sp-origin-lines">
                {otherFiles.slice(0, FILES_SHOWN).map((doc) => <li key={doc.id}><FileButton doc={doc} onOpenFile={onOpenFile} /></li>)}
              </ul>
            </>
          )}
        </div>
        <div className="sp-modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
