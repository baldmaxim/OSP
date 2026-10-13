import WebLinkCell from './WebLinkCell'

// «Путь к Signal» у записи реестра — ссылка на документы в общем хранилище.
// Вид, переход по клику, копирование и правка — общие с «Путём к Larix.CPM»,
// см. WebLinkCell.

// Облако — «общее хранилище», отличается от иконки папки у соседнего пути.
const IconCloud = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </svg>
)

export default function SignalLinkCell({
  addLabel = 'путь к Signal',
  placeholder = 'https://… ссылка на папку договора в Signal',
  ...props
}) {
  return <WebLinkCell {...props} name="Signal" icon={IconCloud} addLabel={addLabel} placeholder={placeholder} />
}
