// «Скачать все» над столбцом «.md» в «Документах» карточки объекта: файлы .md всех документов объекта одним ZIP
// (utils/objectMdArchive.js), поиск по документам на состав не влияет. Стоит в заголовке столбца — поэтому шириной с
// него. Права — как у скачивания одного файла: та же ссылка из requestDownloadUrl.
import { useState } from 'react'
import { saveAs } from 'file-saver'
import { fetchFileBytes } from '../services/s3'
import './ObjectDocMdCell.css'

// Сборка ZIP (pizzip) — только по нажатию: карточка объекта открывается без неё.
const loadArchive = () => import('../utils/objectMdArchive')

export default function ObjectDocMdZipButton({ objectName, documents }) {
  // null — свободна; { done, total } — идёт сборка.
  const [progress, setProgress] = useState(null)
  const busy = progress != null
  const count = documents.filter((d) => d.md).length

  const handleClick = async () => {
    if (busy) return
    setProgress({ done: 0, total: count })
    try {
      const archive = await loadArchive()
      const { entries } = archive.planObjectMdArchive(documents)
      const { bytes, added, failed } = await archive.buildTenderArchive(
        entries,
        (entry) => fetchFileBytes(entry.s3Key),
        { onProgress: setProgress, failedHint: archive.OBJECT_MD_FAILED_HINT },
      )
      if (!added) {
        alert(`Не удалось скачать ни одного файла: ${failed[0]?.error || 'нет ответа хранилища'}`)
        return
      }
      saveAs(new Blob([bytes], { type: 'application/zip' }), `${archive.objectMdArchiveName(objectName)}.zip`)
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
      className="doc-md-zip"
      onClick={handleClick}
      disabled={busy || !count}
      aria-busy={busy}
      aria-label="Скачать все файлы .md документов объекта"
      title={count ? `Все файлы .md документов объекта одним ZIP-архивом: ${count}` : 'Файлов .md пока нет'}
    >
      {busy ? `${progress.done} из ${progress.total}` : 'Скачать все'}
    </button>
  )
}
