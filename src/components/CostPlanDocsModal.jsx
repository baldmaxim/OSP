import { useEffect, useState } from 'react'
import CostPlanEconomistsTab from './CostPlanEconomistsTab'
import CostPlanCalcTab from './CostPlanCalcTab'
import CostPlanCalcLogTab from './CostPlanCalcLogTab'
import './TenderDocsModal.css'

// «Документы раздела» «Планов затрат» — то же окно, что у тендеров (TenderDocsModal, стили tdm-*), три вкладки:
//   Экономисты ОСП — кто из экономистов отвечает за планы затрат каких объектов;
//   Расчёт ПЗ      — инструкции («Прямые затраты», «КП до перекидок») и по объектам: документы расчёта, компенсация
//                    НДС и инфляция с подтверждающим документом объекта;
//   Журнал         — кто и когда прикрепил и открепил файлы «Расчёта ПЗ».
// Видят все сотрудники. Назначает, грузит инструкции и вносит сведения администратор (canEdit); документы объектов
// прикрепляет и открепляет обладатель права cost_plan_docs (canAttach: администратор и экономист ОСП).

const TABS = [
  { key: 'economists', label: 'Экономисты ОСП' },
  { key: 'calc', label: 'Расчёт ПЗ' },
  { key: 'log', label: 'Журнал' },
]

export default function CostPlanDocsModal({ onClose, canEdit = false, canAttach = false, sub = 'Ответственные за планы затрат и расчёт ПЗ' }) {
  const [tab, setTab] = useState('economists')

  useEffect(() => {
    // Открыт просмотр файла (S3DocumentPreview) — Escape закрывает его, а не всё окно.
    const onKeydown = (e) => { if (e.key === 'Escape' && !document.querySelector('.s3-doc-preview')) onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay tdm-overlay" onClick={onClose}>
      <div className="modal tdm-modal tdm-modal--fit cpd-modal" role="dialog" aria-modal="true" aria-labelledby="cost-plan-docs-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="tdm-head">
          <div>
            <h3 id="cost-plan-docs-title">Документы раздела</h3>
            <p className="tdm-sub">{sub}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="tdm-tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tdm-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >{t.label}</button>
          ))}
        </div>

        {tab === 'economists' && <CostPlanEconomistsTab canEdit={canEdit} />}
        {tab === 'calc' && <CostPlanCalcTab canEdit={canEdit} canAttach={canAttach} />}
        {tab === 'log' && <CostPlanCalcLogTab />}

        <div className="tdm-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
