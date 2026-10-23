// «Скачать всё» в шапке раздела окна «ВОРы и РД» тендера — своя у «Рабочей документации»,
// у «Ведомости объёмов работ» и у «Загружены ранее»: файлы раздела одним ZIP, имена — исходные
// (utils/vorRdArchive.js). Права — как у скачивания одного файла: та же ссылка из requestDownloadUrl.
import { useState } from 'react'
import { saveAs } from 'file-saver'
import { fetchFileBytes } from '../services/s3'
import { fetchTenderArchiveTitle } from '../services/tenderVorRd'
import { IconDownload } from './icons/ActionIcons'

// Сборка ZIP (pizzip) — только по нажатию: реестр тендеров открывается без неё.
const loadArchive = () => import('../utils/vorRdArchive')

// Архив собирается в памяти браузера — о большом объёме предупреждаем заранее.
const LARGE_ARCHIVE_BYTES = 500 * 1024 * 1024

const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} МБ`

// Подсказка кнопки; сами разделы — VOR_RD_ARCHIVE_SECTIONS (модуль подгружается по нажатию).
const HINTS = {
  rd: 'Все файлы рабочей документации одним ZIP-архивом, с исходными именами',
  vor: 'Все файлы ВОР одним ZIP-архивом, с исходными именами',
  legacy: 'Все ранее загруженные файлы одним ZIP-архивом, с исходными именами',
}

// section — 'rd' | 'vor' | 'legacy'; docs — файлы раздела (services/tenderVorRd.js → loadVorRd).
export default function VorRdZipButton({ tenderId, section, docs }) {
  // null — свободна; { done, total } — идёт сборка (total = 0 — ещё готовим список).
  const [progress, setProgress] = useState(null)
  const busy = progress != null

  const handleClick = async () => {
    if (busy || !tenderId) return
    setProgress({ done: 0, total: 0 })
    try {
      const [archive, tender] = await Promise.all([
        loadArchive(),
        // Без номера тендера архив всё равно скачивается — под именем «Тендер — РД» / «Тендер — ВОР».
        fetchTenderArchiveTitle(tenderId).catch(() => null),
      ])
      const { entries, totalBytes } = archive.planVorRdArchive(docs, section)
      if (!entries.length) {
        alert('В разделе нет файлов')
        return
      }
      if (totalBytes > LARGE_ARCHIVE_BYTES && !window.confirm(
        `Файлов: ${entries.length}, общий размер ${formatMegabytes(totalBytes)}. `
        + 'Архив собирается в памяти браузера — это займёт время. Скачать?',
      )) return

      setProgress({ done: 0, total: entries.length })
      const { bytes, added, failed } = await archive.buildTenderArchive(
        entries,
        (entry) => fetchFileBytes(entry.s3Key),
        { onProgress: setProgress, failedHint: archive.VOR_RD_FAILED_HINT },
      )
      if (!added) {
        alert(`Не удалось скачать ни одного файла: ${failed[0]?.error || 'нет ответа хранилища'}`)
        return
      }
      saveAs(new Blob([bytes], { type: 'application/zip' }), `${archive.vorRdArchiveName(tender, section)}.zip`)
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

  let label = 'Скачать всё'
  if (busy) label = progress.total ? `Скачано ${progress.done} из ${progress.total}` : 'Подготовка…'

  return (
    <button
      type="button"
      className="tvr-zip-btn"
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy}
      title={HINTS[section]}
    >
      <IconDownload size={14} />
      <span>{label}</span>
    </button>
  )
}
