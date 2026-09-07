import { useEffect } from 'react'
import './CostPlanInstructionModal.css'

// Инструкция по разделу «Планы затрат».
//
// Справочник для тех, кто считает план от сумм договора генподряда: правило
// знают на словах, и новичку его негде посмотреть.
//
// РАЗДЕЛЫ ДОБАВЛЯТЬ НИЖЕ, в <div className="cpi-body">, по образцу существующих
// (<section className="cpi-section"> с заголовком <h4>). Содержимое табличное и
// формульное, поэтому это обычная разметка, а не массив данных.

export default function CostPlanInstructionModal({ onClose }) {
  // Escape закрывает — модалка только для чтения, задерживать в ней незачем.
  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cpi-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cpi-head">
          <div>
            <h3>Инструкция по плану затрат</h3>
            <p className="cpi-sub">Как получить план затрат из сумм договора генподряда</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="cpi-body">
          <section className="cpi-section">
            <h4>Как считается план затрат</h4>
            <p className="cpi-rule">
              Итог плана затрат = <b>итог по договору генподряда ÷ 1,276</b>.
              Материалы переносятся в план как есть, всю разницу забирают работы.
            </p>

            <div className="cpi-table-wrap">
              <table className="cpi-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Договор генподряда</th>
                    <th>План затрат</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Материалы</th>
                    <td>100,00</td>
                    <td>100,00</td>
                  </tr>
                  <tr>
                    <th scope="row">Работы</th>
                    <td>100,00</td>
                    <td>56,74</td>
                  </tr>
                  <tr className="cpi-total">
                    <th scope="row">Итого</th>
                    <td>200,00</td>
                    <td>156,74</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="cpi-formula">
              <div>Итого плана: <code>200,00 ÷ 1,276 = 156,74</code></div>
              <div>Работы: <code>156,74 − 100,00 (материалы) = 56,74</code></div>
            </div>
          </section>

          <section className="cpi-section">
            <h4>Генподрядный коэффициент — 1,276</h4>
            <ul className="cpi-list">
              <li><b>ОФЗ — 16%</b>, общефирменные затраты</li>
              <li><b>ООЗ — 10%</b>, общеобъектные затраты</li>
            </ul>
            <div className="cpi-formula">
              <code>1,10 × 1,16 = 1,276</code>
            </div>
            <p className="cpi-warn">
              Множители <b>перемножаются, а не складываются</b>: сложение процентов
              дало бы 1,26, и план затрат разошёлся бы примерно на 1,3 тыс. на
              каждый миллион.
            </p>
          </section>
          {/* Новые разделы инструкции — сюда. */}
        </div>

        <div className="cpi-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
