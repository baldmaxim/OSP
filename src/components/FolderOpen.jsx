import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { copyToClipboard } from '../utils/clipboard'
import { canOpenFolders, FOLDER_HELPER_FILE, FOLDER_HELPER_URL, folderOpenUrl, isFolderPath } from '../utils/folderOpen'
import './FolderOpen.css'

// Открыть папку в проводнике по нажатию на путь (FolderPathCell, путь заявки на ДС, общая папка раздела).
//
// openFolder(path) открывает ссылку osp-folder:… — её обрабатывает помощник на компьютере (utils/folderOpen.js).
// Понять из браузера, стоит ли помощник, нельзя: без него браузер молча ничего не делает. Поэтому в первый раз
// (в этом браузере) — окно: поставить помощник, открыть папку, скопировать путь. Дальше папка открывается сразу,
// а внизу на несколько секунд — «Открываем папку… Не открылась?» с тем же окном.
// Возвращает false, если путь не к папке Windows или компьютер не на Windows: тогда у вызывающего — прежнее действие.
//
// Окно и подсказка рисуются в своём корне в <body>: openFolder зовут из ячеек таблиц, провайдер на каждую страницу
// не нужен.

const READY_KEY = 'osp:folderHelperReady'
const TOAST_MS = 6000

let state = { help: null, toast: null }
const listeners = new Set()
const setState = (patch) => {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
const getState = () => state

function helperReady() {
  try { return window.localStorage.getItem(READY_KEY) === '1' } catch { return false }
}
function markHelperReady() {
  try { window.localStorage.setItem(READY_KEY, '1') } catch { /* приватный режим — окно покажется ещё раз */ }
}

// Переход по ссылке схемы — нажатием на временную ссылку: вызов остаётся в том же нажатии пользователя, а без
// помощника Chrome и Edge ничего не делают (страница не уходит).
function launch(path) {
  const a = document.createElement('a')
  a.href = folderOpenUrl(path)
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function ensureHost() {
  if (document.getElementById('osp-folder-open')) return
  const el = document.createElement('div')
  el.id = 'osp-folder-open'
  document.body.appendChild(el)
  createRoot(el).render(<FolderOpenHost />)
}

export function openFolder(path) {
  const value = String(path ?? '').trim()
  if (!isFolderPath(value) || !canOpenFolders()) return false
  ensureHost()
  if (!helperReady()) {
    setState({ help: { path: value }, toast: null })
    return true
  }
  launch(value)
  setState({ toast: { path: value, id: Date.now() } })
  return true
}

const IconFolderOpen = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
  </svg>
)
const IconDownload = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
)

function FolderOpenHelp({ path, onClose }) {
  const [copied, setCopied] = useState(false)
  const openRef = useRef(null)
  useEffect(() => { openRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => {
    if (!(await copyToClipboard(path))) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную.'); return }
    setCopied(true)
  }
  const open = () => {
    markHelperReady()
    launch(path)
    onClose()
  }

  return (
    <div className="fopen-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="fopen-modal" role="dialog" aria-modal="true" aria-labelledby="fopen-title">
        <div className="fopen-head">
          <span className="fopen-head-icon"><IconFolderOpen /></span>
          <h3 id="fopen-title">Открыть папку в проводнике</h3>
          <button type="button" className="fopen-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="fopen-path" title={path}>{path}</div>
        <ol className="fopen-steps">
          <li>
            Один раз на этом компьютере поставьте помощник: скачайте файл и запустите его, на вопрос ответьте «Да».
            Права администратора не нужны. Если Windows предупредит о неизвестном файле — «Подробнее» → «Выполнить в
            любом случае».
            <a className="fopen-download" href={FOLDER_HELPER_URL} download={FOLDER_HELPER_FILE}>
              <IconDownload /> Скачать помощник
            </a>
          </li>
          <li>
            Нажмите «Открыть папку». Браузер спросит, открыть ли приложение, — отметьте «Всегда разрешать» и нажмите
            «Открыть». Дальше папки открываются сразу.
          </li>
        </ol>
        <p className="fopen-note">
          Помощник открывает только папки локальной сети (\\сервер\папка или X:\папка) и ничего не запускает. Без него
          путь можно скопировать и вставить в адресную строку проводника: Win+E → Ctrl+L → Ctrl+V.
        </p>
        <div className="fopen-actions">
          <button type="button" ref={openRef} className="fopen-btn is-primary" onClick={open}>Открыть папку</button>
          <button type="button" className="fopen-btn" onClick={copy}>{copied ? 'Скопировано' : 'Скопировать путь'}</button>
          <button type="button" className="fopen-btn is-quiet" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}

function FolderOpenToast({ toast, onHelp, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, TOAST_MS)
    return () => clearTimeout(t)
  }, [toast.id, onClose])
  return (
    <div className="fopen-toast" role="status">
      <IconFolderOpen />
      <span>Открываем папку в проводнике…</span>
      <button type="button" className="fopen-toast-link" onClick={onHelp}>Не открылась?</button>
      <button type="button" className="fopen-toast-close" onClick={onClose} aria-label="Скрыть">✕</button>
    </div>
  )
}

const closeHelp = () => setState({ help: null })
const closeToast = () => setState({ toast: null })

function FolderOpenHost() {
  const { help, toast } = useSyncExternalStore(subscribe, getState)
  return (
    <>
      {help && <FolderOpenHelp path={help.path} onClose={closeHelp} />}
      {toast && !help && (
        <FolderOpenToast toast={toast} onClose={closeToast} onHelp={() => setState({ help: { path: toast.path }, toast: null })} />
      )}
    </>
  )
}
