import { useEffect, useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'
import './CostPlanInstructionModal.css'

// Путь к сетевой папке с кнопкой копирования. Открыть проводник по клику из
// браузера нельзя (Chrome и Edge блокируют file:// и UNC со страницы по https),
// поэтому путь копируют и вставляют в адресную строку проводника.
function FolderPath({ path }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    const ok = await copyToClipboard(path)
    if (!ok) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="cpi-path">
      <code>{path}</code>
      <button type="button" onClick={handleCopy}>{copied ? 'Скопировано' : 'Копировать'}</button>
    </div>
  )
}

// Ответственные тендерного отдела по видам работ — у кого запрашивать разбивку.
const TENDER_DEPT = [
  { name: 'Луис Дженс', scope: 'Общестрой, ПОС, монолит, благоустройство' },
  { name: 'Шанин Роман', scope: 'Отделка' },
  { name: 'Зинин Вячеслав', scope: 'Фасады' },
  { name: 'Сапожникова Ксения', scope: 'ОВиВК' },
  { name: 'Топчий Анна', scope: 'ЭОМ, СС' },
]

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
            <h4>С чего начать</h4>
            <p className="cpi-rule">
              Договор генподряда чаще всего заключается на комплекты — этажи и
              подобное. <b>Перед расчётом запросите у тендерного отдела расчёт с
              разбивкой</b>: считать по комплекту, не разложив его на позиции,
              не получится.
            </p>
            <p className="cpi-label">Разбивка тендерного отдела лежит здесь:</p>
            <FolderPath path="\\192.168.2.55\SharA_Tender\Отдел Субподряда\4.1. Планы затрат" />

            <p className="cpi-label">У кого запрашивать — по видам работ:</p>
            <div className="cpi-table-wrap">
              <table className="cpi-table cpi-table--left">
                <tbody>
                  {TENDER_DEPT.map(p => (
                    <tr key={p.name}>
                      <th scope="row">{p.name}</th>
                      <td>{p.scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cpi-section">
            <h4>Что такое план затрат</h4>
            <p className="cpi-rule">
              Это поиск аналогичных позиций в договоре генподряда (с
              Заказчиком/Застройщиком) и сопоставление <b>один к одному</b>.
            </p>
            <p className="cpi-label">Сверять обязательно:</p>
            <ul className="cpi-list">
              <li>
                <b>Объёмы.</b> Заказчик потенциально может забрать завышенные
                объёмы — расхождение видно только при сверке позиция к позиции.
              </li>
              <li><b>Итоговые суммы.</b></li>
            </ul>
          </section>

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

          <section className="cpi-section">
            <h4>На что ещё обратить внимание</h4>
            <ul className="cpi-list">
              <li>
                <b>Ставка НДС.</b> Подписал ли заказчик дополнительное соглашение
                на её изменение? Некоторые заказчики вместо компенсации 2%
                компенсировали только 1%.
              </li>
              <li>
                <b>Инфляция по объекту.</b> Есть ли она на этом объекте — по
                ЖК INJOY точно есть.
              </li>
            </ul>
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
