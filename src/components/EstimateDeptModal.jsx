import { useEffect } from 'react'
import { ESTIMATE_DEPT } from '../utils/estimateDept'
import './EstimateDeptModal.css'

// Сотрудники сметно-технического отдела по направлениям работ.
//
// Справочник «к кому идти с вопросом по смете»: инженеру основного
// строительства нужно имя человека по своему направлению, а не оргструктура.
// Поэтому подразделения показаны плитками, как на схеме отдела.

export default function EstimateDeptModal({ onClose }) {
  useEffect(() => {
    const onKeydown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [onClose])

  return (
    <div className="modal-overlay sto-overlay" onClick={onClose}>
      <div className="modal sto-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sto-head">
          <div>
            <h3>Сотрудники СТО</h3>
            <p className="sto-sub">{ESTIMATE_DEPT.title} — по направлениям работ</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="sto-body">
          <div className="sto-leads">
            {[ESTIMATE_DEPT.head, ESTIMATE_DEPT.lead].map(p => (
              <div key={p.name} className="sto-lead">
                <span className="sto-name">{p.name}</span>
                <span className="sto-role">{p.role}</span>
              </div>
            ))}
          </div>

          <div className="sto-units-title">Подразделения</div>
          <div className="sto-units">
            {ESTIMATE_DEPT.units.map(u => (
              <div key={u.title} className="sto-unit">
                <div className="sto-unit-title">{u.title}</div>
                {u.people.map(name => (
                  <div key={name} className="sto-unit-person">
                    {name}
                    <span className="sto-role">{ESTIMATE_DEPT.unitRole}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="sto-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
