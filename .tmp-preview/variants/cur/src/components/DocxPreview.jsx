import { useEffect, useRef, useState, useCallback } from 'react'
import { renderAsync } from 'docx-preview'
import { requestDownloadUrl } from '../services/s3'
import './DocxPreview.css'

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim()

// Предпросмотр .docx «как в Word» через docx-preview. Берёт файл из S3 по s3Key,
// рендерит в контейнер (только чтение). Пробрасывает ref контейнера наружу через
// containerRef, чтобы родитель мог читать выделение (window.getSelection) внутри него.
// highlights — массив { text, status } разногласий: совпавшие абзацы подсвечиваются
// цветом по статусу (open/in_review — жёлтый, agreed — зелёный, rejected — серый).
function DocxPreview({ s3Key, containerRef, highlights = [], onParagraphs }) {
  const localRef = useRef(null)
  const styleRef = useRef(null)
  const onParagraphsRef = useRef(onParagraphs)
  onParagraphsRef.current = onParagraphs
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    const bodyEl = localRef.current
    const styleEl = styleRef.current
    if (containerRef) containerRef.current = bodyEl

    async function run() {
      if (!s3Key || !bodyEl) return
      setStatus('loading')
      setErrorMsg('')
      try {
        const { presigned_url } = await requestDownloadUrl(s3Key)
        const resp = await fetch(presigned_url)
        if (!resp.ok) throw new Error(`Не удалось получить файл (${resp.status})`)
        const blob = await resp.blob()
        if (cancelled) return
        bodyEl.innerHTML = ''
        await renderAsync(blob, bodyEl, styleEl, {
          inWrapper: true,
          breakPages: false,
          ignoreHeight: true,
          ignoreLastRenderedPageBreak: true,
          className: 'docx',
        })
        if (!cancelled) {
          // Отдаём наверх порядок абзацев — по нему протокол сортируется хронологически.
          if (onParagraphsRef.current) {
            const list = [...bodyEl.querySelectorAll('p, td')]
              .map((el) => norm(el.textContent)).filter((t) => t.length >= 3)
            onParagraphsRef.current(list)
          }
          setStatus('ready')
        }
      } catch (err) {
        console.error('Ошибка предпросмотра .docx:', err)
        if (!cancelled) { setErrorMsg(err.message || 'Ошибка предпросмотра'); setStatus('error') }
      }
    }
    run()
    return () => { cancelled = true }
  }, [s3Key, containerRef])

  // Подсветка абзацев, вынесенных в протокол. Абзац красим, если его текст целиком
  // входит в текст разногласия (выделяли пункт целиком) либо разногласие целиком
  // внутри абзаца (выделяли фрагмент одного пункта).
  const applyHighlights = useCallback(() => {
    const bodyEl = localRef.current
    if (!bodyEl) return
    const items = highlights
      .map((h) => ({ t: norm(h.text), status: h.status }))
      .filter((h) => h.t.length >= 3)
    bodyEl.querySelectorAll('.cct-hl-open, .cct-hl-agreed, .cct-hl-rejected')
      .forEach((el) => el.classList.remove('cct-hl-open', 'cct-hl-agreed', 'cct-hl-rejected'))
    if (items.length === 0) return
    bodyEl.querySelectorAll('p, td').forEach((el) => {
      const pt = norm(el.textContent)
      if (pt.length < 3) return
      const matched = items.filter((h) => h.t.includes(pt) || (h.t.length >= 20 && pt.includes(h.t)))
      if (matched.length === 0) return
      // Приоритет цвета: открытый вопрос важнее → жёлтый; иначе согласован → зелёный; иначе отклонён.
      const statuses = matched.map((m) => m.status)
      const tone = statuses.some((s) => s === 'open' || s === 'in_review') ? 'open'
        : statuses.some((s) => s === 'agreed') ? 'agreed' : 'rejected'
      el.classList.add(`cct-hl-${tone}`)
    })
  }, [highlights])

  useEffect(() => {
    if (status === 'ready') applyHighlights()
  }, [status, applyHighlights])

  return (
    <div className="docx-preview-wrap">
      <div ref={styleRef} />
      {status === 'loading' && <div className="docx-preview-status">Загрузка предпросмотра…</div>}
      {status === 'error' && <div className="docx-preview-status is-error">{errorMsg}</div>}
      <div ref={localRef} className="docx-preview-body" style={status === 'ready' ? undefined : { display: 'none' }} />
    </div>
  )
}

export default DocxPreview
