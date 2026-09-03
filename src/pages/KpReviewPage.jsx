import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { fetchProposalFilesForReview, setRemarksSent, setSummaryAdded } from '../services/tenderProposalFiles'
import KpReviewBadge from '../components/KpReviewBadge'
import KpReviewModal from '../components/KpReviewModal'
import S3DocumentPreview from '../components/S3DocumentPreview'
import VirtualTableBody from '../components/VirtualTableBody'
import './KpReviewPage.css'

// Порог включения виртуализации <tbody>: ниже него распорки и замеры высот
// только мешают, выше — обычная таблица начинает подтормаживать.
const VIRTUALIZE_FROM = 150

// task 431: вкладка «Проверка КП» — очередь коммерческих предложений на проверку
// аналитиком-экономистом. Показывает все загруженные КП с их статусом проверки;
// экономист/админ проставляет «проверено» или «есть замечания».

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

// Небольшая SVG-иконка документа (проект использует SVG-иконки, не эмодзи).
const IconFile = () => (
  <svg className="kprv-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)

// Этап (стадия) КП. После вердикта аналитика путь расходится, и занесение в
// сводную таблицу есть в каждой ветке — но это разные очереди работы, поэтому и
// этапы разные (миграции 20260824, 20260826):
//
//   pending           — на проверке, ждёт аналитика (общее начало всех веток)
//
//   ветка «без замечаний»:
//   ok_summary        — вердикт «нет замечаний», в сводную ещё не внесено
//   ok_done           — внесено, работа по КП закончена
//
//   ветка «с замечаниями» → подветка «для отправки подрядчику»:
//   remarks_work      — общая очередь на две ПАРАЛЛЕЛЬНЫЕ задачи инженера:
//                       занести в сводную и отправить замечания подрядчику.
//                       Порядок не важен, этап закрыт, когда сделано и то, и то
//   remarks_sent      — обе задачи выполнены, работа по КП закончена
//
//   ветка «с замечаниями» → подветка «без отправки подрядчику»:
//   nosend_summary    — в сводную ещё не внесено
//   nosend_done       — внесено, работа по КП закончена (отправки нет)
//
// remarks_send_required читаем строго через === false: у КП, проверенных до
// миграции 20260826, поля нет, и они должны остаться на прежнем маршруте.
function stageOf(r) {
  if (r.review_status === 'approved') return r.summary_added ? 'ok_done' : 'ok_summary'
  if (r.review_status === 'has_remarks') {
    if (r.remarks_send_required === false) {
      return r.summary_added ? 'nosend_done' : 'nosend_summary'
    }
    return r.summary_added && r.remarks_sent ? 'remarks_sent' : 'remarks_work'
  }
  return 'pending'
}

const STAGE_KEYS = [
  'pending',
  'ok_summary', 'ok_done',
  'remarks_work', 'remarks_sent',
  'nosend_summary', 'nosend_done',
]

// Узлы схемы = очереди работы = вкладки, один в один. tone — цветовой тон,
// actor — кто делает следующий шаг, title — полная подпись для всплывающей
// подсказки (в трёх ветках есть одноимённые узлы «К занесению в сводную»).
// terminal — конечная точка ветки, помечаем галочкой.
const TAB_META = {
  pending: { label: 'На проверке', tone: 'pending', actor: 'аналитик' },
  ok_summary: { label: 'К занесению в сводную', tone: 'summary', actor: 'инженер', title: 'Без замечаний · к занесению в сводную таблицу' },
  ok_done: { label: 'Готово', tone: 'ok', terminal: true, title: 'Без замечаний · работа по КП закончена' },
  // Один этап на две параллельные задачи инженера — порядок между ними не
  // навязываем, важно лишь, чтобы к концу этапа обе были выполнены.
  remarks_work: {
    label: 'Сводная + отправка',
    tone: 'warn',
    actor: 'инженер · параллельно',
    title: 'С замечаниями · параллельно: занести в сводную таблицу и отправить замечания подрядчику',
  },
  remarks_sent: { label: 'Отправлено', tone: 'sent', actor: 'инженер', terminal: true, title: 'С замечаниями · внесено в сводную и отправлено подрядчику' },
  nosend_summary: { label: 'К занесению в сводную', tone: 'summary', actor: 'инженер', title: 'С замечаниями · без отправки подрядчику · к занесению в сводную таблицу' },
  nosend_done: { label: 'Готово', tone: 'ok', terminal: true, title: 'С замечаниями · без отправки подрядчику · работа по КП закончена' },
  all: { label: 'Все', tone: 'all', title: 'Все КП независимо от этапа' },
}

const IconDone = () => (
  <svg className="kprv-flow-done-icon" width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

// План затрат тендера: ссылка, если она есть, иначе — стадия работы над планом.
// Метки те же, что на странице «Планы затрат», чтобы не расходились названия.
const COST_PLAN_LABEL = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
  not_required: 'Не требуется',
}

function CostPlanCell({ tender }) {
  const link = tender?.cost_plan_link
  if (link) {
    return (
      <a href={link} target="_blank" rel="noopener noreferrer" className="kprv-link" title={link}>
        Открыть
      </a>
    )
  }
  const status = tender?.cost_plan_status || 'not_started'
  // «Завершён» без ссылки — рассогласование данных, помечаем явно: иначе
  // выглядит как готовый план, который просто некуда открыть.
  if (status === 'completed') {
    return <span className="kprv-plan-warn" title="Статус «Завершён», но ссылка не указана">Нет ссылки</span>
  }
  return <span className="kprv-muted">{COST_PLAN_LABEL[status] || COST_PLAN_LABEL.not_started}</span>
}

// Сортировка: активное направление — повёрнутый шеврон, неактивный столбец —
// тот же шеврон приглушённым, чтобы было видно, что колонка кликабельна.
const IconSort = () => (
  <svg className="kprv-sort-icon" width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

// Значение для сортировки. null → строка уходит вниз при любом направлении:
// «нет данных» это не «самое маленькое».
function sortValue(r, key) {
  if (key === 'tender_no') {
    const n = r.tenders?.public_tender_number
    return typeof n === 'number' ? n : null
  }
  const iso = key === 'reviewed_at' ? r.reviewed_at : r.created_at
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : t
}

function SortTh({ label, sortKey, sort, onSort, className = '' }) {
  const active = sort.key === sortKey
  return (
    <th
      className={`kprv-th-sort${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="kprv-sort-btn" onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <span className={`kprv-sort-mark is-${active ? sort.dir : 'off'}`}><IconSort /></span>
      </button>
    </th>
  )
}

// Узел схемы: обычная кнопка, поэтому доступна с клавиатуры и получает фокус.
function FlowTab({ tabKey, tab, counts, onSelect }) {
  const m = TAB_META[tabKey]
  const isActive = tab === tabKey
  const count = counts[tabKey] ?? 0
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      title={m.title || m.label}
      className={`kprv-flow-step is-${m.tone}${isActive ? ' is-active' : ''}`}
      onClick={() => onSelect(tabKey)}
    >
      {/* Точка тона — единственный цветной элемент неактивного узла: маршрут
          читается по цвету, но пёстрым полотном схема не становится. */}
      <span className="kprv-flow-dot" aria-hidden />
      <span className="kprv-flow-text">
        <span className="kprv-flow-label">
          {m.terminal && <IconDone />}
          {m.label}
        </span>
        {m.actor && <small className="kprv-flow-actor">{m.actor}</small>}
      </span>
      {/* Нули приглушены — взгляд идёт к очередям, где есть работа. */}
      <span className={`kprv-flow-count${count ? '' : ' is-zero'}`}>{count}</span>
    </button>
  )
}

function KpReviewPage() {
  const { isAdmin, isSuperAdmin, role, scopedObjectIds, userProfile, user } = useRole()
  // Аналитик-экономист (или админ) проставляет вердикт/замечания.
  // isSuperAdmin — доступ по e-mail (RoleContext): суперпользователь проверяет КП
  // всегда, даже когда переключился на другую роль для проверки интерфейса.
  const canReview = isAdmin || isSuperAdmin || role === 'economist'
  // Инженер (или админ) отмечает отправку замечаний контрагенту.
  const canSend = isAdmin || isSuperAdmin || role === 'engineer'

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('pending')
  const [search, setSearch] = useState('')
  // По умолчанию — как раньше: свежие КП сверху.
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' })
  const [reviewFile, setReviewFile] = useState(null)
  const [previewDoc, setPreviewDoc] = useState(null)
  // Скролл-контейнер таблицы — из него виртуализация берёт положение прокрутки.
  const tableWrapRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchProposalFilesForReview({
        objectIds: scopedObjectIds.length ? scopedObjectIds : null,
      })
      setRows(data)
    } catch (e) {
      setError(e.message || 'Не удалось загрузить КП на проверку')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  const handleSend = async (r, sent) => {
    try {
      await setRemarksSent(r.id, { sent, sender: userProfile?.full_name || user?.email || '' })
      load()
    } catch (e) {
      alert('Ошибка отметки отправки: ' + (e.message || e))
    }
  }

  // Занесение в сводную отмечает тот же, кто ведёт переписку с контрагентом.
  const handleSummary = async (r, added) => {
    try {
      await setSummaryAdded(r.id, { added, author: userProfile?.full_name || user?.email || '' })
      load()
    } catch (e) {
      alert('Ошибка отметки о занесении в сводную: ' + (e.message || e))
    }
  }

  // Первый клик по новому столбцу: номер — по возрастанию, даты — от свежих.
  const toggleSort = useCallback((key) => {
    setSort(s => (s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'tender_no' ? 'asc' : 'desc' }))
  }, [])

  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGE_KEYS.map(k => [k, 0]))
    c.all = rows.length
    for (const r of rows) { const st = stageOf(r); c[st] = (c[st] || 0) + 1 }
    return c
  }, [rows])

  const visibleRows = useMemo(() => {
    const s = search.trim().toLowerCase()
    const filtered = rows.filter(r => {
      if (tab !== 'all' && stageOf(r) !== tab) return false
      if (!s) return true
      const hay = [
        r.counterparties?.name,
        r.tenders?.public_tender_number,
        r.tenders?.work_description,
        r.tenders?.objects?.name,
        r.s3?.file_name,
        r.tenders?.responsible_contact?.full_name,
        r.reviewed_by,
      ].filter(v => v != null && v !== '').join(' ').toLowerCase()
      return hay.includes(s)
    })
    const sign = sort.dir === 'asc' ? 1 : -1
    return filtered.sort((a, b) => {
      const va = sortValue(a, sort.key)
      const vb = sortValue(b, sort.key)
      if (va === null || vb === null) {
        if (va === vb) return 0
        return va === null ? 1 : -1
      }
      return (va - vb) * sign
    })
  }, [rows, tab, search, sort])

  return (
    <div className="kprv-page">
      <div className="kprv-header">
        <h2>Проверка КП</h2>
        <p className="kprv-hint">
          Коммерческие предложения контрагентов на проверку. Сюда попадают только КП,
          загруженные с момента запуска функции; ранее загруженные остаются в тендерах.
        </p>

        {/* Схема прохождения КП — она же навигация: каждый узел это очередь
            работы со своим счётчиком. Отдельного ряда вкладок нет, чтобы одно и
            то же не показывалось дважды.
            Вердикт аналитика («нет/есть замечаний») — подпись ветки, а не узел:
            это не очередь, кликать по нему незачем. */}
        <div className="kprv-flow" role="tablist" aria-label="Этапы проверки КП">
          <FlowTab tabKey="pending" tab={tab} counts={counts} onSelect={setTab} />
          <span className="kprv-flow-split">
            <span className="kprv-flow-row">
              <span className="kprv-flow-branch is-ok">без замечаний</span>
              <span className="kprv-flow-arrow" aria-hidden />
              <FlowTab tabKey="ok_summary" tab={tab} counts={counts} onSelect={setTab} />
              <span className="kprv-flow-arrow" aria-hidden />
              <FlowTab tabKey="ok_done" tab={tab} counts={counts} onSelect={setTab} />
            </span>
            {/* Замечания сами по себе развилка: часть уходит подрядчику, часть
                обрабатывается внутри и заканчивается на сводной таблице. */}
            <span className="kprv-flow-row">
              <span className="kprv-flow-branch is-warn">с замечаниями</span>
              <span className="kprv-flow-stem" aria-hidden />
              <span className="kprv-flow-split">
                <span className="kprv-flow-row">
                  <span className="kprv-flow-branch is-send">для отправки подрядчику</span>
                  <span className="kprv-flow-arrow" aria-hidden />
                  <FlowTab tabKey="remarks_work" tab={tab} counts={counts} onSelect={setTab} />
                  <span className="kprv-flow-arrow" aria-hidden />
                  <FlowTab tabKey="remarks_sent" tab={tab} counts={counts} onSelect={setTab} />
                </span>
                <span className="kprv-flow-row">
                  <span className="kprv-flow-branch is-nosend">без отправки подрядчику</span>
                  <span className="kprv-flow-arrow" aria-hidden />
                  <FlowTab tabKey="nosend_summary" tab={tab} counts={counts} onSelect={setTab} />
                  <span className="kprv-flow-arrow" aria-hidden />
                  <FlowTab tabKey="nosend_done" tab={tab} counts={counts} onSelect={setTab} />
                </span>
              </span>
            </span>
          </span>
          <FlowTab tabKey="all" tab={tab} counts={counts} onSelect={setTab} />
        </div>
      </div>

      <div className="kprv-toolbar">
        <input
          className="kprv-search"
          type="search"
          placeholder="Поиск: контрагент, тендер, объект, файл…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="kprv-empty">Загрузка…</div>
      ) : error ? (
        <div className="kprv-error">Ошибка: {error}</div>
      ) : visibleRows.length === 0 ? (
        <div className="kprv-empty">
          {{
            pending: 'Нет КП, ожидающих проверки.',
            ok_summary: 'Нет КП без замечаний, ожидающих занесения в сводную таблицу.',
            ok_done: 'Нет полностью отработанных КП без замечаний.',
            remarks_work: 'Нет КП с замечаниями, ожидающих занесения в сводную таблицу и отправки подрядчику.',
            remarks_sent: 'Нет КП с замечаниями, у которых сделано и занесение в сводную, и отправка подрядчику.',
            nosend_summary: 'Нет КП с замечаниями без отправки подрядчику, ожидающих занесения в сводную таблицу.',
            nosend_done: 'Нет отработанных КП с замечаниями без отправки подрядчику.',
          }[tab] || 'Нет записей.'}
        </div>
      ) : (
        <div className="kprv-table-wrap" ref={tableWrapRef}>
          <table className="kprv-table">
            {/* Ширины заданы явно и в долях: с table-layout:fixed браузер не
                подбирает их по содержимому, поэтому таблица всегда ровно по
                ширине экрана — без горизонтальной прокрутки и без колонок,
                схлопнутых в столбик букв. Сумма ровно 100%. */}
            <colgroup>
              <col style={{ width: '9%' }} />{/* Объект */}
              <col style={{ width: '5%' }} />{/* № тендера */}
              <col style={{ width: '12%' }} />{/* Тендер */}
              <col style={{ width: '10%' }} />{/* Контрагент */}
              <col style={{ width: '13%' }} />{/* КП */}
              <col style={{ width: '6%' }} />{/* Загружен */}
              <col style={{ width: '9%' }} />{/* Ответственный по тендеру */}
              <col style={{ width: '6%' }} />{/* План затрат */}
              <col style={{ width: '13%' }} />{/* Статус проверки */}
              <col style={{ width: '8%' }} />{/* Кто проверил */}
              <col style={{ width: '9%' }} />{/* Действия */}
            </colgroup>
            <thead>
              <tr>
                <th>Объект</th>
                <SortTh label="№ тендера" sortKey="tender_no" sort={sort} onSort={toggleSort} className="kprv-col-tnum" />
                <th>Тендер</th>
                <th>Контрагент</th>
                <th>КП</th>
                <SortTh label="Загружен" sortKey="created_at" sort={sort} onSort={toggleSort} />
                <th>Ответственный по тендеру</th>
                <th>План затрат</th>
                <th>Статус проверки</th>
                <SortTh label="Кто проверил" sortKey="reviewed_at" sort={sort} onSort={toggleSort} />
                <th className="kprv-col-action"></th>
              </tr>
            </thead>
            {(() => {
              const rowEls = visibleRows.map(r => (
                <tr key={r.id}>
                  <td className="kprv-col-object">{r.tenders?.objects?.name || '—'}</td>
                  <td className="kprv-col-tnum">
                    {r.tenders?.public_tender_number != null
                      ? (r.tenders?.id
                        ? <Link to={`/tenders/${r.tenders.id}`} className="kprv-link">№ {r.tenders.public_tender_number}</Link>
                        : `№ ${r.tenders.public_tender_number}`)
                      : <span className="kprv-muted">—</span>}
                  </td>
                  <td className="kprv-col-tender">
                    {r.tenders?.id ? (
                      <Link to={`/tenders/${r.tenders.id}`} className="kprv-link">
                        {r.tenders?.work_description || 'Тендер'}
                      </Link>
                    ) : (r.tenders?.work_description || '—')}
                  </td>
                  <td className="kprv-col-cp">{r.counterparties?.name || '—'}</td>
                  <td className="kprv-col-file">
                    <button
                      type="button"
                      className="kprv-file-btn"
                      title={r.s3?.file_name || 'Открыть КП'}
                      onClick={() => r.s3 && setPreviewDoc(r.s3)}
                      disabled={!r.s3}
                    >
                      <IconFile />
                      <span className="kprv-file-name">{r.s3?.file_name || '—'}</span>
                    </button>
                    {r.version_label && <span className="kprv-vlabel">{r.version_label}</span>}
                  </td>
                  <td className="kprv-col-date">{fmtDate(r.created_at)}</td>
                  <td className="kprv-col-resp">{r.tenders?.responsible_contact?.full_name || '—'}</td>
                  <td className="kprv-col-plan"><CostPlanCell tender={r.tenders} /></td>
                  <td className="kprv-col-review">
                    <KpReviewBadge file={r} canReview={canReview} onReview={setReviewFile} showRemarks />
                  </td>
                  <td className="kprv-col-reviewer">
                    {r.reviewed_by ? (
                      <>
                        <span className="kprv-reviewer-name">{r.reviewed_by}</span>
                        {r.reviewed_at && <span className="kprv-reviewer-date">{fmtDate(r.reviewed_at)}</span>}
                      </>
                    ) : <span className="kprv-muted">—</span>}
                  </td>
                  <td className="kprv-col-action">
                    <div className="kprv-actions">
                      {canReview && (
                        <button
                          type="button"
                          className="kprv-review-btn"
                          onClick={() => setReviewFile(r)}
                        >{r.review_status === 'pending' ? 'Проверить' : 'Изменить'}</button>
                      )}
                      {/* Занесение в сводную — общий шаг всех веток. */}
                      {canSend && (r.review_status === 'approved' || r.review_status === 'has_remarks') && (
                        r.summary_added ? (
                          <button
                            type="button"
                            className="kprv-send-btn is-undo"
                            title={r.summary_added_by ? `Занёс: ${r.summary_added_by}` : undefined}
                            onClick={() => handleSummary(r, false)}
                          >Отменить занесение</button>
                        ) : (
                          <button
                            type="button"
                            className="kprv-send-btn"
                            onClick={() => handleSummary(r, true)}
                          >Занесено в сводную</button>
                        )
                      )}
                      {/* Отправка замечаний идёт параллельно занесению в сводную:
                          порядок между ними не навязываем, ждать нечего. Только в
                          подветке «для отправки подрядчику». */}
                      {canSend && r.review_status === 'has_remarks'
                        && r.remarks_send_required !== false && (
                        r.remarks_sent ? (
                          <button
                            type="button"
                            className="kprv-send-btn is-undo"
                            title={r.remarks_sent_by ? `Отправил: ${r.remarks_sent_by}` : undefined}
                            onClick={() => handleSend(r, false)}
                          >Отменить отправку</button>
                        ) : (
                          <button
                            type="button"
                            className="kprv-send-btn"
                            onClick={() => handleSend(r, true)}
                          >Отправлено подрядчику</button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))
              // Очередь КП живёт постранично загруженной целиком (fetchAllRows),
              // и на тысяче строк обычный <tbody> заметно тормозит. Виртуализуем
              // только когда строк действительно много — на коротких списках
              // распорки и замеры высот ни к чему.
              return rowEls.length > VIRTUALIZE_FROM
                ? <VirtualTableBody rows={rowEls} colSpan={11} scrollRef={tableWrapRef} rowHeight={52} />
                : <tbody>{rowEls}</tbody>
            })()}
          </table>
        </div>
      )}

      {reviewFile && (
        <KpReviewModal
          file={reviewFile}
          onClose={() => setReviewFile(null)}
          onSaved={load}
        />
      )}
      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  )
}

export default KpReviewPage
