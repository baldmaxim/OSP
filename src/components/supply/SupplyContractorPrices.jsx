import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRole } from '../../contexts/RoleContext'
import { decideSupplyAccess, grantSupplyItems, loadSupplyItems, loadSupplyList } from '../../services/contractorBids'
import { logSupplyAccess } from '../../services/supplyContractorPrices'
import { normUnit } from '../../utils/supplySimilarity'
import FilterDropdown from '../FilterDropdown'
import { IconHardHat } from '../icons/TenderHubIcons'
import { IconClose } from '../icons/ToolbarIcons'

// Столбец «Цены подрядчику» в таблице расценки снабжения (решение пользователя 25.11.2026; заменил кнопку «Цены подрядчикам» и окна
// в строке «Тендеров на материалы»). Только инженеру ОСП (роль engineer) и администратору — база других тоже не пускает
// (osp_supply_engineer, миграция 20270303). По умолчанию столбец свёрнут в узкую кнопку; раскрыли — вверху подрядчик основного тендера
// (только приглашённые и с принятой заявкой; кто просит — выбран сам) общим выпадающим списком сайта, кнопки «Все / С документом /
// Сбросить», «только отмеченные» и «Сохранить». В строке — отметка: цену снабжения этой позиции подрядчик увидит и сможет взять.
//
// Отметки — ключи позиций базы (ключ материала и ед. изм., bid_supply_items), не строки таблицы: собранная строка бывает из нескольких
// ключей, а «По ВОРам» один ключ — в нескольких строках. Позиция без единой цены снабжения во всех ВОР подрядчику не отдаётся — в
// строке «—». «Сохранить» заменяет набор открытых позиций целиком (bid_supply_grant), со скрытыми поиском и фильтром; пустой набор
// закрывает цены. Функции нет (20270303 не применена), база отказала или подрядчиков на сайте нет — столбца нет.

// Приглашённые (участники) и одобренные по заявке. Заявка ждёт решения — в списке, но выбрать нельзя.
const MEMBER = new Set(['invited', 'accepted'])

export const supplyItemKey = (itemKey, unitKey) => `${itemKey}|${unitKey || ''}`

// Ключи позиций базы у строки таблицы: ключ материала и ед. изм. её цен — как bid_supply_price_rows (material_key и
// kp_norm_unit(unit); normUnit — то же в браузере). Только ключи, которые база отдала (цена одна во всех ВОР).
export function rowSupplyKeys(row, items) {
  const out = []
  for (const t of row.targets) {
    for (const r of [t.rate, ...(t.duplicates || [])]) {
      if (!r?.material_key) continue
      const k = supplyItemKey(r.material_key, normUnit(r.unit || ''))
      if (items.has(k) && !out.includes(k)) out.push(k)
    }
  }
  return out
}

const errText = (e) => e?.message || String(e)

export function useContractorPrices({ mainId, startOpen = false }) {
  const { role, isAdmin, userProfile } = useRole()
  const allowed = !!mainId && (isAdmin || role === 'engineer')
  const [list, setList] = useState(undefined) // undefined — читается; null — функции нет или база отказала
  const [open, setOpenState] = useState(!!startOpen)
  const [cpId, setCpId] = useState(null)
  // Позиции с ценой снабжения у выбранного подрядчика: Map(ключ → { item_key, unit_key, granted, taken, … }); null — читаются.
  const [items, setItems] = useState(null)
  const [picked, setPicked] = useState(() => new Set())
  const [initial, setInitial] = useState(() => new Set())
  const [onlyPicked, setOnlyPicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const loadList = useCallback(async () => {
    try {
      const rows = await loadSupplyList([mainId])
      setList(rows === null ? null : rows.filter((r) => r.tender_id === mainId))
    } catch {
      // Не инженер ОСП по мнению базы (42501) или сбой — столбца нет; цены вводятся как раньше.
      setList(null)
    }
  }, [mainId])
  useEffect(() => { if (allowed) loadList() }, [allowed, loadList])

  const members = useMemo(() => (list || []).filter((r) => MEMBER.has(r.access)), [list])
  const waiting = useMemo(() => (list || []).filter((r) => !MEMBER.has(r.access)), [list])
  const asks = (list || []).filter((r) => r.status === 'requested').length
  const available = allowed && !!list && list.length > 0
  const current = members.find((r) => r.counterparty_id === cpId) || null

  // Раскрыли — подрядчик, который просит, выбран сам; единственный — тоже. Один раз за раскрытие: выбрали «Подрядчик…» — так и остаётся.
  const autoPicked = useRef(false)
  useEffect(() => {
    if (!open) { autoPicked.current = false; return }
    if (autoPicked.current || cpId || !members.length) return
    autoPicked.current = true
    const pick = members.find((r) => r.status === 'requested') || (members.length === 1 ? members[0] : null)
    if (pick) setCpId(pick.counterparty_id)
  }, [open, cpId, members])

  const reqRef = useRef(0)
  const loadItems = useCallback(async (id) => {
    const n = ++reqRef.current
    try {
      const rows = await loadSupplyItems(mainId, id)
      if (n !== reqRef.current) return
      const m = new Map()
      for (const r of rows || []) m.set(supplyItemKey(r.item_key, r.unit_key), r)
      const granted = new Set([...m].filter(([, r]) => r.granted).map(([k]) => k))
      setItems(m)
      setPicked(granted)
      setInitial(granted)
    } catch (e) {
      if (n !== reqRef.current) return
      setItems(new Map())
      setPicked(new Set())
      setInitial(new Set())
      setError(errText(e))
    }
  }, [mainId])
  useEffect(() => {
    setItems(null)
    setPicked(new Set())
    setInitial(new Set())
    if (open && cpId) loadItems(cpId)
    else reqRef.current += 1
  }, [open, cpId, loadItems])

  const changed = useMemo(() => picked.size !== initial.size || [...picked].some((k) => !initial.has(k)), [picked, initial])
  const keepChanges = () => !changed || window.confirm('Отметки подрядчику не сохранены. Сбросить их?')

  const select = (id) => {
    if ((id || null) === cpId || !keepChanges()) return
    setError('')
    setNote('')
    setOnlyPicked(false)
    setCpId(id || null)
  }
  const setOpen = (v) => {
    if (!v && !keepChanges()) return
    if (!v) setOnlyPicked(false)
    setError('')
    setNote('')
    setOpenState(v)
  }
  // Отметить или снять ключи; набор — новым объектом, строки перерисовываются по своим ключам.
  const toggle = useCallback((keys, on) => setPicked((prev) => {
    const next = new Set(prev)
    for (const k of keys) { if (on) next.add(k); else next.delete(k) }
    return next
  }), [])
  const pickAll = () => { if (items) setPicked(new Set(items.keys())) }
  const pickOnly = (keys) => setPicked(new Set(keys))
  const pickNone = () => setPicked(new Set())
  const cancel = () => setPicked(new Set(initial))

  const decided = async (cp, text) => {
    logSupplyAccess(mainId, { counterpartyId: cp.counterparty_id, name: cp.counterparty_name, text, byName: userProfile?.full_name || null, byRole: role || null })
    await Promise.all([loadItems(cp.counterparty_id), loadList()])
  }

  const save = async () => {
    const cp = current
    if (!cp || !items || busy) return
    const name = cp.counterparty_name || 'организации'
    if (picked.size === 0 && initial.size > 0
      && !window.confirm(`Не отмечено ни одной позиции — цены снабжения «${name}» будут закрыты. Цены, которые подрядчик уже взял, останутся у него, но без счетов. Продолжить?`)) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const rows = [...picked].map((k) => items.get(k)).filter(Boolean).map((r) => ({ key: r.item_key, unit_key: r.unit_key || '' }))
      const n = await grantSupplyItems(mainId, cp.counterparty_id, { items: rows })
      await decided(cp, n > 0 ? `открыто позиций: ${n}` : 'запрещены')
      setNote(n > 0 ? `Сохранено: открыто ${n}` : 'Цены закрыты')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // Просит, а открыть нечего или не нужно — отказ (повторить просьбу подрядчик сможет через сутки).
  const deny = async () => {
    const cp = current
    if (!cp || busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      await decideSupplyAccess(mainId, cp.counterparty_id, false)
      await decided(cp, 'отказано')
      setNote('Отказано')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return {
    available, open, setOpen, list, members, waiting, asks, cpId, current, select, items, picked, initial, changed,
    onlyPicked, setOnlyPicked, toggle, pickAll, pickOnly, pickNone, cancel, save, deny, busy, error, note,
  }
}

// Состояние цен снабжения у подрядчика — под названием в списке и в поле выбора; tone — цвет подписи.
const statusText = (r) => {
  if (r.status === 'requested') return 'просит цены'
  if (r.status === 'granted' && r.granted_items > 0) return `открыто ${r.granted_items}`
  if (r.status === 'denied') return 'закрыто'
  return 'цены не открыты'
}
const statusTone = (r) => {
  if (r.status === 'requested') return ' is-asks'
  if (r.status === 'granted' && r.granted_items > 0) return ' is-open'
  return ''
}

// Строка списка подрядчиков (renderOption у FilterDropdown): название, под ним ИНН и состояние цен. Список рисуется в document.body —
// стили .sp-cp-opt без корня страницы (SupplyPricing.css).
const renderCpOption = (o) => {
  const r = o.row
  const state = o.disabled ? `заявка ждёт решения${r.status === 'requested' ? ', просит цены' : ''}` : statusText(r)
  return (
    <span className="fdrop-option-text sp-cp-opt">
      <span className="sp-cp-opt-name">{o.label}</span>
      <span className={`sp-cp-opt-meta${o.disabled ? '' : statusTone(r)}`}>
        {r.counterparty_inn ? `ИНН ${r.counterparty_inn} · ${state}` : state}
      </span>
    </span>
  )
}

// Шапка столбца: свёрнут — узкая кнопка (сколько просят); раскрыт — подрядчик и отметки. docKeys — ключи позиций с документом
// (колонка «Документ»), selectedKeys — ключи строк, отмеченных слева.
// Подрядчик — общим выпадающим списком сайта (FilterDropdown, как фильтры реестров и выбор контрагента в «Проверке ДП/ДС»): название
// переносится, под ним — состояние цен; заявка ждёт решения — в списке, но не выбирается. Отметки — кнопками в одну группу
// («Все / С документом / Сбросить»), не текстовыми ссылками: в них трудно было попасть (просьба пользователя 25.11.2026).
export function ContractorPricesHead({ cp, docKeys, selectedKeys, bar = false }) {
  if (!cp.open) {
    return (
      <button type="button" className={bar ? 'btn-secondary sp-cp-open' : 'sp-cp-toggle'} onClick={() => cp.setOpen(true)}
        aria-label={`Цены подрядчику: показать столбец${cp.asks ? ` (просят: ${cp.asks})` : ''}`}
        title="Цены снабжения подрядчику: открыть позиции подрядчику тендера">
        <IconHardHat size={16} />
        {bar && <span>Цены подрядчику</span>}
        {cp.asks > 0 && <span className="sp-cp-asks">{bar ? `просят: ${cp.asks}` : cp.asks}</span>}
      </button>
    )
  }
  const cur = cp.current
  const ready = !!cur && !!cp.items
  const options = [
    ...cp.members.map((r) => ({ value: r.counterparty_id, label: r.counterparty_name || 'Организация', row: r })),
    ...cp.waiting.map((r) => ({ value: r.counterparty_id, label: r.counterparty_name || 'Организация', row: r, disabled: true })),
  ]
  const empty = cp.members.length ? 'Выберите подрядчика' : 'Нет приглашённых'
  return (
    <div className="sp-cp-head">
      <div className="sp-cp-title">
        <span>Цены подрядчику</span>
        <button type="button" className="sp-cp-close" onClick={() => cp.setOpen(false)} disabled={cp.busy}
          aria-label="Скрыть столбец «Цены подрядчику»" title="Скрыть столбец">
          <IconClose size={14} />
        </button>
      </div>
      <FilterDropdown
        className="sp-cp-fdrop"
        value={cp.cpId || ''}
        onChange={(v) => cp.select(v)}
        options={options}
        allLabel={empty}
        disabled={cp.busy || !options.length}
        searchable={options.length > 7}
        searchPlaceholder="Поиск подрядчика…"
        triggerTitle="Подрядчик, которому открыть цены снабжения"
        renderOption={renderCpOption}
        formatTrigger={(label) => (cur ? (
          <>
            <span className="sp-cp-trig-name">{label}</span>
            <span className={`sp-cp-trig-meta${statusTone(cur)}`}>{statusText(cur)}</span>
          </>
        ) : label)}
      />
      {cur && !cp.items && <span className="sp-cp-hint">Загрузка позиций…</span>}
      {ready && cp.items.size === 0 && <span className="sp-cp-hint">Снабжение ещё не расценило позиции одной ценой во всех ВОР</span>}
      {ready && cp.items.size > 0 && (
        <>
          <div className="sp-cp-seg" role="group" aria-label="Отметить позиции">
            <button type="button" className="sp-cp-btn" onClick={cp.pickAll} disabled={cp.busy}
              title="Отметить все позиции с ценой снабжения">Все</button>
            <button type="button" className="sp-cp-btn" onClick={() => cp.pickOnly(docKeys)} disabled={cp.busy || !docKeys.length}
              title={docKeys.length ? 'Отметить только позиции с документом (колонка «Документ»), остальные снять' : 'Ни у одной позиции нет документа'}>
              С документом
            </button>
            <button type="button" className="sp-cp-btn" onClick={cp.pickNone} disabled={cp.busy || !cp.picked.size}
              title="Снять все отметки">Сбросить</button>
          </div>
          {selectedKeys.length > 0 && (
            <button type="button" className="sp-cp-btn sp-cp-wide" onClick={() => cp.toggle(selectedKeys, true)} disabled={cp.busy}
              title="Добавить к отметкам позиции, отмеченные галочками слева">Добавить отмеченные слева</button>
          )}
          <div className="sp-cp-line">
            <label className="sp-cp-only">
              <input type="checkbox" checked={cp.onlyPicked} onChange={(e) => cp.setOnlyPicked(e.target.checked)} />
              только отмеченные
            </label>
            <span className="sp-cp-count ui-num" title="Отмечено позиций из позиций с ценой снабжения (одной во всех ВОР)">
              {cp.picked.size} из {cp.items.size}
            </span>
          </div>
          {cp.changed ? (
            <div className="sp-cp-actions">
              <button type="button" className="btn-primary sp-cp-save" onClick={cp.save} disabled={cp.busy}>
                {cp.busy ? 'Сохраняем…' : 'Сохранить'}
              </button>
              <button type="button" className="sp-cp-btn" onClick={cp.cancel} disabled={cp.busy}>Отмена</button>
            </div>
          ) : cur.status === 'requested' && cp.initial.size === 0 ? (
            <div className="sp-cp-actions">
              <button type="button" className="sp-cp-btn is-danger" onClick={cp.deny} disabled={cp.busy}
                title="Отказать в ценах снабжения (повторить просьбу подрядчик сможет через сутки)">Отказать</button>
            </div>
          ) : null}
        </>
      )}
      {ready && cp.items.size === 0 && cur.status === 'requested' && (
        <div className="sp-cp-actions">
          <button type="button" className="sp-cp-btn is-danger" onClick={cp.deny} disabled={cp.busy}
            title="Отказать в ценах снабжения (повторить просьбу подрядчик сможет через сутки)">Отказать</button>
        </div>
      )}
      {cp.error && <span className="sp-cp-error" role="alert">{cp.error}</span>}
      {cp.note && !cp.changed && !cp.error && <span className="sp-cp-note" role="status">{cp.note}</span>}
    </div>
  )
}

// Ячейка строки. state: 'na' — цены снабжения, одной во всех ВОР, нет; 'on' / 'off' / 'mixed' — отметка (mixed — у собранной строки
// открыта часть ключей); пусто — подрядчик не выбран или позиции читаются.
export function ContractorPriceCell({ state, taken, changed, busy, name, onToggle }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'mixed' }, [state])
  if (!state) return null
  if (state === 'na') {
    return <span className="sp-cp-na" title="Нет цены снабжения, одной во всех ВОР: подрядчику её не открыть">—</span>
  }
  return (
    <span className="sp-cp-cell">
      <input ref={ref} type="checkbox" className="sp-select" checked={state === 'on'} disabled={busy}
        onChange={(e) => onToggle(e.target.checked)} aria-label={`Открыть подрядчику цену: ${name}`} />
      {taken && <span className="sp-cp-taken" title="Подрядчик взял эту цену снабжения">взял</span>}
      {changed && <span className="sp-cp-dirty" title="Не сохранено">не сохранено</span>}
    </span>
  )
}
