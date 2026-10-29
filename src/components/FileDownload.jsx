import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { saveAs } from 'file-saver'
import { requestDownloadUrl } from '../services/s3'
import { IconDownload } from './icons/ActionIcons'
import './FileDownload.css'

// Скачать файл, не уходя со страницы (29.10.2026, решение пользователя: «чтобы визуально не обновлялась страница
// при нажатии скачки в любом месте сайта»).
//
// Раньше подписанная ссылка открывалась в новой вкладке (target=_blank) или в этой же (location.assign): браузер
// открывал вкладку и тут же закрывал её — окно мигало, а страница на возврате получала visibilitychange и
// перечитывала данные. Теперь байты берёт fetch (GET с сайта бакет разрешает — так же собирается «Скачать всё»),
// файл сохраняется из памяти (file-saver) под нужным именем: ни вкладки, ни перехода, ни beforeunload.
//
// Файл идёт дольше SHOW_AFTER_MS — внизу справа «Скачиваем «имя»» с ходом загрузки и отменой (свой корень в
// <body>, как у FolderOpen). Повторное нажатие на тот же файл, пока он качается, второй файл не качает.
// Ошибка — исключением (сообщение показывает вызывающий), отмена — false без исключения.

const SHOW_AFTER_MS = 400

let state = { items: [] }
const listeners = new Set()
const setItems = (fn) => {
  state = { items: fn(state.items) }
  listeners.forEach(l => l())
}
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
const getState = () => state

const patchItem = (id, patch) => setItems(list => list.map(it => (it.id === id ? { ...it, ...patch } : it)))

const inflight = new Map()
let seq = 0

function ensureHost() {
  if (document.getElementById('osp-file-download')) return
  const el = document.createElement('div')
  el.id = 'osp-file-download'
  document.body.appendChild(el)
  createRoot(el).render(<FileDownloadHost />)
}

// Тело ответа — кусками, чтобы показать ход загрузки; без потока (старый браузер) — целиком.
async function readBody(res, onProgress) {
  const type = res.headers.get('content-type') || ''
  if (!res.body?.getReader) return res.blob()
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress(loaded, total)
  }
  return new Blob(chunks, { type })
}

async function transfer(s3Key, fileName) {
  ensureHost()
  const id = ++seq
  const controller = new AbortController()
  setItems(list => [...list, { id, name: fileName, loaded: 0, total: 0, visible: false, cancel: () => controller.abort() }])
  const timer = setTimeout(() => patchItem(id, { visible: true }), SHOW_AFTER_MS)
  // Плашку перерисовываем по процентам (или по 256 КБ без размера), а не на каждый кусок.
  let mark = -1
  try {
    const { presigned_url } = await requestDownloadUrl(s3Key, { fileName, download: true })
    const res = await fetch(presigned_url, { signal: controller.signal })
    if (!res.ok) throw new Error(res.status === 404 ? 'файла нет в хранилище' : `хранилище ответило ${res.status}`)
    const blob = await readBody(res, (loaded, total) => {
      const next = total ? Math.floor((loaded * 100) / total) : Math.floor(loaded / 262144)
      if (next === mark) return
      mark = next
      patchItem(id, { loaded, total })
    })
    if (controller.signal.aborted) return false
    saveAs(blob, fileName)
    return true
  } catch (e) {
    if (controller.signal.aborted) return false
    throw e
  } finally {
    clearTimeout(timer)
    setItems(list => list.filter(it => it.id !== id))
  }
}

// Файл хранилища под именем fileName (без имени — последняя часть ключа).
export function downloadS3File(s3Key, fileName) {
  if (inflight.has(s3Key)) return inflight.get(s3Key)
  const name = fileName || String(s3Key).split('/').pop() || 'файл'
  const p = transfer(s3Key, name).finally(() => inflight.delete(s3Key))
  inflight.set(s3Key, p)
  return p
}

const fmtMb = (n) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')}\u00a0МБ`

function DownloadToast({ item }) {
  const pct = item.total ? Math.min(100, Math.floor((item.loaded * 100) / item.total)) : null
  return (
    <div className="fdl-toast" role="status">
      <IconDownload />
      <div className="fdl-body">
        <div className="fdl-name" title={item.name}>Скачиваем «{item.name}»</div>
        <div className={`fdl-bar${pct == null ? ' is-indeterminate' : ''}`}>
          <span style={pct == null ? undefined : { width: `${pct}%` }} />
        </div>
      </div>
      <span className="fdl-pct">{pct != null ? `${pct}\u00a0%` : item.loaded ? fmtMb(item.loaded) : ''}</span>
      <button type="button" className="fdl-cancel" onClick={item.cancel} aria-label={`Отменить скачивание «${item.name}»`}>✕</button>
    </div>
  )
}

function FileDownloadHost() {
  const { items } = useSyncExternalStore(subscribe, getState)
  const shown = items.filter(it => it.visible)
  if (!shown.length) return null
  return (
    <div className="fdl-stack">
      {shown.map(it => <DownloadToast key={it.id} item={it} />)}
    </div>
  )
}
