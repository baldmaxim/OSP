import { useMemo, useState } from 'react'
import { formatDecimal } from '../../utils/psdcWorkbook'

// Просмотр строк ПСДЦ (только чтение). Значения — из базы, текстом; фронт ничего
// не пересчитывает. compare — результат psdc_compare: подсветка новых и
// изменённых строк и список исчезнувших позиций предыдущей редакции.

const PAGE = 400

const FIELD_LABEL = {
  number: '№ п/п', resource_type: 'Тип ресурса', code: 'Шифр', customer_material: 'ДМ', cost_item: 'Статья затрат',
  name: 'Наименование', unit: 'Ед. изм.', consumption_norm: 'Норма расхода', volume: 'Объём',
  material_price: 'Цена за материал', work_price: 'Цена за работу', material_cost: 'Стоимость материала',
  work_cost: 'Стоимость работы', total_cost: 'Общая стоимость', manufacturer: 'Завод-изготовитель',
  materials: 'Применяемые материалы', work_location: 'Место работ', comment: 'Комментарий', legacy_deleted: 'deleted',
}

function PsdcRowsTable({ rows, compare = null, onlyChanges = false }) {
  const [limit, setLimit] = useState(PAGE)
  const diff = useMemo(() => compare?.rows || {}, [compare])

  const visible = useMemo(() => {
    if (!onlyChanges || !compare) return rows
    return rows.filter((r) => diff[r.id] && diff[r.id].status !== 'same')
  }, [rows, onlyChanges, compare, diff])

  const changed = (row, field) => diff[row.id]?.status === 'changed' && diff[row.id].fields.includes(field)
  const cellCls = (row, field, base = '') => `${base}${changed(row, field) ? ' is-changed' : ''}`

  return (
    <div className="psdc-rows">
      <div className="psdc-rows-scroll">
        <table className="psdc-rows-table">
          <thead>
            <tr>
              <th>№ п/п</th>
              <th>Тип ресурса</th>
              <th>Шифр</th>
              <th>ДМ</th>
              <th className="psdc-col-name">Наименование</th>
              <th>Ед. изм.</th>
              <th className="num">Норма расхода</th>
              <th className="num">Объём</th>
              <th className="num">Цена мат.</th>
              <th className="num">Стоимость мат.</th>
              <th className="num">Цена работ</th>
              <th className="num">Стоимость работ</th>
              <th className="num">Ед. расценка</th>
              <th className="num">Общая стоимость</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, limit).map((row) => {
              const status = diff[row.id]?.status
              const rowCls = [
                row.row_kind === 'section' ? 'is-section' : '',
                row.legacy_deleted ? 'is-deleted' : '',
                status === 'new' ? 'is-new' : '',
                !row.row_kind ? 'is-unknown' : '',
              ].filter(Boolean).join(' ')
              return (
                <tr key={row.id} className={rowCls} title={row.legacy_deleted ? 'Строка помечена deleted и не участвует в расчёте' : undefined}>
                  <td className={cellCls(row, 'number', 'mono')}>{row.number}</td>
                  <td className={cellCls(row, 'resource_type')}>{row.resource_type}</td>
                  <td className={cellCls(row, 'code')}>{row.code}</td>
                  <td className={cellCls(row, 'customer_material')}>{row.is_customer_material ? 'ДМ' : row.customer_material}</td>
                  <td
                    className={cellCls(row, 'name', 'psdc-col-name')}
                    title={status === 'changed' ? `Изменено: ${diff[row.id].fields.map((f) => FIELD_LABEL[f] || f).join(', ')}` : undefined}
                  >
                    {row.name}
                    {status === 'new' && <span className="psdc-diff-tag is-new">новая</span>}
                    {row.legacy_deleted && <span className="psdc-diff-tag is-deleted">deleted</span>}
                  </td>
                  <td className={cellCls(row, 'unit')}>{row.unit}</td>
                  <td className={cellCls(row, 'consumption_norm', 'num')}>{formatDecimal(row.consumption_norm, 2)}</td>
                  <td className={cellCls(row, 'volume', 'num')}>{formatDecimal(row.volume, 5)}</td>
                  <td className={cellCls(row, 'material_price', 'num')}>{formatDecimal(row.material_price)}</td>
                  <td className={cellCls(row, 'material_cost', `num${row.is_customer_material ? ' is-info' : ''}`)} title={row.is_customer_material ? 'Давальческий материал: в итог не входит' : undefined}>
                    {formatDecimal(row.material_cost)}
                  </td>
                  <td className={cellCls(row, 'work_price', 'num')}>{formatDecimal(row.work_price)}</td>
                  <td className={cellCls(row, 'work_cost', 'num')}>{formatDecimal(row.work_cost)}</td>
                  <td className="num">{formatDecimal(row.unit_price)}</td>
                  <td className={cellCls(row, 'total_cost', 'num strong')}>{formatDecimal(row.total_cost)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {visible.length > limit && (
        <button type="button" className="btn-secondary psdc-more" onClick={() => setLimit((n) => n + PAGE)}>
          Показать ещё {Math.min(PAGE, visible.length - limit)} из {visible.length - limit}
        </button>
      )}
      {compare?.removed?.length > 0 && (
        <div className="psdc-removed">
          <div className="psdc-removed-title">Нет в новой редакции ({compare.removed.length})</div>
          <ul>
            {compare.removed.slice(0, 200).map((r, i) => (
              <li key={`${r.number}-${i}`}>
                <span className="mono">{r.number}</span> {r.name} {r.total_cost != null && <span className="num">{formatDecimal(r.total_cost)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {compare && (
        <p className="psdc-hint">
          Сравнение с предыдущей ПСДЦ ветки справочное: строки сопоставляются по ID строки, а без него — по № п/п и
          наименованию. Изменённые ячейки подсвечены, список изменений строки — во всплывающей подсказке наименования.
        </p>
      )}
    </div>
  )
}

export default PsdcRowsTable
