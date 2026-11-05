import { useRef, useState } from 'react'
import { downloadS3File } from '../FileDownload'
import { IconDownload, IconTrash } from '../icons/ActionIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { DP_FILE_ACCEPT, dpErrorText, dpFileProblem, isLastRequiredFile } from '../../utils/dpRequests'
import { addDpFile, removeDpFile, replaceDpFiles } from '../../services/dpRequests'

// Файлы заявки одной категории (понятийное соглашение, документ договора): имя — просмотр, значок — скачивание. Кто может менять
// заявку — добавляет и удаляет сразу из ячейки. Оба вида файлов обязательны: последний не удаляется, а заменяется.
export default function DpFileList({ requestId, docs, category, canChange, onChanged, onPreview, onError }) {
  const inputRef = useRef(null)
  const replaceRef = useRef(false)
  const [busy, setBusy] = useState(false)

  const pick = (replace) => {
    replaceRef.current = replace
    inputRef.current?.click()
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const problem = dpFileProblem(file)
    if (problem) { onError(`${file.name}: ${problem}`); return }
    setBusy(true)
    try {
      if (replaceRef.current) await replaceDpFiles(requestId, file, category, docs)
      else await addDpFile(requestId, file, category)
      await onChanged()
    } catch (err) {
      onError(`Файл не загружен: ${dpErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    setBusy(true)
    try {
      await removeDpFile(doc)
      await onChanged()
    } catch (err) {
      onError(`Файл не удалён: ${dpErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const download = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (err) {
      onError(`Файл не скачался: ${err.message}`)
    }
  }

  return (
    <div className="dpr-files">
      {docs.map((doc) => (
        <div key={doc.id} className="dpr-file">
          <button type="button" className="dpr-file-name" title={doc.file_name} onClick={() => onPreview(doc)}>
            <PaperclipIcon size={14} />
            <span>{doc.file_name}</span>
          </button>
          <button type="button" className="dpr-file-btn" aria-label={`Скачать ${doc.file_name}`} title="Скачать" onClick={() => download(doc)}>
            <IconDownload size={14} />
          </button>
          {canChange && !isLastRequiredFile(doc, docs) && (
            <button type="button" className="dpr-file-btn is-danger" aria-label={`Удалить ${doc.file_name}`} title="Удалить" disabled={busy} onClick={() => remove(doc)}>
              <IconTrash size={14} />
            </button>
          )}
        </div>
      ))}
      {docs.length === 0 && <span className="dpr-file-missing">нет файла</span>}
      {canChange && (
        <div className="dpr-file-actions">
          <button type="button" className="dpr-file-add" disabled={busy} onClick={() => pick(false)}>{busy ? 'Загрузка…' : '+ файл'}</button>
          {docs.length === 1 && !busy && (
            <button type="button" className="dpr-file-add" onClick={() => pick(true)}>заменить</button>
          )}
        </div>
      )}
      <input ref={inputRef} type="file" hidden accept={DP_FILE_ACCEPT} onChange={onFile} />
    </div>
  )
}
