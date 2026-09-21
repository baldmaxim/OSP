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

// К кому идти, когда расчёт не сходится. Отдельно от исполнителей выше: это
// эскалация, а не рабочая переписка по разбивке.
const ESCALATION = [
  {
    name: 'Одинцов Артем Андреевич',
    role: 'Руководитель тендерного отдела',
    when: 'Объёмы не совпадают или позиций нет в договоре генподряда',
  },
  {
    name: 'Могуев Алексей Павлович',
    role: 'Руководитель отдела по удорожанию',
    when: 'Туда же — отдел рассмотрит расчёт и при возможности подаст Заказчику на согласование',
  },
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
  // Вкладка «Сотрудники» — те же люди, что упомянуты в инструкции, одним
  // списком: чаще всего от инструкции нужно именно «к кому идти».
  const [tab, setTab] = useState('guide')

  // Escape закрывает — модалка только для чтения, задерживать в ней незачем.
  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay cpi-overlay" onClick={onClose}>
      <div className="modal cpi-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cpi-head">
          <div>
            <h3>Инструкция по плану затрат</h3>
            <p className="cpi-sub">Как получить план затрат из сумм договора генподряда</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="cpi-tabs" role="tablist">
          {[
            { key: 'guide', label: 'Инструкция' },
            { key: 'people', label: 'Сотрудники' },
          ].map(t => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`cpi-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >{t.label}</button>
          ))}
        </div>

        {tab === 'people' && (
          <div className="cpi-body cpi-body--people">
            <section className="cpi-section">
              <h4>Тендерный отдел — разбивка по видам работ</h4>
              <p className="cpi-rule">У них запрашивают расчёт с разбивкой по договору генподряда.</p>
              <ul className="cpi-people">
                {TENDER_DEPT.map(p => (
                  <li key={p.name}>
                    <span className="cpi-person">{p.name}</span>
                    <span className="cpi-person-note">{p.scope}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="cpi-section">
              <h4>Кому сообщать о расхождениях</h4>
              <ul className="cpi-people">
                {ESCALATION.map(p => (
                  <li key={p.name}>
                    <span className="cpi-person">{p.name}</span>
                    <span className="cpi-person-role">{p.role}</span>
                    <span className="cpi-person-note">{p.when}</span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="cpi-note">
              Сотрудники сметно-технического отдела — в разделе «Тендеры →
              Основное строительство», кнопка «Сотрудники СТО».
            </p>
          </div>
        )}

        {/* Именно условный рендер, а не атрибут hidden: у .cpi-body задан
            display:grid, и он перебивает display:none из hidden — обе вкладки
            показывались одновременно. */}
        {tab === 'guide' && (
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
            <p className="cpi-note">
              <b>Не получается найти позиции по тендерам?</b> Обращайтесь к
              ответственным инженерам тендерного отдела — список по видам работ
              выше и на вкладке «Сотрудники».
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

          <section className="cpi-section cpi-section--wide">
            <h4>Как считается план затрат</h4>
            <p className="cpi-rule">
              Итог плана затрат = <b>итог по договору генподряда ÷ 1,276</b>.
              Материалы переносятся в план как есть, всю разницу забирают работы.
            </p>

            {/* Материалы / работы / итого — по горизонтали: так две суммы одной
                строки (ДГП и план) стоят рядом и сравниваются взглядом. */}
            <div className="cpi-table-wrap">
              <table className="cpi-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Материалы</th>
                    <th>Работы</th>
                    <th className="cpi-total-col">Итого</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Договор генподряда</th>
                    <td>100,00</td>
                    <td>100,00</td>
                    <td className="cpi-total-col">200,00</td>
                  </tr>
                  <tr>
                    <th scope="row">План затрат</th>
                    <td>100,00</td>
                    <td>56,74</td>
                    <td className="cpi-total-col">156,74</td>
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
            <h4>Если объём не совпадает или позиций нет</h4>
            <p className="cpi-rule">
              Молча подгонять расчёт нельзя — сообщите обоим:
            </p>
            <div className="cpi-table-wrap">
              <table className="cpi-table cpi-table--left">
                <tbody>
                  {ESCALATION.map(p => (
                    <tr key={p.name}>
                      <th scope="row">
                        {p.name}
                        <span className="cpi-role">{p.role}</span>
                      </th>
                      <td>{p.when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cpi-note">
              <b>Отдел по удорожанию</b> занимается дополнительными соглашениями
              с Заказчиками: рассмотрит расчёт и при возможности подаст Заказчику
              на согласование.
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
        )}

        <div className="cpi-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
