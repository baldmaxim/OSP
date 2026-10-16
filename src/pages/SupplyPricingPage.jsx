import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import useBodyClass from '../hooks/useBodyClass'
import AccessDenied from '../components/AccessDenied'
import SupplyPricingPanel from '../components/supply/SupplyPricingPanel'
import { tenderObjectName } from '../utils/tenderDepartments'
import '../components/supply/SupplyPricing.css'
// Общий рабочий стиль разделов (docs/UI_GUIDELINES.md) — после стилей страницы.
import '../styles/fonts.css'
import '../styles/workUi.css'

// Расценка материалов ВОР для снабжения (/tenders/materials/:id/pricing): шапка тендера и та же таблица, что во
// вкладке «Расценки снабжения» карточки (SupplyPricingPanel). Снабжению карточка с участниками и КП закрыта,
// поэтому оно работает здесь; вход — «Расценка: N из M» в реестре «Тендеры на материалы».
// Тендер для шапки грузит сама таблица вместе с позициями и ценами (одним заходом, onContext).

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')
const STATUS_CLASS = { 'Не начат': 'is-new', 'В работе': 'is-work', 'Завершён': 'is-done', 'Завершен': 'is-done', 'Не требуется': 'is-off', 'Не нужно': 'is-off' }

export default function SupplyPricingPage() {
  const { tenderId } = useParams()
  const { scopedObjectIds } = useRole()
  useBodyClass('ui-work-portal')
  // Контекст помнит, для какого тендера он загружен: перешли на другой — шапка ждёт новый.
  const [loaded, setLoaded] = useState({ id: null, ctx: undefined })
  const ctx = loaded.id === tenderId ? loaded.ctx : undefined
  const onContext = useCallback((c) => setLoaded({ id: tenderId, ctx: c }), [tenderId])

  const main = ctx ? (ctx.main || ctx.opened) : null
  if (ctx === null) return <AccessDenied title="Тендер не найден" message="Тендера нет или он удалён." backTo="/tenders/materials" />
  if (ctx && scopedObjectIds.length > 0 && !scopedObjectIds.includes(main?.object_id)) {
    return (
      <AccessDenied
        title="Тендер недоступен"
        message="Этот тендер относится к другому объекту, вне вашего доступа. Обратитесь к администратору, если нужен доступ."
        backTo="/tenders/materials"
      />
    )
  }
  const materials = ctx?.materials

  return (
    <div className="ui-work sp-page">
      <Link to="/tenders/materials" className="sp-back">← Тендеры на материалы</Link>
      <header className="sp-header">
        {ctx && <div className="sp-title">
          <h2>Расценка материалов</h2>
          <div className="sp-subtitle">
            <span className="ui-num">№ {main?.public_tender_number ?? '—'}</span>
            <span>{tenderObjectName(main)}</span>
            <span className="sp-desc">{main?.work_description}</span>
          </div>
          <div className="sp-meta">
            {materials && <span className={`sp-status ${STATUS_CLASS[materials.status] || 'is-new'}`}>{materials.status}</span>}
            {materials?.materials_proposal_deadline && <span>Срок КП: <b className="ui-num">{fmtDate(materials.materials_proposal_deadline)}</b></span>}
            {materials?.materials_resp_name && <span>Ответственный снабжения: <b>{materials.materials_resp_name}</b></span>}
          </div>
        </div>}
        {!ctx && <div className="sp-title"><h2>Расценка материалов</h2></div>}
      </header>
      <SupplyPricingPanel key={tenderId} tenderId={tenderId} onContext={onContext} variant="page" />
    </div>
  )
}
