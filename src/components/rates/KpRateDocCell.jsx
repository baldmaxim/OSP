import { useState } from 'react'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconPencil, IconTrash } from '../icons/ActionIcons'
import { isWebLink } from '../../utils/kpRegistrySources'
import './KpRates.css'

// Ячейка «Документ (ВОР)» реестра КП (миграция 20261122): откуда взята расценка.
//  • КП из файла — файл КП, сохранённый вместе с ценами (открывается просмотром), и ВОР позиции; файла нет (загружен
//    не через окно КП или удалён) — только ВОР;
//  • цена с сайта — «кабинет подрядчика»;
//  • добавлена вручную — пометка, файл или ссылка (адрес — в новой вкладке, сетевой путь — скопировать), примечание,
//    а с правом правки реестра — «изменить» и «удалить».
export default function KpRateDocCell({ row, canEdit, onOpenFile, onEdit, onDelete }) {
  const [copied, setCopied] = useState(false)
  const kind = row.source_kind
  const file = row.source_doc_id ? (
    <button type="button" className="kpr-doc-file" onClick={() => onOpenFile(row)} title={`Открыть: ${row.source_doc_name || 'файл'}`}>
      <PaperclipIcon size={13} /><span>{row.source_doc_name || 'файл'}</span>
    </button>
  ) : null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.source_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* без доступа к буферу — путь виден в подсказке */ }
  }
  if (kind === 'kp') {
    return (
      <div className="kpr-doc">
        {file || <span className="kpr-doc-muted" title="Цены загружены без сохранённого файла КП (или файл удалён)">файл КП не найден</span>}
        {row.estimate_name && <span className="kpr-doc-vor">ВОР: {row.estimate_name}</span>}
      </div>
    )
  }
  if (kind === 'site') {
    return (
      <div className="kpr-doc">
        <span className="kpr-tag is-site" title="Цена, которую подрядчик ввёл в кабинете на сайте (тендер завершён)">кабинет подрядчика</span>
      </div>
    )
  }
  if (kind === 'manual') {
    return (
      <div className="kpr-doc">
        <span className="kpr-tag is-manual">добавлено вручную</span>
        {file}
        {!file && row.source_url && (isWebLink(row.source_url)
          ? <a className="kpr-doc-file" href={row.source_url} target="_blank" rel="noopener noreferrer" title={row.source_url}><span>Открыть документ</span></a>
          : <button type="button" className="kpr-link-btn" onClick={copy} title={`${row.source_url} — сетевой путь, нажмите, чтобы скопировать`}>
            {copied ? 'Путь скопирован' : 'Скопировать путь к документу'}
          </button>)}
        {row.note && <span className="kpr-doc-note" title={row.note}>{row.note.length > 120 ? `${row.note.slice(0, 120)}…` : row.note}</span>}
        {canEdit && (
          <span className="kpr-doc-actions">
            <button type="button" className="kpr-icon-btn" onClick={() => onEdit(row)} aria-label={`Изменить расценку: ${row.item_name}`} title="Изменить">
              <IconPencil size={14} />
            </button>
            <button type="button" className="kpr-icon-btn is-danger" onClick={() => onDelete(row)} aria-label={`Удалить расценку: ${row.item_name}`} title="Удалить">
              <IconTrash size={14} />
            </button>
          </span>
        )}
      </div>
    )
  }
  return <span className="rr-tender-empty">—</span>
}
