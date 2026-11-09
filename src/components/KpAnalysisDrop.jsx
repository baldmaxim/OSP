// Кнопка «Анализ ВОР/КП» в панели «Проверки КП» (09.11.2026, вместо пункта меню и страницы /analysis-kp).
// На неё перетаскивают Excel-файл ВОР или КП — открывается окно анализа с этим файлом; нажатие — выбор файла.
// Пока файл несут над страницей, кнопка подсвечивается: видно, куда бросать. Брошенный мимо файл браузер
// не открывает (иначе он ушёл бы со страницы). Окно с библиотекой Excel грузится при первом открытии,
// а когда файл уже несут или наводят на кнопку — заранее.
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { IconFileSpreadsheet, IconUpload } from './icons/BsmIcons'
import { ANALYSIS_FILE_ACCEPT, dragHasFiles, isAnalysisFile } from '../utils/kpAnalysisFiles'
import './KpAnalysisDrop.css'

const loadDialog = () => import('./KpAnalysisDialog')
const KpAnalysisDialog = lazy(loadDialog)
// Заранее — без обработки ошибки: не загрузилось сейчас, загрузит само открытие окна и покажет, если что.
const preload = () => { loadDialog().catch(() => {}) }

const HINT = 'Анализ ВОР/КП: перетащите сюда Excel-файл ВОР или КП (можно несколько) — откроется сводная по наименованиям, '
  + 'разные цены и ед. изм., позиции без цены. Или нажмите и выберите файл.'

export default function KpAnalysisDrop() {
  // Открытое окно и файлы, с которыми его открыли; null — закрыто.
  const [opened, setOpened] = useState(null)
  // armed — файл несут где-то над страницей; over — прямо над кнопкой.
  const [armed, setArmed] = useState(false)
  const [over, setOver] = useState(false)
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)
  const buttonRef = useRef(null)

  // Подсветка, пока файл над страницей, и защита от броска мимо. Окно открыто — бросок ловит оно само.
  useEffect(() => {
    if (opened) return undefined
    let depth = 0
    const onEnter = (e) => {
      if (!dragHasFiles(e)) return
      depth += 1
      if (depth === 1) { setArmed(true); preload() }
    }
    const onLeave = (e) => {
      if (!dragHasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) { setArmed(false); setOver(false) }
    }
    const reset = () => { depth = 0; setArmed(false); setOver(false) }
    // Кто файл принимает (кнопка), уже отменил действие браузера; остальным местам — «нельзя».
    const onOver = (e) => {
      if (dragHasFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none' }
    }
    const onDrop = (e) => {
      reset()
      if (dragHasFiles(e) && !e.defaultPrevented) e.preventDefault()
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [opened])

  useEffect(() => {
    if (!message) return undefined
    const t = setTimeout(() => setMessage(''), 6000)
    return () => clearTimeout(t)
  }, [message])

  // Не Excel — окно не открываем, причина рядом с кнопкой. Среди нескольких файлов не-Excel назовёт окно.
  const take = (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    if (!files.some(isAnalysisFile)) {
      setMessage(files.length > 1
        ? 'Среди файлов нет Excel — нужен .xlsx или .xls'
        : `«${files[0].name}» — не Excel: нужен .xlsx или .xls`)
      return
    }
    setMessage('')
    setOpened({ files })
  }

  const onDragOver = (e) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!over) setOver(true)
  }
  const onDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    setOver(false)
  }
  const onDrop = (e) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    setOver(false)
    setArmed(false)
    take(e.dataTransfer.files)
  }

  const close = () => {
    setOpened(null)
    buttonRef.current?.focus()
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`kpa-drop${armed ? ' is-armed' : ''}${over ? ' is-over' : ''}`}
        title={HINT}
        aria-label={HINT}
        onClick={() => inputRef.current?.click()}
        onMouseEnter={preload}
        onFocus={preload}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {over ? <IconUpload size={15} /> : <IconFileSpreadsheet size={15} />}
        <span>Анализ ВОР/КП</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ANALYSIS_FILE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
      {message && <span className="kpa-drop-msg" role="alert">{message}</span>}
      {opened && (
        <Suspense fallback={<div className="kpa-drop-loading" role="status">Открываем анализ…</div>}>
          <KpAnalysisDialog initialFiles={opened.files} onClose={close} />
        </Suspense>
      )}
    </>
  )
}
