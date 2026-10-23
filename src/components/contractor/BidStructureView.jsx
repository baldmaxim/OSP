import { useMemo, useRef, useState } from 'react'
import VirtualTableBody from '../VirtualTableBody'
import { formatAmount } from '../../utils/money'
import { priceStructure } from '../../utils/bidVor'

// Лист «КП» файла ВОР — только просмотр: разделы, работы и материалы под ними, цены подрядчика из списков
// «Материалы» / «Работы» и суммы — как формулы листа «КП» в Excel. Вносить в него ничего не нужно.

const VIRTUAL_FROM = 300
const fmtVolume = (v) => (v == null ? '' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }))
const money = (v) => (v == null ? '' : formatAmount(v))

export default function BidStructureView({ files, rates }) {
  const withKp = files.filter((f) => f.parsed.structure?.length)
  const [fileId, setFileId] = useState(null)
  const current = withKp.find((f) => f.id === fileId) || withKp[0] || null
  const scrollRef = useRef(null)

  const prices = useMemo(() => {
    const m = new Map()
    for (const [k, r] of rates) if (r.price != null) m.set(k, r.price)
    return m
  }, [rates])
  const data = useMemo(() => (current ? priceStructure(current.parsed.structure, prices) : null), [current, prices])

  if (!withKp.length) {
    return <div className="bid-state">В файлах ВОР нет листа «КП» со структурой — расценивайте по спискам «Материалы» и «Работы».</div>
  }

  const rows = data.rows
  const renderRow = (i) => {
    const r = rows[i]
    if (r.type === 'section') {
      return (
        <tr key={i} className={`bid-kp-section lvl-${Math.min(r.level, 3)}`}>
          <td>{r.num}</td>
          <td colSpan={6} className="bid-kp-name">{r.name}</td>
          <td className="num">{money(r.materials)}</td>
          <td className="num">{money(r.works)}</td>
          <td className="num">{money(r.materials + r.works)}</td>
        </tr>
      )
    }
    const isWork = r.kind === 'work'
    return (
      <tr key={i} className={`bid-kp-${r.kind}${r.price == null ? ' is-empty' : ''}`}>
        <td>{r.num}</td>
        <td className="bid-kp-code">{r.code || (isWork ? 'Работа' : 'Мат')}</td>
        <td className="bid-kp-name">{r.name}</td>
        <td>{r.unit}</td>
        <td className="num">{fmtVolume(r.volume)}</td>
        <td className="num">{isWork ? '' : (r.price == null ? 'нет цены' : money(r.price))}</td>
        <td className="num">{isWork ? (r.price == null ? 'нет цены' : money(r.price)) : ''}</td>
        <td className="num">{isWork ? '' : money(r.total)}</td>
        <td className="num">{isWork ? money(r.total) : ''}</td>
        <td className="num">{money(r.total)}</td>
      </tr>
    )
  }

  const big = rows.length > VIRTUAL_FROM
  return (
    <div className="bid-table-block">
      <div className="bid-filters">
        {withKp.length > 1 && (
          <select className="bid-select" value={current.id} onChange={(e) => setFileId(e.target.value)} aria-label="Файл ВОР">
            {withKp.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <span className="bid-filters-total">
          расценено {data.totals.priced} из {data.totals.items} строк · материалы {money(data.totals.materials)} ₽ ·
          работы {money(data.totals.works)} ₽ · итого {money(data.totals.materials + data.totals.works)} ₽
        </span>
      </div>
      <p className="bid-muted">Структура листа «КП» для понимания предложения: цены подставляются из вкладок «Материалы» и «Работы», менять здесь ничего не нужно.</p>
      <div className={`bid-table-wrap${big ? ' is-scroll' : ''}`} ref={scrollRef}>
        <table className="bid-table bid-kp-table">
          <colgroup>
            <col className="bid-w-num" /><col className="bid-w-code" /><col /><col className="bid-w-unit" /><col className="bid-w-vol" />
            <col className="bid-w-sum" /><col className="bid-w-sum" />
            <col className="bid-w-sum" /><col className="bid-w-sum" /><col className="bid-w-sum" />
          </colgroup>
          <thead>
            <tr>
              <th>№</th><th>Код</th><th>Наименование</th><th>Ед. изм.</th><th className="num">Объём</th>
              <th className="num">Цена мат., ₽</th><th className="num">Цена СМР, ₽</th>
              <th className="num">Стоим. мат., ₽</th><th className="num">Стоим. СМР, ₽</th><th className="num">Итого, ₽</th>
            </tr>
          </thead>
          {big ? (
            <VirtualTableBody rowCount={rows.length} renderRow={renderRow} colSpan={10} scrollRef={scrollRef} rowHeight={34} />
          ) : (
            <tbody>{rows.map((_, i) => renderRow(i))}</tbody>
          )}
        </table>
      </div>
    </div>
  )
}
