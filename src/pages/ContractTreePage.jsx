// «Дерево договоров» (/contracts/tree) — эксперимент 12.11.2026, только администратору (просьба пользователя: показать
// руководителю, как «Заявка на ДС», «Заявки на проверку ДП/ДС» и «Заявка на ДП» будут видны в реестре договоров веткой).
//
// Договор — ствол, ДС и заявки — ветки. Два набора данных:
//   • «Пример» — выдуманные договоры со всеми случаями (utils/contractTreeDemo.js); действия работают на экране —
//     «Создать ДС», «Оформить договор», «Привязать», «+ На проверку», «+ Заявка на ДС»; ничего не сохраняется;
//   • «Реальные данные» — договоры и заявки из базы, только чтение. Проверки и заявки на ДП связываются с договором
//     в браузере (своего поля в базе пока нет), привязка вручную — в localStorage этого браузера.
// Логика дерева — utils/contractTree.js, загрузка — services/contractTree.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AccessDenied from '../components/AccessDenied'
import IconTile from '../components/IconTile'
import { IconClose, IconFolderTree, IconSearch } from '../components/icons/ToolbarIcons'
import { useRole } from '../contexts/RoleContext'
import { loadContractTreeData } from '../services/contractTree'
import {
  KIND, KIND_META, LINK_HOW, buildContractTree, contractStatus, dcAmounts, docAmount, docKindLabel, docTitle,
  docTypeShort, isContractDoc, rootHaystack, searchTargets, suggestTargets,
} from '../utils/contractTree'
import { makeDemoData, nextDemoContractNumber } from '../utils/contractTreeDemo'
import { CONTRACTS_REGISTRY_PATH } from '../utils/contractsHub'
import { DS_TYPE_LABEL } from '../utils/dcRequestOptions'
import { DP_ROLE_LABEL } from '../utils/dpRequests'
import { formatMoney } from '../utils/estimateImport'
import { formatDateRu, plural } from '../utils/taskHelpers'
import './ContractTreePage.css'

const MODE_KEY = 'contractTree:mode'
const LINKS_KEY = 'contractTree:links:v1'
const PAGE = 60

const readLocal = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch { return fallback }
}
const writeLocal = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* без памяти — только на экране */ }
}

// «48,6 млн ₽» — в строках дерева; полная сумма — в карточке справа.
function shortMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return ''
  const v = Number(value)
  const abs = Math.abs(v)
  const fmt = (x, d) => x.toLocaleString('ru-RU', { maximumFractionDigits: d })
  if (abs >= 1e6) return `${fmt(v / 1e6, 1)} млн ₽`
  if (abs >= 1e3) return `${fmt(v / 1e3, 0)} тыс. ₽`
  return `${fmt(v, 2)} ₽`
}
const shortDate = (d) => {
  const s = formatDateRu(d)
  return s === '—' ? '' : s.slice(0, 6) + s.slice(8)
}
// «к договору № 12» / «к ДС № 2» — для кнопок привязки.
const linkTitle = (doc) => `${isContractDoc(doc) ? 'договору' : 'ДС'} № ${doc.contract_number || 'без номера'}`
// Документ проверки: «ДС № 1», «ДП № СУ2-12» — без повтора «ДС №», если он уже в номере.
const checkDocLabel = (r) => {
  const num = String(r.doc_number || '').replace(/^\s*(ДС|ДП|договор)\s*№?\s*/i, '')
  return `${r.doc_type === 'dp' ? 'ДП' : 'ДС'} № ${num || '—'}`
}
const pctText = (pct) => (pct == null ? '' : `${pct > 0 ? '+' : ''}${pct.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`)

// ── Мелкие части ─────────────────────────────────────────────────────────────────────────────────────────────────

function KindTag({ kind }) {
  return <span className={`ctree-tag tone-${KIND_META[kind].tone}`}>{KIND_META[kind].short}</span>
}

function DocTag({ doc }) {
  return <span className={`ctree-tag ${isContractDoc(doc) ? 'tone-blue' : 'tone-sky'}`}>{docKindLabel(doc)}</span>
}

function Pill({ state, children, title }) {
  return <span className={`ctree-pill is-${state}`} title={title}>{children}</span>
}

// Этапы точками: пройденные — залиты, текущий — с обводкой. Последний шаг — всё залито.
function Steps({ item }) {
  const { steps, index, kind } = item
  const done = index === steps.length - 1
  return (
    <span
      className={`ctree-steps tone-${KIND_META[kind].tone}`}
      role="img"
      aria-label={index >= 0 ? `Этап ${index + 1} из ${steps.length}: ${item.label}` : `Статус: ${item.label}`}
      title={steps.map((s, i) => `${i < index || done ? '✓' : i === index ? '●' : '○'} ${s.label}`).join('\n')}
    >
      {steps.map((s, i) => (
        <span
          key={s.value}
          className={`ctree-dot${i < index || done ? ' is-done' : ''}${i === index && !done ? ' is-current' : ''}`}
        />
      ))}
    </span>
  )
}

function itemState(item) {
  if (item.overdue && item.active) return 'overdue'
  if (!item.active) return 'done'
  if (item.index <= 0) return 'new'
  return 'work'
}

// Главный факт заявки одной строкой.
function itemFact(item, employees) {
  const r = item.raw
  if (item.kind === KIND.DC) {
    const { before, after, pct } = dcAmounts(r)
    const parts = []
    if (!r.amendment_id && r.ds_number) parts.push(`ДС № ${r.ds_number}`)
    if (before != null && after != null) parts.push(`${shortMoney(before)} → ${shortMoney(after)}${pct != null ? ` (${pctText(pct)})` : ''}`)
    else if (r.amount_contractor != null) parts.push(`ДС подрядчика ${shortMoney(r.amount_contractor)}`)
    else if (after != null) parts.push(`согласовано ${shortMoney(after)}`)
    return parts.join(' · ')
  }
  if (item.kind === KIND.CHECK) {
    const names = (r.assignee_ids || []).map((id) => employees.get(id)).filter(Boolean)
    const parts = []
    if (item.link?.missingDs) parts.push(`${r.doc_number || 'ДС'} — нет в реестре`)
    if (names.length) parts.push(names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0])
    else if (item.active) parts.push('без исполнителя')
    return parts.join(' · ')
  }
  const parts = []
  if (r.amount != null) parts.push(shortMoney(r.amount))
  if (r.responsible_name) parts.push(r.responsible_name)
  if (!parts.length && item.active) parts.push('отдел ещё не заполнил')
  return parts.join(' · ')
}

function dueText(item) {
  const r = item.raw
  if (item.kind !== KIND.CHECK || !r.due_date || !item.active) return null
  return <span className={`ctree-due${item.overdue ? ' is-overdue' : ''}`}>{item.overdue ? 'просрочено, ' : ''}до {shortDate(r.due_date)}</span>
}

// ── Строки дерева ────────────────────────────────────────────────────────────────────────────────────────────────

function RequestLine({ item, employees, selected, flash, hit, onSelect, actions, prefix }) {
  const fact = itemFact(item, employees)
  return (
    <div className={`ctree-line is-request tone-${KIND_META[item.kind].tone}${selected ? ' is-selected' : ''}${flash ? ' is-flash' : ''}${hit ? ' is-hit' : ''}`}>
      <button type="button" className="ctree-line-main" onClick={() => onSelect(item.key)} aria-pressed={selected}>
        {prefix && <span className="ctree-prefix">{prefix}</span>}
        <KindTag kind={item.kind} />
        <span className="ctree-num">{item.number || 'без номера'}</span>
        <Steps item={item} />
        <Pill state={itemState(item)}>{item.label}</Pill>
        {dueText(item)}
        {fact && <span className="ctree-fact">{fact}</span>}
        <span className="ctree-date">{shortDate(item.raw.created_at)}</span>
      </button>
      {actions}
    </div>
  )
}

function DocLine({ doc, parentDoc, selected, flash, hit, onSelect, actions, trunk }) {
  const st = contractStatus(doc)
  const date = shortDate(doc.contract_date)
  const amount = shortMoney(docAmount(doc))
  return (
    <div className={`ctree-line is-doc${trunk ? ' is-trunk' : ''}${selected ? ' is-selected' : ''}${flash ? ' is-flash' : ''}${hit ? ' is-hit' : ''}`}>
      <button type="button" className="ctree-line-main" onClick={() => onSelect(`doc:${doc.id}`)} aria-pressed={selected}>
        <DocTag doc={doc} />
        <span className="ctree-num">{doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'}</span>
        {date && <span className="ctree-date-inline">от {date}</span>}
        {!isContractDoc(doc) && <span className="ctree-subtle">{docTypeShort(doc)}</span>}
        {parentDoc && !isContractDoc(parentDoc) && (
          <span className="ctree-subtle">к ДС № {parentDoc.contract_number || '—'}</span>
        )}
        <Pill state={st.state}>{st.label}</Pill>
        {amount && <span className="ctree-amount">{amount}</span>}
        {doc.work_name && <span className="ctree-fact">{doc.work_name}</span>}
      </button>
      {actions}
    </div>
  )
}

// ── Выбор договора для заявки без договора ───────────────────────────────────────────────────────────────────────

function TargetPicker({ item, idx, onLink, compact = false }) {
  const suggestions = useMemo(() => suggestTargets(item, idx), [item, idx])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const found = useMemo(() => (open ? searchTargets(idx, query) : []), [open, idx, query])
  const label = (doc) => `${docTitle(doc)}${doc.counterparties?.name ? ` · ${doc.counterparties.name}` : ''}`
  return (
    <div className={`ctree-picker${compact ? ' is-compact' : ''}`}>
      {suggestions.length === 0 && !open && (
        <span className="ctree-picker-none">
          {item.kind === KIND.DP ? 'Договоров на объекте нет.' : 'У контрагента на этом объекте договоров нет.'}
        </span>
      )}
      {suggestions.map(({ doc, exact }) => (
        <button key={doc.id} type="button" className={`ctree-chip${exact ? ' is-exact' : ''}`} onClick={() => onLink(item, doc)}
          title={`${label(doc)}${doc.objects?.name ? ` · ${doc.objects.name}` : ''}`}>
          Привязать к {linkTitle(doc)}
          {exact && <span className="ctree-chip-note">номер совпал</span>}
        </button>
      ))}
      {!open ? (
        <button type="button" className="ctree-chip is-ghost" onClick={() => setOpen(true)}>Другой…</button>
      ) : (
        <div className="ctree-picker-search">
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="№ договора или ДС, контрагент, объект"
            aria-label="Найти договор или ДС"
          />
          <button type="button" className="ctree-link-btn" onClick={() => { setOpen(false); setQuery('') }}>Отмена</button>
          {query.trim().length >= 2 && (
            <ul className="ctree-picker-list">
              {found.length === 0 && <li className="ctree-picker-none">Ничего не нашлось</li>}
              {found.map((doc) => (
                <li key={doc.id}>
                  <button type="button" onClick={() => onLink(item, doc)}>
                    <strong>{docTitle(doc)}</strong>
                    <span>{[doc.counterparties?.name, doc.objects?.name].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── Карточка справа ──────────────────────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  if (children == null || children === '' || children === false) return null
  return (
    <div className="ctree-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function StepList({ item }) {
  const done = item.index === item.steps.length - 1
  return (
    <ol className={`ctree-steplist tone-${KIND_META[item.kind].tone}`}>
      {item.steps.map((s, i) => {
        const state = i < item.index || done ? 'done' : i === item.index ? 'current' : 'todo'
        return (
          <li key={s.value} className={`is-${state}`}>
            <span className="ctree-steplist-mark" aria-hidden>{state === 'done' ? '✓' : ''}</span>
            <span>{i === item.index && item.raw.status === 'awaiting_scan' ? item.label : s.label}</span>
          </li>
        )
      })}
      {item.index < 0 && <li className="is-current"><span className="ctree-steplist-mark" aria-hidden /> {item.label}</li>}
    </ol>
  )
}

function sectionLink(item) {
  const r = item.raw
  if (item.kind === KIND.CHECK) return { to: `/doc-check-requests?request=${r.id}`, label: 'Открыть на доске проверки' }
  if (item.kind === KIND.DP) return { to: `/dp-requests?request=${r.id}`, label: 'Открыть в «Заявках на ДП»' }
  return {
    to: r.counterparty_id ? `/dc-requests?counterparty=${r.counterparty_id}` : '/dc-requests',
    label: 'Открыть в «Заявках на ДС»',
  }
}

function RequestCard({ item, tree, employees, mode, actions, onSelect, onLink, onUnlink }) {
  const r = item.raw
  const target = item.link ? tree.idx.byId.get(item.link.targetId) : null
  const link = mode === 'real' ? sectionLink(item) : null
  return (
    <>
      <div className="ctree-card-head">
        <KindTag kind={item.kind} />
        <h3>{KIND_META[item.kind].label} {item.number}</h3>
      </div>
      <div className="ctree-card-status">
        <Pill state={itemState(item)}>{item.label}</Pill>
        {dueText(item)}
      </div>
      <StepList item={item} />

      <section className="ctree-card-box">
        <h4>Где в дереве</h4>
        {target ? (
          <>
            <button type="button" className="ctree-target" onClick={() => onSelect(`doc:${target.id}`)}>
              <DocTag doc={target} /> {docTitle(target)}
              {(target.counterparties?.name || target.objects?.name) && (
                <span className="ctree-target-sub">{[target.counterparties?.name, target.objects?.name].filter(Boolean).join(' · ')}</span>
              )}
            </button>
            <p className="ctree-how">
              {item.kind === KIND.DP ? 'Основание договора. ' : ''}{LINK_HOW[item.link.how]}
              {item.link.missingDs ? `. ${r.doc_number || 'ДС'} в реестре нет — проверка висит на договоре` : ''}.
            </p>
            {item.link.how === 'local' && (
              <button type="button" className="ctree-link-btn" onClick={() => onUnlink(item)}>Убрать привязку</button>
            )}
          </>
        ) : (
          <>
            <p className="ctree-how">
              {item.kind === KIND.DP && item.active ? 'Договор ещё не оформлен. ' : 'Не привязана к договору. '}
              Подсказки — договоры того же контрагента и объекта.
            </p>
            <TargetPicker item={item} idx={tree.idx} onLink={onLink} />
          </>
        )}
      </section>

      <dl className="ctree-fields">
        <Field label="Объект">{r.objects?.name}</Field>
        {item.kind !== KIND.DP && <Field label="Контрагент">{r.counterparties?.name}</Field>}
        {item.kind === KIND.DC && (
          <>
            <Field label="№ ДС">{r.ds_number}</Field>
            <Field label="Тип ДС">{DS_TYPE_LABEL[r.ds_type]}</Field>
            <Field label="Работы">{r.works_description}</Field>
            <Field label="Было ПСДЦ">{formatMoney(r.amount_before)}</Field>
            <Field label="ДС подрядчика">{formatMoney(r.amount_contractor)}</Field>
            <Field label="Согласовано ДС ОСП">{formatMoney(r.amount_after)}</Field>
            <Field label="Было ВОР подрядчик">{formatMoney(r.vor_amount_before)}</Field>
            <Field label="Стало ВОР ОСП">{formatMoney(r.vor_amount_after)}</Field>
            {(() => {
              const { before, after, pct } = dcAmounts(r)
              return before != null && after != null
                ? <Field label="Изменение">{formatMoney(after - before)} ({pctText(pct)})</Field>
                : null
            })()}
          </>
        )}
        {item.kind === KIND.CHECK && (
          <>
            <Field label="Документ">{checkDocLabel(r)}</Field>
            <Field label="Дата документа">{r.doc_date ? formatDateRu(r.doc_date) : null}</Field>
            <Field label="Исполнители">
              {(r.assignee_ids || []).map((id) => employees.get(id)).filter(Boolean).join(', ') || null}
            </Field>
            <Field label="Срок">{r.due_date ? formatDateRu(r.due_date) : null}</Field>
            <Field label="Примечание">{r.notes}</Field>
          </>
        )}
        {item.kind === KIND.DP && (
          <>
            <Field label="Договор (текстом)">{r.contract_title}</Field>
            <Field label="Сумма">{formatMoney(r.amount)}</Field>
            <Field label="Ответственный">
              {r.responsible_name ? `${r.responsible_name}${DP_ROLE_LABEL[r.responsible_role] ? ` (${DP_ROLE_LABEL[r.responsible_role]})` : ''}` : null}
            </Field>
            <Field label="Примечание">{r.reason}</Field>
          </>
        )}
        <Field label="Создал(а)">{r.created_by_name}</Field>
        <Field label="Создана">{r.created_at ? formatDateRu(r.created_at) : null}</Field>
      </dl>

      {(actions || link) && (
        <div className="ctree-card-actions">
          {actions}
          {link && <Link to={link.to} className="ctree-btn is-ghost">{link.label}</Link>}
        </div>
      )}
    </>
  )
}

function DocCard({ doc, tree, mode, actions }) {
  const root = tree.rootOf.get(doc.id)
  const node = tree.nodes.get(doc.id)
  const st = contractStatus(doc)
  const parent = doc.parent_contract_id ? tree.idx.byId.get(doc.parent_contract_id) : null
  const reqs = node ? [...node.basis, ...node.requests] : []
  return (
    <>
      <div className="ctree-card-head">
        <DocTag doc={doc} />
        <h3>{docTitle(doc)}</h3>
      </div>
      <div className="ctree-card-status"><Pill state={st.state}>{st.label}</Pill></div>
      <dl className="ctree-fields">
        <Field label="Дата">{doc.contract_date ? formatDateRu(doc.contract_date) : null}</Field>
        {!isContractDoc(doc) && <Field label="Тип">{docTypeShort(doc)}</Field>}
        {!isContractDoc(doc) && parent && <Field label="Изменяет">{docTitle(parent)}</Field>}
        <Field label="Контрагент">{doc.counterparties?.name}</Field>
        <Field label="Объект">{doc.objects?.name}</Field>
        <Field label="Работы">{doc.work_name}</Field>
        <Field label="Сумма">{formatMoney(docAmount(doc), doc.currency || 'RUB')}</Field>
        <Field label="Юрист">{doc.responsible?.full_name}</Field>
        <Field label="ID">{doc.display_id}</Field>
      </dl>
      <section className="ctree-card-box">
        <h4>Ветки этого документа</h4>
        {reqs.length === 0 && (!root || root.doc.id !== doc.id || root.ds.length === 0)
          ? <p className="ctree-how">Заявок нет.</p>
          : (
            <ul className="ctree-card-list">
              {root && root.doc.id === doc.id && root.ds.length > 0 && <li>ДС: {root.ds.length}</li>}
              {['dp', 'check', 'dc'].map((k) => {
                const n = reqs.filter((r) => r.kind === k).length
                return n ? <li key={k}>{KIND_META[k].label}: {n}</li> : null
              })}
            </ul>
          )}
      </section>
      {(actions || mode === 'real') && (
        <div className="ctree-card-actions">
          {actions}
          {mode === 'real' && <Link to={`/contracts/${doc.id}`} className="ctree-btn is-ghost">Открыть карточку</Link>}
        </div>
      )}
    </>
  )
}

// ── Страница ─────────────────────────────────────────────────────────────────────────────────────────────────────

export default function ContractTreePage() {
  const { isAdmin, isSuperAdmin } = useRole()
  const allowed = isAdmin || isSuperAdmin

  const [mode, setMode] = useState(() => (readLocal(MODE_KEY, 'demo') === 'real' ? 'real' : 'demo'))
  const [demo, setDemo] = useState(makeDemoData)
  const [real, setReal] = useState({ status: 'idle', data: null, error: '' })
  const [links, setLinks] = useState(() => readLocal(LINKS_KEY, {}) || {})
  const [expanded, setExpanded] = useState(() => new Set(['demo-c1']))
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [objectId, setObjectId] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [withRequests, setWithRequests] = useState(mode === 'real')
  const [looseOpen, setLooseOpen] = useState(false)
  const [looseDone, setLooseDone] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [flash, setFlash] = useState(null)
  const [info, setInfo] = useState(null)
  const flashTimer = useRef(null)

  const loadReal = useCallback(() => {
    setReal((s) => ({ ...s, status: 'loading', error: '' }))
    loadContractTreeData()
      .then((data) => setReal({ status: 'ready', data, error: '' }))
      .catch((err) => setReal({ status: 'error', data: null, error: err?.message || String(err) }))
  }, [])

  useEffect(() => {
    if (allowed && mode === 'real' && real.status === 'idle') loadReal()
  }, [allowed, mode, real.status, loadReal])

  useEffect(() => () => clearTimeout(flashTimer.current), [])

  // Новое или привязанное — на экран: в примере его сразу видно в ветке.
  useEffect(() => {
    if (!flash) return undefined
    const raf = requestAnimationFrame(() => {
      document.querySelector('.ctree-page .is-flash')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [flash])

  const switchMode = (next) => {
    if (next === mode) return
    setMode(next)
    writeLocal(MODE_KEY, next)
    setSelected(null)
    setSearch('')
    setObjectId('')
    setOnlyActive(false)
    setWithRequests(next === 'real')
    setLimit(PAGE)
    setExpanded(new Set(next === 'demo' ? ['demo-c1'] : []))
  }

  const data = mode === 'demo' ? demo : real.data
  const tree = useMemo(() => (data
    ? buildContractTree({ ...data, links: mode === 'real' ? links : {} })
    : null), [data, links, mode])

  const employees = useMemo(() => {
    const map = new Map()
    for (const e of data?.employees || []) map.set(e.user_id, e.display_name || e.full_name || e.email || '')
    return map
  }, [data])

  const haystacks = useMemo(() => new Map((tree?.roots || []).map((r) => [r.key, rootHaystack(r)])), [tree])

  const objects = useMemo(() => {
    const map = new Map()
    for (const r of tree?.roots || []) if (r.doc.object_id) map.set(r.doc.object_id, r.doc.objects?.name || '—')
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'))
  }, [tree])

  const q = search.trim().toLowerCase()
  const shownRoots = useMemo(() => {
    if (!tree) return []
    let list = tree.roots
    if (objectId) list = list.filter((r) => r.doc.object_id === objectId)
    if (withRequests) list = list.filter((r) => r.stats.total > 0)
    if (onlyActive) list = list.filter((r) => r.stats.active > 0)
    if (q) list = list.filter((r) => haystacks.get(r.key)?.includes(q))
    return [...list].sort((a, b) => (b.stats.overdue > 0) - (a.stats.overdue > 0)
      || (b.stats.active > 0) - (a.stats.active > 0)
      || String(b.stats.latest || '').localeCompare(String(a.stats.latest || '')))
  }, [tree, objectId, withRequests, onlyActive, q, haystacks])

  const autoOpen = q.length >= 2 && shownRoots.length <= 3

  // ── Выбор и подсветка ──
  const pulse = (key) => {
    setFlash(key)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 1800)
  }
  const openRootOf = (docId) => {
    const root = tree?.rootOf.get(docId)
    if (root) setExpanded((s) => (s.has(root.key) ? s : new Set(s).add(root.key)))
  }
  const select = useCallback((key) => {
    setSelected((cur) => (cur === key ? null : key))
  }, [])
  const toggleRoot = (key) => setExpanded((s) => {
    const next = new Set(s)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  useEffect(() => {
    if (!selected) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  // ── Действия ──
  // В примере — меняют набор на экране; в реальных данных — привязка в браузере, остальное — пояснение.
  const nextNumber = (list) => list.reduce((m, r) => Math.max(m, Number(r.request_number) || 0), 0) + 1

  const linkItem = (item, doc) => {
    if (mode === 'real') {
      const next = { ...links, [item.key]: doc.id }
      setLinks(next)
      writeLocal(LINKS_KEY, next)
    } else {
      setDemo((d) => {
        const patch = (list) => list.map((r) => {
          if (r.id !== item.id) return r
          if (item.kind !== KIND.DC) return { ...r, contract_id: doc.id }
          if (isContractDoc(doc)) return { ...r, contract_id: doc.id, amendment_id: null }
          return { ...r, contract_id: doc.root_contract_id || doc.parent_contract_id, amendment_id: doc.id }
        })
        if (item.kind === KIND.DC) return { ...d, dcRequests: patch(d.dcRequests) }
        if (item.kind === KIND.CHECK) return { ...d, checks: patch(d.checks) }
        return { ...d, dpRequests: patch(d.dpRequests) }
      })
    }
    openRootOf(doc.id)
    setSelected(item.key)
    pulse(item.key)
  }

  const unlinkItem = (item) => {
    const next = { ...links }
    delete next[item.key]
    setLinks(next)
    writeLocal(LINKS_KEY, next)
  }

  const explain = (title, text) => setInfo({ title, text })

  // Новые строки примера считаются от текущего набора (не внутри setDemo: StrictMode вызывает обновление дважды).
  const nowIso = () => new Date().toISOString()
  const today = () => nowIso().slice(0, 10)
  const nextDisplayId = () => Math.max(0, ...demo.contracts.map((c) => c.display_id || 0)) + 1
  const showNew = (key, docId) => {
    if (docId) openRootOf(docId)
    setSelected(key)
    pulse(key)
  }

  const createDs = (item) => {
    const r = item.raw
    const contract = tree.idx.byId.get(item.link?.targetId)
    if (!contract) return
    const amount = r.amount_after ?? r.amount_contractor ?? null
    if (mode === 'real') {
      explain('Создать ДС из заявки', `Откроется форма ДС к ${docTitle(contract)}: номер «${r.ds_number || '—'}», `
        + `сумма${amount != null ? ` ${formatMoney(amount)}` : ''} и предмет — из заявки на ДС ${item.number}. `
        + 'После сохранения заявка встанет под новым ДС. В эксперименте настоящие данные не меняются — '
        + 'как это работает, видно в «Примере».')
      return
    }
    const id = `demo-ds-${Date.now()}`
    const ds = {
      ...contract,
      id,
      display_id: nextDisplayId(),
      record_type: r.ds_type === 'psdc_change' ? 'ds_vor' : 'ds_extra',
      parent_contract_id: contract.id,
      root_contract_id: contract.id,
      contract_number: r.ds_number || String((tree.idx.dsOf.get(contract.id) || []).length + 1),
      contract_date: today(),
      status: 'new_request',
      contract_amount: amount,
      psdc_total: null,
      signed_date: null,
      work_name: r.works_description || '',
      created_at: nowIso(),
    }
    setDemo({
      ...demo,
      contracts: [...demo.contracts, ds],
      dcRequests: demo.dcRequests.map((x) => (x.id === r.id ? { ...x, amendment_id: id } : x)),
    })
    showNew(`doc:${id}`)
  }

  const createContract = (item) => {
    const r = item.raw
    if (mode === 'real') {
      explain('Оформить договор по заявке', `Откроется форма договора: объект${r.objects?.name ? ` «${r.objects.name}»` : ''}`
        + `${r.amount != null ? `, сумма ${formatMoney(r.amount)}` : ''}, номер — следующий по нумерации объекта. `
        + `После сохранения заявка на ДП ${item.number} станет основанием договора и встанет в его ветку. `
        + 'В эксперименте настоящие данные не меняются.')
      return
    }
    const id = `demo-c-${Date.now()}`
    const obj = demo.contracts.find((c) => c.object_id === r.object_id)?.objects || r.objects
    const contract = {
      id,
      display_id: nextDisplayId(),
      record_type: 'dp',
      parent_contract_id: null,
      root_contract_id: null,
      contract_number: nextDemoContractNumber(demo.contracts, r.object_id),
      contract_date: today(),
      status: 'new_request',
      contract_amount: r.amount ?? null,
      currency: 'RUB',
      work_name: r.reason || '',
      object_id: r.object_id,
      objects: obj ? { name: obj.name, status: obj.status } : null,
      counterparty_id: null,
      counterparties: null,
      contract_counterparties: [],
      responsible: null,
      deleted_at: null,
      created_at: nowIso(),
    }
    setDemo({
      ...demo,
      contracts: [...demo.contracts, contract],
      dpRequests: demo.dpRequests.map((x) => (x.id === r.id ? { ...x, contract_id: id } : x)),
    })
    setExpanded((s) => new Set(s).add(id))
    showNew(`doc:${id}`)
  }

  const addCheck = (doc) => {
    if (mode === 'real') {
      explain('Отправить на проверку', `Откроется окно новой заявки на проверку: объект, контрагент, вид и номер документа `
        + `(${docTitle(doc)}) уже заполнены, заявка сразу в ветке документа и в колонке «Новые заявки» доски. `
        + 'В эксперименте настоящие данные не меняются.')
      return
    }
    const id = `demo-ch-${Date.now()}`
    const row = {
      id, request_number: nextNumber(demo.checks), doc_type: isContractDoc(doc) ? 'dp' : 'ds', status: 'new',
      object_id: doc.object_id, objects: doc.objects ? { name: doc.objects.name } : null,
      counterparty_id: doc.counterparty_id, counterparties: doc.counterparties ? { name: doc.counterparties.name } : null,
      contract_id: doc.id, doc_number: doc.contract_number, doc_date: doc.contract_date, notes: '',
      assignee_ids: [], due_date: null, archived_at: null, created_by_name: 'Вы',
      deleted_at: null, created_at: nowIso(), updated_at: nowIso(),
    }
    setDemo({ ...demo, checks: [...demo.checks, row] })
    showNew(`check:${id}`, doc.id)
  }

  const addDc = (contract) => {
    if (mode === 'real') {
      explain('Новая заявка на ДС', `Откроется форма заявки на ДС: объект, контрагент и договор (${docTitle(contract)}) `
        + 'уже выбраны. Заявка сразу встанет в ветку договора, а когда по ней создадут ДС — под это ДС. '
        + 'В эксперименте настоящие данные не меняются.')
      return
    }
    const id = `demo-dc-${Date.now()}`
    const dsNumbers = demo.contracts.filter((c) => c.root_contract_id === contract.id).map((c) => Number(c.contract_number) || 0)
    const pending = demo.dcRequests.filter((x) => x.contract_id === contract.id && !x.amendment_id).map((x) => Number(x.ds_number) || 0)
    const row = {
      id, request_number: nextNumber(demo.dcRequests), status: 'contract_check', check_status: 'not_checked',
      object_id: contract.object_id, objects: contract.objects ? { name: contract.objects.name } : null,
      counterparty_id: contract.counterparty_id,
      counterparties: contract.counterparties ? { name: contract.counterparties.name } : null,
      contract_id: contract.id, amendment_id: null, ds_number: String(Math.max(0, ...dsNumbers, ...pending) + 1), ds_type: null,
      works_description: '', amount_before: null, amount_contractor: null, amount_after: null,
      created_by_name: 'Вы', deleted_at: null, created_at: nowIso(), updated_at: nowIso(),
    }
    setDemo({ ...demo, dcRequests: [...demo.dcRequests, row] })
    showNew(`dc:${id}`, contract.id)
  }

  const resetDemo = () => {
    setDemo(makeDemoData())
    setSelected(null)
    setExpanded(new Set(['demo-c1']))
  }

  if (!allowed) return <AccessDenied />

  // ── Отрисовка ветки ──
  const reqActions = (item) => {
    if (item.kind === KIND.DC && item.link && !item.raw.amendment_id) {
      const target = tree.idx.byId.get(item.link.targetId)
      if (target && isContractDoc(target)) {
        return <button type="button" className="ctree-btn is-small" onClick={() => createDs(item)}>Создать ДС</button>
      }
    }
    if (item.kind === KIND.DP && !item.link && item.active) {
      return <button type="button" className="ctree-btn is-small" onClick={() => createContract(item)}>Оформить договор</button>
    }
    return null
  }

  const hitOf = (text) => !!q && String(text || '').toLowerCase().includes(q)
  const reqHit = (item) => hitOf([item.number, item.raw.ds_number, item.raw.doc_number, item.raw.counterparties?.name].join(' '))
  const docHit = (doc) => hitOf([doc.contract_number, doc.work_name].join(' '))

  const renderRequest = (item, prefix) => (
    <li key={item.key} className={`ctree-node${prefix ? ' is-basis' : ''}`}>
      <RequestLine
        item={item}
        employees={employees}
        selected={selected === item.key}
        flash={flash === item.key}
        hit={reqHit(item)}
        onSelect={select}
        actions={reqActions(item)}
        prefix={prefix}
      />
    </li>
  )

  const renderBranch = (root) => {
    const { doc, node, ds } = root
    const checks = node.requests.filter((r) => r.kind === KIND.CHECK)
    const dcs = node.requests.filter((r) => r.kind === KIND.DC)
    const children = checks.length + ds.length + dcs.length
    const isContract = isContractDoc(doc)
    return (
      <div className="ctree-branch">
        <div className="ctree-branch-head">
          <span className="ctree-branch-title">Ветка {isContract ? 'договора' : 'ДС'}</span>
          <div className="ctree-branch-actions">
            {isContract && <button type="button" className="ctree-btn is-small is-ghost" onClick={() => addDc(doc)}>+ Заявка на ДС</button>}
            <button type="button" className="ctree-btn is-small is-ghost" onClick={() => addCheck(doc)}>+ На проверку</button>
          </div>
        </div>
        <ul className="ctree-tree">
          {node.basis.map((b) => renderRequest(b, 'основание'))}
          <li className="ctree-node is-trunk">
            <DocLine doc={doc} trunk selected={selected === `doc:${doc.id}`} flash={flash === `doc:${doc.id}`}
              hit={docHit(doc)} onSelect={select} />
            {children > 0 ? (
              <ul>
                {checks.map((c) => renderRequest(c))}
                {ds.map((n) => (
                  <li key={n.doc.id} className="ctree-node">
                    <DocLine
                      doc={n.doc}
                      parentDoc={n.doc.parent_contract_id && n.doc.parent_contract_id !== doc.id ? tree.idx.byId.get(n.doc.parent_contract_id) : null}
                      selected={selected === `doc:${n.doc.id}`}
                      flash={flash === `doc:${n.doc.id}`}
                      hit={docHit(n.doc)}
                      onSelect={select}
                      actions={<button type="button" className="ctree-btn is-small is-ghost ctree-hover-action" onClick={() => addCheck(n.doc)}>+ На проверку</button>}
                    />
                    {n.requests.length > 0 && <ul>{n.requests.map((r) => renderRequest(r))}</ul>}
                  </li>
                ))}
                {dcs.map((c) => renderRequest(c))}
              </ul>
            ) : (
              <p className="ctree-empty">Веток пока нет: ни ДС, ни заявок по {isContract ? 'договору' : 'этому ДС'}.</p>
            )}
          </li>
        </ul>
      </div>
    )
  }

  const kindCount = (stats, kind) => stats.byKind[kind]

  // ── Карточка справа ──
  let card = null
  if (selected && tree) {
    if (selected.startsWith('doc:')) {
      const doc = tree.idx.byId.get(selected.slice(4))
      if (doc) {
        card = (
          <DocCard doc={doc} tree={tree} mode={mode} actions={(
            <>
              {isContractDoc(doc) && <button type="button" className="ctree-btn" onClick={() => addDc(doc)}>+ Заявка на ДС</button>}
              <button type="button" className="ctree-btn" onClick={() => addCheck(doc)}>+ На проверку</button>
            </>
          )} />
        )
      }
    } else {
      const item = tree.items.get(selected)
      if (item) {
        card = (
          <RequestCard item={item} tree={tree} employees={employees} mode={mode} actions={reqActions(item)}
            onSelect={(key) => { setSelected(key); openRootOf(key.slice(4)) }} onLink={linkItem} onUnlink={unlinkItem} />
        )
      }
    }
  }

  const looseActive = tree ? {
    dp: tree.loose.dp.filter((i) => i.active).length,
    dc: tree.loose.dc.filter((i) => i.active).length,
    check: tree.loose.check.filter((i) => i.active).length,
  } : { dp: 0, dc: 0, check: 0 }
  const looseTotal = tree ? tree.loose.dp.length + tree.loose.dc.length + tree.loose.check.length : 0
  const contractsCount = tree ? tree.idx.live.length : 0

  const LOOSE_GROUPS = [
    { kind: KIND.DP, title: 'Заявки на ДП — ждут договора' },
    { kind: KIND.DC, title: 'Заявки на ДС без договора' },
    { kind: KIND.CHECK, title: 'Проверки ДП/ДС без договора' },
  ]

  return (
    <div className={`ctree-page ui-work${card ? ' has-card' : ''}`}>
      <header className="ctree-header">
        <h2>
          <IconTile tone="sand" className="page-icon-tile"><IconFolderTree size={18} /></IconTile>
          Дерево договоров
          <span className="ctree-exp" title="Страница видна только администратору">Эксперимент · только администратору</span>
        </h2>
        <div className="ctree-mode" role="tablist" aria-label="Данные">
          {[['demo', 'Пример'], ['real', 'Реальные данные']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={mode === key}
              className={`ctree-mode-btn${mode === key ? ' is-active' : ''}`} onClick={() => switchMode(key)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <p className="ctree-intro">
        Договор — ствол, ДС и заявки — ветки. Нажмите на строку договора, чтобы раскрыть ветку, на заявку или документ —
        откроется карточка справа.{' '}
        {mode === 'demo'
          ? 'В примере договоры выдуманы, а действия работают: «Создать ДС», «Оформить договор», «Привязать», «+ На проверку». Ничего не сохраняется.'
          : 'Данные из базы, только чтение. Проверки и заявки на ДП пока связываются с договором по контрагенту, объекту и номеру; ручная привязка запоминается только в этом браузере.'}
        {mode === 'demo' && <button type="button" className="ctree-link-btn" onClick={resetDemo}>Вернуть пример как был</button>}
      </p>

      {/* Будущая полоса раздела: дерево и рабочие места заявок рядом, вместо отдельных плиток. */}
      <nav className="ctree-sections" aria-label="Разделы договоров">
        <span className="ctree-section is-current">Дерево договоров</span>
        <Link className="ctree-section" to={CONTRACTS_REGISTRY_PATH}>Реестр<span className="ctree-section-count">{tree ? contractsCount : '…'}</span></Link>
        <Link className="ctree-section tone-green" to="/dc-requests">Заявки на ДС<span className="ctree-section-count">{tree ? tree.totals.dc : '…'}</span></Link>
        <Link className="ctree-section tone-slate" to="/doc-check-requests">Проверка ДП/ДС<span className="ctree-section-count">{tree ? tree.totals.check : '…'}</span></Link>
        <Link className="ctree-section tone-violet" to="/dp-requests">Заявки на ДП<span className="ctree-section-count">{tree ? tree.totals.dp : '…'}</span></Link>
        <span className="ctree-sections-note">{mode === 'demo' ? 'числа — по примеру; ' : ''}у заявок — сколько в работе</span>
      </nav>

      <div className="ctree-legend" aria-label="Обозначения">
        <span><span className="ctree-tag tone-blue">Договор</span><span className="ctree-tag tone-sky">ДС</span> — документы реестра</span>
        <span><KindTag kind="dp" /> основание договора</span>
        <span><KindTag kind="check" /> проверка документа</span>
        <span><KindTag kind="dc" /> заявка на ДС</span>
        <span className="ctree-legend-steps"><span className="ctree-steps tone-slate"><span className="ctree-dot is-done" /><span className="ctree-dot is-current" /><span className="ctree-dot" /></span> этапы: пройдено · сейчас · впереди</span>
      </div>

      {mode === 'real' && real.status === 'loading' && <div className="ctree-state">Загружаем договоры и заявки…</div>}
      {mode === 'real' && real.status === 'error' && (
        <div className="ctree-state is-error">
          Не удалось загрузить: {real.error}{' '}
          <button type="button" className="ctree-link-btn" onClick={loadReal}>Повторить</button>
        </div>
      )}
      {mode === 'real' && real.data?.missing?.length > 0 && (
        <div className="ctree-state">Нет в базе: {real.data.missing.join(', ')} — эти ветки не показаны.</div>
      )}

      {tree && (
        <>
          {looseTotal > 0 && (
            <section className={`ctree-loose${looseOpen ? ' is-open' : ''}`} aria-label="Заявки без договора">
              <button type="button" className="ctree-loose-head" aria-expanded={looseOpen} onClick={() => setLooseOpen((v) => !v)}>
                <span className="ctree-loose-chev" aria-hidden>▸</span>
                <strong>Без договора:</strong>
                {looseActive.dp > 0 && (
                  <span className="tone-violet">
                    {looseActive.dp} {plural(looseActive.dp, 'заявка', 'заявки', 'заявок')} на ДП {looseActive.dp === 1 ? 'ждёт' : 'ждут'} договора
                  </span>
                )}
                {looseActive.dc > 0 && (
                  <span className="tone-green">{looseActive.dc} {plural(looseActive.dc, 'заявка', 'заявки', 'заявок')} на ДС</span>
                )}
                {looseActive.check > 0 && (
                  <span className="tone-slate">{looseActive.check} {plural(looseActive.check, 'проверка', 'проверки', 'проверок')}</span>
                )}
                {looseActive.dp + looseActive.dc + looseActive.check === 0 && <span>в работе нет</span>}
                {looseTotal > looseActive.dp + looseActive.dc + looseActive.check && (
                  <span className="ctree-subtle">и {looseTotal - looseActive.dp - looseActive.dc - looseActive.check} завершённых</span>
                )}
                <span className="ctree-loose-cta">{looseOpen ? 'Свернуть' : 'Разобрать'}</span>
              </button>
              {looseOpen && (
                <div className="ctree-loose-body">
                  {LOOSE_GROUPS.map(({ kind, title }) => {
                    const all = tree.loose[kind]
                    const list = looseDone ? all : all.filter((i) => i.active)
                    const hidden = all.length - list.length
                    if (all.length === 0) return null
                    return (
                      <div key={kind} className="ctree-loose-group">
                        <h3>{title} <span className="ctree-subtle">{list.length}</span></h3>
                        {list.length === 0 && <p className="ctree-empty">В работе таких нет.</p>}
                        <ul className="ctree-loose-list">
                          {list.slice(0, 40).map((item) => (
                            <li key={item.key} className="ctree-loose-item">
                              <RequestLine item={item} employees={employees} selected={selected === item.key}
                                flash={flash === item.key} onSelect={select} actions={reqActions(item)} />
                              <div className="ctree-loose-meta">
                                {[item.raw.objects?.name, item.raw.counterparties?.name,
                                  item.kind === KIND.CHECK ? checkDocLabel(item.raw) : '',
                                  item.kind === KIND.DC && item.raw.ds_number ? `ДС № ${item.raw.ds_number}` : ''].filter(Boolean).join(' · ')}
                              </div>
                              <TargetPicker item={item} idx={tree.idx} onLink={linkItem} compact />
                            </li>
                          ))}
                        </ul>
                        {list.length > 40 && <p className="ctree-subtle">и ещё {list.length - 40} — найдите поиском в карточке заявки</p>}
                        {hidden > 0 && !looseDone && (
                          <button type="button" className="ctree-link-btn" onClick={() => setLooseDone(true)}>
                            ещё {hidden} завершённых
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {looseDone && <button type="button" className="ctree-link-btn" onClick={() => setLooseDone(false)}>Скрыть завершённые</button>}
                </div>
              )}
            </section>
          )}

          <div className="ctree-toolbar">
            <div className="ctree-search">
              <IconSearch />
              <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE) }}
                placeholder="№ договора, ДС или заявки, контрагент" aria-label="Поиск по договорам, ДС и заявкам" />
            </div>
            <select value={objectId} onChange={(e) => { setObjectId(e.target.value); setLimit(PAGE) }} aria-label="Объект">
              <option value="">Все объекты</option>
              {objects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <button type="button" className={`ctree-toggle${withRequests ? ' is-on' : ''}`} aria-pressed={withRequests}
              onClick={() => { setWithRequests((v) => !v); setLimit(PAGE) }}>
              Только с заявками
            </button>
            <button type="button" className={`ctree-toggle${onlyActive ? ' is-on' : ''}`} aria-pressed={onlyActive}
              onClick={() => { setOnlyActive((v) => !v); setLimit(PAGE) }}>
              Есть заявки в работе
            </button>
            <span className="ctree-count">Договоров: {shownRoots.length}</span>
          </div>

          <div className="ctree-list" role="list">
            <div className="ctree-row ctree-row-head" aria-hidden>
              <span />
              <span>Документ</span>
              <span>Контрагент и объект</span>
              <span>Работы</span>
              <span className="is-num">Сумма</span>
              <span>Статус</span>
              <span>Ветки</span>
            </div>
            {shownRoots.length === 0 && <div className="ctree-state">Ничего не нашлось.</div>}
            {shownRoots.slice(0, limit).map((root) => {
              const { doc, stats } = root
              const open = expanded.has(root.key) || autoOpen
              const st = contractStatus(doc)
              return (
                <div key={root.key} role="listitem" className={`ctree-root${open ? ' is-open' : ''}${flash === `doc:${doc.id}` ? ' is-flash' : ''}`}>
                  <button type="button" className="ctree-row" aria-expanded={open} onClick={() => toggleRoot(root.key)}>
                    <span className="ctree-chev" aria-hidden>▸</span>
                    <span className="ctree-cell-doc">
                      <strong>{doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'}</strong>
                      <span className="ctree-subtle">
                        {[!isContractDoc(doc) ? 'ДС без договора в реестре' : '', doc.contract_date ? `от ${formatDateRu(doc.contract_date)}` : '',
                          doc.display_id != null ? `ID ${doc.display_id}` : ''].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="ctree-cell-party">
                      <span>{doc.counterparties?.name || <span className="ctree-subtle">контрагент не указан</span>}</span>
                      <span className="ctree-subtle">{doc.objects?.name || 'объект не указан'}</span>
                    </span>
                    <span className="ctree-cell-work" title={doc.work_name || ''}>{doc.work_name || '—'}</span>
                    <span className="ctree-cell-amount">{shortMoney(docAmount(doc)) || '—'}</span>
                    <span><Pill state={st.state}>{st.label}</Pill></span>
                    <span className="ctree-cell-branches">
                      {stats.ds > 0 && <span className="ctree-mini tone-sky" title="Дополнительных соглашений">ДС {stats.ds}</span>}
                      {['dp', 'check', 'dc'].map((k) => kindCount(stats, k) > 0 && (
                        <span key={k} className={`ctree-mini tone-${KIND_META[k].tone}`} title={KIND_META[k].label}>
                          <span className="ctree-mini-dot" />{kindCount(stats, k)}
                        </span>
                      ))}
                      {stats.active > 0 && (
                        <span className={`ctree-active${stats.overdue ? ' is-overdue' : ''}`}
                          title={stats.overdue ? `Просрочено: ${stats.overdue}` : 'Не закончены'}>
                          ● {stats.active} в работе
                        </span>
                      )}
                      {stats.total === 0 && stats.ds === 0 && <span className="ctree-subtle">веток нет</span>}
                    </span>
                  </button>
                  {open && renderBranch(root)}
                </div>
              )
            })}
            {shownRoots.length > limit && (
              <button type="button" className="ctree-more" onClick={() => setLimit((n) => n + PAGE)}>
                Показать ещё {Math.min(PAGE, shownRoots.length - limit)} из {shownRoots.length - limit}
              </button>
            )}
          </div>
        </>
      )}

      {card && (
        <aside className="ctree-card" aria-label="Карточка">
          <button type="button" className="ctree-card-close" aria-label="Закрыть карточку" onClick={() => setSelected(null)}>
            <IconClose size={16} />
          </button>
          {card}
        </aside>
      )}

      {info && (
        <div className="ctree-info-overlay" role="presentation" onClick={() => setInfo(null)}>
          <div className="ctree-info" role="dialog" aria-modal="true" aria-label={info.title} onClick={(e) => e.stopPropagation()}>
            <h3>{info.title}</h3>
            <p>{info.text}</p>
            <div className="ctree-card-actions">
              <button type="button" className="ctree-btn" onClick={() => setInfo(null)} autoFocus>Понятно</button>
              <button type="button" className="ctree-btn is-ghost" onClick={() => { setInfo(null); switchMode('demo') }}>Показать в примере</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
