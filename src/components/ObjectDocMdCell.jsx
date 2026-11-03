import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { attachDocMd, isMdFileName, removeDocMd } from '../services/objectDocMd'
import { downloadS3File } from './FileDownload'
import { IconCheck, IconDownload, IconRefresh, IconTrash } from './icons/ActionIcons'
import './ObjectDocMdCell.css'

// Ячейка столбца «.md» в строке документа объекта: крестик и «.md» — файла нет, зелёная галочка — есть (один файл на
// документ). С правом правки нажатие на крестик загружает файл, на галочку — меню «Скачать / Заменить / Удалить». Без
// права галочка скачивает файл, крестик — просто отметка.
// onChanged(id документа, строка s3_documents | null) — обновить документ у родителя без перечитывания всей карточки.

const MENU_WIDTH = 176 // rem-значение в CSS — 11rem
const MENU_HEIGHT = 140 // примерно: имя файла и три действия; решает только, открывать меню вниз или вверх

const IconCross = () => (
  <svg className="doc-md-cross" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
  </svg>
)

function menuPosition(button) {
  const r = button.getBoundingClientRect()
  const left = Math.max(8, Math.min(r.left + r.width / 2 - MENU_WIDTH / 2, window.innerWidth - MENU_WIDTH - 8))
  const fitsBelow = r.bottom + 4 + MENU_HEIGHT <= window.innerHeight
  return fitsBelow ? { top: r.bottom + 4, left } : { bottom: window.innerHeight - r.top + 4, left }
}

export default function ObjectDocMdCell({ doc, canEdit, onChanged }) {
  const inputRef = useRef(null)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(null) // положение открытого меню
  const md = doc.md || null
  const title = doc.name || doc.document_number || 'документ'

  useEffect(() => {
    if (!menu) return undefined
    menuRef.current?.querySelector('button')?.focus()
    const close = () => setMenu(null)
    const onPointer = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) close()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { close(); buttonRef.current?.focus() }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const pickFile = () => {
    setMenu(null)
    inputRef.current?.click()
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // тот же файл можно выбрать снова
    if (!file) return
    if (!isMdFileName(file.name)) { alert('Нужен файл с расширением .md'); return }
    if (!file.size) { alert('Файл .md пустой'); return }
    setBusy(true)
    try {
      onChanged(doc.id, await attachDocMd(doc, file))
    } catch (err) {
      alert('Файл .md не загружен: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    setMenu(null)
    try {
      await downloadS3File(md.s3_key, md.file_name)
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const remove = async () => {
    setMenu(null)
    if (!window.confirm(`Удалить файл «${md.file_name}»?`)) return
    setBusy(true)
    try {
      await removeDocMd(doc)
      onChanged(doc.id, null)
    } catch (err) {
      alert('Файл .md не удалён: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const onCheck = () => {
    if (!canEdit) { download(); return }
    setMenu((open) => (open ? null : menuPosition(buttonRef.current)))
  }

  return (
    <div className="doc-md" data-md-doc={doc.id}>
      {canEdit && (
        <input ref={inputRef} type="file" accept=".md,text/markdown" hidden onChange={onFile} aria-label={`Файл .md: ${title}`} />
      )}
      {busy ? (
        <span className="doc-md-busy" role="status" aria-label={`Файл .md: ${title}, идёт операция`}>…</span>
      ) : md ? (
        <button
          ref={buttonRef}
          type="button"
          className="doc-md-btn doc-md-yes"
          onClick={onCheck}
          title={md.file_name}
          aria-label={`Файл .md есть: ${title}`}
          aria-haspopup={canEdit ? 'menu' : undefined}
          aria-expanded={canEdit ? !!menu : undefined}
        >
          <IconCheck size={14} />
        </button>
      ) : canEdit ? (
        <button
          type="button"
          className="doc-md-btn doc-md-no"
          onClick={pickFile}
          title="Файла .md нет — нажмите, чтобы загрузить"
          aria-label={`Загрузить файл .md: ${title}`}
        >
          <IconCross />.md
        </button>
      ) : (
        <span className="doc-md-no" title="Файла .md нет" role="img" aria-label={`Файла .md нет: ${title}`}>
          <IconCross />.md
        </span>
      )}
      {menu && md && createPortal(
        <div ref={menuRef} className="doc-md-menu" role="menu" aria-label={`Файл .md: ${title}`} style={menu}>
          <div className="doc-md-menu-name" title={md.file_name}>{md.file_name}</div>
          <button type="button" role="menuitem" onClick={download}><IconDownload size={14} /> Скачать</button>
          <button type="button" role="menuitem" onClick={pickFile}><IconRefresh size={14} /> Заменить</button>
          <button type="button" role="menuitem" className="doc-md-menu-danger" onClick={remove}><IconTrash size={14} /> Удалить</button>
        </div>,
        document.body,
      )}
    </div>
  )
}
