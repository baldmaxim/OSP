import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, fetchDocuments, setDocumentVersion, uploadFile } from '../services/s3'
import { downloadS3File } from './FileDownload'
import S3DocumentPreview from './S3DocumentPreview'
import DocListZipButton from './DocListZipButton'
import {
  filesCountLabel, folderDateForUpload, groupDocsByDay, hasFolderDate, localTime, todayKey, uploadedOtherDay,
} from '../utils/docDateFolders'
import { hasVersionColumn, olderFirst, suggestVersionGroup, versionGroups } from '../utils/docVersions'
import './S3DocumentList.css'

// Универсальный список S3-документов для произвольной сущности.
// Использование:
//   <S3DocumentList ownerType="tender" ownerId={tenderId} title="Документы" />
// Права: сотрудники (isEmployee) могут загружать/удалять; подрядчики — только просмотр.
// canEdit можно явно переопределить пропом (например, для разделов с другой политикой). canDelete — удаление и
// переименование (по умолчанию = canEdit): сервер меняет файлы по праву правки раздела, а загружать бывает можно и с
// просмотром (файлы договора — server/osp-api/src/routes/s3Presign.js, CHANGE_RULES). canDeleteDoc(doc) — ещё и по самому
// файлу (файл задачи меняют загрузивший, постановщик и администратор).
// downloadAllOwner — кнопка «Скачать всё» (все файлы списка одним ZIP «<владелец> — <title>.zip», DocListZipButton);
// без пропа кнопки нет. Видна всем, кто видит список: скачивание — по тому же праву, что и одного файла.
// dateFolders — файлы по папкам дня загрузки (utils/docDateFolders.js): новая папка открыта, прежние свёрнуты; «Загрузить»
// кладёт в папку сегодняшнего дня. В уже существующую папку (19.11.2026) — кнопкой «+ в папку» у папки или перетаскиванием
// файлов на папку; брошенное на список вне папок — в сегодняшнюю. Прежняя папка — только когда в базе есть
// s3_documents.folder_date (20270220), иначе у прежних папок кнопки нет, а брошенное на них ложится в сегодняшнюю.
// Без пропа — плоский список, как прежде, без перетаскивания.
// versions — версии файлов (utils/docVersions.js, s3_documents.version_group_id, миграция 20270307; решение пользователя 26.11.2026,
// ВОР в окне «ВОРы и РД»): строка — текущая версия файла с отметкой «Версия N», прежние раскрываются под ней (версия 1 — самая
// ранняя; удалили версию — следующие сдвигаются). Новая версия — кнопкой у файла, перетаскиванием файла с компьютера на строку
// или из «Загрузить»: файл с тем же именем без отметок редакции («ВОР ОВ» → «ВОР ОВ изм.1») список предлагает загрузить новой
// версией — человек подтверждает или выбирает «отдельный файл». Строку файла можно перетащить на другой файл (станет его версией)
// или на полосу «самостоятельный файл»; то же без мыши (телефон) — кнопкой «Версии» у файла. Колонки в базе нет — список без
// версий, как прежде. Не вместе с dateFolders.
// documents — список уже загружен родителем (окно «ВОРы и РД» читает все файлы раздела одним запросом): свой запрос не делается,
// после правки вызывается onChange, и родитель перечитывает список сам.
// Несколько файлов за раз: ошибка одного не останавливает остальные; в конце — список незагруженных. На кнопке — ход:
// «Файл 2 из 5 · 45 %» (повтор — «попытка 2 из 3»); встала отправка или молчит сервер — ошибка этого файла (src/api/storagePut.js),
// а не вечная «Загрузка».

// Аккуратные inline SVG-иконки (вместо эмодзи, которые на части систем рендерятся криво).
const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const EyeIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /></Icon>
const DownloadIcon = () => <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Icon>
const TrashIcon = () => <Icon><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></Icon>
const UploadIcon = () => <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></Icon>
const FolderIcon = () => <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Icon>
const ChevronIcon = () => <Icon><path d="m9 6 6 6-6 6" /></Icon>
const PlusIcon = () => <Icon><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
// Новая версия файла: лист с плюсом.
const NewVersionIcon = () => <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="M9 15h6" /></Icon>
// Версии файла (связь с другим файлом): стопка листов.
const LayersIcon = () => <Icon><path d="m12 2 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></Icon>
const GripIcon = () => <Icon><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></Icon>

// Ход загрузки на кнопке: «Загрузка: 45 %», несколько файлов — «Файл 2 из 5 · 45 %»; подтверждение — «сохранение»;
// отправка повторяется после обрыва — «попытка 2 из 3», чтобы повтор не выглядел зависанием.
function progressLabel(p) {
  if (!p) return 'Загрузка…'
  const pct = p.size > 0 ? Math.min(100, Math.floor((p.loaded * 100) / p.size)) : 0
  const retry = p.stage === 'send' && p.attempt > 1 ? ` · попытка ${p.attempt} из ${p.attempts}` : ''
  const step = p.stage === 'save' ? 'сохранение' : p.stage === 'send' ? `${pct} %${retry}` : 'подготовка'
  return p.total > 1 ? `Файл ${p.done + 1} из ${p.total} · ${step}` : `Загрузка: ${step}`
}

// Перетаскивают файлы (а не текст или строку таблицы).
const dragsFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
// Перетаскивают строку файла списка (версии): свой тип данных, с файлами с компьютера не путается.
const DOC_DRAG_TYPE = 'application/x-osp-doc'
const dragsDoc = (e) => Array.from(e.dataTransfer?.types || []).includes(DOC_DRAG_TYPE)

// Ключ «бросили на список вне папок» — в папку сегодняшнего дня (с версиями — отдельными файлами).
const DROP_LIST = '__list__'
// Полоса «самостоятельный файл» (перетаскивание строки версии).
const DROP_STANDALONE = '__standalone__'
// В выборе «Версии»: самостоятельный файл.
const OWN = '__own__'

// Сколько незагруженных файлов перечислять в сообщении.
const FAILED_SHOWN = 10

function formatBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
}

// «2 версии», «5 версий».
function versionsLabel(n) {
  const m10 = n % 10
  const m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? 'версия' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'версии' : 'версий'
  return `${n} ${word}`
}

// Каким номером встанет файл doc в группу group (порядок — по времени загрузки): { no, count }.
function placeInGroup(doc, group) {
  const list = [...group.versions.map((v) => v.doc).filter((d) => d.id !== doc.id), doc].sort(olderFirst)
  return { no: list.findIndex((d) => d.id === doc.id) + 1, count: list.length }
}

export default function S3DocumentList({ ownerType, ownerId, title = 'Документы', canEdit: canEditProp, canDelete: canDeleteProp, canDeleteDoc = null, category = null, excludeCategory = null, downloadAllOwner = null, dateFolders = false, versions = false, documents: documentsProp = null, onChange }) {
  const { isEmployee } = useRole()
  const canEdit = canEditProp !== undefined ? canEditProp : isEmployee
  const canDelete = canDeleteProp !== undefined ? canDeleteProp : canEdit
  // Список родителя: свой запрос не делаем, после правки родитель перечитывает (onChange).
  const controlled = Array.isArray(documentsProp)

  const [ownDocuments, setDocuments] = useState([])
  const [ownLoading, setLoading] = useState(!controlled)
  const [error, setError] = useState(null)
  const documents = useMemo(() => {
    const list = controlled ? documentsProp : ownDocuments
    // Служебные категории (напр. шаблон согласования) не показываем в общем списке.
    return excludeCategory ? list.filter((d) => d.doc_category !== excludeCategory) : list
  }, [controlled, documentsProp, ownDocuments, excludeCategory])
  const loading = controlled ? false : ownLoading
  const [uploading, setUploading] = useState(false)
  // { done, total, stage, loaded, size } — пока идёт загрузка: какой файл по счёту и сколько его отправлено.
  const [uploadProgress, setUploadProgress] = useState(null)
  // Папка, в которую выбирают файлы кнопкой «+ в папку» (null — «Загрузить», папка сегодняшнего дня).
  const pickFolderRef = useRef(null)
  // Файл, новую версию которого выбирают кнопкой у строки (null — «Загрузить»).
  const pickVersionRef = useRef(null)
  // Куда сейчас тянут файлы: ключ папки (группы версий), DROP_LIST, DROP_STANDALONE или null. Счётчик — dragenter/dragleave
  // вложенных элементов.
  const [dropKey, setDropKey] = useState(null)
  const dragDepth = useRef(0)
  // Папки, раскрытые или свёрнутые вручную: день → true/false; остальные — по умолчанию (открыта только новая).
  const [folderOpen, setFolderOpen] = useState({})
  const [previewDoc, setPreviewDoc] = useState(null)
  const fileInputRef = useRef(null)
  // Версии: раскрытые группы (ключ → true), перетаскиваемая строка, выбор «как загрузить» и правка связи у строки.
  const [openGroups, setOpenGroups] = useState({})
  const [dragDoc, setDragDoc] = useState(null)
  const [plan, setPlan] = useState(null) // [{ file, target: id текущей версии | '' }]
  const [linkEdit, setLinkEdit] = useState(null) // { docId, value: ключ группы | OWN }
  const [linking, setLinking] = useState(false)

  // Через ref: колбэк родителя не обязан быть мемоизирован.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // «Загрузка списка…» — только пока списка ещё нет: перечитывание после загрузки, удаления или правки версий таблицу не прячет
  // (раньше она мигала после каждого действия).
  const loadedRef = useRef(false)
  const reload = useCallback(async () => {
    if (controlled || !ownerId) return
    if (!loadedRef.current) setLoading(true)
    setError(null)
    try {
      setDocuments(await fetchDocuments(ownerType, ownerId, category))
      loadedRef.current = true
    } catch (e) {
      setError(e.message || 'Не удалось загрузить список документов')
    } finally {
      setLoading(false)
    }
  }, [controlled, ownerType, ownerId, category])

  // Другой владелец или раздел — список с нуля.
  useEffect(() => { loadedRef.current = false; reload() }, [reload])

  // После правки: свой список — перечитать и сообщить родителю; список родителя — его перечитывает родитель.
  const refresh = async () => {
    if (controlled) { await onChangeRef.current?.(); return }
    await reload()
    onChangeRef.current?.()
  }

  // Версии — только когда в базе есть колонка (миграция 20270307); пустой список ещё не знает — файлы грузятся отдельными.
  const versionsOn = versions && !dateFolders && hasVersionColumn(documents)
  const groups = useMemo(() => (versionsOn ? versionGroups(documents) : null), [versionsOn, documents])
  const groupByKey = useMemo(() => new Map((groups || []).map((g) => [g.key, g])), [groups])
  // Файл → { group, no }: номер версии и её группа.
  const versionOf = useMemo(() => {
    const m = new Map()
    for (const g of groups || []) for (const v of g.versions) m.set(v.doc.id, { group: g, no: v.no })
    return m
  }, [groups])
  const canLink = versionsOn && canDelete && !!ownerId

  // Загрузка файлов в папку folderKey (null — сегодняшняя). Прежняя папка — днём в folder_date, сегодняшняя — без него.
  // targets — с версиями: id файла, новой версией которого грузится каждый (по порядку; '' или null — отдельный файл).
  const uploadFiles = async (files, folderKey = null, targets = null) => {
    if (files.length === 0 || uploading) return
    const folderDate = dateFolders ? folderDateForUpload(folderKey) : null
    setUploading(true)
    setUploadProgress({ done: 0, total: files.length, stage: 'prepare', loaded: 0, size: files[0].size })
    const failed = []
    try {
      for (const [i, file] of files.entries()) {
        const onProgress = ({ stage, loaded, attempt, attempts }) => setUploadProgress({ done: i, total: files.length, stage, loaded, size: file.size, attempt, attempts })
        try {
          await uploadFile({ file, ownerType, ownerId, category, folderDate, versionOf: targets?.[i] || null, onProgress })
        } catch (err) {
          failed.push({ name: file.name, message: err?.message || String(err) })
        }
        setUploadProgress({ done: i + 1, total: files.length, stage: 'prepare', loaded: 0, size: files[i + 1]?.size || 0 })
      }
    } finally {
      setUploading(false)
      setUploadProgress(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    // Загруженные показываем и тогда, когда часть файлов не прошла; папку, куда клали, — раскрытой; группу, куда легла новая
    // версия, — тоже: видно, что прежняя стала версией 1, новая — 2.
    if (failed.length < files.length) {
      if (dateFolders) setFolderOpen((prev) => ({ ...prev, [folderKey || todayKey()]: true }))
      const opened = (targets || []).map((id) => (id ? versionOf.get(id)?.group.key : null)).filter(Boolean)
      if (opened.length) setOpenGroups((prev) => ({ ...prev, ...Object.fromEntries(opened.map((k) => [k, true])) }))
      await refresh()
    }
    if (failed.length === 1 && files.length === 1) {
      alert('Ошибка загрузки: ' + failed[0].message)
    } else if (failed.length) {
      const lines = failed.slice(0, FAILED_SHOWN).map((f) => `• ${f.name}: ${f.message}`)
      if (failed.length > FAILED_SHOWN) lines.push(`…и ещё ${failed.length - FAILED_SHOWN}`)
      alert(`Не загружено ${failed.length} из ${files.length}:\n${lines.join('\n')}`)
    }
  }

  // Новые файлы списка с версиями: похожие на новую версию файла (то же имя без отметок редакции) — сначала выбор, как загрузить;
  // остальные — сразу отдельными, как раньше.
  const addFiles = (files) => {
    if (!files.length) return
    if (!versionsOn) { uploadFiles(files); return }
    const items = files.map((file) => ({ file, target: suggestVersionGroup(file.name, groups)?.current.id || '' }))
    if (items.some((it) => it.target)) setPlan(items)
    else uploadFiles(files)
  }

  const handlePickFiles = (e) => {
    const files = Array.from(e.target.files || [])
    const folderKey = pickFolderRef.current
    const versionTarget = pickVersionRef.current
    pickFolderRef.current = null
    pickVersionRef.current = null
    if (versionTarget) uploadFiles(files, null, files.map(() => versionTarget))
    else if (versions && !dateFolders) addFiles(files)
    else uploadFiles(files, folderKey)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const pickInto = (folderKey) => {
    pickFolderRef.current = folderKey
    pickVersionRef.current = null
    fileInputRef.current?.click()
  }

  const pickVersion = (group) => {
    pickFolderRef.current = null
    pickVersionRef.current = group.current.id
    fileInputRef.current?.click()
  }

  // ── Связь версий: файл — версия другого или самостоятельный ──
  const relink = async (doc, targetGroup) => {
    if (linking) return
    setLinking(true)
    try {
      await setDocumentVersion(doc, targetGroup ? targetGroup.current.id : null)
      if (targetGroup) setOpenGroups((prev) => ({ ...prev, [targetGroup.key]: true }))
      setLinkEdit(null)
      await refresh()
    } catch (err) {
      alert('Не удалось изменить версии: ' + (err.message || err))
    } finally {
      setLinking(false)
    }
  }

  // Перетащили строку файла на другой файл: спросить — порядок версий по дате загрузки, номер может удивить.
  const attachByDrop = (doc, group) => {
    const { no, count } = placeInGroup(doc, group)
    const where = no === count ? `станет текущей версией ${no}` : `станет версией ${no} из ${count} (версии упорядочены по дате загрузки)`
    if (!window.confirm(`Сделать «${doc.file_name}» версией файла «${group.current.file_name}»? Он ${where}.`)) return
    relink(doc, group)
  }

  const detachByDrop = (doc) => {
    if (!window.confirm(`Сделать «${doc.file_name}» самостоятельным файлом? Остальные версии останутся вместе.`)) return
    relink(doc, null)
  }

  // Перетаскивание (список с папками или с версиями, у кого есть загрузка). Папка (группа) под указателем — по data-folder-key её
  // строк; прежняя папка без колонки в базе не принимает — брошенное ложится в сегодняшнюю, и подсвечивается весь список.
  const canFolderDate = dateFolders && hasFolderDate(documents)
  const today = todayKey()
  const fileDropEnabled = (dateFolders || (versions && !dateFolders)) && canEdit && !!ownerId
  const dropTargetOf = (e) => {
    const el = e.target?.closest?.('[data-folder-key]')
    const key = el?.getAttribute('data-folder-key')
    if (versionsOn) return key && groupByKey.has(key) ? key : DROP_LIST
    return key && (key === today || canFolderDate) ? key : DROP_LIST
  }
  // Куда можно бросить перетаскиваемую строку: на другую группу или на полосу «самостоятельный» (если файл в группе не один).
  const docDropTargetOf = (e) => {
    if (!dragDoc) return null
    if (e.target?.closest?.('[data-ver-standalone]')) return (versionOf.get(dragDoc.id)?.group.count || 1) > 1 ? DROP_STANDALONE : null
    const key = e.target?.closest?.('[data-folder-key]')?.getAttribute('data-folder-key')
    return key && groupByKey.has(key) && key !== versionOf.get(dragDoc.id)?.group.key ? key : null
  }
  const anyDropEnabled = fileDropEnabled || canLink
  const dropHandlers = anyDropEnabled ? {
    onDragEnter: (e) => {
      if (!(dragsFiles(e) && fileDropEnabled) && !(dragsDoc(e) && canLink)) return
      e.preventDefault()
      dragDepth.current += 1
      setDropKey(dragsDoc(e) ? docDropTargetOf(e) : dropTargetOf(e))
    },
    onDragOver: (e) => {
      if (dragsDoc(e) && canLink) {
        const key = docDropTargetOf(e)
        if (key) e.preventDefault()
        e.dataTransfer.dropEffect = key && !linking ? 'move' : 'none'
        setDropKey((prev) => (prev === key ? prev : key))
        return
      }
      if (!dragsFiles(e) || !fileDropEnabled) return
      e.preventDefault()
      e.dataTransfer.dropEffect = uploading ? 'none' : 'copy'
      const key = dropTargetOf(e)
      setDropKey((prev) => (prev === key ? prev : key))
    },
    onDragLeave: (e) => {
      if (!(dragsFiles(e) && fileDropEnabled) && !(dragsDoc(e) && canLink)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDropKey(null)
    },
    onDrop: (e) => {
      if (dragsDoc(e) && canLink) {
        e.preventDefault()
        const key = docDropTargetOf(e)
        const doc = dragDoc
        dragDepth.current = 0
        setDropKey(null)
        setDragDoc(null)
        if (!doc || !key) return
        if (key === DROP_STANDALONE) detachByDrop(doc)
        else attachByDrop(doc, groupByKey.get(key))
        return
      }
      if (!dragsFiles(e) || !fileDropEnabled) return
      e.preventDefault()
      const key = dropTargetOf(e)
      dragDepth.current = 0
      setDropKey(null)
      const files = Array.from(e.dataTransfer.files || [])
      if (versions && !dateFolders) {
        // На строку файла — новые версии этого файла; на список вне строк — новые файлы (похожие — с выбором).
        const group = key !== DROP_LIST ? groupByKey.get(key) : null
        if (group) uploadFiles(files, null, files.map(() => group.current.id))
        else addFiles(files)
        return
      }
      uploadFiles(files, key === DROP_LIST ? null : key)
    },
  } : {}
  // Промахнулись мимо списка — браузер открыл бы файл вместо страницы (и всё несохранённое пропало бы): пока список с
  // перетаскиванием на экране, брошенный мимо файл просто не принимается. Попавший в список уже обработан (defaultPrevented).
  useEffect(() => {
    if (!fileDropEnabled) return undefined
    const refuse = (e) => {
      if (e.defaultPrevented || !dragsFiles(e)) return
      e.preventDefault()
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', refuse)
    window.addEventListener('drop', refuse)
    return () => {
      window.removeEventListener('dragover', refuse)
      window.removeEventListener('drop', refuse)
    }
  }, [fileDropEnabled])

  const dropGroup = versionsOn && dropKey && dropKey !== DROP_LIST && dropKey !== DROP_STANDALONE ? groupByKey.get(dropKey) : null
  const dropFolderLabel = !versionsOn && dropKey && dropKey !== DROP_LIST
    ? (groupDocsByDay(documents).find((f) => f.key === dropKey)?.label || '')
    : ''
  const dropHint = dragDoc
    ? (dropKey === DROP_STANDALONE ? `Отпустите — «${dragDoc.file_name}» станет самостоятельным файлом`
      : dropGroup ? `Отпустите — «${dragDoc.file_name}» станет версией файла «${dropGroup.current.file_name}»`
        : 'Перетащите на другой файл — станет его версией')
    : !dropKey ? ''
      : dropGroup ? `Отпустите — новая версия файла «${dropGroup.current.file_name}»`
        : versionsOn ? 'Отпустите — файлы загрузятся новыми; на строке файла — его новой версией'
          : dropFolderLabel ? `Отпустите — файлы лягут в папку ${dropFolderLabel}` : 'Отпустите — файлы лягут в папку с сегодняшней датой'

  const toggleFolder = (key, open) => setFolderOpen((prev) => ({ ...prev, [key]: !open }))

  const handleDownload = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const deleteQuestion = (doc) => {
    const v = versionOf.get(doc.id)
    if (!v || v.group.count < 2) return `Удалить файл «${doc.file_name}»?`
    if (v.no === v.group.count) {
      const prev = v.group.versions[v.no - 2].doc
      return `Удалить версию ${v.no} «${doc.file_name}»? Текущей станет версия ${v.no - 1} «${prev.file_name}».`
    }
    return `Удалить версию ${v.no} «${doc.file_name}»? Следующие версии сдвинутся: номера пойдут подряд, порядок не изменится.`
  }

  const handleDelete = async (doc) => {
    if (!window.confirm(deleteQuestion(doc))) return
    try {
      await deleteDocument(doc)
      if (controlled) await refresh()
      else {
        setDocuments(prev => prev.filter(d => d.id !== doc.id))
        onChangeRef.current?.()
      }
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const handleRenamed = async (doc) => {
    if (controlled) { await refresh(); return }
    setDocuments(prev => prev.map(d => (d.id === doc.id ? { ...d, file_name: doc.file_name } : d)))
    onChangeRef.current?.()
  }

  const mayChange = (doc) => canDelete && (!canDeleteDoc || canDeleteDoc(doc))

  // Строка файла. v — версия ({ group, no }) в списке с версиями: отметка, перетаскивание, кнопки версий.
  const renderRow = (doc, when, v = null, { head = false } = {}) => {
    const grouped = v && v.group.count > 1
    const draggable = canLink && mayChange(doc) && !linking
    return (
      <tr
        key={doc.id}
        className={`${v && !head ? 's3-ver-old' : ''}${dragDoc?.id === doc.id ? ' is-dragging-row' : ''}`.trim() || undefined}
        draggable={draggable || undefined}
        onDragStart={draggable ? (e) => {
          e.dataTransfer.setData(DOC_DRAG_TYPE, doc.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragDoc(doc)
        } : undefined}
        onDragEnd={draggable ? () => { setDragDoc(null); setDropKey(null); dragDepth.current = 0 } : undefined}
      >
        <td className="s3-doc-name">
          {v ? (
            <div className="s3-ver-name">
              {draggable && <span className="s3-ver-grip" title="Перетащите на другой файл — станет его версией"><GripIcon /></span>}
              <span className="s3-ver-file">{doc.file_name}</span>
              {grouped && (
                <span className={`s3-ver-chip${head ? ' is-current' : ''}`} title={head ? 'Текущая версия' : 'Прежняя версия'}>
                  Версия {v.no}
                </span>
              )}
              {head && grouped && (
                <button
                  type="button"
                  className={`s3-ver-toggle${openGroups[v.group.key] ? ' is-open' : ''}`}
                  aria-expanded={!!openGroups[v.group.key]}
                  onClick={() => setOpenGroups((prev) => ({ ...prev, [v.group.key]: !prev[v.group.key] }))}
                >
                  <span className="s3-ver-chevron"><ChevronIcon /></span>
                  {openGroups[v.group.key] ? 'Скрыть прежние' : `Все ${versionsLabel(v.group.count)}`}
                </button>
              )}
            </div>
          ) : doc.file_name}
        </td>
        <td>{formatBytes(doc.size_bytes)}</td>
        <td>{doc.uploaded_by_name || '—'}</td>
        <td className="s3-doc-when" title={dateFolders ? `Загружен ${formatDateTime(doc.created_at)}` : undefined}>{when}</td>
        <td className="s3-doc-actions">
          <button type="button" title="Просмотр" aria-label="Просмотр" onClick={() => setPreviewDoc(doc)}><EyeIcon /></button>
          <button type="button" title="Скачать" aria-label="Скачать" onClick={() => handleDownload(doc)}><DownloadIcon /></button>
          {v && head && canEdit && versionsOn && (
            <button type="button" title="Загрузить новую версию этого файла" aria-label={`Загрузить новую версию «${doc.file_name}»`}
              onClick={() => pickVersion(v.group)} disabled={uploading}><NewVersionIcon /></button>
          )}
          {v && canLink && mayChange(doc) && (
            <button type="button" title="Версии: сделать версией другого файла или самостоятельным"
              aria-label={`Версии файла «${doc.file_name}»`}
              className={linkEdit?.docId === doc.id ? 'is-active' : undefined}
              onClick={() => setLinkEdit(linkEdit?.docId === doc.id ? null : { docId: doc.id, value: grouped ? v.group.key : OWN })}
              disabled={linking}><LayersIcon /></button>
          )}
          {mayChange(doc) && (
            <button
              type="button"
              title="Удалить"
              aria-label="Удалить"
              className="s3-doc-btn-danger"
              onClick={() => handleDelete(doc)}
            ><TrashIcon /></button>
          )}
        </td>
      </tr>
    )
  }

  // Выбор связи версий у строки (без перетаскивания — телефон, клавиатура).
  const renderLinkEditor = (doc) => {
    const v = versionOf.get(doc.id)
    if (!v) return null
    const own = v.group
    const options = [
      { value: OWN, label: 'Самостоятельный файл' },
      ...(own.count > 1 ? [{ value: own.key, label: `Версия файла «${own.current.id === doc.id ? own.versions[own.count - 2].doc.file_name : own.current.file_name}» — как сейчас` }] : []),
      ...groups.filter((g) => g.key !== own.key).map((g) => {
        const { no, count } = placeInGroup(doc, g)
        return { value: g.key, label: `Версия файла «${g.current.file_name}» — станет версией ${no} из ${count}` }
      }),
    ]
    const current = own.count > 1 ? own.key : OWN
    const save = () => {
      if (linkEdit.value === current) { setLinkEdit(null); return }
      relink(doc, linkEdit.value === OWN ? null : groupByKey.get(linkEdit.value))
    }
    return (
      <tr key={`${doc.id}-link`} className="s3-ver-edit-row">
        <td colSpan={5}>
          <div className="s3-ver-edit" role="group" aria-label={`Версии файла «${doc.file_name}»`}>
            <div className="s3-ver-edit-title">«{doc.file_name}» — это:</div>
            <div className="s3-ver-edit-options">
              {options.map((o) => (
                <label key={o.value} className={`s3-ver-option${linkEdit.value === o.value ? ' is-checked' : ''}`}>
                  <input type="radio" name={`ver-${doc.id}`} value={o.value} checked={linkEdit.value === o.value}
                    onChange={() => setLinkEdit({ docId: doc.id, value: o.value })} disabled={linking} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            <p className="s3-ver-edit-hint">Версии упорядочены по дате загрузки: последняя загруженная — текущая.</p>
            <div className="s3-ver-edit-actions">
              <button type="button" className="s3-doc-btn-primary" onClick={save} disabled={linking}>
                {linking ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button type="button" className="s3-doc-btn-secondary" onClick={() => setLinkEdit(null)} disabled={linking}>Отмена</button>
            </div>
          </div>
        </td>
      </tr>
    )
  }

  // Группа версий: строка текущей версии, под ней (раскрыта) — прежние от новой к первой, и выбор связи у нужной строки.
  const renderGroup = (g) => {
    const open = !!openGroups[g.key]
    const rows = []
    const pushRow = (v, head) => {
      rows.push(renderRow(v.doc, formatDateTime(v.doc.created_at), { group: g, no: v.no }, { head }))
      if (linkEdit?.docId === v.doc.id) rows.push(renderLinkEditor(v.doc))
    }
    pushRow(g.versions[g.count - 1], true)
    if (open) for (let i = g.count - 2; i >= 0; i--) pushRow(g.versions[i], false)
    // Выбор у прежней версии свёрнутой группы — не прячем.
    if (!open && linkEdit && g.versions.some((v, i) => i < g.count - 1 && v.doc.id === linkEdit.docId)) {
      const v = g.versions.find((x) => x.doc.id === linkEdit.docId)
      rows.push(renderRow(v.doc, formatDateTime(v.doc.created_at), { group: g, no: v.no }))
      rows.push(renderLinkEditor(v.doc))
    }
    return (
      <tbody
        key={g.key}
        className={`s3-ver-group${g.count > 1 ? ' has-versions' : ''}${dropKey === g.key ? ' is-drop-target' : ''}`}
        data-folder-key={g.key}
      >
        {rows}
      </tbody>
    )
  }

  // Выбор «как загрузить» для файлов, похожих на новые версии.
  const renderPlan = () => {
    const extra = new Map() // id текущей → сколько файлов плана уже кладётся в эту группу
    const labels = plan.map((it) => {
      if (!it.target) return null
      const n = (extra.get(it.target) || 0) + 1
      extra.set(it.target, n)
      return n
    })
    const groupOfTarget = (id) => (groups || []).find((g) => g.current.id === id)
    const go = () => {
      const items = plan
      setPlan(null)
      uploadFiles(items.map((it) => it.file), null, items.map((it) => it.target || null))
    }
    return (
      <div className="s3-ver-plan" role="group" aria-label="Как загрузить файлы">
        <div className="s3-ver-plan-title">Похоже на новые версии файлов — проверьте, как загрузить:</div>
        <ul className="s3-ver-plan-list">
          {plan.map((it, i) => {
            const g = it.target ? groupOfTarget(it.target) : null
            return (
              <li key={`${it.file.name}-${i}`}>
                <span className="s3-ver-plan-file" title={it.file.name}>{it.file.name}</span>
                <select
                  value={it.target}
                  aria-label={`Как загрузить «${it.file.name}»`}
                  onChange={(e) => setPlan((prev) => prev.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}
                >
                  <option value="">Отдельный файл</option>
                  {(groups || []).map((grp) => (
                    <option key={grp.key} value={grp.current.id}>Новая версия «{grp.current.file_name}»</option>
                  ))}
                </select>
                {g && <span className="s3-ver-plan-note">станет версией {g.count + labels[i]}</span>}
              </li>
            )
          })}
        </ul>
        <div className="s3-ver-edit-actions">
          <button type="button" className="s3-doc-btn-primary" onClick={go} disabled={uploading}>Загрузить</button>
          <button type="button" className="s3-doc-btn-secondary" onClick={() => setPlan(null)}>Отмена</button>
        </div>
      </div>
    )
  }

  const standaloneVisible = dragDoc && (versionOf.get(dragDoc.id)?.group.count || 1) > 1

  return (
    <div
      className={`s3-doc-list${versions && !dateFolders ? ' has-version-ui' : ''}${dropKey === DROP_LIST ? ' is-drop-target' : ''}${dropKey || dragDoc ? ' is-dragging' : ''}${standaloneVisible ? ' has-standalone' : ''}`}
      {...dropHandlers}
    >
      <div className="s3-doc-toolbar">
        <h3 className="s3-doc-title">{title}</h3>
        <div className="s3-doc-toolbar-actions">
          {downloadAllOwner != null && !loading && documents.length > 0 && (
            <DocListZipButton docs={documents} ownerName={downloadAllOwner} title={title} />
          )}
          {canEdit && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={handlePickFiles}
              />
              <button
                type="button"
                className="s3-doc-btn-primary"
                onClick={() => pickInto(null)}
                disabled={uploading || !ownerId}
                aria-live="polite"
                title={dateFolders
                  ? 'Можно выбрать несколько файлов — они лягут в папку с сегодняшней датой. В прежнюю папку — «+ в папку» или перетащите файлы на неё'
                  : versionsOn ? 'Новые файлы. Новую версию файла — кнопкой у файла или перетащите файл на его строку'
                    : undefined}
              >
                <UploadIcon />
                {!uploading ? 'Загрузить' : progressLabel(uploadProgress)}
              </button>
            </>
          )}
        </div>
      </div>

      {loading && <div className="s3-doc-empty">Загрузка списка…</div>}
      {error && <div className="s3-doc-error">Ошибка: {error}</div>}
      {!loading && !error && documents.length === 0 && (
        <div className="s3-doc-empty">{fileDropEnabled ? 'Документы не загружены — нажмите «Загрузить» или перетащите файлы сюда' : 'Документы не загружены'}</div>
      )}
      {plan && renderPlan()}
      {(dropKey || dragDoc) && dropHint && (
        <div className="s3-doc-drop-hint" role="status">{dropHint}</div>
      )}

      {!loading && documents.length > 0 && (
        <table className="s3-doc-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Размер</th>
              <th>Кто загрузил</th>
              <th>{dateFolders ? 'Время' : 'Когда'}</th>
              <th className="s3-doc-actions-col">Действия</th>
            </tr>
          </thead>
          {versionsOn ? groups.map(renderGroup) : dateFolders ? groupDocsByDay(documents).map((folder, i) => {
            const open = folderOpen[folder.key] ?? i === 0
            // В прежнюю папку — только с колонкой folder_date; в сегодняшнюю — всегда; «Без даты» — нет.
            const canAddHere = canEdit && !!folder.key && (folder.key === today || canFolderDate)
            return (
              <tbody
                key={folder.key || 'no-date'}
                className={`s3-doc-folder${dropKey && dropKey === folder.key ? ' is-drop-target' : ''}`}
                data-folder-key={folder.key || undefined}
              >
                <tr className="s3-doc-folder-row">
                  <td colSpan={5}>
                    <div className="s3-doc-folder-head">
                      <button
                        type="button"
                        className={`s3-doc-folder-toggle${open ? ' is-open' : ''}`}
                        aria-expanded={open}
                        onClick={() => toggleFolder(folder.key, open)}
                      >
                        <span className="s3-doc-folder-chevron"><ChevronIcon /></span>
                        <FolderIcon />
                        <span className="s3-doc-folder-date">{folder.label}</span>
                        <span className="s3-doc-folder-count">{filesCountLabel(folder.docs.length)}</span>
                      </button>
                      {canAddHere && (
                        <button
                          type="button"
                          className="s3-doc-folder-add"
                          onClick={() => pickInto(folder.key)}
                          disabled={uploading}
                          aria-label={`Загрузить файлы в папку ${folder.label}`}
                          title={`Загрузить файлы в папку ${folder.label} (или перетащите их на папку)`}
                        >
                          <PlusIcon />
                          <span>в папку</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {open && folder.docs.map((doc) => renderRow(doc, uploadedOtherDay(doc) ? formatDateTime(doc.created_at) : localTime(doc.created_at)))}
              </tbody>
            )
          }) : (
            <tbody>
              {documents.map((doc) => renderRow(doc, formatDateTime(doc.created_at)))}
            </tbody>
          )}
        </table>
      )}

      {standaloneVisible && (
        <div
          className={`s3-ver-standalone${dropKey === DROP_STANDALONE ? ' is-drop-target' : ''}`}
          data-ver-standalone="1"
        >
          Отпустите здесь — файл станет самостоятельным (не версией)
        </div>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} onRenamed={mayChange(previewDoc) ? handleRenamed : undefined} />
      )}
    </div>
  )
}
