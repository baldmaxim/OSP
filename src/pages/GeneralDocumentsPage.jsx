import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import AutoGrowTextarea from '../components/AutoGrowTextarea'
import PaperclipIcon from '../components/icons/PaperclipIcon'
import { useIsPhone } from '../hooks/useMediaQuery'
import {
  foldersIn, docsIn, folderPathOf, folderOptions, collectFolderIds,
  subtreeCounts, nextFolderOrder, nextDocOrder, searchInCategory,
} from '../utils/documentFolders'
import '../components/MobileCards.css'
import './GeneralDocumentsPage.css'

// task 416: реестр общих документов компании. Одна запись — «карточка документа»,
// в которой может быть несколько ссылок (general_document_links) и несколько файлов
// (s3_documents по owner_type='general_document', owner_id=id).
//
// task 434: внутри каждой подгруппы — папки произвольной вложенности
// (general_document_folders). Навигация как в Проводнике: показывается содержимое
// одной папки, сверху хлебные крошки, первой строкой «..». Текущая папка живёт
// в URL (?cat=&folder=), поэтому работают F5 и кнопка «назад» браузера.

const MATERIALS_PREVIEW = 4  // сколько материалов показывать в строке до «Ещё N»

function normalizeUrl(raw) {
  const v = (raw || '').trim()
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}
function isValidUrl(v) {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
// ДД.ММ.ГГГГ ЧЧ:ММ — для колонки «Обновлено»
function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
}
// Нейтральные SVG-иконки действий (currentColor, единый размер 16×16).
const gdIconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  width: 16, height: 16, 'aria-hidden': true,
}
const EditIcon = () => (
  <svg {...gdIconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const TrashIcon = () => (
  <svg {...gdIconProps}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
)
// Мягкий бейдж типа файла по расширению (без внешних библиотек).
function fileBadge(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return { label: 'PDF', cls: 'badge-pdf' }
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { label: 'DOC', cls: 'badge-doc' }
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return { label: 'XLS', cls: 'badge-xls' }
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { label: 'PPT', cls: 'badge-ppt' }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return { label: 'IMG', cls: 'badge-img' }
  if (['zip', 'rar', '7z'].includes(ext)) return { label: 'ZIP', cls: 'badge-other' }
  return { label: (ext || 'FILE').slice(0, 4).toUpperCase(), cls: 'badge-other' }
}

// Иконки подгрупп документов (SVG, currentColor — цвет задаётся из CSS).
const catIconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  width: 17, height: 17, 'aria-hidden': true,
}
const IconFolder = () => (
  <svg {...catIconProps}><path d="M4 5h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /></svg>
)
const IconHardHat = () => (
  <svg {...catIconProps}>
    <path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1Z" />
    <path d="M10 10V6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4" />
    <path d="M4 16v-3a6 6 0 0 1 6-6" /><path d="M14 7a6 6 0 0 1 6 6v3" />
  </svg>
)
const IconCalculator = () => (
  <svg {...catIconProps}>
    <rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8" />
    <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h4" />
  </svg>
)
const IconScale = () => (
  <svg {...catIconProps}>
    <path d="M12 3v18" /><path d="M7 21h10" />
    <path d="M5 7h4c1.5 0 3-.7 3-1.5 0 .8 1.5 1.5 3 1.5h4" />
    <path d="m5 7-3 7c0 1.1 1.3 2 3 2s3-.9 3-2Z" />
    <path d="m19 7-3 7c0 1.1 1.3 2 3 2s3-.9 3-2Z" />
  </svg>
)

// Подгруппы раздела «Документы». 'general' — текущий реестр «Общая информация».
const CATEGORIES = [
  { key: 'general', label: 'Общая информация', Icon: IconFolder },
  { key: 'engineers', label: 'Инженеры', Icon: IconHardHat },
  { key: 'economists', label: 'Экономисты', Icon: IconCalculator },
  { key: 'lawyers', label: 'Юристы', Icon: IconScale },
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]))

const EMPTY_FORM = { title: '', description: '', links: [], newFiles: [], category: 'general', folder_id: null }
const EMPTY_FOLDER_FORM = { open: false, editing: null, name: '', parentId: null, saving: false, error: '' }

// Ограничения загрузки файлов для корпоративного реестра документов.
const MAX_FILE_SIZE_MB = 50
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
// Исполняемые / потенциально опасные типы — запрещены (не документы).
const BLOCKED_EXTENSIONS = ['exe', 'msi', 'bat', 'cmd', 'scr', 'ps1', 'sh', 'dll', 'com', 'jar', 'vbs', 'vbe', 'wsf', 'pif', 'hta', 'cpl', 'msc', 'reg']
// Подсказка для input accept (не защита — основная проверка в validateFile).
const ACCEPT_HINT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp,.heic,.zip,.rar,.7z,.odt,.ods,.odp'

function getFileExtension(name) {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}
// Причина отклонения файла (строка) или null, если файл допустим.
function validateFile(file) {
  const ext = getFileExtension(file.name)
  if (BLOCKED_EXTENSIONS.includes(ext)) return 'исполняемые файлы запрещены'
  if (file.size === 0) return 'файл пустой'
  if (file.size > MAX_FILE_SIZE) return `превышает лимит ${MAX_FILE_SIZE_MB} МБ`
  return null
}
// Понятная причина сбоя загрузки в S3 (техническое остаётся в console).
function uploadFailureReason(err, fileName) {
  const msg = String(err?.message || '')
  if (/Unsupported owner_type/i.test(msg)) return `${fileName} — не настроена загрузка файлов для раздела «Документы», обратитесь к администратору`
  if (/Missing owner_id|Missing file_name/i.test(msg)) return `${fileName} — некорректные данные загрузки, обновите страницу`
  if (/presigned URL|non-2xx|Edge Function|Unauthorized|not configured/i.test(msg)) return `${fileName} — не удалось получить ссылку загрузки`
  if (/PUT не удался|Failed to fetch|NetworkError|network|403|413|CORS/i.test(msg)) return `${fileName} — ошибка загрузки в хранилище, попробуйте позже`
  if (/row-level security|violates|constraint|duplicate|s3_documents|column/i.test(msg)) return `${fileName} — не удалось сохранить запись о файле`
  return `${fileName} — не удалось загрузить`
}

export default function GeneralDocumentsPage() {
  const navigate = useNavigate()
  const { user, userProfile, canEdit } = useRole()
  const isPhone = useIsPhone()
  const canEditDocs = canEdit('general_documents')
  // Отображаемое имя текущего пользователя (ФИО → email → null) для created_by/updated_by.
  const currentUserName = userProfile?.full_name || user?.email || null

  const [documents, setDocuments] = useState([])
  const [folders, setFolders] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  // Подгруппа и текущая папка живут в URL (?cat=&folder=): работают F5, «назад»
  // браузера и ссылка на конкретную папку, отправленная коллеге.
  const [searchParams, setSearchParams] = useSearchParams()
  const catParam = searchParams.get('cat')
  const activeCat = CATEGORY_LABEL[catParam] ? catParam : 'general'
  const folderParam = searchParams.get('folder') || null
  // Каждая вкладка помнит папку, в которой её оставили.
  const folderMemory = useRef({})

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [removeFileIds, setRemoveFileIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [fileErrors, setFileErrors] = useState([])
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef(null)

  // Модалка папки: создание / переименование / перенос.
  const [folderForm, setFolderForm] = useState(EMPTY_FOLDER_FORM)
  const [deletingFolderId, setDeletingFolderId] = useState(null)

  // Загрузка: папки + карточки + ссылки (join) + файлы из s3_documents (по owner).
  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const [docsRes, foldersRes] = await Promise.all([
        supabase
          .from('general_documents')
          .select('*, general_document_links(*)')
          .order('sort_order', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true }),
        supabase
          .from('general_document_folders')
          .select('*')
          .order('sort_order', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true }),
      ])
      if (docsRes.error) throw docsRes.error
      if (foldersRes.error) throw foldersRes.error
      const docs = docsRes.data
      const folderRows = foldersRes.data || []

      const ids = (docs || []).map(d => d.id)
      let filesByDoc = {}
      if (ids.length) {
        const { data: files, error: fErr } = await supabase
          .from('s3_documents')
          .select('id, owner_id, file_name, s3_key, size_bytes, created_at')
          .eq('owner_type', 'general_document')
          .in('owner_id', ids)
          .order('created_at', { ascending: true })
        if (fErr) throw fErr
        filesByDoc = (files || []).reduce((acc, f) => {
          (acc[f.owner_id] = acc[f.owner_id] || []).push(f)
          return acc
        }, {})
      }

      const mapped = (docs || []).map(d => ({
        ...d,
        links: [...(d.general_document_links || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
        files: filesByDoc[d.id] || [],
      }))
      setDocuments(mapped)
      setFolders(folderRows)
      return { docs: mapped, folders: folderRows }
    } catch (err) {
      console.error('Ошибка загрузки документов:', err.message)
      alert('Ошибка загрузки документов: ' + err.message)
      return { docs: [], folders: [] }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  // Кол-во документов по каждой подгруппе (для бейджей во вкладках).
  const catCounts = useMemo(() => {
    const c = {}
    for (const d of documents) {
      const k = d.category || 'general'
      c[k] = (c[k] || 0) + 1
    }
    return c
  }, [documents])

  // ── Навигация по папкам ────────────────────────────────────────────────
  // Папка из URL могла быть удалена в другой вкладке или относиться к другой
  // подгруппе — в обоих случаях спокойно показываем корень.
  const currentFolderId = useMemo(() => {
    if (!folderParam) return null
    const f = folders.find(x => x.id === folderParam)
    if (!f || (f.category || 'general') !== activeCat) return null
    return f.id
  }, [folderParam, folders, activeCat])

  const folderPath = useMemo(() => folderPathOf(folders, currentFolderId), [folders, currentFolderId])

  useEffect(() => { folderMemory.current[activeCat] = currentFolderId }, [activeCat, currentFolderId])

  const goTo = useCallback((cat, folderId) => {
    const next = {}
    if (cat && cat !== 'general') next.cat = cat
    if (folderId) next.folder = folderId
    setSearchParams(next)
  }, [setSearchParams])

  const setActiveCat = useCallback((cat) => {
    goTo(cat, folderMemory.current[cat] || null)
  }, [goTo])

  const enterFolder = useCallback((folderId) => { setSearch(''); goTo(activeCat, folderId) }, [goTo, activeCat])
  const goUp = useCallback(() => {
    const parent = folderPath.length > 1 ? folderPath[folderPath.length - 2].id : null
    goTo(activeCat, parent)
  }, [goTo, activeCat, folderPath])

  // ── Содержимое текущей папки / результаты поиска ───────────────────────
  const matchDoc = useCallback((d, q) => {
    const hay = [
      d.title,
      d.description,
      ...(d.links || []).flatMap(l => [l.title, l.url]),
      ...(d.files || []).map(f => f.file_name),
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  }, [])

  // При поиске игнорируем текущую папку и ищем по всей подгруппе: пользователь
  // не знает, в какой папке лежит нужный документ.
  const searchMode = search.trim().length > 0
  const searchResults = useMemo(
    () => searchInCategory(folders, documents, activeCat, search, matchDoc),
    [folders, documents, activeCat, search, matchDoc],
  )

  const visibleFolders = useMemo(
    () => (searchMode ? searchResults.folders : foldersIn(folders, activeCat, currentFolderId)),
    [searchMode, searchResults, folders, activeCat, currentFolderId],
  )
  const visibleDocs = useMemo(
    () => (searchMode ? searchResults.docs : docsIn(documents, activeCat, currentFolderId)),
    [searchMode, searchResults, documents, activeCat, currentFolderId],
  )
  const isEmptyView = visibleFolders.length === 0 && visibleDocs.length === 0

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // ── Модалка ────────────────────────────────────────────────────────────
  const clearErrors = () => { setFormError(''); setLinkError(''); setFileErrors([]) }
  const openAdd = () => {
    setEditing(null)
    // Новый документ создаётся в текущей открытой подгруппе и папке.
    setForm({ ...EMPTY_FORM, links: [], category: activeCat, folder_id: currentFolderId })
    setRemoveFileIds(new Set())
    clearErrors()
    setShowModal(true)
  }
  const openEdit = (doc) => {
    setEditing(doc)
    setForm({
      title: doc.title || '',
      description: doc.description || '',
      links: (doc.links || []).map(l => ({ title: l.title || '', url: l.url || '' })),
      newFiles: [],
      category: doc.category || 'general',
      folder_id: doc.folder_id || null,
    })
    setRemoveFileIds(new Set())
    clearErrors()
    setShowModal(true)
  }
  // Смена подгруппы обнуляет папку: папки чужой подгруппы недоступны, а триггер
  // general_documents_sync_folder_category молча вернул бы документ обратно.
  const changeFormCategory = (cat) => setForm(f => ({ ...f, category: cat, folder_id: null }))
  const closeModal = () => {
    if (saving) return
    setShowModal(false); setEditing(null); setForm(EMPTY_FORM); setRemoveFileIds(new Set())
    clearErrors(); setDragActive(false)
  }

  // Escape окно не закрывает — заполненную форму слишком легко потерять случайным
  // нажатием. Закрытие только осознанное: крестик или «Отмена».

  const openFileDialog = () => fileInputRef.current?.click()
  const onDropZoneDragOver = (e) => { e.preventDefault(); if (!dragActive) setDragActive(true) }
  const onDropZoneDragLeave = (e) => { e.preventDefault(); setDragActive(false) }
  const onDropZoneDrop = (e) => {
    e.preventDefault()
    setDragActive(false)
    if (e.dataTransfer?.files?.length) addNewFiles(e.dataTransfer.files)
  }

  const addLinkRow = () => setForm(f => ({ ...f, links: [...f.links, { title: '', url: '' }] }))
  const updateLinkRow = (i, field, value) => setForm(f => ({
    ...f, links: f.links.map((l, idx) => idx === i ? { ...l, [field]: value } : l),
  }))
  const removeLinkRow = (i) => setForm(f => ({ ...f, links: f.links.filter((_, idx) => idx !== i) }))

  const addNewFiles = (fileList) => {
    const arr = Array.from(fileList || [])
    if (!arr.length) return
    const accepted = []
    const rejected = []
    arr.forEach(f => {
      const reason = validateFile(f)
      if (reason) rejected.push(`${f.name} — ${reason}`)
      else accepted.push(f)
    })
    if (accepted.length) setForm(f => ({ ...f, newFiles: [...f.newFiles, ...accepted] }))
    setFileErrors(rejected)
  }
  const removeNewFile = (i) => setForm(f => ({ ...f, newFiles: f.newFiles.filter((_, idx) => idx !== i) }))
  const toggleRemoveExistingFile = (id) => setRemoveFileIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const handleDownload = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key, { fileName: s3doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = s3doc.file_name || ''
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      alert('Не удалось получить файл: ' + e.message)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    clearErrors()
    const title = form.title.trim()
    if (!title) { setFormError('Укажите наименование документа'); return }

    // Валидация ссылок: игнорируем полностью пустые строки; ловим «есть название, но нет URL»
    // и некорректные URL. Ошибку показываем рядом с блоком ссылок.
    const nonEmpty = form.links
      .map(l => ({ title: (l.title || '').trim(), rawUrl: (l.url || '').trim() }))
      .filter(r => r.title || r.rawUrl)
    for (const r of nonEmpty) {
      if (!r.rawUrl) { setLinkError('Для заполненного названия укажите ссылку (URL)'); return }
      if (!isValidUrl(normalizeUrl(r.rawUrl))) { setLinkError(`Укажите корректную ссылку: ${r.rawUrl}`); return }
    }
    const validLinks = nonEmpty.map(r => ({ title: r.title, url: normalizeUrl(r.rawUrl) }))

    const keptExisting = (editing?.files || []).filter(f => !removeFileIds.has(f.id))
    if (validLinks.length + form.newFiles.length + keptExisting.length === 0) {
      setFormError('Добавьте хотя бы одну ссылку или файл')
      return
    }

    setSaving(true)
    const problems = []
    try {
      let docId
      if (editing) {
        const { error } = await supabase.from('general_documents')
          .update({
            title,
            description: form.description.trim() || null,
            category: form.category || 'general',
            folder_id: form.folder_id || null,
            updated_at: new Date().toISOString(),
            updated_by: user?.id || null,
            updated_by_name: currentUserName,
          })
          .eq('id', editing.id)
        if (error) throw error
        docId = editing.id

        // Ссылки: вставляем новый набор, затем удаляем старые (безопасно при сбое).
        const oldLinkIds = (editing.links || []).map(l => l.id)
        if (validLinks.length) {
          const rows = validLinks.map((l, idx) => ({ general_document_id: docId, title: l.title || null, url: l.url, sort_order: idx }))
          const { error: insErr } = await supabase.from('general_document_links').insert(rows)
          if (insErr) throw insErr
        }
        if (oldLinkIds.length) {
          const { error: delErr } = await supabase.from('general_document_links').delete().in('id', oldLinkIds)
          if (delErr) throw delErr
        }

        // Удаляем помеченные существующие файлы.
        const toRemove = (editing.files || []).filter(f => removeFileIds.has(f.id))
        for (const f of toRemove) {
          try { await deleteDocument(f) } catch (delErr) {
            console.error('Файл не удалён:', f.file_name, delErr?.message)
            problems.push(`${f.file_name} — не удалось удалить файл из хранилища`)
          }
        }
      } else {
        const { data: created, error } = await supabase.from('general_documents')
          .insert({
            title,
            description: form.description.trim() || null,
            category: form.category || 'general',
            folder_id: form.folder_id || null,
            sort_order: nextDocOrder(documents, form.category || 'general', form.folder_id || null),
            source_type: 'mixed',
            created_by: user?.id || null,
            created_by_name: currentUserName,
            updated_by: user?.id || null,
            updated_by_name: currentUserName,
          })
          .select('id')
          .single()
        if (error) throw error
        docId = created.id

        if (validLinks.length) {
          const rows = validLinks.map((l, idx) => ({ general_document_id: docId, title: l.title || null, url: l.url, sort_order: idx }))
          const { error: linkErr } = await supabase.from('general_document_links').insert(rows)
          if (linkErr) throw linkErr
        }
      }

      // Загрузка новых файлов (частичный сбой — сообщаем по каждому, не откатываем всё).
      const failedFiles = []
      for (const file of form.newFiles) {
        try {
          await uploadFile({ file, ownerType: 'general_document', ownerId: docId })
        } catch (upErr) {
          console.error('Файл не загружен:', file.name, upErr?.message)
          failedFiles.push(file)
          problems.push(uploadFailureReason(upErr, file.name))
        }
      }

      const { docs } = await fetchDocs()

      if (problems.length) {
        // Оставляем модалку открытой в режиме редактирования сохранённого документа,
        // чтобы можно было повторить проблемные операции без дублей.
        // category и folder_id обязательно переносим: без них повторное сохранение
        // перебросило бы документ в «Общую информацию» и в корень.
        const saved = docs.find(d => d.id === docId) || editing
        setEditing(saved)
        setForm({
          title,
          description: form.description,
          links: (saved?.links || validLinks).map(l => ({ title: l.title || '', url: l.url || '' })),
          newFiles: failedFiles,
          category: form.category || 'general',
          folder_id: form.folder_id || null,
        })
        setRemoveFileIds(new Set())
        setFileErrors(problems)
        setFormError('Документ сохранён, но часть операций не выполнена. Проверьте список ниже и сохраните снова.')
        return
      }
      // Показываем подгруппу и папку, в которые попал документ.
      setSearch('')
      goTo(form.category || 'general', form.folder_id || null)
      closeModal()
    } catch (err) {
      setFormError('Не удалось сохранить документ: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (doc) => {
    if (!window.confirm(`Удалить документ «${doc.title}» и все связанные файлы и ссылки?`)) return
    try {
      // Сначала файлы из S3 (при сбое — прерываемся, чтобы не потерять связь).
      for (const f of (doc.files || [])) {
        await deleteDocument(f)
      }
      // Ссылки удалятся каскадом вместе с записью.
      const { error } = await supabase.from('general_documents').delete().eq('id', doc.id)
      if (error) throw error
      await fetchDocs()
    } catch (err) {
      alert('Не удалось удалить документ: ' + err.message)
    }
  }

  // ── Папки ──────────────────────────────────────────────────────────────
  const openFolderAdd = () => setFolderForm({ ...EMPTY_FOLDER_FORM, open: true, parentId: currentFolderId })
  const openFolderEdit = (folder) => setFolderForm({
    ...EMPTY_FOLDER_FORM, open: true, editing: folder, name: folder.name || '', parentId: folder.parent_id || null,
  })
  const closeFolderModal = () => setFolderForm(prev => (prev.saving ? prev : EMPTY_FOLDER_FORM))

  const submitFolder = async (e) => {
    e.preventDefault()
    const name = folderForm.name.trim()
    if (!name) { setFolderForm(f => ({ ...f, error: 'Укажите название папки' })); return }

    setFolderForm(f => ({ ...f, saving: true, error: '' }))
    try {
      const parentId = folderForm.parentId || null
      if (folderForm.editing) {
        const { error } = await supabase.from('general_document_folders')
          .update({
            name,
            parent_id: parentId,
            updated_by: user?.id || null,
            updated_by_name: currentUserName,
          })
          .eq('id', folderForm.editing.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('general_document_folders')
          .insert({
            name,
            category: activeCat,
            parent_id: parentId,
            sort_order: nextFolderOrder(folders, activeCat, parentId),
            created_by: user?.id || null,
            created_by_name: currentUserName,
            updated_by: user?.id || null,
            updated_by_name: currentUserName,
          })
        if (error) throw error
      }
      await fetchDocs()
      setFolderForm(EMPTY_FOLDER_FORM)
    } catch (err) {
      // 23505 — уникальный индекс на имя внутри одной папки.
      const msg = err?.code === '23505'
        ? 'Папка с таким именем уже есть в этой папке'
        : 'Не удалось сохранить папку: ' + err.message
      setFolderForm(f => ({ ...f, saving: false, error: msg }))
    }
  }

  const handleDeleteFolder = async (folder) => {
    const { folders: nf, docs: nd } = subtreeCounts(folders, documents, folder.id)
    if (nf || nd) {
      const parts = []
      if (nf) parts.push(`${nf} ${pluralFolders(nf)}`)
      if (nd) parts.push(`${nd} ${pluralDocs(nd)}`)
      alert(`Нельзя удалить папку «${folder.name}».\n\nВнутри: ${parts.join(' и ')}.\nСначала переместите или удалите содержимое.`)
      return
    }
    if (!window.confirm(`Удалить пустую папку «${folder.name}»?`)) return
    setDeletingFolderId(folder.id)
    try {
      const { error } = await supabase.from('general_document_folders').delete().eq('id', folder.id)
      if (error) throw error
      await fetchDocs()
    } catch (err) {
      // 23503 — FK RESTRICT: содержимое появилось из другой вкладки браузера.
      alert(err?.code === '23503'
        ? 'Папка уже не пуста — обновите страницу и проверьте содержимое.'
        : 'Не удалось удалить папку: ' + err.message)
    } finally {
      setDeletingFolderId(null)
    }
  }

  // Материалы карточки для отображения (сначала ссылки, потом файлы).
  const buildMaterials = (doc) => ([
    ...(doc.links || []).map(l => ({ kind: 'link', id: `l-${l.id}`, title: l.title, url: l.url })),
    ...(doc.files || []).map(f => ({ kind: 'file', id: `f-${f.id}`, s3: f })),
  ])

  const renderMaterial = (m) => {
    if (m.kind === 'link') {
      return (
        <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" className="gd-material gd-material-link" title={m.url}>
          <span className="gd-mat-icon" aria-hidden>🔗</span>
          <span className="gd-mat-text">{m.title || 'Открыть ссылку'}</span>
        </a>
      )
    }
    return (
      <button key={m.id} className="gd-material gd-material-file" onClick={() => handleDownload(m.s3)} title={`Скачать ${m.s3.file_name}`}>
        <span className="gd-mat-icon" aria-hidden><PaperclipIcon size={14} /></span>
        <span className="gd-mat-text">{m.s3.file_name}</span>
        {m.s3.size_bytes != null && <span className="gd-mat-size">{formatSize(m.s3.size_bytes)}</span>}
      </button>
    )
  }

  const colCount = canEditDocs ? 6 : 5

  // Подпись со счётчиками: в режиме поиска — сколько нашли, иначе — что в папке.
  const countsLabel = searchMode
    ? `Найдено: ${visibleFolders.length} ${pluralFolders(visibleFolders.length)} и ${visibleDocs.length} ${pluralDocs(visibleDocs.length)}`
    : `${visibleFolders.length} ${pluralFolders(visibleFolders.length)} · ${visibleDocs.length} ${pluralDocs(visibleDocs.length)}`

  return (
    <div className="general-documents-page">
      <div className="gd-header">
        <div className="gd-header-left">
          <button className="gd-back" onClick={() => navigate('/general')} title="Назад к общей информации">←</button>
          <div>
            <h2>Документы</h2>
            <p className="gd-subtitle">Общие документы, инструкции и полезные ссылки</p>
          </div>
        </div>
        {canEditDocs && (
          <div className="gdf-header-actions">
            <button className="btn-secondary gdf-add-folder" onClick={openFolderAdd}>+ Папка</button>
            <button className="btn-primary" onClick={openAdd}>+ Добавить документ</button>
          </div>
        )}
      </div>

      {/* Подгруппы раздела «Документы» */}
      <div className="gd-tabs" role="tablist" aria-label="Подгруппы документов">
        {CATEGORIES.map(c => (
          <button
            key={c.key}
            role="tab"
            aria-selected={activeCat === c.key}
            className={`gd-tab gd-tab--${c.key}${activeCat === c.key ? ' is-active' : ''}`}
            onClick={() => setActiveCat(c.key)}
          >
            <span className="gd-tab-icon" aria-hidden><c.Icon /></span>
            <span className="gd-tab-label">{c.label}</span>
            <span className="gd-tab-count">{catCounts[c.key] || 0}</span>
          </button>
        ))}
      </div>

      {/* Хлебные крошки: путь до текущей папки. Каждый уровень кликабелен. */}
      <nav className={`gdf-breadcrumbs${currentFolderId ? ' is-nested' : ''}`} aria-label="Путь к папке">
        {currentFolderId && (
          <button type="button" className="gdf-crumb gdf-crumb-up" onClick={goUp} title="На уровень выше">↑</button>
        )}
        <button
          type="button"
          className={`gdf-crumb${currentFolderId ? '' : ' is-current'}`}
          onClick={() => enterFolder(null)}
          disabled={!currentFolderId}
        >
          <span className="gdf-crumb-icon" aria-hidden><IconFolder /></span>
          {CATEGORY_LABEL[activeCat]}
        </button>
        {folderPath.map((f, i) => (
          <span key={f.id} className="gdf-crumb-item">
            <span className="gdf-crumb-sep" aria-hidden>›</span>
            <button
              type="button"
              className={`gdf-crumb${i === folderPath.length - 1 ? ' is-current' : ''}`}
              onClick={() => enterFolder(f.id)}
              disabled={i === folderPath.length - 1}
            >{f.name}</button>
          </span>
        ))}
      </nav>

      <div className="gd-toolbar">
        <input
          type="text"
          className="gd-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Поиск по подгруппе «${CATEGORY_LABEL[activeCat]}»`}
        />
        <span className="gd-total">{countsLabel}</span>
      </div>

      {/* Шапка открытой папки — главный признак «мы внутри», а не в корне. */}
      {currentFolderId && !searchMode && (
        <div className="gdf-folder-banner">
          <span className="gdf-folder-banner-icon" aria-hidden><IconFolder /></span>
          <div className="gdf-folder-banner-text">
            <span className="gdf-folder-banner-name">{folderPath[folderPath.length - 1]?.name}</span>
            <span className="gdf-folder-banner-path">
              {[CATEGORY_LABEL[activeCat], ...folderPath.slice(0, -1).map(f => f.name)].join(' › ')}
            </span>
          </div>
          <button type="button" className="gdf-folder-banner-up" onClick={goUp}>↑ Наверх</button>
        </div>
      )}

      <div className={`gd-card${currentFolderId && !searchMode ? ' gdf-in-folder' : ''}`}>
        {loading ? (
          <div className="gd-loading">Загрузка...</div>
        ) : isEmptyView ? (
          <div className="gd-empty">
            {searchMode ? (
              <p>Ничего не найдено в подгруппе «{CATEGORY_LABEL[activeCat]}».</p>
            ) : currentFolderId ? (
              <>
                <p className="gd-empty-title">Папка «{folderPath[folderPath.length - 1]?.name}» пуста</p>
                <p className="gd-empty-hint">Создайте вложенную папку или добавьте документ</p>
                {canEditDocs && (
                  <div className="gdf-empty-actions">
                    <button className="btn-secondary" onClick={openFolderAdd}>+ Папка</button>
                    <button className="btn-primary" onClick={openAdd}>+ Добавить документ</button>
                  </div>
                )}
                <button className="gdf-up-btn" onClick={goUp} style={{ marginTop: '0.75rem' }}>↑ Наверх</button>
              </>
            ) : (
              <>
                <p className="gd-empty-title">В подгруппе «{CATEGORY_LABEL[activeCat]}» документов пока нет</p>
                <p className="gd-empty-hint">Добавьте первую ссылку, инструкцию или файл</p>
                {canEditDocs && (
                  <div className="gdf-empty-actions">
                    <button className="btn-secondary" onClick={openFolderAdd}>+ Папка</button>
                    <button className="btn-primary" onClick={openAdd}>+ Добавить документ</button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : isPhone ? (
          <div className="mcard-list">
            {!searchMode && currentFolderId && (
              <button type="button" className="mcard gdf-mcard-up" onClick={goUp}>↑ Наверх</button>
            )}
            {visibleFolders.map((folder) => {
              const cnt = subtreeCounts(folders, documents, folder.id)
              return (
                <div key={folder.id} className="mcard gdf-mcard-folder">
                  <div className="mcard-head">
                    <button type="button" className="gdf-name-btn" onClick={() => enterFolder(folder.id)}>
                      <span className="gdf-folder-icon" aria-hidden><IconFolder /></span>
                      <span className="mcard-title" style={{ fontSize: '0.9375rem' }}>{folder.name}</span>
                    </button>
                    {canEditDocs && (
                      <div className="mcard-actions">
                        <button className="gd-icon-btn" onClick={() => openFolderEdit(folder)} title="Переименовать" aria-label="Переименовать"><EditIcon /></button>
                        <button className="gd-icon-btn gd-icon-danger" onClick={() => handleDeleteFolder(folder)} disabled={deletingFolderId === folder.id} title="Удалить" aria-label="Удалить"><TrashIcon /></button>
                      </div>
                    )}
                  </div>
                  {searchMode && folder.__path && <div className="gdf-path">{folder.__path}</div>}
                  <div className="gdf-count">{cnt.folders} {pluralFolders(cnt.folders)} · {cnt.docs} {pluralDocs(cnt.docs)}</div>
                </div>
              )
            })}
            {visibleDocs.map((doc) => {
              const materials = buildMaterials(doc)
              return (
                <div key={doc.id} className="mcard">
                  <div className="mcard-head">
                    <span className="mcard-title" style={{ fontSize: '0.9375rem' }}>{doc.title}</span>
                    {canEditDocs && (
                      <div className="mcard-actions">
                        <button className="gd-icon-btn" onClick={() => openEdit(doc)} title="Редактировать" aria-label="Редактировать"><EditIcon /></button>
                        <button className="gd-icon-btn gd-icon-danger" onClick={() => handleDelete(doc)} title="Удалить" aria-label="Удалить"><TrashIcon /></button>
                      </div>
                    )}
                  </div>
                  {searchMode && doc.__path && (
                    <button type="button" className="gdf-path gdf-path-btn" onClick={() => enterFolder(doc.folder_id || null)}>
                      {doc.__path}
                    </button>
                  )}
                  {doc.description && <div className="mcard-desc">{doc.description}</div>}
                  {materials.length > 0 && (
                    <div className="gd-materials" style={{ marginTop: '0.25rem' }}>
                      {materials.map(renderMaterial)}
                    </div>
                  )}
                  <div className="mcard-rows">
                    <div className="mcard-row">
                      <span className="mcard-label">Обновлено</span>
                      <span className="mcard-value">{formatDateTime(doc.updated_at || doc.created_at)}</span>
                    </div>
                    <div className="mcard-row">
                      <span className="mcard-label">Обновил</span>
                      <span className="mcard-value">{doc.updated_by_name || doc.created_by_name || '—'}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="gd-table-container">
            <table className="gd-table">
              <colgroup>
                <col className="cg-num" />
                <col className="cg-title" />
                <col className="cg-materials" />
                <col className="cg-updated" />
                <col className="cg-updatedby" />
                {canEditDocs && <col className="cg-actions" />}
              </colgroup>
              <thead>
                <tr>
                  <th className="gd-col-num">№</th>
                  <th className="gd-col-title">Наименование документа</th>
                  <th className="gd-col-materials">Документы и ссылки</th>
                  <th className="gd-col-updated">Обновлено</th>
                  <th className="gd-col-updatedby">Обновил</th>
                  {canEditDocs && <th className="gd-col-actions">Действия</th>}
                </tr>
              </thead>
              <tbody>
                {/* Выход на уровень выше — первой строкой, как «..» в Проводнике. */}
                {!searchMode && currentFolderId && (
                  <tr className="gdf-up-row" onClick={goUp}>
                    <td className="gd-col-num" aria-hidden>↑</td>
                    <td className="gd-col-title" colSpan={colCount - 1}>
                      {/* Кликабельна вся строка; на кнопке гасим всплытие, иначе goUp дважды. */}
                      <button type="button" className="gdf-up-btn" onClick={(e) => { e.stopPropagation(); goUp() }}>.. Наверх</button>
                    </td>
                  </tr>
                )}
                {visibleFolders.map((folder, index) => {
                  const cnt = subtreeCounts(folders, documents, folder.id)
                  return (
                    <tr key={folder.id} className="gdf-row" onDoubleClick={() => enterFolder(folder.id)}>
                      <td className="gd-col-num">{index + 1}</td>
                      <td className="gd-col-title gd-title-cell">
                        <div className="document-title-cell">
                          <button type="button" className="gdf-name-btn" onClick={() => enterFolder(folder.id)} title="Открыть папку">
                            <span className="gdf-folder-icon" aria-hidden><IconFolder /></span>
                            <span className="document-title gd-title-text">{folder.name}</span>
                          </button>
                          {canEditDocs && (
                            <button
                              className="document-title-edit-button"
                              onClick={() => openFolderEdit(folder)}
                              title="Переименовать или переместить папку"
                              aria-label="Переименовать или переместить папку"
                            ><EditIcon /></button>
                          )}
                        </div>
                        {searchMode && folder.__path && <span className="gdf-path">{folder.__path}</span>}
                      </td>
                      <td className="gd-col-materials">
                        <span className="gdf-count">{cnt.folders} {pluralFolders(cnt.folders)} · {cnt.docs} {pluralDocs(cnt.docs)}</span>
                      </td>
                      <td className="gd-col-updated gd-updated-cell">{formatDateTime(folder.updated_at || folder.created_at)}</td>
                      <td className="gd-col-updatedby gd-updatedby-cell">
                        {folder.updated_by_name || folder.created_by_name || '—'}
                      </td>
                      {canEditDocs && (
                        <td className="gd-col-actions">
                          <button
                            className="gd-icon-btn gd-icon-danger"
                            onClick={() => handleDeleteFolder(folder)}
                            disabled={deletingFolderId === folder.id}
                            title="Удалить папку"
                            aria-label="Удалить папку"
                          ><TrashIcon /></button>
                        </td>
                      )}
                    </tr>
                  )
                })}
                {visibleDocs.map((doc, index) => {
                  const materials = buildMaterials(doc)
                  const isExp = expanded.has(doc.id)
                  const shown = isExp ? materials : materials.slice(0, MATERIALS_PREVIEW)
                  const hiddenCount = materials.length - shown.length
                  return (
                    <tr key={doc.id}>
                      <td className="gd-col-num">{visibleFolders.length + index + 1}</td>
                      <td className="gd-col-title gd-title-cell">
                        <div className="document-title-cell">
                          <span className="document-title gd-title-text">{doc.title}</span>
                          {canEditDocs && (
                            <button
                              className="document-title-edit-button"
                              onClick={() => openEdit(doc)}
                              title="Редактировать документ"
                              aria-label="Редактировать документ"
                            ><EditIcon /></button>
                          )}
                        </div>
                        {/* В режиме поиска показываем, в какой папке лежит найденное. */}
                        {searchMode && doc.__path && (
                          <button
                            type="button"
                            className="gdf-path gdf-path-btn"
                            onClick={() => enterFolder(doc.folder_id || null)}
                            title="Показать в папке"
                          >{doc.__path}</button>
                        )}
                        {/* Описание свёрнуто до 2 строк. Клик открывает карточку документа —
                            быстрый доступ к полному тексту и редактированию прямо из таблицы. */}
                        {doc.description && (
                          canEditDocs ? (
                            <button
                              type="button"
                              className="gd-desc-text gd-desc-btn"
                              onClick={() => openEdit(doc)}
                              title="Открыть карточку документа"
                            >{doc.description}</button>
                          ) : (
                            <span className="gd-desc-text" title={doc.description}>{doc.description}</span>
                          )
                        )}
                      </td>
                      <td className="gd-col-materials">
                        {materials.length === 0 ? (
                          <span className="gd-missing">—</span>
                        ) : (
                          <div className="gd-materials">
                            {shown.map(renderMaterial)}
                            {hiddenCount > 0 && (
                              <button className="gd-more-btn" onClick={() => toggleExpand(doc.id)}>Ещё {hiddenCount}</button>
                            )}
                            {isExp && materials.length > MATERIALS_PREVIEW && (
                              <button className="gd-more-btn" onClick={() => toggleExpand(doc.id)}>Свернуть</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="gd-col-updated gd-updated-cell">{formatDateTime(doc.updated_at || doc.created_at)}</td>
                      <td className="gd-col-updatedby gd-updatedby-cell">
                        {doc.updated_by_name || doc.created_by_name || '—'}
                      </td>
                      {canEditDocs && (
                        <td className="gd-col-actions">
                          <button className="gd-icon-btn gd-icon-danger" onClick={() => handleDelete(doc)} title="Удалить" aria-label="Удалить"><TrashIcon /></button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              {!isEmptyView && (
                <tfoot>
                  <tr>
                    <td colSpan={colCount} className="gd-tfoot">{countsLabel}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* Клик по подложке НЕ закрывает окно: заполненную форму легко потерять случайным
          кликом. Закрытие — только крестиком или кнопкой «Отмена». */}
      {showModal && (
        <div className="gd-modal-overlay">
          <div className="gd-modal" role="dialog" aria-modal="true">
            <div className="gd-modal-header">
              <div className="gd-modal-heading">
                <h3>{editing ? 'Редактировать документ' : 'Добавить документ'}</h3>
                <p className="gd-modal-subtitle">
                  {editing
                    ? 'Измените название, ссылки и прикреплённые файлы'
                    : 'Добавьте название, ссылки и прикреплённые файлы'}
                </p>
              </div>
              <button className="gd-modal-close" onClick={closeModal} aria-label="Закрыть">×</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="gd-modal-body">
                {/* Основная информация */}
                <section className="gd-section">
                  <h4 className="gd-section-title">Основная информация</h4>
                  <div className="gd-form-group">
                    <label htmlFor="gd-title">Наименование документа *</label>
                    <input
                      id="gd-title"
                      type="text"
                      value={form.title}
                      onChange={(e) => { setForm(f => ({ ...f, title: e.target.value })); if (formError) setFormError('') }}
                      placeholder="Например: Обучение Excel и Revit"
                      autoFocus
                    />
                  </div>
                  <div className="gd-form-group">
                    <label htmlFor="gd-category">Подгруппа</label>
                    <select
                      id="gd-category"
                      className="gd-select"
                      value={form.category}
                      onChange={(e) => changeFormCategory(e.target.value)}
                    >
                      {CATEGORIES.map(c => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="gd-form-group">
                    <label htmlFor="gd-folder">Папка</label>
                    <select
                      id="gd-folder"
                      className="gd-select"
                      value={form.folder_id || ''}
                      onChange={(e) => setForm(f => ({ ...f, folder_id: e.target.value || null }))}
                    >
                      <option value="">— Корень подгруппы —</option>
                      {folderOptions(folders, form.category || 'general').map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="gd-form-group">
                    <label htmlFor="gd-desc">Описание / примечание</label>
                    {/* Авторасширение: поле растёт под текст, без внутреннего ползунка.
                        Компонент неконтролируемый — модалка монтируется заново при каждом
                        открытии, поэтому defaultValue всегда актуален. */}
                    <AutoGrowTextarea
                      id="gd-desc"
                      className="gd-textarea"
                      minHeight={90}
                      defaultValue={form.description}
                      onInput={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Краткое описание — для кого и зачем этот документ (необязательно)"
                    />
                  </div>
                </section>

                {/* Ссылки */}
                <section className="gd-section">
                  <h4 className="gd-section-title">Ссылки</h4>
                  {form.links.length === 0 && <p className="gd-hint">Ссылки пока не добавлены</p>}
                  {form.links.map((l, i) => (
                    <div className="gd-link-row" key={i}>
                      <input
                        type="text"
                        className="gd-link-title"
                        value={l.title}
                        onChange={(e) => { updateLinkRow(i, 'title', e.target.value); if (linkError) setLinkError('') }}
                        placeholder="Название ссылки"
                      />
                      <input
                        type="text"
                        className="gd-link-url"
                        value={l.url}
                        onChange={(e) => { updateLinkRow(i, 'url', e.target.value); if (linkError) setLinkError('') }}
                        placeholder="https://..."
                      />
                      <button type="button" className="gd-row-remove" onClick={() => removeLinkRow(i)} title="Удалить ссылку" aria-label="Удалить ссылку">×</button>
                    </div>
                  ))}
                  {linkError && <p className="gd-inline-error">{linkError}</p>}
                  <button type="button" className="gd-add-row" onClick={addLinkRow}>+ Добавить ссылку</button>
                </section>

                {/* Файлы — зона загрузки */}
                <section className="gd-section">
                  <h4 className="gd-section-title">Файлы</h4>
                  <div
                    className={`gd-dropzone ${dragActive ? 'is-drag' : ''}`}
                    onClick={openFileDialog}
                    onDragOver={onDropZoneDragOver}
                    onDragLeave={onDropZoneDragLeave}
                    onDrop={onDropZoneDrop}
                  >
                    <span className="gd-dropzone-icon" aria-hidden>📎</span>
                    <div className="gd-dropzone-main">Перетащите файлы сюда</div>
                    <div className="gd-dropzone-sub">или выберите их на компьютере</div>
                    <button type="button" className="gd-dropzone-btn" onClick={(e) => { e.stopPropagation(); openFileDialog() }}>Выбрать файлы</button>
                    <div className="gd-dropzone-hint">PDF, DOCX, XLSX, изображения и архивы — до {MAX_FILE_SIZE_MB} МБ</div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={ACCEPT_HINT}
                      className="gd-file-input-hidden"
                      onChange={(e) => { addNewFiles(e.target.files); e.target.value = '' }}
                    />
                  </div>

                  {fileErrors.length > 0 && (
                    <div className="gd-file-errors" role="alert">
                      <div className="gd-file-errors-title">Проблемы с файлами:</div>
                      <ul>
                        {fileErrors.map((msg, i) => <li key={i}>{msg}</li>)}
                      </ul>
                    </div>
                  )}

                  {form.newFiles.length > 0 && (
                    <div className="gd-file-block">
                      <div className="gd-file-block-title">Новые файлы</div>
                      <ul className="gd-file-list">
                        {form.newFiles.map((f, i) => {
                          const b = fileBadge(f.name)
                          return (
                            <li key={i} className="gd-file-item is-new">
                              <span className={`gd-file-badge ${b.cls}`}>{b.label}</span>
                              <span className="gd-file-name" title={f.name}>{f.name}</span>
                              <span className="gd-file-size">{formatSize(f.size)}</span>
                              <button type="button" className="gd-file-action gd-file-remove" onClick={() => removeNewFile(i)} title="Убрать" aria-label="Убрать файл">Убрать</button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                </section>

                {/* Прикреплённые файлы (режим редактирования) */}
                {editing && (editing.files || []).length > 0 && (
                  <section className="gd-section">
                    <h4 className="gd-section-title">Прикреплённые файлы</h4>
                    <ul className="gd-file-list">
                      {editing.files.map(f => {
                        const b = fileBadge(f.file_name)
                        const marked = removeFileIds.has(f.id)
                        return (
                          <li key={f.id} className={`gd-file-item ${marked ? 'is-removed' : ''}`}>
                            <span className={`gd-file-badge ${b.cls}`}>{b.label}</span>
                            <span className="gd-file-name" title={f.file_name}>{f.file_name}</span>
                            {f.size_bytes != null && <span className="gd-file-size">{formatSize(f.size_bytes)}</span>}
                            <button type="button" className="gd-file-action" onClick={() => handleDownload(f)} title="Скачать" aria-label="Скачать файл">Скачать</button>
                            <button
                              type="button"
                              className={`gd-file-action ${marked ? '' : 'gd-file-remove'}`}
                              onClick={() => toggleRemoveExistingFile(f.id)}
                              title={marked ? 'Вернуть' : 'Удалить'}
                              aria-label={marked ? 'Вернуть файл' : 'Удалить файл'}
                            >{marked ? 'Вернуть' : 'Удалить'}</button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}
              </div>

              <div className="gd-modal-footer">
                {formError && <span className="gd-form-error">{formError}</span>}
                <div className="gd-footer-actions">
                  <button type="button" className="btn-secondary" onClick={closeModal} disabled={saving}>Отмена</button>
                  <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модалка папки: создание, переименование и перенос в другую папку. */}
      {folderForm.open && (
        <div className="gd-modal-overlay">
          <div className="gd-modal gdf-modal" role="dialog" aria-modal="true">
            <div className="gd-modal-header">
              <div className="gd-modal-heading">
                <h3>{folderForm.editing ? 'Папка' : 'Новая папка'}</h3>
                <p className="gd-modal-subtitle">
                  Подгруппа «{CATEGORY_LABEL[activeCat]}»
                </p>
              </div>
              <button className="gd-modal-close" onClick={closeFolderModal} aria-label="Закрыть">×</button>
            </div>

            <form onSubmit={submitFolder}>
              <div className="gd-modal-body">
                <div className="gd-form-group">
                  <label htmlFor="gdf-name">Название папки *</label>
                  <input
                    id="gdf-name"
                    type="text"
                    value={folderForm.name}
                    onChange={(e) => setFolderForm(f => ({ ...f, name: e.target.value, error: '' }))}
                    placeholder="Например: Проектная документация"
                    autoFocus
                  />
                </div>
                <div className="gd-form-group">
                  <label htmlFor="gdf-parent">Расположение</label>
                  <select
                    id="gdf-parent"
                    className="gd-select"
                    value={folderForm.parentId || ''}
                    onChange={(e) => setFolderForm(f => ({ ...f, parentId: e.target.value || null }))}
                  >
                    <option value="">— Корень подгруппы —</option>
                    {/* Себя и своих потомков в списке нет — иначе получился бы цикл. */}
                    {folderOptions(folders, activeCat, {
                      excludeIds: folderForm.editing ? collectFolderIds(folders, folderForm.editing.id) : null,
                    }).map(o => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="gd-modal-footer">
                {folderForm.error && <span className="gd-form-error">{folderForm.error}</span>}
                <div className="gd-footer-actions">
                  <button type="button" className="btn-secondary" onClick={closeFolderModal} disabled={folderForm.saving}>Отмена</button>
                  <button type="submit" className="btn-primary" disabled={folderForm.saving}>{folderForm.saving ? 'Сохранение…' : 'Сохранить'}</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function pluralDocs(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'документ'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'документа'
  return 'документов'
}

function pluralFolders(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'папка'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'папки'
  return 'папок'
}
