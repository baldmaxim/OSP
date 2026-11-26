import { formatAmount } from '../../utils/money'
import { IconFileCheck, IconFileDown, IconLetter } from '../icons/ActionIcons'
import { TENDER_MAILBOX } from '../../utils/bidMail'

// Сводка расценки по ведомостям ВОР (решение пользователя 24.11.2026: расценка по каждому ВОР видна сразу, как только у подрядчика
// есть доступ к тендеру). С 25.11.2026 (просьба пользователя: «название ВОРа, а снизу три стоимости», ведомости рядом, с промежутком,
// «чтобы не сливались в кашу») — плитка на ведомость: название, под ним материалы, работы, итого и сколько позиций расценено; неполная
// сумма — мягким тёплым тоном (не кислотно-жёлтым). Плитка выбирает ведомость для таблицы позиций ниже.
// Позже 25.11.2026 (вторая просьба): название крупнее и темнее; плиток не больше 5 в ряд, меньше — растягиваются на ряд; итог по всем ВОР —
// не полосой, а столбиком (материалы, работы, итог, НДС), рядом — крупный блок «КП нужно зафиксировать письмом»; «Исходный ВОР» (файл
// отдела, как загружен) и «Расценённый ВОР» (тот же файл с вашими ценами) — разными кнопками: исходный — серой рамкой, расценённый —
// бирюзовой заливкой и своим значком; над плитками — «Скачать все исходные ВОР» и «Скачать все расценённые ВОР» (ZIP, каждый ВОР своим
// файлом). Отдел обновил ВОР — «что изменилось»; новая версия, которую отдел ещё не подтвердил, — серой плиткой, в итог не входит.

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

// Итог ведомости (или всех): сумма и сколько позиций расценено из всех.
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
  rows, total, selected, onSelect, changes, held, files, vatExempt, vatSlot = null, mailHref = `mailto:${TENDER_MAILBOX}`,
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
          <button type="button" className="bid-dl is-source is-big" onClick={onDownloadAll} disabled={anyBusy || !files.length}
            title="Все ведомости отдела как загружены на сайт, без ваших цен: ZIP-архив, каждая — своим файлом">
            <IconFileDown size={16} />
            <span>{busy?.kind === 'all' ? progressText(busy) : 'Скачать все исходные ВОР'}</span>
          </button>
          <button type="button" className="bid-dl is-priced is-big" onClick={onDownloadAllPriced} disabled={anyBusy || !pricedReady}
            title={pricedReady
              ? 'Каждый ВОР — своим файлом в оформлении отдела, с вашими ценами, посчитанными итогами и анкетой; все — одним ZIP-архивом'
              : pricedHint}>
            <IconFileCheck size={16} />
            <span>{busy?.kind === 'priced' ? progressText(busy) : 'Скачать все расценённые ВОР'}</span>
          </button>
        </div>
      </div>

      <div className="bid-vs-head">
        {/* Итог по всем ВОР — столбиком, как в плитке (просьба пользователя 25.11.2026); ставка НДС — здесь же. */}
        <div className={`bid-vs-total${selected ? ' is-clickable' : ''}`}>
          <div className="bid-vs-total-name">
            {selected
              ? <button type="button" className="bid-vs-pick" onClick={() => onSelect('')} title="Показать позиции всех ведомостей">ИТОГО по всем ВОР</button>
              : <b>ИТОГО по всем ВОР</b>}
          </div>
          <div className="bid-vs-sums">
            <KindLine s={total.material} label="Материалы" />
            <KindLine s={total.work} label="Работы" />
            <TotalLine s={total} label={totalLabel} />
          </div>
          {vatSlot}
        </div>

        {/* КП фиксируется письмом на почту отдела (просьба пользователя 25.11.2026); крупно — вторая просьба того же дня. */}
        <div className="bid-vs-mail" role="note">
          <div className="bid-vs-mail-title"><IconLetter size={20} /><span>КП нужно зафиксировать письмом</span></div>
          <ol className="bid-vs-mail-steps">
            <li>Скачайте все расценённые ВОР — кнопка «Скачать все расценённые ВОР» выше.</li>
            <li>Отправьте файлы на <a href={mailHref}>{TENDER_MAILBOX}</a></li>
          </ol>
          <p className="bid-vs-mail-note">Цены на сайте сохраняются сами и сразу видны отделу, письмо фиксирует ваше предложение.</p>
        </div>
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
                  {/* Имена кнопок не входят одно в другое: поиск по имени (и экранный диктор) их не путает. */}
                  <button type="button" className="bid-dl is-source" aria-label={`Исходный ВОР «${f.file_name}»`}
                    title="Файл ВОР отдела, как загружен на сайт, — без ваших цен" onClick={() => onDownload(f)}>
                    <IconFileDown size={15} />
                    <span>Исходный ВОР</span>
                  </button>
                  {!heldBy && (
                    <button type="button" className="bid-dl is-priced" aria-label={`Расценённый ВОР «${f.file_name}»`}
                      title={pricedReady ? 'Этот ВОР в оформлении отдела — с вашими ценами, посчитанными итогами и анкетой' : pricedHint}
                      disabled={anyBusy || !pricedReady} onClick={() => onDownloadPriced(f)}>
                      <IconFileCheck size={15} />
                      <span>{oneBusy ? 'Готовим…' : 'Расценённый ВОР'}</span>
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
