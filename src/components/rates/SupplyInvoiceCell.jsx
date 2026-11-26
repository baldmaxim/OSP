import { IconFileText } from '../icons/ToolbarIcons'
import { isWebLink } from '../../utils/kpRegistrySources'
import { fmtMoscowDate } from '../../utils/ratesRegistry'

// Колонка «Документ» реестра «Расценки от снабжения СУ-10» (миграция 20270227): значок счёта без текста — зелёный, если к
// расценке привязана ссылка на счёт (открывается в новой вкладке: это адрес страницы, а не файл портала), красный — ссылки
// нет. Цвет — не единственный признак: подпись в title и aria-label. Нажатие на ссылку строку не раскрывает.
// Строка счёта / КП, загруженного в тендер (миграция 20270306): docFile — { name, deletedAt }. Файл есть — зелёная кнопка,
// открывает просмотр файла портала (onOpenFile); файл удалён из тендера — красный значок с датой удаления.
export default function SupplyInvoiceCell({ url, docFile = null, onOpenFile = null }) {
  if (docFile) {
    if (docFile.deletedAt) {
      const text = `Файл удалён из тендера ${fmtMoscowDate(docFile.deletedAt)}: «${docFile.name || 'без имени'}»`
      return (
        <span className="rr-invoice is-missing" role="img" aria-label={text} title={text}>
          <IconFileText size={16} />
        </span>
      )
    }
    return (
      <button type="button" className="rr-invoice is-linked" title={`Файл: ${docFile.name || 'без имени'}`}
        aria-label={`Открыть файл «${docFile.name || 'без имени'}»`}
        onClick={(e) => { e.stopPropagation(); onOpenFile?.() }}>
        <IconFileText size={16} />
      </button>
    )
  }
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
