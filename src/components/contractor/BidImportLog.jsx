import { formatAmount } from '../../utils/money'

// Что сделала загрузка «Цен из файла» (просьба пользователя 25.11.2026: «если подрядчик свои ВОРы закинет, расценки не сбросятся; выбор —
// заменять позиции или нет; вернуть при необходимости старые, в том числе кнопка „вернуть всё“ или „заменить всё“»). Страница помнит, какая
// цена стояла у позиции до загрузки (old; null — цены не было) и какая в файле (file): у позиций, где цены различаются, можно вернуть свою
// или взять цену файла — по одной и все разом; «Отменить загрузку целиком» возвращает прежние и убирает новые цены. Разом меняются только
// позиции, которые после загрузки не правили руками (их цена — ровно прежняя или ровно из файла), — ручную правку кнопки «всё» не затирают.
// Список — в браузере (localStorage, по тендеру и организации; в просмотре от имени подрядчика — только на странице): в базе истории цен нет.

const stateOf = (x, rates) => {
  const cur = rates.get(x.key)?.price ?? null
  if (cur === x.file) return 'file'
  if (x.old ? cur === x.old.price : cur == null) return 'old'
  return 'other'
}
const timeOf = (v) => {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const money = (v) => `${formatAmount(v)} ₽`

export default function BidImportLog({ log, rates, canEdit, busy = false, onRestore, onHide }) {
  const items = log.items || []
  const conflicts = items.filter((x) => x.old)
  const fresh = items.filter((x) => !x.old)
  const by = (list, st) => list.filter((x) => stateOf(x, rates) === st)
  const conflictFile = by(conflicts, 'file')
  const conflictOld = by(conflicts, 'old')
  const freshFile = by(fresh, 'file')
  const freshOld = by(fresh, 'old')
  const n = log.files?.length || 0
  const plural = n % 10 === 1 && n % 100 !== 11 ? 'файл' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'файла' : 'файлов'
  const files = n === 1 ? `«${log.files[0]}»` : `(${n} ${plural})`

  const undoAll = () => {
    const n = conflictFile.length + freshFile.length
    if (!n) return
    if (!window.confirm(`Отменить загрузку целиком: вернуть ваши прежние цены (${conflictFile.length}) и убрать новые цены из файла (${freshFile.length})?`)) return
    onRestore([...conflictFile, ...freshFile], 'old')
  }
  const hide = () => {
    if (window.confirm('Скрыть список? Вернуть прежние цены этой загрузки потом будет нельзя.')) onHide()
  }

  return (
    <section className="bid-import-log" aria-label="Цены из файла: ваши прежние цены">
      <div className="bid-import-log-head">
        <span className="bid-import-log-text">
          <b>{n === 1 ? 'Цены из файла' : 'Цены из файлов'}</b> {files}{log.at ? ` · ${timeOf(log.at)}` : ''}: новых цен — {fresh.length},
          {' '}у {conflicts.length} поз. ваша цена и цена файла различаются (сейчас из файла — {conflictFile.length}, ваши — {conflictOld.length}).
        </span>
        <span className="bid-import-log-acts">
          {canEdit && (
            <>
              <button type="button" className="cab-btn" disabled={busy || !conflictFile.length} onClick={() => onRestore(conflictFile, 'old')}>
                Вернуть все мои прежние цены ({conflictFile.length})
              </button>
              <button type="button" className="cab-btn" disabled={busy || !(conflictOld.length + freshOld.length)}
                onClick={() => onRestore([...conflictOld, ...freshOld], 'file')}>
                Заменить всё ценами файла ({conflictOld.length + freshOld.length})
              </button>
              <button type="button" className="bid-link" disabled={busy || !(conflictFile.length + freshFile.length)} onClick={undoAll}>
                Отменить загрузку целиком
              </button>
            </>
          )}
          <button type="button" className="bid-link" onClick={hide}>Скрыть</button>
        </span>
      </div>
      {conflicts.length > 0 && (
        <details className="bid-import-log-list">
          <summary>Позиции, где ваша цена и цена файла различаются: {conflicts.length}</summary>
          <ul>
            {conflicts.map((x) => {
              const st = stateOf(x, rates)
              const cur = rates.get(x.key)?.price ?? null
              return (
                <li key={x.key} className={`is-${st}`}>
                  <span className="bid-import-log-name">{x.name}{x.unit ? `, ${x.unit}` : ''}</span>
                  <span className="bid-import-log-prices">
                    ваша прежняя {money(x.old.price)} · из файла {money(x.file)}
                    {' — '}
                    <b>{st === 'file' ? 'стоит цена файла' : st === 'old' ? 'стоит ваша' : cur == null ? 'цена убрана' : `сейчас ${money(cur)}`}</b>
                  </span>
                  {canEdit && (
                    <span className="bid-import-log-row-acts">
                      {st !== 'old' && (
                        <button type="button" className="bid-link" disabled={busy} onClick={() => onRestore([x], 'old')}>вернуть {money(x.old.price)}</button>
                      )}
                      {st !== 'file' && (
                        <button type="button" className="bid-link" disabled={busy} onClick={() => onRestore([x], 'file')}>взять из файла {money(x.file)}</button>
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </section>
  )
}
