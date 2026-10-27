import { useEffect } from 'react'
import { IconCompare } from './icons/ToolbarIcons'
import SectionTemplateCards from './SectionTemplateCards'
import { SECTION_TEMPLATE } from '../services/sectionTemplates'
import './TenderDocsModal.css'

// «Документы раздела» реестра «Заявка на ДС» — то же окно, что у «Тендеров — Основное строительство»
// (TenderDocsModal, его стили tdm-*), но с одной вкладкой «Материалы»: всё, что относится к работе с
// заявками, но не к конкретной заявке. Сейчас там «Шаблон Было-Стало»: скачивает каждый, прикрепляет и
// заменяет администратор (SectionTemplateCards, миграция 20261107). Новые материалы — плитками в tdm-cards.

const WAS_BECAME = [{
  code: SECTION_TEMPLATE.wasBecame,
  title: 'Шаблон Было-Стало',
  desc: 'Таблица «было — стало» к заявке на ДС — скачать и заполнить',
  icon: <IconCompare size={18} />,
}]

export default function DcRequestDocsModal({ onClose, canEditTemplates = false }) {
  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay tdm-overlay" onClick={onClose}>
      <div className="modal tdm-modal tdm-modal--fit" role="dialog" aria-modal="true" aria-labelledby="dcr-docs-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="tdm-head">
          <div>
            <h3 id="dcr-docs-title">Документы раздела</h3>
            <p className="tdm-sub">Материалы и шаблоны по заявкам на ДС</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="tdm-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="true" className="tdm-tab is-active">Материалы</button>
        </div>

        <div className="tdm-body">
          <p className="tdm-lead">
            Всё, что относится к работе с заявками на ДС, но не к конкретной заявке.
          </p>
          <div className="tdm-cards">
            <SectionTemplateCards items={WAS_BECAME} canEdit={canEditTemplates} />
          </div>
        </div>

        <div className="tdm-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
