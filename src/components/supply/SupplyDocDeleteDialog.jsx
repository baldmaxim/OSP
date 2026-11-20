import { useEffect, useRef } from 'react'
import { formatAmount } from '../../utils/money'

// Удаление файла счёта / КП (19.11.2026, просьба пользователя: «когда убираю счёт, как снять цены, которые из него
// проставлялись»). Вместо подтверждения браузера: файл можно удалить один или вместе с ценами, поставленными из него.
// ask — { doc, used — у скольких позиций он документ, offered — сколько его строк предлагалось, prices — цены из него
// [{ key, name, estimate, unit, price }] или null (файл не прочитан — какие цены из него, неизвестно), later — снять цены
// можно будет и после удаления (таблица следов есть, миграция 20270223), dupeOf — имя оставленного файла, если удаляют повтор
// (цены не предлагаются: те же строки остаются у оставленного файла) }. busy — { text } во время работы; error — текст отказа.
// onConfirm(withPrices), onClose. Окно открывается поверх окон «Счета и КП» и «Документ»: Escape закрывает только его.
export default function SupplyDocDeleteDialog({ ask, busy = null, error = '', onConfirm, onClose }) {
  const cancelRef = useRef(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!busyRef.current) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  if (!ask) return null
  const { doc, used, offered, prices, later, dupeOf } = ask
  const n = prices?.length || 0
  const manyVors = n > 0 && new Set(prices.map((p) => p.estimate)).size > 1
  return (
    <div className="sp-modal-backdrop sp-modal-backdrop-top" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="sp-modal sp-modal-wide" role="alertdialog" aria-modal="true" aria-labelledby="sp-docdel-title" aria-describedby="sp-docdel-text">
        <h3 id="sp-docdel-title">Удалить файл?</h3>
        <p className="sp-modal-item">{doc.file_name}</p>
        <div id="sp-docdel-text" className="sp-modal-body">
          {used > 0 && <p>Он документ у позиций этого тендера: <b className="ui-num">{used}</b> — у них документа не станет.</p>}
          {offered > 0 && !dupeOf && <p>Его цены (строк: <span className="ui-num">{offered}</span>) больше не будут предлагаться.</p>}
          <p className="sp-muted">Если цену брали в другие тендеры вместе с этим файлом, там документ тоже пропадёт, цена останется.</p>
          {n > 0 && (
            <>
              <p>
                Из него поставлены цены: <b className="ui-num">{n}</b>.{' '}
                {later
                  ? 'Их можно снять сейчас или позже — в окне «Счета и КП», в строке удалённого файла.'
                  : 'Снять их можно только сейчас: после удаления файла расценка не будет знать, какие цены были из него.'}
              </p>
              <ul className="sp-docdel-list" aria-label="Цены, поставленные из файла">
                {prices.map((p) => (
                  <li key={p.key}>
                    <span className="sp-docdel-name">{p.name}{manyVors ? <span className="sp-muted"> · {p.estimate}</span> : null}</span>
                    <span className="ui-num">{formatAmount(p.price)} ₽{p.unit ? ` за ${p.unit}` : ''}</span>
                  </li>
                ))}
              </ul>
              <p className="sp-muted">Цены, которые после применения правили вручную, в список не входят и останутся. Снятие записывается в журнал — цену можно вернуть из истории.</p>
            </>
          )}
          {prices === null && used > 0 && (
            <p>Файл не прочитан, поэтому какие цены взяты из него, определить нельзя — цены останутся, снять их можно в таблице.</p>
          )}
          {dupeOf && <p>Это повтор файла «{dupeOf}»: цены остаются — те же строки есть в оставленном файле.</p>}
          {prices !== null && n === 0 && used > 0 && !dupeOf && (
            <p>Цен, которые совпадают с его строками, сейчас нет — цены позиций останутся.</p>
          )}
          {error && <p className="sp-error-text" role="alert">{error}</p>}
          {busy && <p className="sp-muted" role="status">{busy.text}</p>}
        </div>
        <div className="sp-modal-actions">
          <button ref={cancelRef} type="button" className="btn-secondary" onClick={onClose} disabled={!!busy}>Отмена</button>
          <button type="button" className={n > 0 ? 'btn-secondary' : 'sp-btn-danger'} onClick={() => onConfirm(false)} disabled={!!busy}>
            {n > 0 ? 'Удалить только файл' : 'Удалить файл'}
          </button>
          {n > 0 && (
            <button type="button" className="sp-btn-danger" onClick={() => onConfirm(true)} disabled={!!busy}>
              Удалить файл и снять цены: {n}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
