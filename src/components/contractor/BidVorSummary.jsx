import { formatAmount } from '../../utils/money'
import { IconDownload } from '../icons/ActionIcons'

// Сводка расценки по ведомостям ВОР (решение пользователя 24.11.2026: расценка по каждому ВОР видна сразу, как только у подрядчика
// есть доступ к тендеру): строка на ведомость — материалы, работы, итого, сколько позиций расценено; итог неполный — жёлтым, как в
// «Сравнении КП». Строка выбирает ведомость для таблицы позиций ниже. Отдел обновил ВОР — «что изменилось»; новая версия, которую
// отдел ещё не подтвердил, — серой строкой, в итог не входит.

const dateOf = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

function KindCell({ s, label }) {
  const incomplete = s.items > 0 && s.priced < s.items
  if (!s.items) return <td className="num bid-vs-cell is-empty">—</td>
  return (
    <td className={`num bid-vs-cell${incomplete ? ' is-incomplete' : ''}`}
      title={incomplete ? `${label}: без цены ${s.items - s.priced} поз. — сумма неполная` : undefined}>
      <span className="bid-vs-money">{formatAmount(s.total)}</span>
      <span className="bid-vs-count">{s.priced} из {s.items}</span>
    </td>
  )
}

export default function BidVorSummary({ rows, total, selected, onSelect, changes, held, files, onDownload, vatExempt }) {
  const fileById = new Map(files.map((f) => [f.id, f]))
  return (
    <div className="bid-vs-wrap">
      <table className="bid-vs">
        <colgroup><col /><col className="bid-vs-w" /><col className="bid-vs-w" /><col className="bid-vs-w" /><col className="bid-vs-w-act" /></colgroup>
        <thead>
          <tr>
            <th>Ведомость ВОР</th>
            <th className="num">Материалы, ₽</th>
            <th className="num">Работы, ₽</th>
            <th className="num">{vatExempt ? 'Итого без НДС, ₽' : 'Итого с НДС, ₽'}</th>
            <th aria-label="Файл ВОР" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ch = changes.get(r.id)
            const heldBy = held.get(r.id)
            const isSel = selected === r.id
            const f = fileById.get(r.id)
            return (
              <tr key={r.id} className={`bid-vs-row${isSel ? ' is-selected' : ''}${heldBy ? ' is-held' : ''}`}>
                <td className="bid-vs-name">
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
                </td>
                {heldBy ? (
                  <td colSpan={3} className="bid-vs-cell is-empty">не входит в итог</td>
                ) : (
                  <>
                    <KindCell s={r.material} label="Материалы" />
                    <KindCell s={r.work} label="Работы" />
                    <td className={`num bid-vs-cell bid-vs-total${r.incomplete ? ' is-incomplete' : ''}`}>
                      <span className="bid-vs-money">{formatAmount(r.total)}</span>
                      {r.incomplete && <span className="bid-vs-count">не все позиции</span>}
                    </td>
                  </>
                )}
                <td className="bid-vs-act">
                  {f && (
                    <button type="button" className="bid-icon-btn" aria-label={`Скачать ВОР «${f.file_name}»`} title="Скачать файл ВОР отдела"
                      onClick={() => onDownload(f)}>
                      <IconDownload size={16} />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className={selected ? 'is-clickable' : undefined}>
            <td className="bid-vs-name">
              {selected
                ? <button type="button" className="bid-vs-pick" onClick={() => onSelect('')}>ИТОГО по всем ВОР</button>
                : <b>ИТОГО по всем ВОР</b>}
            </td>
            <KindCell s={total.material} label="Материалы" />
            <KindCell s={total.work} label="Работы" />
            <td className={`num bid-vs-cell bid-vs-total${total.incomplete ? ' is-incomplete' : ''}`}>
              <span className="bid-vs-money">{formatAmount(total.total)}</span>
              {total.incomplete && <span className="bid-vs-count">не все позиции</span>}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
