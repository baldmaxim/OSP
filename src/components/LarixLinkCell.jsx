import WebLinkCell from './WebLinkCell'
import { LARIX_NAME } from '../utils/contractLarix'

// «Путь к Larix.CPM» у договора или ДС — ссылка на карточку документа в Larix.
// Вносится так же, как «Путь к Signal» (общий WebLinkCell). По заполненности
// этого пути определяется, внесён ли договор в Larix, — см. utils/contractLarix.js.

// Карточка со строками — «запись в учётной системе»; отличается от папки и облака
// у соседних путей.
const IconRecord = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h10" />
    <path d="M7 13h10" />
    <path d="M7 17h5" />
  </svg>
)

export default function LarixLinkCell({
  addLabel = `путь к ${LARIX_NAME}`,
  placeholder = 'https://cpm.su10.larix.ru/contract/…',
  ...props
}) {
  return <WebLinkCell {...props} name={LARIX_NAME} icon={IconRecord} addLabel={addLabel} placeholder={placeholder} />
}
