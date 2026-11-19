// «Скачать всё» в шапке списка документов (S3DocumentList с пропом downloadAllOwner): файлы раздела одним ZIP,
// имена — исходные (utils/docListArchive.js). Права — как у скачивания одного файла: та же ссылка из requestDownloadUrl,
// поэтому кнопка есть и у тех, кто только смотрит.
import { useState } from 'react'
import { saveAs } from 'file-saver'
import { fetchFileBytes } from '../services/s3'

// Сборка ZIP (pizzip) — только по нажатию: страницы со списком документов открываются без неё.
const loadArchive = () => import('../utils/docListArchive')

// Архив собирается в памяти браузера — о большом объёме предупреждаем заранее.
const LARGE_ARCHIVE_BYTES = 500 * 1024 * 1024

const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} МБ`

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" />
  </svg>
)

// docs — уже загруженные строки списка; ownerName — кому принадлежат (имя архива); title — название раздела.
export default function DocListZipButton({ docs, ownerName, title }) {
  // null — свободна; { done, total } — идёт сборка.
  const [progress, setProgress] = useState(null)
  const busy = progress != null
  const count = docs.length

  const handleClick = async () => {
    if (busy || !count) return
    setProgress({ done: 0, total: count })
    try {
      const archive = await loadArchive()
      const { entries, totalBytes } = archive.planDocListArchive(docs, title)
      if (totalBytes > LARGE_ARCHIVE_BYTES && !window.confirm(
        `Файлов: ${entries.length}, общий размер ${formatMegabytes(totalBytes)}. `
        + 'Архив собирается в памяти браузера — это займёт время. Скачать?',
      )) return

      const { bytes, added, failed } = await archive.buildTenderArchive(
        entries,
        (entry) => fetchFileBytes(entry.s3Key),
        { onProgress: setProgress, failedHint: archive.docListFailedHint(title) },
      )
      if (!added) {
        alert(`Не удалось скачать ни одного файла: ${failed[0]?.error || 'нет ответа хранилища'}`)
        return
      }
      saveAs(new Blob([bytes], { type: 'application/zip' }), `${archive.docListArchiveName(ownerName, title)}.zip`)
      if (failed.length) {
        alert(`Архив неполный: не скачано ${failed.length} из ${entries.length}. `
          + `Список — в файле «${archive.FAILED_LIST_NAME}» внутри архива.`)
      }
    } catch (e) {
      alert('Не удалось собрать архив: ' + (e?.message || e))
    } finally {
      setProgress(null)
    }
  }

  return (
    <button
      type="button"
      className="s3-doc-btn-secondary"
      onClick={handleClick}
      disabled={busy || !count}
      aria-busy={busy}
      title={`Все файлы раздела «${title}» одним ZIP-архивом, с исходными именами`}
    >
      <DownloadIcon />
      {busy ? `Скачано ${progress.done} из ${progress.total}` : 'Скачать всё'}
    </button>
  )
}
