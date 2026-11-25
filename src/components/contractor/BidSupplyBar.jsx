// Цены снабжения СУ-10 в кабинете подрядчика (решение пользователя 24.11.2026): подрядчик может взять нашу цену материала вместо
// своей, но только после того, как отдел это разрешил. Состояние разрешения — строка tender_bid_supply_access своей организации
// (миграция 20270301); нет таблицы — блока нет. С 25.11.2026 (миграция 20270303) инженер открывает цены по позициям: withPrice —
// сколько позиций открыто (цены других база не отдаёт).

const dateOf = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}
const DAY = 24 * 60 * 60 * 1000

export default function BidSupplyBar({
  access, canEdit, withPrice, missing, differ, withDocs = 0, busy, message, error, onRequest, onRefresh, onTakeMissing, onTakeAll,
}) {
  if (access === undefined) return null
  const status = access?.status || null
  const canAskAgain = status === 'denied' && (!access.decided_at || Date.now() - new Date(access.decided_at).getTime() > DAY)
  let tone = ''
  let body
  if (status === 'granted') {
    tone = ' is-granted'
    body = withPrice > 0 ? (
      <>
        <span className="bid-supply-text">
          <b>Отдел открыл цены снабжения СУ-10</b> у {withPrice} поз. материалов (с НДС и доставкой).
          {' '}Цену можно взять у каждой позиции в колонке «Цена СУ-10» или сразу у всех.
          {withDocs > 0 && ' У взятой цены — ссылка «счёт»: счёт или КП поставщика, по которому снабжение её поставило.'}
        </span>
        {canEdit && (
          <span className="bid-supply-actions">
            {missing > 0 && (
              <button type="button" className="cab-btn cab-btn-primary" disabled={busy} onClick={onTakeMissing}>
                Взять для позиций без цены ({missing})
              </button>
            )}
            {differ > 0 && (
              <button type="button" className="cab-btn" disabled={busy} onClick={onTakeAll}>
                Заменить мои цены ({differ})
              </button>
            )}
          </span>
        )}
      </>
    ) : (
      <span className="bid-supply-text">
        <b>Отдел разрешил цены снабжения СУ-10</b>, но открытых позиций с ценой снабжения сейчас нет.
        {' '}<button type="button" className="bid-link" onClick={onRefresh} disabled={busy}>Проверить ещё раз</button>
      </span>
    )
  } else if (status === 'requested') {
    tone = ' is-wait'
    body = (
      <span className="bid-supply-text">
        Просьба взять цены снабжения отправлена{dateOf(access.requested_at) ? ` ${dateOf(access.requested_at)}` : ''} — ждёт решения отдела.
        {' '}<button type="button" className="bid-link" onClick={onRefresh} disabled={busy}>Проверить</button>
      </span>
    )
  } else if (status === 'denied') {
    body = (
      <span className="bid-supply-text">
        Отдел не разрешил брать цены снабжения в этом тендере{dateOf(access.decided_at) ? ` (${dateOf(access.decided_at)})` : ''}.
        {canEdit && canAskAgain && <> <button type="button" className="bid-link" onClick={onRequest} disabled={busy}>Попросить снова</button></>}
      </span>
    )
  } else {
    body = (
      <>
        <span className="bid-supply-text">
          <b>Цены снабжения СУ-10 на материалы.</b> Отдел может разрешить взять наши цены материалов — тогда не придётся искать свои.
        </span>
        {canEdit && (
          <span className="bid-supply-actions">
            <button type="button" className="cab-btn" disabled={busy} onClick={onRequest}>Попросить разрешение</button>
          </span>
        )}
      </>
    )
  }
  return (
    <div className={`bid-supply${tone}`} role="region" aria-label="Цены снабжения">
      {body}
      {(message || error) && <span className={`bid-supply-note${error ? ' is-error' : ''}`} role="status">{error || message}</span>}
    </div>
  )
}
