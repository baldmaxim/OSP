import { useMemo, useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'
import './DocStorageStructureModal.css'

// Справочник по структуре папок в сетевом хранилище: показывает, куда класть
// файл, чтобы у всех получалось одинаково. Приложение папки не создаёт и не
// читает — из браузера нет доступа к SMB-шаре, это документация.
//
// Сама схема приходит пропом `structure` из
// [docStorageStructures.js](src/utils/docStorageStructures.js) — своя на каждый
// раздел (договоры, тендеры). Здесь только показ: дерево описано данными, из тех
// же данных строится текст для кнопки «Копировать схему», поэтому картинка и
// копия не расходятся.

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

const nodeKey = (path, i, node) => `${path}/${i}-${node.name}`

const collectKeys = (nodes, path = '', acc = new Set(), onlyDefaultCollapsed = true) => {
  nodes.forEach((node, i) => {
    const key = nodeKey(path, i, node)
    if (node.children?.length && (!onlyDefaultCollapsed || node.defaultCollapsed)) acc.add(key)
    if (node.children) collectKeys(node.children, key, acc, onlyDefaultCollapsed)
  })
  return acc
}

const plural = (n, one, few, many) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
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
        const key = nodeKey(path, i, node)
        const expandable = !!node.children?.length
        const isCollapsed = collapsed.has(key)
        const count = node.children?.length || 0
        // Строка целиком работает как переключатель: попадать в маленькую
        // стрелку курсором неудобно, а других действий у строки нет.
        const RowTag = expandable ? 'button' : 'div'
        return (
          <li key={key} className={`dss-item dss-item--${node.kind}`}>
            <RowTag
              className="dss-row"
              {...(expandable
                ? {
                  type: 'button',
                  onClick: () => onToggle(key),
                  'aria-expanded': !isCollapsed,
                  'aria-label': `${node.name}: ${isCollapsed ? 'развернуть' : 'свернуть'}`,
                }
                : {})}
            >
              {expandable ? (
                <span className={`dss-toggle${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden>▾</span>
              ) : (
                <span className="dss-toggle is-leaf" aria-hidden />
              )}
              <IconFolderSm />
              <span className="dss-name">{node.name}</span>
              {/* У свёрнутой ветки показываем, сколько внутри папок: иначе не
                  видно, где ещё есть что раскрывать. */}
              {expandable && isCollapsed && (
                <span className="dss-count">{count} {plural(count, 'папка', 'папки', 'папок')}</span>
              )}
              {node.hint && <span className="dss-hint">{node.hint}</span>}
            </RowTag>

            {expandable && !isCollapsed && (
              <TreeNodes nodes={node.children} path={key} collapsed={collapsed} onToggle={onToggle} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default function DocStorageStructureModal({ structure, rootPath, onClose }) {
  const { tree, title, subtitle, defaultRoot, legend, notes } = structure
  const [collapsed, setCollapsed] = useState(() => collectKeys(tree))
  const [copied, setCopied] = useState(false)
  const allKeys = useMemo(() => collectKeys(tree, '', new Set(), false), [tree])
  const allExpanded = collapsed.size === 0
  const root = rootPath || defaultRoot

  const asciiTree = useMemo(() => `${root}\n│\n${toAscii(tree)}`, [root, tree])

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
            <h3>{title}</h3>
            <p className="dss-subtitle">{subtitle}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="dss-body">
          <div className="dss-root">
            <span className="dss-root-label">Корень</span>
            <code className="dss-root-path">{root}</code>
          </div>

          <div className="dss-tree-bar">
            <span className="dss-tree-hint">Нажмите на папку, чтобы раскрыть вложенные</span>
            <button
              type="button"
              className="dss-tree-btn"
              onClick={() => setCollapsed(allExpanded ? new Set(allKeys) : new Set())}
            >
              {allExpanded ? 'Свернуть всё' : 'Развернуть всё'}
            </button>
          </div>

          <TreeNodes nodes={tree} path="" collapsed={collapsed} onToggle={toggle} />

          {legend && (
            <div className="dss-legend">
              <div className="dss-legend-head">{legend.head}</div>
              <ul className="dss-legend-list">
                {legend.items.map(item => (
                  <li key={item.name}>
                    <span className="dss-stage">{item.name}</span>
                    <span className="dss-hint">{item.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {notes?.length > 0 && (
            <div className="dss-notes">
              {notes.map(note => (
                <p key={note.title}><b>{note.title}</b> {note.text}</p>
              ))}
            </div>
          )}
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
