import { IconFileText } from '../icons/ToolbarIcons'
import { isWebLink } from '../../utils/kpRegistrySources'

// Колонка «Документ» реестра «Расценки от снабжения СУ-10» (миграция 20270227): значок счёта без текста — зелёный, если к
// расценке привязана ссылка на счёт (открывается в новой вкладке: это адрес страницы, а не файл портала), красный — ссылки
// нет. Цвет — не единственный признак: подпись в title и aria-label. Нажатие на ссылку строку не раскрывает.
export default function SupplyInvoiceCell({ url }) {
  if (isWebLink(url)) {
    return (
      <a className="rr-invoice is-linked" href={url} target="_blank" rel="noopener noreferrer"
        title={`Счёт: ${url}`} aria-label="Открыть счёт (в новой вкладке)" onClick={(e) => e.stopPropagation()}>
        <IconFileText size={16} />
      </a>
    )
  }
  return (
    <span className="rr-invoice is-missing" role="img" aria-label="Ссылки на счёт нет" title="Ссылки на счёт нет">
      <IconFileText size={16} />
    </span>
  )
}
