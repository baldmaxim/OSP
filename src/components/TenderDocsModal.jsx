import { useEffect, useState } from 'react'
import { ESTIMATE_DEPT } from '../utils/estimateDept'
import {
  JOINT_GUIDE_SOURCE, JOINT_STEPS, JOINT_LONG_LIST, JOINT_PACKAGE,
  JOINT_INCOMING, JOINT_RULES, JOINT_CHECKLIST, JOINT_OPEN_QUESTIONS,
} from '../utils/jointTenderGuide'
import { IconMail, IconFolderTree, IconPhone } from './icons/ToolbarIcons'
import './TenderDocsModal.css'

// task 435: «Документы» раздела тендеров — три вкладки в одном окне:
//   Материалы    — шаблон письма, структура хранения, предпросмотр напоминания;
//   Инструкция   — порядок ведения тендера от запроса объекта до итогов;
//   Сотрудники СТО — сметно-технический отдел по направлениям работ.
//
// В направлении «Совместные тендеры» добавляется четвёртая вкладка со своей
// инструкцией (utils/jointTenderGuide.js). Она открывается там первой: правила
// совместных тендеров другие, и общая инструкция выше их не заменяет. На
// обычные тендеры эти правила не распространяются, поэтому вкладки в других
// направлениях нет.
//
// Инструкция намеренно свёрстана разметкой, а не данными: в ней списки,
// выделения и таблица, и держать это массивом было бы неудобнее, чем править.
// НОВЫЕ РАЗДЕЛЫ ИНСТРУКЦИИ добавлять в <section className="tdm-section"> ниже.

const TENDER_PACKAGE = [
  'Ведомость объёмов работ от сметно-технического отдела',
  'Рабочая документация',
  'Техническое задание',
  'Вендор-лист (при наличии)',
  'Шаблон договора',
  'Письмо для участия в тендере — на сайте создаётся автоматически, но проверьте, всё ли корректно',
]

const MATERIALS_STEPS = [
  'Создать ссылку на тендер',
  'Приложить ВОР только в части материалов',
  'Приложить рабочую документацию',
  'Приложить вендор-лист',
  'Направить ссылку в чат',
  'Указать срок проведения тендера на материалы',
]

const COUNTERPARTY_WORK = [
  'Проставить статус по каждому контрагенту: отказался, принял в работу или предоставил КП',
  'Указать в столбце «Примечания» последнюю актуальную информацию',
  'Обзвонить приглашённых контрагентов',
  'Зафиксировать предполагаемый срок предоставления КП',
  'При отказе указать причину отказа от участия',
]

const KP_FOLLOWUP = [
  'Отслеживает наличие замечаний',
  'Проверяет вкладку «Замечания: к отправке»',
  'Направляет замечания контрагенту',
  'Запрашивает исправленное коммерческое предложение',
  'Контролирует получение скорректированного КП',
  'Отвечает на вопросы контрагентов по тендеру',
  'Курирует все вопросы, связанные с проведением тендера и получением КП',
]

const DEADLINE_CONTROL = [
  'Уведомляет объект о завершении срока',
  'Направляет актуальный список участников',
  'Указывает, кто предоставил КП',
  'Указывает, кто отказался от участия',
  'Контролирует срок предоставления результатов тендера на материалы со стороны снабжения',
]

const TENDER_ANALYSIS = [
  'Анализирует сроки выполнения работ по графику производства работ с Заказчиком',
  'Анализирует договорные риски и зеркально отражает соответствующие условия в техническом задании',
  'Зеркально отражает в тендерной документации вендор-лист Заказчика или Застройщика',
]

export default function TenderDocsModal({
  onClose,
  onOpenLetterTemplate,
  onOpenStorageStructure,
  onOpenReminderPreview,
  canPreviewReminder = false,
  department = 'construction',
  initialTab,
}) {
  const isJoint = department === 'joint'
  // По кнопке «Документы» окно открывается как везде — на «Материалах»; на
  // инструкцию по совместным тендерам ведёт отдельная кнопка в шапке раздела
  // (initialTab='joint'), а её вкладка в любом случае стоит первой.
  const [tab, setTab] = useState(initialTab || 'materials')

  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay tdm-overlay" onClick={onClose}>
      <div className="modal tdm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="tdm-head">
          <div>
            <h3>Документы раздела</h3>
            <p className="tdm-sub">Материалы, порядок работы и контакты по тендерам</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="tdm-tabs" role="tablist">
          {[
            ...(isJoint ? [{ key: 'joint', label: 'Совместные тендеры' }] : []),
            { key: 'materials', label: 'Материалы' },
            { key: 'guide', label: 'Инструкция' },
            { key: 'sto', label: 'Сотрудники СТО' },
          ].map(t => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tdm-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >{t.label}</button>
          ))}
        </div>

        {/* ── Совместные тендеры ────────────────────────────────────────── */}
        {tab === 'joint' && (
          <div className="tdm-body tdm-body--guide">
            <section className="tdm-section tdm-section--wide tdm-section--plain">
              <h4 className="tdm-h4-plain">Совместные тендеры — инструкция инженеру СУ-10</h4>
              <p><b>Область применения:</b> {JOINT_GUIDE_SOURCE.scope}</p>
              <p className="tdm-note">
                {JOINT_GUIDE_SOURCE.disclaimer} Источник — файл «<span className="tdm-filename">{JOINT_GUIDE_SOURCE.file}</span>»,
                листы {JOINT_GUIDE_SOURCE.sheets.map(s => `«${s}»`).join(', ')}.
                Там, где источник молчит, в инструкции стоит оговорка — додумывать сроки и
                лимиты нельзя.
              </p>
            </section>

            <section className="tdm-section tdm-section--wide">
              <h4>Порядок работы</h4>
              <div className="tdm-table-wrap">
                <table className="tdm-table tdm-table--steps">
                  <thead>
                    <tr>
                      <th scope="col">№</th>
                      <th scope="col">Что делает инженер СУ-10</th>
                      <th scope="col">Срок / результат</th>
                    </tr>
                  </thead>
                  <tbody>
                    {JOINT_STEPS.rows.map(step => (
                      <tr key={step.n}>
                        <td className="tdm-td-num">{step.n}</td>
                        <td>{step.what}</td>
                        <td>
                          {step.when}
                          {step.unclear && <span className="tdm-unclear">Требует уточнения: {step.unclear}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tdm-src">Источник: {JOINT_STEPS.src}</p>
            </section>

            <section className="tdm-section">
              <h4>Длинный список участников</h4>
              <div className="tdm-table-wrap">
                <table className="tdm-table">
                  <thead>
                    <tr>
                      <th scope="col">Сумма закупки</th>
                      <th scope="col" className="tdm-th-num">Минимум компаний</th>
                    </tr>
                  </thead>
                  <tbody>
                    {JOINT_LONG_LIST.rows.map(row => (
                      <tr key={row.range}>
                        <td>{row.range}</td>
                        <td className="tdm-td-num">{row.min}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {JOINT_LONG_LIST.notes.map(note => (
                <p key={note} className="tdm-callout">{note}</p>
              ))}
              {JOINT_LONG_LIST.unclear.map(note => (
                <p key={note} className="tdm-note">{note}</p>
              ))}
              <p className="tdm-src">Источник: {JOINT_LONG_LIST.src}</p>
            </section>

            <section className="tdm-section">
              <h4>Документы</h4>
              <p className="tdm-label">{JOINT_PACKAGE.title}</p>
              <p>{JOINT_PACKAGE.lead}</p>
              <ol className="tdm-list">
                {JOINT_PACKAGE.rows.map(row => (
                  <li key={row.title}>
                    <b>{row.title}</b>{row.note ? ` — ${row.note}` : ''}
                  </li>
                ))}
              </ol>

              <p className="tdm-label">{JOINT_INCOMING.title}</p>
              <p>{JOINT_INCOMING.lead}</p>
              <div className="tdm-table-wrap">
                <table className="tdm-table">
                  <thead>
                    <tr>
                      <th scope="col">Документ</th>
                      <th scope="col">Требуемый вид</th>
                    </tr>
                  </thead>
                  <tbody>
                    {JOINT_INCOMING.rows.map(row => (
                      <tr key={row.doc}>
                        <td>{row.doc}</td>
                        <td>{row.form}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {JOINT_INCOMING.unclear.map(note => (
                <p key={note} className="tdm-note">{note}</p>
              ))}
              <p className="tdm-src">Источник: {JOINT_PACKAGE.src}; входящие документы — {JOINT_INCOMING.src}</p>
            </section>

            <section className="tdm-section">
              <h4>Ключевые правила</h4>
              {JOINT_RULES.rows.map(rule => (
                <div key={rule.title} className="tdm-rule">
                  <p className="tdm-rule-title">{rule.title}</p>
                  <p>{rule.text}</p>
                  {rule.unclear && <p className="tdm-note">{rule.unclear}</p>}
                </div>
              ))}
              <p className="tdm-src">Источник: {JOINT_RULES.src}</p>
            </section>

            <section className="tdm-section">
              <h4>Контроль инженера</h4>
              <p className="tdm-label">Перед запуском</p>
              <ul className="tdm-list tdm-list--check">
                {JOINT_CHECKLIST.before.map(item => <li key={item}>{item}</li>)}
              </ul>
              <p className="tdm-label">Перед завершением</p>
              <ul className="tdm-list tdm-list--check">
                {JOINT_CHECKLIST.after.map(item => <li key={item}>{item}</li>)}
              </ul>
              <p className="tdm-src">Источник: {JOINT_CHECKLIST.src}</p>
            </section>

            <section className="tdm-section tdm-section--wide">
              <h4>Что осталось неуточнённым</h4>
              <p>
                Эти места источник не закрывает. Портал их не додумывает: решение принимает
                инженер по регламенту или уточняет у Заказчика.
              </p>
              <ul className="tdm-list tdm-list--warn">
                {JOINT_OPEN_QUESTIONS.map(item => <li key={item}>{item}</li>)}
              </ul>
            </section>
          </div>
        )}

        {/* ── Материалы ─────────────────────────────────────────────────── */}
        {tab === 'materials' && (
          <div className="tdm-body">
            <p className="tdm-lead">
              Всё, что относится к работе с тендерами, но не к конкретному тендеру.
            </p>
            <div className="tdm-cards">
              <button type="button" className="tdm-card" onClick={onOpenLetterTemplate}>
                <span className="tdm-card-icon"><IconMail size={18} /></span>
                <span className="tdm-card-title">Шаблон письма</span>
                <span className="tdm-card-desc">
                  Текст запроса КП с подстановкой номера тендера, объекта и сроков
                </span>
              </button>

              <button type="button" className="tdm-card" onClick={onOpenStorageStructure}>
                <span className="tdm-card-icon"><IconFolderTree size={18} /></span>
                <span className="tdm-card-title">Структура хранения документов</span>
                <span className="tdm-card-desc">
                  Единый порядок папок в сетевом хранилище — куда класть файлы
                </span>
              </button>

              {canPreviewReminder && (
                <button type="button" className="tdm-card" onClick={onOpenReminderPreview}>
                  <span className="tdm-card-icon"><IconPhone size={18} /></span>
                  <span className="tdm-card-title">Напоминание об обзвоне</span>
                  <span className="tdm-card-desc">
                    Как выглядит вторничное окно у инженеров — предпросмотр
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Инструкция ────────────────────────────────────────────────── */}
        {tab === 'guide' && (
          <div className="tdm-body tdm-body--guide">
            <section className="tdm-section">
              <h4>Запуск тендера</h4>
              <p>
                В общий чат объекта в Telegram (например, «ЖК Примавера К14 Тендеры»)
                руководитель строительства пишет запрос на проведение тендерных процедур.
              </p>
              <p>
                Сметный отдел даёт сроки подготовки ведомостей объёмов работ (ВОР) и
                выполняет расчёт, после чего выкладывает ВОР в тот же чат. Отдел
                сопровождения подрядчиков (ОСП) готовит тендерный пакет и запускает
                тендер в работу.
              </p>
              <p className="tdm-callout">
                <b>Срок проведения тендерных процедур — 2 недели</b> с момента запуска.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Тендерный пакет</h4>
              <ol className="tdm-list">
                {TENDER_PACKAGE.map(item => <li key={item}>{item}</li>)}
              </ol>
            </section>

            <section className="tdm-section">
              <h4>Создание тендера на сайте</h4>
              <p>
                Инженер по тендеру создаёт тендер на сайте и заполняет все необходимые
                данные — для него формируется шаблон пригласительного письма для
                участия в тендере.
              </p>
              <p>
                Техническое задание составляется на основании ТЗ от Заказчика
                (генподряд) с последующей доработкой в ChatGPT.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Рассылка и участники</h4>
              <p>
                После создания заявки инженер по тендерам добавляет список участников
                (выбирает по видам работ) и делает рассылку со всеми документами.
                Затем сообщает в общий чат, что тендер запущен, и прикладывает список
                участников.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Тендер на материалы</h4>
              <p>
                Параллельно с основным тендером инженер запрашивает у снабжения
                проведение тендера на материалы — запрос размещается в чате
                «ОСП / Снабжение».
              </p>
              <p className="tdm-callout">
                <b>Срок проведения тендера на материалы — 1 неделя.</b>
              </p>
              <p className="tdm-label">Что приложить к запросу:</p>
              <ul className="tdm-list">
                {MATERIALS_STEPS.map(item => <li key={item}>{item}</li>)}
              </ul>
              <p className="tdm-note">
                Контактное лицо со стороны снабжения — <b>Смолина Ольга</b>.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Работа с приглашёнными контрагентами</h4>
              <ul className="tdm-list">
                {COUNTERPARTY_WORK.map(item => <li key={item}>{item}</li>)}
              </ul>
              <p className="tdm-note">
                Если <b>более половины</b> приглашённых участников отказались, инженер
                обязан расширить список контрагентов и пригласить дополнительных
                участников.
              </p>
              <p className="tdm-callout is-success">
                <b>Критерий успешного тендера:</b> получено более трёх коммерческих
                предложений.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Получение и сопровождение КП</h4>
              <p>
                Полученное коммерческое предложение инженер прикрепляет к
                соответствующему контрагенту. После этого КП попадает в раздел
                «Проверка КП» — на проверку аналитику-экономисту.
              </p>
              <p className="tdm-label">После проверки инженер по тендерам:</p>
              <ul className="tdm-list">
                {KP_FOLLOWUP.map(item => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section className="tdm-section">
              <h4>Сопровождение плана затрат</h4>
              <p>
                Одновременно с проведением тендера инженер курирует план затрат — он
                создаётся автоматически при регистрации тендера. В нём контролируются:
              </p>
              <ul className="tdm-list">
                <li>сумма, предусмотренная договором генподряда;</li>
                <li>стоимость предложений контрагентов;</li>
                <li>генподрядный процент по каждому предложению.</li>
              </ul>
              <p className="tdm-note">
                К каждому контрагенту прикладывается отчёт из Контур.Фокус. Доступ к
                сервису — через почту <b>tenderosp@gmail.com</b>.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Контроль сроков проведения тендера</h4>
              <p>При приближении срока завершения тендерных процедур инженер:</p>
              <ul className="tdm-list">
                {DEADLINE_CONTROL.map(item => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section className="tdm-section">
              <h4>Ведение реестра контрагентов</h4>
              <p>
                Инженер вносит в реестр контрагентов актуальную информацию: контактные
                данные, реквизиты и прочие сведения по контрагенту.
              </p>
            </section>

            <section className="tdm-section">
              <h4>Анализ условий тендера</h4>
              <ul className="tdm-list">
                {TENDER_ANALYSIS.map(item => <li key={item}>{item}</li>)}
              </ul>
            </section>
            {/* Новые разделы инструкции — сюда. */}
          </div>
        )}

        {/* ── Сотрудники СТО ────────────────────────────────────────────── */}
        {tab === 'sto' && (
          <div className="tdm-body">
            <p className="tdm-lead">{ESTIMATE_DEPT.title} — по направлениям работ.</p>

            <div className="tdm-leads">
              {[ESTIMATE_DEPT.head, ESTIMATE_DEPT.lead].map(p => (
                <div key={p.name} className="tdm-lead-card">
                  <span className="tdm-person">{p.name}</span>
                  <span className="tdm-role">{p.role}</span>
                </div>
              ))}
            </div>

            <p className="tdm-label">Подразделения</p>
            <div className="tdm-units">
              {ESTIMATE_DEPT.units.map(u => (
                <div key={u.title} className="tdm-unit">
                  <div className="tdm-unit-title">{u.title}</div>
                  {u.people.map(name => (
                    <div key={name} className="tdm-unit-person">
                      {name}
                      <span className="tdm-role">{ESTIMATE_DEPT.unitRole}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="tdm-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
