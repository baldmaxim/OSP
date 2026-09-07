import { useMemo, useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'
import './DocStorageStructureModal.css'

// Эталонная структура папок для документов по договорам в сетевом хранилище.
// Справочник: показывает, куда класть файл, чтобы у всех получалось одинаково.
//
// Схема описана данными, а не картинкой: из неё же строится текстовый вариант
// для копирования (кнопка «Копировать схему»), и её можно править в одном месте.
//
// Ключевая идея нумерации: имена папок начинаются с числа, поэтому проводник
// сортирует их по порядку стадии согласования, а не по алфавиту.

// Пять стадий согласования — одинаковые и у самого договора, и у каждого ДС.
const STAGES = [
  { name: '01_Понятийное соглашение', hint: 'Понятийное соглашение и переписка по нему' },
  { name: '02_Входящие документы', hint: 'Что прислал подрядчик: его редакция, протокол разногласий' },
  { name: '03_Рабочая редакция', hint: 'Версии в работе: правки ОСП и юриста' },
  { name: '04_На подписание', hint: 'Финальная согласованная редакция, ушедшая на подпись' },
  { name: '05_Подписано ЭДО', hint: 'Подписанный оригинал, выгруженный из ЭДО' },
]

const contractNode = (name, dsList, extra = {}) => ({
  name,
  kind: 'contract',
  hint: 'Номер и дата — как в реестре договоров',
  ...extra,
  children: [
    { name: '00_ДОГОВОР', kind: 'group', hint: 'Сам договор (ДП)', children: STAGES.map(s => ({ ...s, kind: 'stage' })) },
    {
      name: '01_ДОПОЛНИТЕЛЬНЫЕ СОГЛАШЕНИЯ',
      kind: 'group',
      hint: 'По папке на каждое ДС, внутри те же пять стадий',
      children: [
        ...dsList.map(ds => ({
          name: ds,
          kind: 'ds',
          children: STAGES.map(s => ({ ...s, kind: 'stage' })),
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
    name: 'ОБЪЕКТ',
    kind: 'object',
    hint: 'Название — как в реестре объектов',
    children: [
      {
        name: 'ООО "Подрядчик"',
        kind: 'counterparty',
        hint: 'Название — как в карточке контрагента',
        children: [
          contractNode('Договор № СУ-10-001 от 01.03.2026', ['ДС №1 от 15.04.2026', 'ДС №2 от 20.06.2026']),
          // Второй договор того же подрядчика свёрнут: он показывает, что папок
          // договоров может быть несколько, но повторять всю схему незачем.
          contractNode('Договор № СУ-10-017 от 10.08.2026', ['ДС №1 от 01.09.2026'], { defaultCollapsed: true }),
        ],
      },
    ],
  },
]

const DEFAULT_ROOT = '\\\\192.168.2.55\\SharA_Tender\\СУБПОДРЯДЫ ДОГОВОРА И ДС'

// Текстовый вид схемы — тот же псевдографический формат, что в служебных записках.
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

function TreeNodes({ nodes, path, collapsed, onToggle }) {
  return (
    <ul className="dss-list">
      {nodes.map((node, i) => {
        const key = `${path}/${i}-${node.name}`
        const hasChildren = !!node.children?.length
        const isCollapsed = collapsed.has(key)
        return (
          <li key={key} className={`dss-item dss-item--${node.kind}`}>
            <div className="dss-row">
              {hasChildren ? (
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
              <span className="dss-name">{node.name}</span>
              {node.hint && <span className="dss-hint">— {node.hint}</span>}
            </div>
            {hasChildren && !isCollapsed && (
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
              Единый порядок папок в сетевом хранилище: одинаковый для всех объектов и подрядчиков
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

          <div className="dss-notes">
            <p><b>Почему папки пронумерованы.</b> Проводник сортирует по имени, поэтому номер в начале
              удерживает папки в порядке стадий согласования, а не по алфавиту.</p>
            <p><b>Договор и ДС устроены одинаково.</b> У каждого дополнительного соглашения свои пять
              стадий — искать документ по ДС нужно там же, где по основному договору.</p>
            <p><b>Пока у ДС нет номера</b>, документы лежат в «В РАБОТЕ»; после подписания папку
              переименовывают в «ДС №… от …» и переносят рядом с остальными.</p>
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
