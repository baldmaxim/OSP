import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { requestDownloadUrl } from '../services/s3'
import './DocxPreview.css'

// Предпросмотр .docx «как в Word» через docx-preview. Берёт файл из S3 по s3Key,
// рендерит в контейнер (только чтение). Пробрасывает ref контейнера наружу через
// containerRef, чтобы родитель мог читать выделение (window.getSelection) внутри него.
function DocxPreview({ s3Key, containerRef }) {
  const localRef = useRef(null)
  const styleRef = useRef(null)
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
        if (!cancelled) setStatus('ready')
      } catch (err) {
        console.error('Ошибка предпросмотра .docx:', err)
        if (!cancelled) { setErrorMsg(err.message || 'Ошибка предпросмотра'); setStatus('error') }
      }
    }
    run()
    return () => { cancelled = true }
  }, [s3Key, containerRef])

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
