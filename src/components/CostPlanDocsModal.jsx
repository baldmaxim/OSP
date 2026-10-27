import { useEffect } from 'react'
import CostPlanEconomistsTab from './CostPlanEconomistsTab'
import './TenderDocsModal.css'

// «Документы раздела» «Планов затрат» и «Общей информации → Отделов» — то же окно, что у тендеров
// (TenderDocsModal, стили tdm-*), с вкладкой «Экономисты ОСП»: кто из экономистов отвечает за планы затрат
// каких объектов. Видят все сотрудники, назначает администратор (canEdit).

export default function CostPlanDocsModal({ onClose, canEdit = false, sub = 'Ответственные за планы затрат по объектам' }) {
  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay tdm-overlay" onClick={onClose}>
      <div className="modal tdm-modal tdm-modal--fit" role="dialog" aria-modal="true" aria-labelledby="cost-plan-docs-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="tdm-head">
          <div>
            <h3 id="cost-plan-docs-title">Документы раздела</h3>
            <p className="tdm-sub">{sub}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="tdm-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="true" className="tdm-tab is-active">Экономисты ОСП</button>
        </div>

        <CostPlanEconomistsTab canEdit={canEdit} />

        <div className="tdm-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
