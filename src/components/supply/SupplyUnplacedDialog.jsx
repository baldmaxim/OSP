import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck } from '../icons/ActionIcons'
import { IconClose, IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount } from '../../utils/money'
import { AUTO_MIN, LIST_MIN, MATCH_CANDIDATES, itemCandidates, searchGroups, sharedMatchIndex } from '../../utils/supplyDocMatch'
import Name from './SupplyNameDiff'

// Сразу видно подсказок у строки; остальные (до MATCH_CANDIDATES) — «ещё».
const SUGGEST_LIMIT = 6
const FIND_LIMIT = 8
// Строк окна — порциями: следующая дорисовывается, когда прокрутили к концу (на тендере в сотни строк без позиции окно открывалось
// почти секунду — всё рисовалось разом).
const ROWS_STEP = 40
const lineKey = (doc, line) => `${doc.id}:${line.name}:${line.price}`
// Цвет похожести. В окно попадают строки, у которых ничего не дошло до AUTO_MIN, поэтому цвета делят рабочий диапазон кандидатов
// (LIST_MIN…AUTO_MIN): от AUTO_MIN (сопоставилась бы сама, но другая ед. изм. или выбор отменён) — зелёный, от середины — жёлтый, ниже —
// красный. Иначе почти все плашки были бы одного цвета.
const MID_MIN = (LIST_MIN + AUTO_MIN) / 2
const scoreTone = (score) => (score >= AUTO_MIN ? 'is-high' : score >= MID_MIN ? 'is-mid' : 'is-low')
// После ближайшей отрисовки (кадр, затем задача).
const afterPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 0))
// Вид изделия строки — начало первого слова («Кабель …» → «кабе»): найденное по словам добавляется к кандидатам, только если оно того
// же вида, иначе к кабелю добавлялись бы трубы с тем же числом в наименовании. Кандидатов нет совсем — по словам без этого условия.
const kindOf = (name) => (String(name || '').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я]{3,}/)?.[0] || '').slice(0, 4)

// Строки счетов и КП без позиции ВОР — окно поверх «Счетов и КП тендера» (27.11.2026, просьба пользователя: блок внизу окна был
// неудобен — «пусть будет как документы, большое, и окно не закрывается само после выбора»). Каждая строка — отдельно: наименование,
// цена и файл слева, справа — похожие позиции ВОР одной кнопкой (кандидаты сопоставления, даже ниже порога и в другой ед. изм.; их
// мало — добавляются найденные по словам наименования) и поиск по всем позициям. Выбранное остаётся в окне отметкой «сопоставлено» с
// «отменить»: список не прыгает, видно, что сделано. Выбор — как «другая строка» в таблице окна: при файле, строка попадает в таблицу
// отмеченной; каждый такой выбор — запись журнала ручных сопоставлений (scripts/supply-match-review.mjs).
// 27.11.2026 (просьба пользователя): подсказок больше трёх (6, остальные — «ещё»); в подсказке жёлтым — отличия от строки счёта, как в
// таблице окна; похожесть — цветом; строка счёта слева — полужирным, по середине строки. Окно не тормозит: строки порциями, выбор
// отмечается сразу, а пересчёт страницы (все сопоставления, таблица окна) идёт следом, не задерживая отметку.
// items — [{ doc, line }] сейчас без позиции; groups — позиции ВОР; busy — идёт запись. onPick(group, doc, line), onUndo(group, doc,
// line) — снять выбор (строка — «не эта позиция»), onOpenFile(doc), onClose. Escape и щелчок мимо закрывают только это окно (Escape
// ловит окно «Счета и КП»).
export default function SupplyUnplacedDialog({ items, groups, busy, onPick, onUndo, onOpenFile, onClose }) {
  const closeRef = useRef(null)
  const bodyRef = useRef(null)
  const moreRef = useRef(null)
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query).trim().toLowerCase()
  // Выбранное в этом окне: ключ строки → { doc, line, group }; group null — выбор отменён. Строка с выбором уже не «без позиции», но
  // из окна не пропадает.
  const [done, setDone] = useState(() => new Map())
  const [shown, setShown] = useState(ROWS_STEP)
  // Подсказки по словам (перебор всех позиций на строку) — после первого кадра, в фоне: окно открывается сразу.
  const [warm, setWarm] = useState(false)
  const wordsOn = useDeferredValue(warm)
  useEffect(() => {
    closeRef.current?.focus()
    setWarm(true)
  }, [])

  const byKey = useMemo(() => new Map(items.map((x) => [lineKey(x.doc, x.line), x])), [items])
  // Порядок строк — как при открытии, новые (отменили выбор в таблице, загрузили файл) — в конце.
  const order = useRef({ list: [], seen: new Set() })
  for (const key of byKey.keys()) {
    if (!order.current.seen.has(key)) {
      order.current.seen.add(key)
      order.current.list.push(key)
    }
  }
  // Строка — тот же объект, пока не изменилась: перерисовывается только та, что изменилась (memo у UnplacedRow).
  const rowCache = useRef(new Map())
  const allRows = useMemo(() => {
    const next = new Map()
    const out = []
    for (const key of order.current.list) {
      const live = byKey.get(key)
      const mine = done.get(key)
      // Пока страница не пересчитала строки после выбора, строка берётся из выбора: не пропадает и не мигает.
      const src = live || mine
      if (!src) continue
      const picked = mine?.group || null
      const was = rowCache.current.get(key)
      const row = was && was.doc === src.doc && was.line === src.line && was.picked === picked ? was : { key, doc: src.doc, line: src.line, picked }
      next.set(key, row)
      out.push(row)
    }
    rowCache.current = next
    return out
  }, [byKey, done])
  const rows = useMemo(() => (q ? allRows.filter((r) => q.split(/\s+/).every((w) => r.line.name.toLowerCase().includes(w))) : allRows), [allRows, q])
  const visible = rows.length > shown ? rows.slice(0, shown) : rows
  const left = items.length
  const matched = [...done].filter(([k, d]) => d.group && !byKey.has(k)).length

  // Выбор — отметка в окне сразу; запись и пересчёт страницы (все сопоставления, таблица окна) — после того, как отметка нарисована,
  // переходом: не задерживают ни её, ни следующий щелчок. Порядок выборов сохраняется.
  const latest = useRef(null)
  latest.current = { onPick, onUndo }
  const pick = useCallback((row, group) => {
    setDone((prev) => new Map(prev).set(row.key, { doc: row.doc, line: row.line, group }))
    afterPaint(() => startTransition(() => latest.current.onPick(group, row.doc, row.line)))
  }, [])
  const undo = useCallback((row) => {
    setDone((prev) => new Map(prev).set(row.key, { doc: row.doc, line: row.line, group: null }))
    afterPaint(() => startTransition(() => latest.current.onUndo(row.picked, row.doc, row.line)))
  }, [])

  // Дошли до конца показанных строк — следующая порция (заранее, за пол-экрана до конца).
  const more = rows.length - visible.length
  useEffect(() => {
    const el = moreRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) startTransition(() => setShown((n) => n + ROWS_STEP))
    }, { root: bodyRef.current, rootMargin: '0px 0px 600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, shown])

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
        <div ref={bodyRef} className="sp-modal-body sp-tf-body">
          <p className="sp-un-hint sp-muted">
            Похожие позиции ВОР — одной кнопкой, остальные — поиском. Жёлтым — слова и числа, которых нет в строке счёта; цвет процента — насколько
            похоже. Выбранная строка встаёт в таблицу окна отмеченной; цена пишется, когда нажмёте «Применить цены».
          </p>
          {rows.length > 0 ? (
            <table className="data-table sp-tf-table sp-un-table">
              <colgroup><col className="sp-un-c-line" /><col className="sp-un-c-pos" /></colgroup>
              <thead><tr><th>Строка счёта</th><th>Позиция ВОР</th></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <UnplacedRow key={r.key} row={r} groups={groups} busy={busy} wordsOn={wordsOn} onPick={pick} onUndo={undo} onOpenFile={onOpenFile} />
                ))}
                {more > 0 && (
                  <tr className="sp-un-more">
                    <td colSpan={2}>
                      <button ref={moreRef} type="button" className="sp-link-btn" onClick={() => setShown((n) => n + ROWS_STEP)}>
                        Показать ещё {Math.min(more, ROWS_STEP)} из {more}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : <p className="sp-td-empty">{q ? 'Ничего не нашли.' : 'Строк без позиции нет.'}</p>}
        </div>
      </div>
    </div>
  )
}

// Строка окна: что в счёте и куда её поставить. Кандидаты сопоставления — из общей памяти указателя (как у таблицы окна, тот же
// предел — иначе строка искалась бы заново); их меньше SUGGEST_LIMIT — добавляются найденные по словам наименования (в фоне, wordsOn).
const UnplacedRow = memo(function UnplacedRow({ row, groups, busy, wordsOn, onPick, onUndo, onOpenFile }) {
  const { doc, line, picked } = row
  const [query, setQuery] = useState('')
  const typed = useDeferredValue(query).trim()
  const [all, setAll] = useState(false)
  const candidates = useMemo(() => itemCandidates(line, groups, sharedMatchIndex(groups), MATCH_CANDIDATES, { packs: true })
    .map((c) => ({ group: c.group, score: c.score, unitOk: c.unitOk })), [line, groups])
  const needWords = !picked && wordsOn && candidates.length < SUGGEST_LIMIT
  const pool = useMemo(() => {
    if (!needWords) return candidates
    const have = new Set(candidates.map((c) => c.group.key))
    const kind = candidates.length ? kindOf(line.name) : ''
    const words = searchGroups(line.name, groups, MATCH_CANDIDATES)
      .filter((g) => !have.has(g.key) && (!kind || g.name.toLowerCase().replace(/ё/g, 'е').includes(kind)))
      .map((group) => ({ group, score: null, unitOk: null }))
    return [...candidates, ...words].slice(0, MATCH_CANDIDATES)
  }, [needWords, candidates, line, groups])
  const suggest = all ? pool : pool.slice(0, SUGGEST_LIMIT)
  const found = useMemo(() => (typed ? searchGroups(typed, groups, FIND_LIMIT) : []), [typed, groups])
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
                      <Name text={s.group.name} other={line.name} />
                      <span className="sp-un-opt-meta">
                        <span className="sp-td-meta">{s.group.unit || (s.group.units || []).join(', ')}</span>
                        {s.score != null
                          ? <span className={`sp-un-score ${scoreTone(s.score)}`}>похоже на {Math.round(s.score * 100)} %</span>
                          : <span className="sp-un-score is-words">похоже по словам</span>}
                        {s.unitOk === false && <span className="sp-td-meta is-warn">ед. изм. другая</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pool.length > SUGGEST_LIMIT && (
              <button type="button" className="sp-link-btn sp-un-all" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? 'свернуть' : `ещё ${pool.length - SUGGEST_LIMIT} похожих`}
              </button>
            )}
            {!suggest.length && !wordsOn && <span className="sp-td-meta sp-un-wait">ищем похожие по словам…</span>}
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
                      <Name text={g.name} other={line.name} />{g.unit ? <span className="sp-td-meta">{g.unit}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {typed && typed === query.trim() && !found.length && <span className="sp-td-meta">Ничего не нашли</span>}
          </>
        )}
      </td>
    </tr>
  )
})
