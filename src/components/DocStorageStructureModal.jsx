import { useMemo, useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'
import './DocStorageStructureModal.css'

// Эталонная структура папок для документов по договорам в сетевом хранилище.
// Справочник: показывает, куда класть файл, чтобы у всех получалось одинаково.
//
// Схема описана данными, а не картинкой: из неё же строится текстовый вариант
// для копирования (кнопка «Копировать схему»), и её можно править в одном месте.
//
// Две сквозные идеи структуры:
//  1. Имена папок начинаются с номера — проводник сортирует по имени, поэтому
//     номер удерживает порядок стадий и порядок заведения объектов/подрядчиков.
//  2. Договор и каждое ДС устроены одинаково: те же пять стадий согласования.

// Пять стадий — одинаковые и у самого договора, и у каждого ДС. В дереве
// показываются одной строкой-набором: пятнадцать одинаковых строк подряд
// (договор + два ДС) читались как шум и прятали саму структуру.
const STAGES = [
  { name: '01_Понятийное соглашение', hint: 'Понятийное соглашение и переписка по нему' },
  { name: '02_Входящие документы', hint: 'Что прислал подрядчик: его редакция, протокол разногласий' },
  { name: '03_Рабочая редакция', hint: 'Версии в работе: правки ОСП и юриста' },
  { name: '04_На подписание', hint: 'Финальная согласованная редакция, ушедшая на подпись' },
  { name: '05_Подписано ЭДО', hint: 'Подписанный оригинал, выгруженный из ЭДО' },
]

const stageChildren = () => STAGES.map(s => ({ name: s.name, kind: 'stage' }))

const contractNode = (name, dsList, extra = {}) => ({
  name,
  kind: 'contract',
  hint: 'Номер и дата — как в реестре договоров',
  ...extra,
  children: [
    {
      name: '00_ДОГОВОР',
      kind: 'group',
      hint: 'Сам договор (ДП)',
      stagesInline: true,
      children: stageChildren(),
    },
    {
      name: '01_ДОПОЛНИТЕЛЬНЫЕ СОГЛАШЕНИЯ',
      kind: 'group',
      hint: 'По папке на каждое ДС',
      children: [
        ...dsList.map(ds => ({
          name: ds,
          kind: 'ds',
          stagesInline: true,
          children: stageChildren(),
        })),
        { name: 'В РАБОТЕ', kind: 'special', hint: 'ДС без номера и даты; после подписания папку переименовывают' },
      ],
    },
    { name: '02_ПЕРЕПИСКА', kind: 'group', hint: 'Письма по договору вне конкретной стадии' },
    { name: '99_АРХИВ', kind: 'group', hint: 'Устаревшие версии и всё, что больше не используется' },
  ],
})

const TREE = [
  {
    name: '01_ЖК Алия',
    kind: 'object',
    hint: 'Номер по порядку + название, как в реестре объектов',
    children: [
      {
        name: '01_ООО «Подрядчик»',
        kind: 'counterparty',
        hint: 'Номер по порядку внутри объекта + название, как в карточке контрагента',
        children: [
          contractNode('Договор № СУ-10-001 от 01.03.2026', ['ДС №1 от 15.04.2026', 'ДС №2 от 20.06.2026']),
          // Второй договор того же подрядчика свёрнут: показывает, что папок
          // договоров может быть несколько, но не повторяет всю схему.
          contractNode('Договор № СУ-10-017 от 10.08.2026', ['ДС №1 от 01.09.2026'], { defaultCollapsed: true }),
        ],
      },
      {
        name: '02_ТОО «Второй подрядчик»',
        kind: 'counterparty',
        hint: 'Внутри объекта — та же структура',
        defaultCollapsed: true,
        children: [contractNode('Договор № СУ-10-004 от 12.03.2026', ['ДС №1 от 05.05.2026'])],
      },
    ],
  },
  {
    name: '02_ЖК Нурсая',
    kind: 'object',
    hint: 'Нумерация объектов сквозная и не меняется',
    defaultCollapsed: true,
    children: [
      {
        name: '01_ООО «Подрядчик»',
        kind: 'counterparty',
        hint: 'У каждого объекта своя нумерация подрядчиков — с 01',
        children: [contractNode('Договор № СУ-10-021 от 02.09.2026', ['ДС №1 от 01.10.2026'])],
      },
    ],
  },
]

const DEFAULT_ROOT = '\\\\192.168.2.55\\SharA_Tender\\СУБПОДРЯДЫ ДОГОВОРА И ДС'

// Текстовый вид схемы — та же псевдографика, что в служебных записках. Стадии
// в тексте разворачиваются полностью: в письме сворачивать нечего.
function toAscii(nodes, prefix = '') {
  let out = ''
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1
    out += `${prefix}${isLast ? '└── ' : '├── '}${node.name}\n`
    if (node.children?.length) out += toAscii(node.children, `${prefix}${isLast ? '    ' : '│   '}`)
  })
  return out
}

const collectCollapsed = (nodes, path = '', acc = new Set()) => {
  nodes.forEach((node, i) => {
    const key = `${path}/${i}-${node.name}`
    if (node.defaultCollapsed) acc.add(key)
    if (node.children) collectCollapsed(node.children, key, acc)
  })
  return acc
}

const IconFolderSm = () => (
  <svg className="dss-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)

function TreeNodes({ nodes, path, collapsed, onToggle }) {
  return (
    <ul className="dss-list">
      {nodes.map((node, i) => {
        const key = `${path}/${i}-${node.name}`
        // Стадии не сворачиваются: они показаны набором, а не ветками.
        const expandable = !!node.children?.length && !node.stagesInline
        const isCollapsed = collapsed.has(key)
        return (
          <li key={key} className={`dss-item dss-item--${node.kind}`}>
            <div className="dss-row">
              {expandable ? (
                <button
                  type="button"
                  className={`dss-toggle${isCollapsed ? ' is-collapsed' : ''}`}
                  onClick={() => onToggle(key)}
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? `Развернуть ${node.name}` : `Свернуть ${node.name}`}
                >▾</button>
              ) : (
                <span className="dss-toggle is-leaf" aria-hidden />
              )}
              <IconFolderSm />
              <span className="dss-name">{node.name}</span>
              {node.hint && <span className="dss-hint">{node.hint}</span>}
            </div>

            {node.stagesInline && (
              <div className="dss-stages" aria-label="Пять стадий согласования">
                {STAGES.map(s => <span key={s.name} className="dss-stage">{s.name}</span>)}
              </div>
            )}

            {expandable && !isCollapsed && (
              <TreeNodes nodes={node.children} path={key} collapsed={collapsed} onToggle={onToggle} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default function DocStorageStructureModal({ rootPath, onClose }) {
  const [collapsed, setCollapsed] = useState(() => collectCollapsed(TREE))
  const [copied, setCopied] = useState(false)
  const root = rootPath || DEFAULT_ROOT

  const asciiTree = useMemo(() => `${root}\n│\n${toAscii(TREE)}`, [root])

  const toggle = (key) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const handleCopy = async () => {
    const ok = await copyToClipboard(asciiTree)
    if (!ok) { alert('Не удалось скопировать схему. Выделите её и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dss-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dss-header">
          <div>
            <h3>Структура хранения документов</h3>
            <p className="dss-subtitle">
              Единый порядок папок в сетевом хранилище — одинаковый для всех объектов и подрядчиков
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="dss-body">
          <div className="dss-root">
            <span className="dss-root-label">Корень</span>
            <code className="dss-root-path">{root}</code>
          </div>

          <TreeNodes nodes={TREE} path="" collapsed={collapsed} onToggle={toggle} />

          <div className="dss-legend">
            <div className="dss-legend-head">Пять стадий — внутри договора и внутри каждого ДС</div>
            <ul className="dss-legend-list">
              {STAGES.map(s => (
                <li key={s.name}>
                  <span className="dss-stage">{s.name}</span>
                  <span className="dss-hint">{s.hint}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="dss-notes">
            <p><b>Почему всё пронумеровано.</b> Проводник сортирует по имени. Номер в начале удерживает
              объекты, подрядчиков и стадии в нужном порядке, а не по алфавиту.</p>
            <p><b>Номер закрепляется навсегда.</b> Новый объект или подрядчик получает следующий свободный;
              перенумеровывать существующие нельзя — у людей разъедутся ярлыки и ссылки на папки.</p>
            <p><b>Пока у ДС нет номера</b>, документы лежат в «В РАБОТЕ». После подписания папку
              переименовывают в «ДС №… от …» и оставляют рядом с остальными.</p>
          </div>
        </div>

        <div className="dss-footer">
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            {copied ? 'Схема скопирована' : 'Копировать схему'}
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
