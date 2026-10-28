import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { IconDocsStack, IconFileText, IconFolderTree } from './icons/ToolbarIcons'
import { IconFileSpreadsheet, IconUpload } from './icons/BsmIcons'
import SectionTemplateCards from './SectionTemplateCards'
import { CONCEPT_AGREEMENT_TEMPLATE, CONTRACTS_DP_TEMPLATE } from '../utils/sectionTemplateItems'
import './TenderDocsModal.css'

// «Документы раздела» реестра «Договоры и ДС» — то же окно, что у «Тендеров — Основное строительство»
// (TenderDocsModal, стили tdm-*), с одной вкладкой «Материалы»: всё, что относится к работе с договорами, но не
// к конкретному договору. Сюда из шапки реестра переехали «Структура хранения», «Приложения», «Импорт Excel» и
// «Загрузка ПСДЦ» — шапка ужалась до общей папки, столбцов, «Документов» и «+ Добавить договор».
//
// Шаблоны — ссылки: «Понятийное соглашение», общее с тендерами (одна правка видна в обоих разделах), и
// «Шаблон ДП» (договор подряда) — только здесь. Указывает и меняет администратор, открывает каждый. Импорт и
// загрузка ПСДЦ — только с правом правки договоров и не во вкладке «Удаленные».

const TEMPLATES = [
  { ...CONCEPT_AGREEMENT_TEMPLATE, icon: <IconFileText size={18} /> },
  { ...CONTRACTS_DP_TEMPLATE, icon: <IconDocsStack size={18} /> },
]

export default function ContractDocsModal({
  onClose,
  onOpenStorageStructure,
  onOpenAttachments,
  onOpenImport,
  canImport = false,
  canEditTemplates = false,
}) {
  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay tdm-overlay" onClick={onClose}>
      <div className="modal tdm-modal tdm-modal--fit" role="dialog" aria-modal="true" aria-labelledby="contract-docs-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="tdm-head">
          <div>
            <h3 id="contract-docs-title">Документы раздела</h3>
            <p className="tdm-sub">Шаблоны, справочники и загрузка по договорам и ДС</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="tdm-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="true" className="tdm-tab is-active">Материалы</button>
        </div>

        <div className="tdm-body">
          <p className="tdm-lead">
            Всё, что относится к работе с договорами и ДС, но не к конкретному договору.
          </p>
          <div className="tdm-cards">
            <SectionTemplateCards items={TEMPLATES} canEdit={canEditTemplates} />

            <button type="button" className="tdm-card" onClick={onOpenStorageStructure}>
              <span className="tdm-card-icon"><IconFolderTree size={18} /></span>
              <span className="tdm-card-title">Структура хранения документов</span>
              <span className="tdm-card-desc">Единый порядок папок в сетевом хранилище — куда класть файлы</span>
            </button>

            <button type="button" className="tdm-card" onClick={onOpenAttachments}>
              <span className="tdm-card-icon"><IconDocsStack size={18} /></span>
              <span className="tdm-card-title">Стандартные приложения</span>
              <span className="tdm-card-desc">Приложения, которые предлагаются при заведении договора по объекту</span>
            </button>

            {canImport && (
              <button type="button" className="tdm-card" onClick={onOpenImport}>
                <span className="tdm-card-icon"><IconFileSpreadsheet size={18} /></span>
                <span className="tdm-card-title">Импорт из Excel</span>
                <span className="tdm-card-desc">Пакетное создание договоров и ДС из Excel-файла</span>
              </button>
            )}

            {canImport && (
              <Link to="/contracts/psdc-batch" className="tdm-card tdm-card--link" onClick={onClose}>
                <span className="tdm-card-icon"><IconUpload size={18} /></span>
                <span className="tdm-card-title">Загрузка ПСДЦ</span>
                <span className="tdm-card-desc">Массовая загрузка ПСДЦ пакетом с сопоставлением файлов и документов</span>
              </Link>
            )}
          </div>
        </div>

        <div className="tdm-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
