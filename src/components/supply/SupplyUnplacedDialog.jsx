import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck } from '../icons/ActionIcons'
import { IconClose, IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount } from '../../utils/money'
import { MATCH_CANDIDATES, itemCandidates, searchGroups, sharedMatchIndex } from '../../utils/supplyDocMatch'

const SUGGEST_LIMIT = 3
const FIND_LIMIT = 8
// Подсказки «по словам» (кандидатов нет совсем) — перебор всех позиций на строку: при сотнях строк и тысячах позиций (тендер № 704)
// это секунда при открытии. Больше — по кнопке у строки.
const WORDS_AT_ONCE = 200000
const lineKey = (doc, line) => `${doc.id}:${line.name}:${line.price}`

// Строки счетов и КП без позиции ВОР — окно поверх «Счетов и КП тендера» (27.11.2026, просьба пользователя: блок внизу окна был
// неудобен — «пусть будет как документы, большое, и окно не закрывается само после выбора»). Каждая строка — отдельно: наименование,
// цена и файл слева, справа — похожие позиции ВОР одной кнопкой (кандидаты сопоставления, даже ниже порога и в другой ед. изм.; нет
// и таких — по словам наименования) и поиск по всем позициям. Выбранное остаётся в окне отметкой «сопоставлено» с «отменить»: список
// не прыгает, видно, что сделано. Выбор — как «другая строка» в таблице окна: при файле, строка попадает в таблицу отмеченной; каждый
// такой выбор — запись журнала ручных сопоставлений (scripts/supply-match-review.mjs).
// items — [{ doc, line }] сейчас без позиции; groups — позиции ВОР; busy — идёт запись. onPick(group, doc, line), onUndo(group, doc,
// line) — снять выбор (строка — «не эта позиция»), onOpenFile(doc), onClose. Escape и щелчок мимо закрывают только это окно (Escape
// ловит окно «Счета и КП»).
export default function SupplyUnplacedDialog({ items, groups, busy, onPick, onUndo, onOpenFile, onClose }) {
  const closeRef = useRef(null)
  const [query, setQuery] = useState('')
  // Выбранное в этом окне: ключ строки → { doc, line, group }. Строка с выбором уже не «без позиции», но из окна не пропадает.
  const [done, setDone] = useState(() => new Map())
  // Порядок строк — как при открытии, новые (отменили выбор в таблице, загрузили файл) — в конце.
  const order = useRef([])
  const byKey = new Map(items.map((x) => [lineKey(x.doc, x.line), x]))
  for (const key of byKey.keys()) if (!order.current.includes(key)) order.current.push(key)
  useEffect(() => { closeRef.current?.focus() }, [])

  const q = query.trim().toLowerCase()
  const rows = order.current
    .map((key) => {
      const live = byKey.get(key)
      const picked = done.get(key)
      if (!live && !picked) return null
      return { key, doc: (picked || live).doc, line: (picked || live).line, picked: picked?.group || null }
    })
    .filter(Boolean)
    .filter((r) => !q || q.split(/\s+/).every((w) => r.line.name.toLowerCase().includes(w)))
  const left = items.length
  const matched = [...done.keys()].filter((k) => !byKey.has(k)).length

  const pick = (row, group) => {
    setDone((prev) => new Map(prev).set(row.key, { doc: row.doc, line: row.line, group }))
    onPick(group, row.doc, row.line)
  }
  const undo = (row) => {
    setDone((prev) => { const m = new Map(prev); m.delete(row.key); return m })
    onUndo(row.picked, row.doc, row.line)
  }

  return (
    <div className="sp-modal-backdrop sp-tf-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sp-modal sp-tf sp-un" role="dialog" aria-modal="true" aria-labelledby="sp-un-title">
        <div className="sp-tf-head">
          <h3 id="sp-un-title">Строки счетов без позиции ВОР</h3>
          <span className="sp-td-meta ui-num" role="status">
            {left ? `осталось: ${left}` : 'все строки сопоставлены'}{matched ? ` · сопоставлено сейчас: ${matched}` : ''}
          </span>
          <label className="ui-search sp-td-find sp-un-filter">
            <IconSearch size={14} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти строку счёта"
              aria-label="Найти строку счёта среди строк без позиции"
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }} />
          </label>
          <button ref={closeRef} type="button" className="sp-icon-btn sp-tf-close" onClick={onClose} aria-label="Закрыть окно строк без позиции" title="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="sp-modal-body sp-tf-body">
          <p className="sp-un-hint sp-muted">
            Похожие позиции ВОР — одной кнопкой, остальные — поиском. Выбранная строка встаёт в таблицу окна отмеченной; цена пишется, когда нажмёте «Применить цены».
          </p>
          {rows.length > 0 ? (
            <table className="data-table sp-tf-table sp-un-table">
              <colgroup><col className="sp-un-c-line" /><col className="sp-un-c-pos" /></colgroup>
              <thead><tr><th>Строка счёта</th><th>Позиция ВОР</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <UnplacedRow key={r.key} row={r} groups={groups} busy={busy} byWords={groups.length * rows.length <= WORDS_AT_ONCE}
                    onPick={pick} onUndo={undo} onOpenFile={onOpenFile} />
                ))}
              </tbody>
            </table>
          ) : <p className="sp-td-empty">{q ? 'Ничего не нашли.' : 'Строк без позиции нет.'}</p>}
        </div>
      </div>
    </div>
  )
}

// Строка окна: что в счёте и куда её поставить. Подсказки считаются один раз на строку (кандидаты сопоставления — из общей памяти
// указателя, как у таблицы окна).
const UnplacedRow = memo(function UnplacedRow({ row, groups, busy, byWords, onPick, onUndo, onOpenFile }) {
  const { doc, line, picked } = row
  const [query, setQuery] = useState('')
  const [wordsAsked, setWordsAsked] = useState(false)
  const candidates = useMemo(() => itemCandidates(line, groups, sharedMatchIndex(groups), MATCH_CANDIDATES, { packs: true })
    .slice(0, SUGGEST_LIMIT).map((c) => ({ group: c.group, score: c.score, unitOk: c.unitOk })), [line, groups])
  const wordsOn = !candidates.length && (byWords || wordsAsked)
  const words = useMemo(() => (wordsOn ? searchGroups(line.name, groups, SUGGEST_LIMIT).map((group) => ({ group, score: null, unitOk: null })) : []), [wordsOn, line, groups])
  const suggest = candidates.length ? candidates : words
  const found = useMemo(() => (query.trim() ? searchGroups(query, groups, FIND_LIMIT) : []), [query, groups])
  return (
    <tr className={picked ? 'is-done' : undefined}>
      <td className="sp-un-line">
        <span className="sp-td-name">{line.name}</span>
        <span className="sp-td-meta ui-num">
          {formatAmount(line.price)} ₽{line.unit ? ` за ${line.unit}` : ''}
          {' · '}
          <button type="button" className="sp-td-file" onClick={() => onOpenFile(doc)} title="Открыть файл"><PaperclipIcon size={12} /> {doc.file_name}</button>
        </span>
        {line.unsure && <span className="sp-td-tag is-warn" title="Строка со скана или из ячейки с несколькими позициями: сверьте цифры с файлом.">сверьте с файлом</span>}
      </td>
      <td className="sp-un-pos">
        {picked ? (
          <span className="sp-un-done">
            <IconCheck size={14} />
            <span>Сопоставлено: <b>{picked.name}</b>{picked.unit ? <span className="sp-td-meta"> · {picked.unit}</span> : null}</span>
            <button type="button" className="sp-link-btn" disabled={busy} onClick={() => onUndo(row)}>отменить</button>
          </span>
        ) : (
          <>
            {suggest.length > 0 && (
              <ul className="sp-un-suggest" aria-label={`Похожие позиции ВОР для «${line.name}»`}>
                {suggest.map((s) => (
                  <li key={s.group.key}>
                    <button type="button" className="sp-td-opt sp-un-opt" disabled={busy} onClick={() => onPick(row, s.group)}>
                      <span>{s.group.name}</span>
                      <span className="sp-td-meta">
                        {s.group.unit || (s.group.units || []).join(', ')}
                        {s.score != null ? ` · похоже на ${Math.round(s.score * 100)} %` : ' · похоже по словам'}
                        {s.unitOk === false ? ' · ед. изм. другая' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!suggest.length && !wordsOn && (
              <button type="button" className="sp-link-btn sp-un-words" onClick={() => setWordsAsked(true)}>подобрать по словам наименования</button>
            )}
            <label className="ui-search sp-td-find">
              <IconSearch size={14} />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти позицию ВОР" disabled={busy}
                aria-label={`Найти позицию ВОР для «${line.name}»`}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }} />
            </label>
            {found.length > 0 && (
              <ul className="sp-td-picker-list sp-un-found">
                {found.map((g) => (
                  <li key={g.key}>
                    <button type="button" className="sp-td-opt" disabled={busy} onClick={() => { onPick(row, g); setQuery('') }}>
                      <span>{g.name}</span>{g.unit ? <span className="sp-td-meta">{g.unit}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {query.trim() && !found.length && <span className="sp-td-meta">Ничего не нашли</span>}
          </>
        )}
      </td>
    </tr>
  )
})
