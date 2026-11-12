// «Документы» карточки объекта на телефоне (≤ 640 px; 12.11.2026, просьба пользователя: «на телефоне некорректно
// отображается информация»). Таблица из 7–8 столбцов прокручивалась вбок, а столбцы без своей ширины («№ / дата»,
// «Описание ДС») получали почти ноль — номер, дата, описание и названия приложений шли по букве в строку. Здесь тот же
// состав и те же действия, только карточкой: название целиком, номер и дата, примечание, три файла с подписями,
// приложения — вложенными карточками (раскрываются так же, как в таблице: общий expandedDocs). Перетаскивания нет —
// на сенсорном экране его нет и в таблице (HTML5 drag and drop), порядок меняют на компьютере.
// Файл документа рисует страница (renderFile — тот же DocFileCell, что в таблице), «.md» — ObjectDocMdCell.
import ObjectDocMdCell from './ObjectDocMdCell'
import { IconPencil, IconTrash } from './icons/ActionIcons'
import './ObjectDocCards.css'

function DocCard({
  doc, level, kids, getAttachments, expandedDocs, toggleExpand, formatDate, renderFile,
  onAddAttachment, onEdit, onDelete, canEdit, linkedId, onMdChanged,
}) {
  const isAttachment = level > 0
  const isExpanded = expandedDocs.has(doc.id)
  const date = doc.document_date ? formatDate(doc.document_date) : ''
  // В таблице у приложения номер стоит отдельно («Прил. 1»), название — рядом; у договора — номер и дата столбцом.
  const title = doc.name || (isAttachment ? '' : '—')
  const number = doc.document_number || ''
  const meta = [
    !isAttachment && number ? `№ ${number}` : '',
    date ? `от ${date}` : '',
  ].filter(Boolean).join(' · ')

  const addAttachment = () => {
    if (!isExpanded) toggleExpand(doc.id)
    onAddAttachment(doc.id)
  }

  return (
    <div
      className={['odc-card', isAttachment ? 'odc-card-att' : '', linkedId === doc.id ? 'is-linked' : ''].filter(Boolean).join(' ')}
      data-doc-id={doc.id}
    >
      <div className="odc-top">
        <div className="odc-head">
          <div className="odc-title">
            {isAttachment && number && <span className="odc-num">{number}</span>}
            {title ? <span className="odc-name">{title}</span> : !number && <span className="odc-muted">Без названия</span>}
          </div>
          {meta && <div className="odc-meta">{meta}</div>}
          {doc.notes && <div className="odc-notes">{doc.notes}</div>}
        </div>
        {canEdit && (
          <div className="odc-actions">
            <button type="button" className="odc-icon" onClick={() => onEdit(doc)} aria-label="Редактировать" title="Редактировать">
              <IconPencil size={17} />
            </button>
            <button type="button" className="odc-icon odc-icon-danger" onClick={() => onDelete(doc.id)} aria-label="Удалить" title="Удалить">
              <IconTrash size={17} />
            </button>
          </div>
        )}
      </div>

      <div className={`odc-files${onMdChanged ? ' has-md' : ''}`}>
        <div className="odc-file">
          <span className="odc-file-label">Подписанный</span>
          {renderFile(doc.signed, 'signed')}
        </div>
        {onMdChanged && (
          <div className="odc-file odc-file-md">
            <span className="odc-file-label">.md</span>
            <ObjectDocMdCell doc={doc} canEdit={canEdit} onChanged={onMdChanged} />
          </div>
        )}
        <div className="odc-file">
          <span className="odc-file-label">Редактируемый</span>
          {renderFile(doc.editable, 'editable')}
        </div>
      </div>

      {(kids.length > 0 || canEdit) && (
        <div className="odc-foot">
          {kids.length > 0 ? (
            <button
              type="button"
              className="odc-toggle"
              onClick={() => toggleExpand(doc.id)}
              aria-expanded={isExpanded}
            >
              <span className="odc-chevron" aria-hidden>{isExpanded ? '▾' : '▸'}</span>
              Приложения: {kids.length}
            </button>
          ) : null}
          {canEdit && (
            <button type="button" className="odc-add" onClick={addAttachment}
              title={isAttachment ? 'Добавить приложение к этому приложению' : 'Добавить приложение к этому документу'}>
              + Приложение
            </button>
          )}
        </div>
      )}

      {isExpanded && kids.length > 0 && (
        <div className="odc-children">
          {kids.map((k) => (
            <DocCard
              key={k.id}
              doc={k}
              level={level + 1}
              kids={getAttachments(k.id)}
              getAttachments={getAttachments}
              expandedDocs={expandedDocs}
              toggleExpand={toggleExpand}
              formatDate={formatDate}
              renderFile={renderFile}
              onAddAttachment={onAddAttachment}
              onEdit={onEdit}
              onDelete={onDelete}
              canEdit={canEdit}
              linkedId={linkedId}
              onMdChanged={onMdChanged}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// groups — [{ parent, atts }]: верхние документы раздела и их приложения (уже отобранные поиском, как у таблицы).
export default function ObjectDocCards({ groups, ...rest }) {
  return (
    <div className="odc-list">
      {groups.map((g) => (
        <DocCard key={g.parent.id} doc={g.parent} level={0} kids={g.atts} {...rest} />
      ))}
    </div>
  )
}
