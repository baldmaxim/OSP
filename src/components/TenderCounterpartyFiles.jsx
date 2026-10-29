import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { requestDownloadUrl } from '../services/s3'
import {
  addProposalFile,
  deleteProposalFile,
  fetchProposalFiles,
} from '../services/tenderProposalFiles'
import { currentProposals, groupProposals, reviewSummary } from '../utils/proposalTimeline'
import { plural } from '../utils/taskHelpers'
import { IconDownload, IconTrash } from './icons/ActionIcons'
import { IconUser } from './icons/ToolbarIcons'
import S3DocumentPreview from './S3DocumentPreview'
import KpReviewModal from './KpReviewModal'
import KpReviewBadge from './KpReviewBadge'
import PersonName from './PersonName'
import TenderFilesZipButton from './TenderFilesZipButton'
import './TenderCounterpartyFiles.css'
// Токены рабочего стиля (--ui-link) и .ui-sr-only для PersonName: карточка тендера
// на рабочий стиль не переведена, а ячейка та же, что в реестре.
import '../styles/workUi.css'

// Файлы КП и сопутствующие документы одного контрагента в рамках тендера (task 290).
// Используется и в раскрытой строке реестра тендеров, и во вкладке «Участники» карточки.
//
// 29.10.2026 — лента по образцу «Проверки КП»: у каждого файла дата и время загрузки, кто
// загрузил, у КП — версия и проверка (вердикт, кто и когда проверил — в подсказке, замечания,
// сводная и отправка подрядчику). Имя файла само открывает просмотр — отдельной кнопки нет;
// рядом «Скачать» и, с правом правки, «Удалить». Новая версия КП выбирается в окне загрузки
// («+ КП» → «Новая версия КП от …»), а не кнопкой под каждым КП.
//
// Тот же день, позже (замечания пользователя: таблица перегружена, всё сливается, версии
// непонятны):
//   • КП — блоками по группам версий (utils/proposalTimeline.js, groupProposals): «КП 1 · 2
//     версии», внутри версии «в1», «в2» по порядку загрузки, последняя — текущая, прежние
//     приглушены; блоки КП разделены промежутком;
//   • имя файла — в одну строку (основа — многоточием, расширение видно, полное — в подсказке);
//   • состояние проверки — только полосой слева у блока КП (зелёная — проверено, янтарная —
//     замечания, серая — ждёт проверки или без неё), фон и рамка не красятся;
//   • строка сведений одна: дата и время, кто загрузил, метка, проверка и шаги;
//   • сверху — строка-сводка «КП · N» со стрелкой и кнопками «+ КП», «+ Документ», «Скачать
//     всё»: стрелка сворачивает файлы участника, галочка «Свернуть всё» над таблицей
//     (ParticipantsCollapseToggle, проп collapsed) — всех сразу;
//   • у текущей версии КП (это и есть ВОР подрядчика) «Скачать» — кнопкой с подписью и акцентом, у
//     прежних версий и документов — значком.
// «Скачать всё» — все файлы только этого участника одним ZIP; кнопка есть, только когда файлы
// есть. tender — для имени архива (№ и работы), counterpartyName — название компании.

// Документов больше — список свёрнут до нажатия на «Документы · N».
const DOCS_OPEN_MAX = 3

function formatBytes(bytes) {
  if (bytes == null) return ''
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const pad2 = (x) => String(x).padStart(2, '0')
const asDate = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

// «21.10.26» — год двумя цифрами, как в «Проверке КП»; полностью — в подсказке.
function fmtDate(iso) {
  const d = asDate(iso)
  return d ? `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)}` : '—'
}

function fmtTime(iso) {
  const d = asDate(iso)
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : ''
}

function fmtDateTime(iso) {
  const d = asDate(iso)
  return d ? `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${fmtTime(iso)}` : ''
}

// Имя файла в строке: основа и расширение порознь — длинная основа сокращается многоточием
// (CSS), расширение остаётся видно (как в «Проверке КП»).
function splitFileName(name) {
  const m = /^(.+?)(\.[^.\s]{1,5})$/.exec(name || '')
  return m ? [m[1], m[2]] : [name || '', '']
}

const versionsWord = (n) => plural(n, 'версия', 'версии', 'версий')

// Тип файла — цветом значка (таблица, PDF, Word, архив, картинка; прочее — серым): при беглом
// взгляде видно, Excel это или скан, не читая расширение.
const FILE_KINDS = [
  ['sheet', /^(xlsx?|xlsm|xlsb|csv|ods)$/i, 'Таблица'],
  ['pdf', /^pdf$/i, 'PDF'],
  ['doc', /^(docx?|odt|rtf)$/i, 'Документ Word'],
  ['zip', /^(zip|rar|7z)$/i, 'Архив'],
  ['img', /^(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i, 'Изображение'],
]
function fileKind(name) {
  const ext = /\.([^.\s]{1,5})$/.exec(name || '')?.[1] || ''
  return FILE_KINDS.find(([, re]) => re.test(ext)) || ['file', null, 'Файл']
}

// Цвет полосы блока КП — состояние его текущей версии: проверено, замечания, ждёт проверки
// (серая, как «На проверке» в «Проверке КП»), без проверки.
function kpTone(file) {
  if (file.review_required !== true) return 'plain'
  const status = file.review_status || 'pending'
  if (status === 'approved') return 'ok'
  if (status === 'has_remarks') return 'warn'
  return 'pending'
}

const IconFile = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)

// Значок файла с заливкой цвета типа (цвет — классом .tcpf-ftype.is-<тип>).
const IconFileTyped = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
      fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
)

const IconChevron = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const IconStepDone = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const IconStepTodo = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
  </svg>
)

// Шаг после проверки: «в сводной» / «отправлено подрядчику» — только состояние,
// отмечают его в «Проверке КП». Кто и когда — в подсказке.
function StepTag({ done, at, by, doneText, todoText }) {
  const who = [by, fmtDateTime(at)].filter(Boolean).join(' · ')
  return (
    <span
      className={`tcpf-step ${done ? 'is-done' : 'is-todo'}`}
      title={done ? `${doneText}${who ? `: ${who}` : ''}` : `${todoText} — отмечают в «Проверке КП»`}
    >
      {done ? <IconStepDone /> : <IconStepTodo />}
      {done ? doneText : todoText}
    </span>
  )
}

// Проверка в строке сведений: у проверяющего КП на проверке — кнопка «Проверить», иначе
// вердикт цветным словом (у проверяющего — с карандашом, открывает окно проверки); у текущей
// версии — шаги. Кто и когда проверил — в подсказке вердикта (KpReviewBadge).
function ReviewPart({ file, canReview, onReview, withSteps }) {
  const status = file.review_status || 'pending'
  const reviewed = status === 'approved' || status === 'has_remarks'
  const remarks = status === 'has_remarks'
  return (
    <span className="tcpf-review">
      {canReview && status === 'pending' ? (
        <button
          type="button"
          className="tcpf-check-btn"
          title="КП ждёт проверки — открыть окно проверки"
          onClick={() => onReview(file)}
        >Проверить</button>
      ) : (
        <KpReviewBadge file={file} canReview={canReview} onReview={onReview} editHint />
      )}
      {withSteps && reviewed && (
        <>
          <StepTag
            done={!!file.summary_added}
            at={file.summary_added_at}
            by={file.summary_added_by}
            doneText="в сводной"
            todoText="к занесению в сводную"
          />
          {remarks && file.remarks_send_required === false && (
            <span className="tcpf-step is-muted" title="Замечания обрабатываются без отправки подрядчику">
              без отправки подрядчику
            </span>
          )}
          {remarks && file.remarks_send_required !== false && (
            <StepTag
              done={!!file.remarks_sent}
              at={file.remarks_sent_at}
              by={file.remarks_sent_by}
              doneText="отправлено подрядчику"
              todoText="к отправке подрядчику"
            />
          )}
        </>
      )}
    </span>
  )
}

// Строка файла: имя в одну строку со значком типа, «Скачать» и «Удалить»; ниже одной строкой
// дата и время загрузки, кто загрузил, метка версии, у прежней версии — когда заменена, у КП
// на проверке — проверка; замечания текущей версии — строкой под ней.
// item — элемент proposals из buildFilesTimeline (у документа — { file }); versioned — у КП
// несколько версий: слева метка «в1», «в2».
function FileItem({ item, isProposal, versioned, onDownload, onPreview, onDelete, canReview, onReview }) {
  const { file } = item
  const s3 = file.s3
  if (!s3) return null
  const fileName = s3.file_name || 'Файл'
  const [stem, ext] = splitFileName(fileName)
  const [kind, , kindLabel] = fileKind(fileName)
  const replaced = isProposal && !!item.replacedAt
  const size = formatBytes(s3.size_bytes)
  const reviewed = isProposal && file.review_required === true
  const remarks = reviewed && !replaced && file.review_status === 'has_remarks' && file.review_note
  // Текущая версия КП — то, что скачивают чаще всего: кнопка с подписью.
  const mainDownload = isProposal && !replaced
  return (
    <li className={`tcpf-item${replaced ? ' is-replaced' : ''}`} data-file={file.id}>
      <div className="tcpf-line">
        {versioned && (
          <span
            className={`tcpf-vtag${replaced ? '' : ' is-current'}`}
            title={replaced
              ? `Версия ${item.version} из ${item.versions}: ${fmtDateTime(item.replacedAt)} загружена следующая`
              : `Версия ${item.version} из ${item.versions} — текущая`}
          >в{item.version}</span>
        )}
        <button
          type="button"
          className="tcpf-file"
          title={`Открыть: ${fileName}${size ? ` (${kindLabel}, ${size})` : ` (${kindLabel})`}`}
          onClick={() => onPreview(s3)}
        >
          <span className={`tcpf-ftype is-${kind}`}><IconFileTyped /></span>
          <span className="tcpf-file-name">{stem}</span>
          {ext && <span className="tcpf-file-ext">{ext}</span>}
        </button>
        <button
          type="button"
          className={`tcpf-icon-btn${mainDownload ? ' tcpf-dl-main' : ''}`}
          title={`Скачать «${s3.file_name}»`}
          aria-label={`Скачать ${s3.file_name}`}
          onClick={() => onDownload(s3)}
        >
          <IconDownload size={14} />
          {mainDownload && <span aria-hidden>Скачать</span>}
        </button>
        {onDelete && (
          <button
            type="button"
            className="tcpf-icon-btn tcpf-icon-del"
            title="Удалить файл"
            aria-label={`Удалить ${s3.file_name}`}
            onClick={() => onDelete(file)}
          ><IconTrash size={14} /></button>
        )}
      </div>
      <div className="tcpf-meta">
        <span className="tcpf-when" title={`Загружено ${fmtDateTime(file.created_at)}`}>
          <span className="tcpf-date">{fmtDate(file.created_at)}</span>
          <span className="tcpf-time">{fmtTime(file.created_at)}</span>
        </span>
        {s3.uploaded_by_name && (
          <span className="tcpf-uploader">
            <IconUser size={12} />
            <PersonName full={s3.uploaded_by_name} titlePrefix="Кто загрузил" />
          </span>
        )}
        {file.version_label && (
          <span className="tcpf-vlabel" title="Метка версии">«{file.version_label}»</span>
        )}
        {replaced && (
          <span className="tcpf-ver" title={`Заменена ${fmtDateTime(item.replacedAt)}`}>
            заменена {fmtDate(item.replacedAt)}
          </span>
        )}
        {/* Проверка — только у КП, которые идут через «Проверку КП» (review_required);
            КП до запуска проверки — без неё. Шаги — только у текущей версии. */}
        {reviewed && (
          <ReviewPart file={file} canReview={canReview} onReview={onReview} withSteps={!replaced} />
        )}
      </div>
      {remarks && (
        <div className="tcpf-remarks" title={file.review_note}>{file.review_note}</div>
      )}
    </li>
  )
}

// Свёрнутая ячейка: сколько КП проверено, с замечаниями, ждёт проверки (по текущим версиям).
function ReviewSummary({ groups }) {
  const sum = reviewSummary(groups)
  const parts = [
    ['ok', sum.approved, 'проверено'],
    ['warn', sum.has_remarks, 'замечания'],
    ['pending', sum.pending, 'на проверке'],
  ].filter(([, n]) => n > 0)
  if (parts.length === 0) return null
  return (
    <span className="tcpf-sum-review">
      {parts.map(([tone, n, label]) => (
        <span key={tone} className={`tcpf-sum-st is-${tone}`}>
          <span className="tcpf-sum-dot" aria-hidden />
          {label} {n}
        </span>
      ))}
    </span>
  )
}

export default function TenderCounterpartyFiles({
  tenderId,
  counterpartyId,
  canEdit: canEditProp,
  tender = null,
  counterpartyName = '',
  collapsed = false,
}) {
  const { isEmployee, isAdmin, isSuperAdmin, role } = useRole()
  const canEdit = canEditProp !== undefined ? canEditProp : isEmployee
  // task 431: проверять КП может экономист ОСП, админ и суперпользователь
  // (доступ по e-mail, не зависит от выбранной роли — см. RoleContext).
  const canReview = isAdmin || isSuperAdmin || role === 'economist'

  const [data, setData] = useState({ proposals: [], attachments: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [previewDoc, setPreviewDoc] = useState(null)
  // task 431: файл, для которого открыто окно проверки КП.
  const [reviewFile, setReviewFile] = useState(null)
  // Документы: null — по числу (до DOCS_OPEN_MAX раскрыты), true/false — выбор пользователя.
  const [docsOpen, setDocsOpen] = useState(null)
  // Стрелка участника: выбор действует, пока не сменилась галочка «Свернуть КП» (for) —
  // тогда все участники снова идут за ней.
  const [openOverride, setOpenOverride] = useState({ for: collapsed, open: null })
  // Окно загрузки КП: null | { file, proposalGroupId, label }. proposalGroupId — новая
  // версия этого КП, null — отдельное КП.
  const [uploadModal, setUploadModal] = useState(null)

  const proposalRef = useRef(null)
  const attachmentRef = useRef(null)

  const open = openOverride.for === collapsed && openOverride.open != null ? openOverride.open : !collapsed
  const setOpen = (value) => setOpenOverride({ for: collapsed, open: value })

  const reload = useCallback(async () => {
    if (!tenderId || !counterpartyId) return
    setLoading(true)
    setError(null)
    try {
      setData(await fetchProposalFiles(tenderId, counterpartyId))
    } catch (e) {
      setError(e.message || 'Не удалось загрузить файлы')
    } finally {
      setLoading(false)
    }
  }, [tenderId, counterpartyId])

  useEffect(() => { reload() }, [reload])

  // После выбора файла — окно: отдельное КП или новая версия, метка версии.
  const handleProposalFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadModal({ file, proposalGroupId: null, label: '' })
  }

  const handleUploadCancel = () => setUploadModal(null)

  const handleUploadConfirm = async () => {
    if (!uploadModal) return
    const { file, proposalGroupId, label } = uploadModal
    setUploading(true)
    try {
      await addProposalFile({
        tenderId,
        counterpartyId,
        file,
        fileKind: 'commercial_proposal',
        proposalGroupId,
        versionLabel: label,
      })
      setUploadModal(null)
      // Свёрнутый участник раскрывается — загруженное КП видно сразу.
      setOpen(true)
      await reload()
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setUploading(false)
    }
  }

  const handleAttachmentFile = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) {
        await addProposalFile({ tenderId, counterpartyId, file, fileKind: 'attachment' })
      }
      // Раскрыть документы — чтобы добавленные было видно сразу.
      setDocsOpen(true)
      setOpen(true)
      await reload()
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (file) => {
    if (!window.confirm(`Удалить файл «${file.s3?.file_name || ''}»?`)) return
    try {
      await deleteProposalFile(file)
      await reload()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const handleDownload = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key, { fileName: s3doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = s3doc.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const { proposals, attachments } = data
  const groups = groupProposals(proposals)
  const isEmpty = proposals.length === 0 && attachments.length === 0
  const ready = !loading && !error
  const canDownloadAll = ready && !isEmpty
  const showDocs = docsOpen ?? attachments.length <= DOCS_OPEN_MAX
  const versionTargets = currentProposals(proposals)
  const itemProps = {
    onDownload: handleDownload,
    onPreview: setPreviewDoc,
    onDelete: canEdit ? handleDelete : null,
    canReview,
    onReview: setReviewFile,
  }
  // Подписи блоков «КП 1», «КП 2» — когда КП несколько; у одного КП число версий уже в сводке.
  const groupHeads = groups.length > 1

  return (
    <div className={`tcpf${open ? '' : ' is-collapsed'}`} aria-busy={loading}>
      {/* Скрытые file-input'ы — клики на видимые кнопки делегируются на них. */}
      <input ref={proposalRef} type="file" style={{ display: 'none' }} onChange={handleProposalFile} />
      <input ref={attachmentRef} type="file" multiple style={{ display: 'none' }} onChange={handleAttachmentFile} />

      {/* Строка-сводка: стрелка и число КП (свёрнуто — ещё документы и проверка), справа
          загрузка и «Скачать всё». «Скачать всё» видит и тот, кто не может загружать:
          скачивание одного файла ему тоже доступно. */}
      <div className="tcpf-head">
        {loading ? (
          <span className="tcpf-empty">Загрузка…</span>
        ) : error ? (
          <span className="tcpf-error">{error}</span>
        ) : isEmpty ? (
          <span className="tcpf-none">КП не загружено</span>
        ) : (
          <button
            type="button"
            className="tcpf-summary"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            title={open ? 'Свернуть КП и документы участника' : 'Показать КП и документы участника'}
          >
            <span className={`tcpf-chev${open ? ' is-open' : ''}`}><IconChevron /></span>
            {groups.length > 0 ? (
              <span className="tcpf-sum-kp">
                КП · {groups.length}
                {proposals.length > groups.length && (
                  <span className="tcpf-sum-sub"> · {proposals.length} {versionsWord(proposals.length)}</span>
                )}
              </span>
            ) : (
              <span className="tcpf-sum-kp is-none">КП не загружено</span>
            )}
          </button>
        )}
        {(canEdit || canDownloadAll) && (
          <div className="tcpf-quick-actions">
            {canEdit && (
              <>
                <button
                  type="button"
                  className="tcpf-btn-primary"
                  onClick={() => proposalRef.current?.click()}
                  disabled={uploading || !!uploadModal}
                >+ КП</button>
                <button
                  type="button"
                  className="tcpf-btn-secondary"
                  onClick={() => attachmentRef.current?.click()}
                  disabled={uploading || !!uploadModal}
                >+ Документ</button>
              </>
            )}
            {canDownloadAll && (
              <TenderFilesZipButton
                tender={tender || { id: tenderId }}
                counterparty={{ id: counterpartyId, name: counterpartyName }}
                className="tcpf-btn-secondary tcpf-zip-btn"
              />
            )}
          </div>
        )}
      </div>

      {/* Свёрнуто — второй строкой во всю ширину: документы и проверка текущих версий КП (рядом с
          кнопками сводка ужималась в три-четыре строки). */}
      {ready && !open && !isEmpty && (attachments.length > 0 || groups.some(g => g.current.file.review_required === true)) && (
        <div className="tcpf-sum-more">
          {attachments.length > 0 && (
            <span className="tcpf-sum-docs">Документы · {attachments.length}</span>
          )}
          <ReviewSummary groups={groups} />
        </div>
      )}

      {ready && open && (
        <>
          {groups.length > 0 && (
            <section className="tcpf-section" aria-label="Коммерческие предложения">
              <ol className="tcpf-kps">
                {groups.map((g, gi) => (
                  <li key={g.groupId} className={`tcpf-kp tcpf-tone-${kpTone(g.current.file)}`} data-group={g.groupId}>
                    {groupHeads && (
                      <div className="tcpf-kp-head">
                        <span className="tcpf-kp-name">КП {gi + 1}</span>
                        {g.items.length > 1 && (
                          <span className="tcpf-kp-sub">{g.items.length} {versionsWord(g.items.length)}</span>
                        )}
                      </div>
                    )}
                    <ol className="tcpf-list">
                      {g.items.map(item => (
                        <FileItem key={item.file.id} item={item} isProposal versioned={g.items.length > 1} {...itemProps} />
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {attachments.length > 0 && (
            <section className="tcpf-section tcpf-docs" aria-label="Документы">
              <button
                type="button"
                className="tcpf-section-head tcpf-section-toggle"
                aria-expanded={showDocs}
                onClick={() => setDocsOpen(!showDocs)}
                title={showDocs ? 'Свернуть документы' : 'Показать документы'}
              >
                <span className={`tcpf-chev${showDocs ? ' is-open' : ''}`}><IconChevron /></span>
                <span>Документы · {attachments.length}</span>
              </button>
              {showDocs && (
                <ol className="tcpf-list tcpf-doc-list">
                  {attachments.map(file => (
                    <FileItem key={file.id} item={{ file }} {...itemProps} />
                  ))}
                </ol>
              )}
            </section>
          )}
        </>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}

      {/* task 431: окно проверки КП */}
      {reviewFile && (
        <KpReviewModal
          file={reviewFile}
          onClose={() => setReviewFile(null)}
          onSaved={reload}
        />
      )}

      {/* Окно загрузки КП */}
      {uploadModal && (
        // Клик по подложке и Escape НЕ закрывают окно — только крестик/«Отмена»/загрузка.
        <div className="tcpf-modal-overlay">
          <div className="tcpf-modal" role="dialog" aria-modal="true" aria-labelledby="tcpf-modal-title">
            <div className="tcpf-modal-header">
              <h3 className="tcpf-modal-title" id="tcpf-modal-title">
                {uploadModal.proposalGroupId ? 'Загрузка новой версии КП' : 'Загрузка КП'}
              </h3>
              <button
                type="button"
                className="tcpf-modal-close"
                onClick={handleUploadCancel}
                aria-label="Закрыть"
              >×</button>
            </div>
            <div className="tcpf-modal-body">
              <div className="tcpf-modal-file">
                <span className="tcpf-modal-file-icon"><IconFile /></span>
                <div className="tcpf-modal-file-info">
                  <span className="tcpf-modal-file-name" title={uploadModal.file.name}>
                    {uploadModal.file.name}
                  </span>
                  <span className="tcpf-modal-file-size">
                    {formatBytes(uploadModal.file.size)}
                  </span>
                </div>
              </div>
              {/* Уже есть КП — спрашиваем, отдельное это КП или новая версия одного из
                  них (после переторжки, со скидкой). Версии одного КП стоят в блоке КП
                  с номерами «в1», «в2», прежние помечены «заменена». */}
              {versionTargets.length > 0 && (
                <fieldset className="tcpf-modal-choices">
                  <legend className="tcpf-modal-field-label">Что загружаете</legend>
                  <label className="tcpf-modal-choice">
                    <input
                      type="radio"
                      name="tcpf-kind"
                      checked={!uploadModal.proposalGroupId}
                      onChange={() => setUploadModal(s => s ? { ...s, proposalGroupId: null } : s)}
                    />
                    <span>Новое КП</span>
                  </label>
                  {versionTargets.map(p => (
                    <label key={p.groupId} className="tcpf-modal-choice">
                      <input
                        type="radio"
                        name="tcpf-kind"
                        checked={uploadModal.proposalGroupId === p.groupId}
                        onChange={() => setUploadModal(s => s ? { ...s, proposalGroupId: p.groupId } : s)}
                      />
                      <span className="tcpf-modal-choice-text">
                        <span>Новая версия КП от {fmtDate(p.file.created_at)}</span>
                        <span className="tcpf-modal-choice-sub" title={p.file.s3?.file_name}>
                          {p.file.s3?.file_name || 'файл не найден'}
                          {p.versions > 1 ? ` · версия ${p.version}` : ''}
                          {p.file.version_label ? ` · ${p.file.version_label}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="tcpf-modal-field">
                <span className="tcpf-modal-field-label">Метка версии (необязательно)</span>
                <input
                  type="text"
                  value={uploadModal.label}
                  onChange={(e) => setUploadModal(s => s ? { ...s, label: e.target.value } : s)}
                  placeholder={uploadModal.proposalGroupId
                    ? 'например: со скидкой 5%, после переторжки'
                    : 'например: исходное'}
                  className="tcpf-modal-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleUploadConfirm() }
                  }}
                />
              </label>
            </div>
            <div className="tcpf-modal-footer">
              <button
                type="button"
                className="tcpf-btn-secondary"
                onClick={handleUploadCancel}
                disabled={uploading}
              >Отмена</button>
              <button
                type="button"
                className="tcpf-btn-primary"
                onClick={handleUploadConfirm}
                disabled={uploading}
              >{uploading ? 'Загрузка…' : 'Загрузить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
