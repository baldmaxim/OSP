import { formatAmount } from '../../utils/money'
import { IconFileCheck, IconFileDown, IconLetter } from '../icons/ActionIcons'
import { TENDER_MAILBOX } from '../../utils/bidMail'

// Сводка расценки по ведомостям ВОР (решение пользователя 24.11.2026: расценка по каждому ВОР видна сразу, как только у подрядчика
// есть доступ к тендеру).
// 27.11.2026 (просьба пользователя: «слишком много информации, подрядчик теряется — сделать такой же простой вид, как в „Сравнении
// КП“»): вместо плиток — одна таблица, как сводная матрица «Сравнения КП»: строка на ведомость (материалы, работы, итого), внизу —
// ИТОГО по всем ВОР и ставка НДС. Неполная сумма — мягким тёплым тоном (сколько расценено — в подсказке ячейки: «без цены N» уже есть
// у вкладок и над таблицей позиций). Скачать — значками без текста слева в строке: «файл ↓» — исходный ВОР отдела, бирюзовый «файл ✓» —
// он же с вашими ценами; в строке ИТОГО те же значки скачивают все ВОР одним ZIP (каждый своим файлом). Имена кнопок для диктора и
// поиска — прежние. Крупный блок «КП нужно зафиксировать письмом» свёрнут в одну строку под таблицей. На телефоне строка — карточкой:
// значки и название, под ними суммы с подписями (data-label) — «Итого» видно без прокрутки вбок.
// Строка выбирает ведомость для таблицы позиций ниже. Отдел обновил ВОР — «что изменилось» под названием; новая версия, которую отдел
// ещё не подтвердил, — серой строкой, в итог не входит.

const dateOf = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

// Сумма вида работ ведомости (или всех): s = { items, priced, total }.
function KindCell({ s, label }) {
  if (!s.items) return <td className="num bid-vs-num is-empty" data-label={label} title={`${label}: позиций нет`}>—</td>
  const incomplete = s.priced < s.items
  return (
    <td className={`num bid-vs-num${incomplete ? ' is-incomplete' : ''}`} data-label={label}
      title={incomplete ? `${label}: без цены ${s.items - s.priced} из ${s.items} поз. — сумма неполная` : `${label}: расценены все ${s.items} поз.`}>
      {formatAmount(s.total)}
    </td>
  )
}

function TotalCell({ s, label }) {
  const items = s.material.items + s.work.items
  const priced = s.material.priced + s.work.priced
  return (
    <td className={`num bid-vs-num bid-vs-sum${s.incomplete ? ' is-incomplete' : ''}`} data-label={label}
      title={s.incomplete ? `Без цены ${items - priced} из ${items} поз. — итог неполный` : undefined}>
      {formatAmount(s.total)}
    </td>
  )
}

const progressText = (busy) => (busy?.total ? `Собираем архив ВОР: ${busy.done} из ${busy.total}…` : 'Готовим архив ВОР…')

// vat: null (поля НДС в анкете нет) | { missing: true } | { label, value } — ставка и «в т. ч.» для строки под итогом.
export default function BidVorSummary({
  rows, total, selected, onSelect, changes, held, files, vatExempt, vat = null, onPickVat, mailHref = `mailto:${TENDER_MAILBOX}`,
  onDownload, onDownloadPriced, onDownloadAll, onDownloadAllPriced, busy = null, pricedReady = false, pricedHint = '',
}) {
  const fileById = new Map(files.map((f) => [f.id, f]))
  const totalLabel = vatExempt ? 'Итого без НДС' : 'Итого с НДС'
  const anyBusy = !!busy
  const busyOne = busy?.kind === 'one' ? fileById.get(busy.id) : null
  return (
    <section className="bid-vs-wrap" aria-label="Ведомости ВОР">
      <div className="bid-vs-scroll">
        <table className="bid-vs-table">
          <colgroup>
            <col className="bid-vs-w-dl" /><col /><col className="bid-vs-w-money" /><col className="bid-vs-w-money" /><col className="bid-vs-w-money" />
          </colgroup>
          <thead>
            <tr>
              <th className="bid-vs-dl"><span className="bid-sr-only">Скачать</span></th>
              <th>ВОР</th>
              <th className="num">Материалы, ₽</th>
              <th className="num">Работы, ₽</th>
              <th className="num">{totalLabel}, ₽</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ch = changes.get(r.id)
              const heldBy = held.get(r.id)
              const isSel = selected === r.id
              const f = fileById.get(r.id)
              const oneBusy = busy?.kind === 'one' && busy.id === r.id
              const changed = ch && ch.counts.added + ch.counts.removed + ch.counts.volume + ch.counts.unit > 0
              return (
                <tr key={r.id} className={`bid-vs-row${isSel ? ' is-selected' : ''}${heldBy ? ' is-held' : ''}`}>
                  <td className="bid-vs-dl">
                    {f && (
                      <span className="bid-vs-dl-btns">
                        {/* Имена кнопок не входят одно в другое: поиск по имени (и экранный диктор) их не путает. */}
                        <button type="button" className="bid-dl is-source is-icon" aria-label={`Исходный ВОР «${f.file_name}»`}
                          title="Скачать исходный ВОР — файл отдела, как загружен на сайт, без ваших цен" onClick={() => onDownload(f)}>
                          <IconFileDown size={16} />
                        </button>
                        {!heldBy && (
                          <button type="button" className="bid-dl is-priced is-icon" aria-label={`Расценённый ВОР «${f.file_name}»`}
                            aria-busy={oneBusy || undefined}
                            title={pricedReady ? 'Скачать расценённый ВОР — файл отдела с вашими ценами, посчитанными итогами и анкетой' : pricedHint}
                            disabled={anyBusy || !pricedReady} onClick={() => onDownloadPriced(f)}>
                            <IconFileCheck size={16} />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="bid-vs-name">
                    <button type="button" className="bid-vs-pick" aria-pressed={isSel} onClick={() => onSelect(isSel ? '' : r.id)}
                      title={isSel ? 'Показать позиции всех ведомостей' : 'Показать позиции только этой ведомости'}>
                      {r.title}
                    </button>
                    {heldBy && (
                      <span className="bid-vs-badge is-wait">
                        Похоже на новую версию «{heldBy}» — ждёт подтверждения отдела, пока не расценивается
                      </span>
                    )}
                    {changed && (
                      <span className="bid-vs-badge is-changed">
                        Отдел обновил ВОР{dateOf(ch.at) ? ` ${dateOf(ch.at)}` : ''}:
                        {ch.counts.added > 0 && ` новых ${ch.counts.added}`}
                        {ch.counts.removed > 0 && ` · убрано ${ch.counts.removed}`}
                        {ch.counts.volume + ch.counts.unit > 0 && ` · изменено ${ch.counts.volume + ch.counts.unit}`}
                      </span>
                    )}
                  </td>
                  {heldBy ? (
                    <td colSpan={3} className="bid-vs-held-note">не входит в итог</td>
                  ) : (
                    <>
                      <KindCell s={r.material} label="Материалы" />
                      <KindCell s={r.work} label="Работы" />
                      <TotalCell s={r} label={totalLabel} />
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="bid-vs-total">
              <td className="bid-vs-dl">
                <span className="bid-vs-dl-btns">
                  <button type="button" className="bid-dl is-source is-icon" aria-label="Скачать все исходные ВОР"
                    aria-busy={busy?.kind === 'all' || undefined} disabled={anyBusy || !files.length} onClick={onDownloadAll}
                    title="Скачать все исходные ВОР — файлы отдела без ваших цен, одним ZIP-архивом (каждая ведомость — своим файлом)">
                    <IconFileDown size={16} />
                  </button>
                  <button type="button" className="bid-dl is-priced is-icon" aria-label="Скачать все расценённые ВОР"
                    aria-busy={busy?.kind === 'priced' || undefined} disabled={anyBusy || !pricedReady} onClick={onDownloadAllPriced}
                    title={pricedReady
                      ? 'Скачать все расценённые ВОР — каждый в оформлении отдела с вашими ценами, итогами и анкетой, одним ZIP-архивом'
                      : pricedHint}>
                    <IconFileCheck size={16} />
                  </button>
                </span>
              </td>
              <td className="bid-vs-total-name">
                {selected
                  ? <button type="button" className="bid-vs-pick" onClick={() => onSelect('')} title="Показать позиции всех ведомостей">ИТОГО по всем ВОР</button>
                  : 'ИТОГО по всем ВОР'}
              </td>
              <KindCell s={total.material} label="Материалы" />
              <KindCell s={total.work} label="Работы" />
              <TotalCell s={total} label={totalLabel} />
            </tr>
            {vat && (
              <tr className={`bid-vs-vat${vat.missing ? ' is-missing' : ''}`}>
                <td />
                <td colSpan={3}>
                  {vat.missing
                    ? <button type="button" className="bid-vs-vat-pick" onClick={onPickVat}>Ставка НДС не указана — выбрать в анкете</button>
                    : `НДС: ${vat.label}`}
                </td>
                <td className="num">{vat.missing ? '' : vat.value}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {anyBusy && (
        <div className="bid-vs-status" role="status">
          {busyOne ? `Готовим расценённый ВОР «${busyOne.file_name}»…` : progressText(busy)}
        </div>
      )}
      {/* КП фиксируется письмом на почту отдела (просьба пользователя 25.11.2026) — одной строкой (27.11.2026). */}
      <p className="bid-vs-mail" role="note">
        <IconLetter size={16} />
        <span>
          <b>КП зафиксируйте письмом:</b> скачайте расценённые ВОР <IconFileCheck size={14} /> и отправьте их на <a href={mailHref}>{TENDER_MAILBOX}</a>
        </span>
      </p>
    </section>
  )
}
