import { formatAmount } from '../../utils/money'
import { IconDownload } from '../icons/ActionIcons'
import { TENDER_MAILBOX } from '../../utils/bidMail'

// Сводка расценки по ведомостям ВОР (решение пользователя 24.11.2026: расценка по каждому ВОР видна сразу, как только у подрядчика
// есть доступ к тендеру). С 25.11.2026 (просьба пользователя: «название ВОРа, а снизу три стоимости», ведомости рядом, с промежутком,
// «чтобы не сливались в кашу») — плитка на ведомость: название, под ним материалы, работы, итого и сколько позиций расценено; неполная
// сумма — жёлтым, как в «Сравнении КП». Плитка выбирает ведомость для таблицы позиций ниже. Итог по всем ВОР — полосой над плитками.
// Отдел обновил ВОР — «что изменилось»; новая версия, которую отдел ещё не подтвердил, — серой плиткой, в итог не входит.
// Скачать: у плитки — файл отдела и он же с вашими ценами; над плитками — все ВОР архивом (каждый своим файлом), так же с ценами.

const dateOf = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

function KindLine({ s, label }) {
  if (!s.items) {
    return (
      <div className="bid-vs-line is-empty">
        <span className="bid-vs-label">{label}</span>
        <span className="bid-vs-money">—</span>
        <span className="bid-vs-count" />
      </div>
    )
  }
  const incomplete = s.priced < s.items
  return (
    <div className={`bid-vs-line${incomplete ? ' is-incomplete' : ''}`}
      title={incomplete ? `${label}: без цены ${s.items - s.priced} поз. — сумма неполная` : undefined}>
      <span className="bid-vs-label">{label}</span>
      <span className="bid-vs-money">{formatAmount(s.total)}</span>
      <span className="bid-vs-count">{s.priced} из {s.items}</span>
    </div>
  )
}

// Итог ведомости (или всех): сумма и сколько позиций расценено из всех — короче прежнего «не все позиции» и помещается в плитку.
function TotalLine({ s, label }) {
  const priced = s.material.priced + s.work.priced
  const items = s.material.items + s.work.items
  return (
    <div className={`bid-vs-line bid-vs-line-total${s.incomplete ? ' is-incomplete' : ''}`}
      title={s.incomplete ? `Без цены ${items - priced} поз. — итог неполный` : undefined}>
      <span className="bid-vs-label">{label}</span>
      <span className="bid-vs-money">{formatAmount(s.total)}</span>
      <span className="bid-vs-count">{items ? `${priced} из ${items}` : ''}</span>
    </div>
  )
}

const progressText = (busy) => (busy?.total ? `Собираем ${busy.done} из ${busy.total}…` : 'Готовим…')

export default function BidVorSummary({
  rows, total, selected, onSelect, changes, held, files, vatExempt, mailHref = `mailto:${TENDER_MAILBOX}`,
  onDownload, onDownloadPriced, onDownloadAll, onDownloadAllPriced, busy = null, pricedReady = false, pricedHint = '',
}) {
  const fileById = new Map(files.map((f) => [f.id, f]))
  const totalLabel = vatExempt ? 'Итого без НДС' : 'Итого с НДС'
  const anyBusy = !!busy
  return (
    <section className="bid-vs-wrap" aria-label="Ведомости ВОР">
      <div className="bid-vs-bar">
        <h3 className="bid-vs-title">Ведомости ВОР <span className="bid-vs-n">{rows.length}</span></h3>
        <div className="bid-vs-bar-acts">
          <button type="button" className="cab-btn bid-vs-all" onClick={onDownloadAll} disabled={anyBusy || !files.length}
            title="Все ведомости отдела одним ZIP-архивом, каждая — своим файлом, как загружена на сайт">
            <IconDownload size={14} />
            <span>{busy?.kind === 'all' ? progressText(busy) : 'Скачать все ВОР'}</span>
          </button>
          <button type="button" className="cab-btn bid-vs-all" onClick={onDownloadAllPriced} disabled={anyBusy || !pricedReady}
            title={pricedReady
              ? 'Каждый ВОР — своим файлом в оформлении отдела, с вашими ценами и анкетой на «Главном листе»; все — одним ZIP-архивом'
              : pricedHint}>
            <IconDownload size={14} />
            <span>{busy?.kind === 'priced' ? progressText(busy) : 'Скачать все ВОР с моими ценами'}</span>
          </button>
        </div>
      </div>

      {/* Просьба пользователя 25.11.2026: КП фиксируется письмом на почту отдела; адрес — ссылкой, письмо открывается с темой. */}
      <p className="bid-vs-mail">
        <b>КП нужно зафиксировать письмом</b> на <a href={mailHref}>{TENDER_MAILBOX}</a>: приложите файлы ВОР с вашими ценами
        (кнопка «Скачать все ВОР с моими ценами»). Цены на сайте сохраняются сами, письмо фиксирует ваше предложение.
      </p>

      <div className={`bid-vs-total${selected ? ' is-clickable' : ''}`}>
        <div className="bid-vs-total-name">
          {selected
            ? <button type="button" className="bid-vs-pick" onClick={() => onSelect('')} title="Показать позиции всех ведомостей">ИТОГО по всем ВОР</button>
            : <b>ИТОГО по всем ВОР</b>}
        </div>
        <KindLine s={total.material} label="Материалы" />
        <KindLine s={total.work} label="Работы" />
        <TotalLine s={total} label={totalLabel} />
      </div>

      <ul className="bid-vs">
        {rows.map((r) => {
          const ch = changes.get(r.id)
          const heldBy = held.get(r.id)
          const isSel = selected === r.id
          const f = fileById.get(r.id)
          const oneBusy = busy?.kind === 'one' && busy.id === r.id
          return (
            <li key={r.id} className={`bid-vs-row${isSel ? ' is-selected' : ''}${heldBy ? ' is-held' : ''}`}>
              <div className="bid-vs-name">
                <button type="button" className="bid-vs-pick" aria-pressed={isSel} onClick={() => onSelect(isSel ? '' : r.id)}
                  title={isSel ? 'Показать все ведомости' : 'Показать позиции этой ведомости'}>
                  {r.title}
                </button>
                {heldBy && (
                  <span className="bid-vs-badge is-wait">
                    Похоже на новую версию «{heldBy}» — ждёт подтверждения отдела, пока не расценивается и в итог не входит
                  </span>
                )}
                {ch && (ch.counts.added + ch.counts.removed + ch.counts.volume + ch.counts.unit > 0) && (
                  <span className="bid-vs-badge is-changed">
                    Отдел обновил ВОР{dateOf(ch.at) ? ` ${dateOf(ch.at)}` : ''}:
                    {ch.counts.added > 0 && ` новых ${ch.counts.added}`}
                    {ch.counts.removed > 0 && ` · убрано ${ch.counts.removed}`}
                    {ch.counts.volume + ch.counts.unit > 0 && ` · изменено ${ch.counts.volume + ch.counts.unit}`}
                  </span>
                )}
              </div>
              {heldBy ? (
                <div className="bid-vs-sums"><div className="bid-vs-line is-empty"><span className="bid-vs-label">не входит в итог</span></div></div>
              ) : (
                <div className="bid-vs-sums">
                  <KindLine s={r.material} label="Материалы" />
                  <KindLine s={r.work} label="Работы" />
                  <TotalLine s={r} label={totalLabel} />
                </div>
              )}
              {f && (
                <div className="bid-vs-acts">
                  <button type="button" className="bid-vs-dl" aria-label={`Скачать ВОР «${f.file_name}»`} title="Файл ВОР отдела, как загружен на сайт"
                    onClick={() => onDownload(f)}>
                    <IconDownload size={14} />
                    <span>ВОР</span>
                  </button>
                  {/* Имя кнопки с ценами — не продолжение «Скачать ВОР «…»»: поиск по имени (и экранный диктор) их не путает. */}
                  {!heldBy && (
                    <button type="button" className="bid-vs-dl" aria-label={`С моими ценами — ВОР «${f.file_name}»`}
                      title={pricedReady ? 'Этот ВОР в оформлении отдела — с вашими ценами и анкетой' : pricedHint}
                      disabled={anyBusy || !pricedReady} onClick={() => onDownloadPriced(f)}>
                      <IconDownload size={14} />
                      <span>{oneBusy ? 'Готовим…' : 'С моими ценами'}</span>
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
