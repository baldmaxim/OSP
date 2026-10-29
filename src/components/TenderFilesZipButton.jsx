// «Скачать всё» над колонкой «КП / Документы» раздела «Участники» карточки тендера:
// все файлы участников одним ZIP, папка на каждую компанию (utils/tenderFilesArchive.js).
// С counterparty ({ id, name }) — та же кнопка в ячейке одного участника: архив только его
// файлов, без папки компании (она — в имени архива).
// Права — как у скачивания одного файла: та же ссылка из requestDownloadUrl.
import { useState } from 'react'
import { saveAs } from 'file-saver'
import { fetchTenderFilesForArchive } from '../services/tenderProposalFiles'
import { fetchFileBytes } from '../services/s3'
import {
  archiveBaseName, buildTenderArchive, counterpartyArchiveName, planCounterpartyArchive, planTenderArchive, FAILED_LIST_NAME,
} from '../utils/tenderFilesArchive'
import { tenderObjectName } from '../utils/tenderDepartments'
import { IconDownload } from './icons/ActionIcons'

// Архив собирается в памяти браузера — о большом объёме предупреждаем заранее.
const LARGE_ARCHIVE_BYTES = 500 * 1024 * 1024

const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} МБ`

export default function TenderFilesZipButton({ tender, participants, counterparty = null, className = 'tc-zip-btn' }) {
  // null — свободна; { done, total } — идёт сборка (total = 0 — ещё готовим список).
  const [progress, setProgress] = useState(null)
  const busy = progress != null

  const handleClick = async () => {
    if (busy || !tender?.id) return
    setProgress({ done: 0, total: 0 })
    try {
      const rows = await fetchTenderFilesForArchive(tender.id, { counterpartyId: counterparty?.id })
      const { entries, totalBytes } = counterparty
        ? planCounterpartyArchive(rows, { counterpartyId: counterparty.id, name: counterparty.name })
        : planTenderArchive(rows, (participants || []).map((tc) => ({
          counterpartyId: tc.counterparty_id,
          name: tc.counterparties?.name,
        })))
      if (!entries.length) {
        alert(counterparty ? 'У участника нет файлов' : 'У участников тендера нет файлов')
        return
      }
      if (totalBytes > LARGE_ARCHIVE_BYTES && !window.confirm(
        `Файлов: ${entries.length}, общий размер ${formatMegabytes(totalBytes)}. `
        + 'Архив собирается в памяти браузера — это займёт время. Скачать?',
      )) return

      setProgress({ done: 0, total: entries.length })
      const { bytes, added, failed } = await buildTenderArchive(
        entries,
        (entry) => fetchFileBytes(entry.s3Key),
        { onProgress: setProgress },
      )
      if (!added) {
        alert(`Не удалось скачать ни одного файла: ${failed[0]?.error || 'нет ответа хранилища'}`)
        return
      }
      const objectName = tenderObjectName(tender, 'Тендер')
      const name = counterparty
        ? counterpartyArchiveName(tender, counterparty.name, objectName)
        : archiveBaseName(tender, objectName)
      saveAs(new Blob([bytes], { type: 'application/zip' }), `${name}.zip`)
      if (failed.length) {
        alert(`Архив неполный: не скачано ${failed.length} из ${entries.length}. `
          + `Список — в файле «${FAILED_LIST_NAME}» внутри архива.`)
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
      className={className}
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy}
      title={counterparty
        ? `Все файлы участника «${counterparty.name || 'без названия'}» одним ZIP-архивом: КП, прежние версии и документы`
        : 'Все файлы участников одним ZIP-архивом, по папкам компаний'}
    >
      <IconDownload size={14} />
      <span>{label}</span>
    </button>
  )
}
