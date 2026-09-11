import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { formatMoney } from '../utils/estimateImport'
import {
  DOC_TYPE,
  DOC_TYPE_LABEL,
  DOC_TYPE_SHORT,
  OVERRIDABLE_FIELD_LABEL,
  buildDocIndex,
  contractActualAmount,
  effectiveDocumentAmount,
  flattenTree,
  hasAppliedPsdc,
  isAmendment,
  planAmendment,
} from '../utils/contractAmendments'
import S3DocumentList from '../components/S3DocumentList'
import ContractClausesTab from '../components/ContractClausesTab'
import AccessDenied from '../components/AccessDenied'
import PsdcPanel from '../components/psdc/PsdcPanel'
import '../components/ContractRegistry.css'

// Держать в согласии со STATUS_OPTIONS в ContractsPage.jsx.
const STATUS_LABEL = {
  new_request: 'Новая заявка',
  in_work: 'В работе',
  awaiting_paper_sign: 'Ожидание подписания в бум. виде',
  paused: 'Приостановка',
  completed: 'Завершено',
}

// CSS-классы статусов пишутся через дефис, а значения — через подчёркивание,
// поэтому шаблон `status-${status}` промахивался мимо стилей для new_request
// и in_work. Явное соответствие вместо склейки строк.
const STATUS_CLASS = {
  new_request: 'status-new-request',
  in_work: 'status-in-work',
  awaiting_paper_sign: 'status-awaiting-paper',
  paused: 'status-paused',
  completed: 'status-completed',
}

const EVENT_LABEL = {
  created: '🆕 Создание',
  status_changed: '🔄 Смена статуса',
  field_updated: '✏️ Изменение полей',
  soft_deleted: '🗑️ В корзину',
  restored: '↩ Восстановление',
  psdc_imported: '📊 Импорт ПСДЦ',
  psdc_approved: '✅ Утверждение ПСДЦ',
  psdc_uploaded: 'ПСДЦ: загрузка',
  psdc_validated: 'ПСДЦ: проверка',
  psdc_applied: 'ПСДЦ: применение',
  psdc_upload_cancelled: 'ПСДЦ: отмена загрузки',
  psdc_deleted: 'ПСДЦ: удаление',
  psdc_exported: 'ПСДЦ: экспорт',
  advance_updated: '💸 График авансирования',
}

const TABS = [
  { key: 'info', label: 'Информация' },
  { key: 'psdc', label: 'ПСДЦ / ВОР' },
  { key: 'advances', label: 'Авансирование' },
  { key: 'clauses', label: 'Согласование' },
  { key: 'documents', label: 'Документы' },
  { key: 'history', label: 'История' },
]

function ContractDetailPage() {
  const { contractId } = useParams()
  const navigate = useNavigate()
  const { userProfile, canEdit, scopedObjectIds } = useRole()
  // Руководитель строительства (привязан к объекту) не видит примечание юриста.
  const hideNotes = scopedObjectIds.length > 0
  // task 333: гейт редактирования раздела «contracts»
  const canEditContracts = canEdit('contracts')

  const [activeTab, setActiveTab] = useState('info')
  const [contract, setContract] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [auditLog, setAuditLog] = useState([])
  const [advances, setAdvances] = useState([])
  const [loading, setLoading] = useState(true)
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  // Всё дерево документа: сам договор и его ДС. Нужно и для сумм, и для навигации.
  const [family, setFamily] = useState([])

  // Авансирование
  const [advForm, setAdvForm] = useState({ planned_date: '', amount: '', description: '', paid_date: '' })
  const [editingAdvId, setEditingAdvId] = useState(null)

  // Универсальная запись в аудит-лог
  const logEvent = useCallback(async (eventType, payload = {}) => {
    try {
      await supabase.from('contract_audit_log').insert([{
        contract_id: contractId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: localStorage.getItem('userRole') || null,
        changed_by_name: userProfile?.full_name || null,
      }])
    } catch (err) {
      console.error('Не удалось записать в аудит-лог:', err.message)
    }
  }, [contractId, userProfile])

  const fetchContract = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('contracts')
        .select('*, objects(name), counterparties(id, name, inn, kpp, legal_address, actual_address, website, work_type), contract_counterparties(sort_order, counterparties(id, name, inn, kpp, legal_address, actual_address, website, work_type)), tenders(work_description), responsible:contacts!responsible_contact_id(id, full_name, position)')
        .eq('id', contractId)
        .single()
      if (error) throw error
      setContract(data)
      setNotesDraft(data?.notes || '')

      const { data: caRows } = await supabase
        .from('contract_attachments')
        .select('object_contract_attachments(id, name, link, sort_order)')
        .eq('contract_id', contractId)
      const list = (caRows || [])
        .map(r => r.object_contract_attachments)
        .filter(Boolean)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      setAttachments(list)

      const { data: logRows } = await supabase
        .from('contract_audit_log')
        .select('*')
        .eq('contract_id', contractId)
        .order('changed_at', { ascending: false })
      setAuditLog(logRows || [])
    } catch (err) {
      console.error('Ошибка загрузки договора:', err.message)
    }
  }, [contractId])

  // Дерево документа грузим одним запросом по корню: и договор, и все его ДС.
  // Пока миграция с root_contract_id не применена, запрос падает — тогда просто
  // не показываем блок ДС, остальная карточка работает как раньше.
  const rootId = contract?.root_contract_id || contract?.id || null
  const fetchFamily = useCallback(async () => {
    if (!rootId) return
    try {
      const { data, error } = await supabase
        .from('contracts')
        .select('id, display_id, record_type, parent_contract_id, root_contract_id, status, deleted_at, contract_number, contract_date, contract_amount, psdc_total, gp_amount, currency, vat_rate, amount_includes_vat, bsm, work_name, work_start_date, work_end_date, warranty_retention_percent, warranty_retention_period, warranty_period, changed_fields')
        .or(`id.eq.${rootId},root_contract_id.eq.${rootId}`)
        .is('deleted_at', null)
      if (error) throw error
      setFamily(data || [])
    } catch (err) {
      console.warn('Дерево документа недоступно:', err.message)
      setFamily([])
    }
  }, [rootId])

  useEffect(() => { fetchFamily() }, [fetchFamily])

  const docIndex = useMemo(() => buildDocIndex(family), [family])
  const rootDoc = rootId ? docIndex.byId.get(rootId) : null
  const parentDoc = contract?.parent_contract_id ? docIndex.byId.get(contract.parent_contract_id) : null
  // Плоское дерево от корня: договор → его ДС → их изменения.
  const familyTree = useMemo(
    () => (rootDoc ? flattenTree(rootDoc, docIndex) : []),
    [rootDoc, docIndex])
  const actualAmount = rootDoc ? contractActualAmount(rootDoc, docIndex) : null

  const fetchAdvances = useCallback(async () => {
    const { data } = await supabase
      .from('contract_advance_schedule')
      .select('*')
      .eq('contract_id', contractId)
      .order('sort_order', { ascending: true })
    setAdvances(data || [])
  }, [contractId])

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchContract(), fetchAdvances()]).finally(() => setLoading(false))
  }, [fetchContract, fetchAdvances])

  const formatDate = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  }

  const formatDateTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }

  const currency = contract?.currency || 'RUB'
  const money = (amount) => formatMoney(amount, currency) || '—'

  // --- Примечание (task 185) ---
  const handleSaveNotes = async () => {
    const next = notesDraft.trim() || null
    if ((contract?.notes || null) === next) return
    setSavingNotes(true)
    try {
      const { error } = await supabase.from('contracts').update({ notes: next }).eq('id', contractId)
      if (error) throw error
      await logEvent('field_updated', {
        fieldName: 'notes',
        oldValue: contract?.notes ?? null,
        newValue: next,
        description: next ? (contract?.notes ? 'Примечание обновлено' : 'Добавлено примечание') : 'Примечание удалено',
      })
      setContract(prev => ({ ...prev, notes: next }))
      fetchContract()
    } catch (err) {
      console.error('Ошибка сохранения примечания:', err.message)
      alert('Ошибка: ' + err.message)
    } finally {
      setSavingNotes(false)
    }
  }

  // --- Авансирование ---
  const handleSaveAdvance = async (e) => {
    e.preventDefault()
    const payload = {
      contract_id: contractId,
      planned_date: advForm.planned_date || null,
      amount: advForm.amount === '' ? null : advForm.amount,
      description: advForm.description || null,
      paid_date: advForm.paid_date || null,
    }
    try {
      if (editingAdvId) {
        const { error } = await supabase.from('contract_advance_schedule').update(payload).eq('id', editingAdvId)
        if (error) throw error
      } else {
        payload.sort_order = advances.length
        const { error } = await supabase.from('contract_advance_schedule').insert([payload])
        if (error) throw error
      }
      await logEvent('advance_updated', { description: editingAdvId ? 'Изменён транш авансирования' : 'Добавлен транш авансирования' })
      setAdvForm({ planned_date: '', amount: '', description: '', paid_date: '' })
      setEditingAdvId(null)
      fetchAdvances()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const handleEditAdvance = (a) => {
    setEditingAdvId(a.id)
    setAdvForm({
      planned_date: a.planned_date || '',
      amount: a.amount ?? '',
      description: a.description || '',
      paid_date: a.paid_date || '',
    })
  }

  const handleDeleteAdvance = async (id) => {
    if (!window.confirm('Удалить транш?')) return
    try {
      const { error } = await supabase.from('contract_advance_schedule').delete().eq('id', id)
      if (error) throw error
      await logEvent('advance_updated', { description: 'Удалён транш авансирования' })
      if (editingAdvId === id) { setEditingAdvId(null); setAdvForm({ planned_date: '', amount: '', description: '', paid_date: '' }) }
      fetchAdvances()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const advancesTotal = advances.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0)

  if (loading) {
    return <div className="contract-registry"><div className="loading" style={{ padding: '3rem', textAlign: 'center' }}>Загрузка...</div></div>
  }
  // Скоуп по объекту: руководитель не видит договор чужого объекта даже по прямой ссылке.
  if (contract && scopedObjectIds.length > 0 && !scopedObjectIds.includes(contract.object_id)) {
    return (
      <AccessDenied
        title="Договор недоступен"
        message="Этот договор относится к другому объекту, вне вашего доступа. Обратитесь к администратору, если нужен доступ."
        backTo="/contracts"
      />
    )
  }
  if (!contract) {
    return <div className="contract-registry"><div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>Договор не найден</div></div>
  }

  // Стороны договора (может быть несколько). Старые договоры — только основной контрагент.
  const partyRows = contract.contract_counterparties || []
  const parties = partyRows.length > 0
    ? [...partyRows].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(r => r.counterparties).filter(Boolean)
    : (contract.counterparties ? [contract.counterparties] : [])
  const statusLabel = STATUS_LABEL[contract.status] || contract.status
  const isDeleted = !!contract.deleted_at
  const vatLabel = contract.vat_rate != null
    ? `${contract.vat_rate}% (${contract.amount_includes_vat ? 'с НДС' : 'без НДС'})`
    : null
  // Сумма документа: применённая ПСДЦ, иначе ручная (одно правило с реестром).
  const documentAmount = effectiveDocumentAmount(contract)
  const psdcApplied = hasAppliedPsdc(contract)

  return (
    <div className="contract-registry contract-detail">
      <div className="registry-header cd-header">
        <button className="cd-back" onClick={() => navigate('/contracts')} aria-label="Назад к списку">←</button>
        <div className="cd-header-info">
          <div className="cd-title-row">
            <h2>
              {contract.contract_number
                ? `Договор № ${contract.contract_number}`
                : <>Договор <span className="cds-missing">(№ не присвоен)</span></>}
            </h2>
            <span className={`cd-status ${STATUS_CLASS[contract.status] || ''}`}>{statusLabel}</span>
            {isDeleted && <span className="cd-status cd-status-deleted">Удалён</span>}
          </div>
          <div className="cd-chips">
            <span className="cd-chip">
              {contract.contract_date ? `от ${formatDate(contract.contract_date)}` : <span className="cds-missing">дата не указана</span>}
            </span>
            {contract.objects?.name && <span className="cd-chip"><span className="cd-chip-l">Объект</span> {contract.objects.name}</span>}
            {parties[0]?.name && <span className="cd-chip"><span className="cd-chip-l">Контрагент</span> {parties[0].name}</span>}
            {money(documentAmount) !== '—' && <span className="cd-chip"><span className="cd-chip-l">{psdcApplied ? 'Сумма по ПСДЦ' : 'Сумма'}</span> {money(documentAmount)}</span>}
            {contract.responsible?.full_name && <span className="cd-chip"><span className="cd-chip-l">Юрист</span> {contract.responsible.full_name}</span>}
            {contract.signed_date && <span className="cd-chip"><span className="cd-chip-l">План. подписания</span> {formatDate(contract.signed_date)}</span>}
          </div>
        </div>
      </div>

      <div className="contract-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`contract-tab${activeTab === t.key ? ' active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
            {t.key === 'advances' && advances.length > 0 && <span className="contract-tab-badge">{advances.length}</span>}
            {t.key === 'history' && auditLog.length > 0 && <span className="contract-tab-badge">{auditLog.length}</span>}
          </button>
        ))}
      </div>

      {/* ВКЛАДКА: Информация */}
      {activeTab === 'info' && (
        <div className="contract-detail-grid">
          <div className="contract-section">
            <h3>Основная информация</h3>
            <div className="info-rows">
              <InfoRow label="ID портала" value={contract.display_id} mono />
              <InfoRow label="Тип" value={DOC_TYPE_LABEL[contract.record_type] || 'Договор'} />
              {isAmendment(contract) && rootDoc && rootDoc.id !== contract.id && (
                <InfoRow
                  label="Основной договор"
                  value={<Link to={`/contracts/${rootDoc.id}`} style={{ color: 'var(--primary-color)' }}>
                    ID {rootDoc.display_id}{rootDoc.contract_number ? ` · № ${rootDoc.contract_number}` : ''}
                  </Link>}
                />
              )}
              {isAmendment(contract) && parentDoc && (
                <InfoRow
                  label="Изменяемый документ"
                  value={<Link to={`/contracts/${parentDoc.id}`} style={{ color: 'var(--primary-color)' }}>
                    ID {parentDoc.display_id} · {DOC_TYPE_SHORT[parentDoc.record_type] || 'Договор'}
                  </Link>}
                />
              )}
              {isAmendment(contract) && (contract.changed_fields || []).length > 0 && (
                <InfoRow
                  label="Изменяет условия"
                  value={contract.changed_fields.map(f => OVERRIDABLE_FIELD_LABEL[f] || f).join(', ')}
                />
              )}
              <InfoRow label={isAmendment(contract) ? '№ ДС' : '№ договора'} value={contract.contract_number} />
              <InfoRow label="Дата" value={formatDate(contract.contract_date)} />
              <InfoRow label="Объект" value={contract.objects?.name} />
              <InfoRow label={isAmendment(contract) ? 'Предмет ДС' : 'Описание работ'} value={contract.work_name || contract.tenders?.work_description} />
              <InfoRow
                label={familyTree.length > 0 && !isAmendment(contract) ? 'Исходная сумма' : 'Сумма'}
                value={psdcApplied ? `${money(documentAmount)} (по ПСДЦ)` : money(documentAmount)}
              />
              {psdcApplied && (
                <InfoRow label="Ручная сумма" value={contract.contract_amount != null ? `${money(contract.contract_amount)} — действует, если удалить ПСДЦ` : 'не задана'} />
              )}
              {/* Актуальную показываем, только когда завершённые ДС её изменили. */}
              {!isAmendment(contract) && actualAmount != null && Number(actualAmount) !== Number(documentAmount || 0) && (
                <InfoRow label="Актуальная сумма" value={money(actualAmount)} />
              )}
              <InfoRow label="Валюта" value={contract.currency || 'RUB'} />
              <InfoRow label="Ставка НДС" value={vatLabel} />
              <InfoRow label="Статус" value={statusLabel} />
              <InfoRow label="Ответственный" value={contract.responsible?.full_name} />
              {contract.document_link && (
                <InfoRow
                  label="Документ"
                  value={<a href={contract.document_link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)' }}>Открыть на Google Drive</a>}
                />
              )}
            </div>
          </div>

          {/* Дерево документа: договор и все его соглашения. Каждая строка —
              ссылка на карточку, отступ показывает, что чем изменяется. */}
          <div className="contract-section contract-section-wide">
            <div className="cd-ds-head">
              <h3>Дополнительные соглашения{familyTree.length > 0 ? ` (${familyTree.length})` : ''}</h3>
              {canEditContracts && !isDeleted && (
                <div className="cd-ds-actions">
                  {[DOC_TYPE.CHANGE, DOC_TYPE.EXTRA].map(type => {
                    const plan = planAmendment(type, contract, docIndex)
                    return (
                      <button
                        key={type}
                        type="button"
                        className="btn-secondary"
                        disabled={!plan.ok}
                        title={plan.ok ? DOC_TYPE_LABEL[type] : plan.reason}
                        onClick={() => navigate(`/contracts?ds=${contract.display_id}&ds_type=${type}`)}
                      >+ {DOC_TYPE_LABEL[type]}</button>
                    )
                  })}
                </div>
              )}
            </div>
            {familyTree.length === 0 ? (
              <p className="cd-ds-empty">Соглашений нет. Условия договора действуют в исходной редакции.</p>
            ) : (
              <div className="cd-ds-list">
                {familyTree.map(({ doc, depth }) => (
                  <Link
                    key={doc.id}
                    to={`/contracts/${doc.id}`}
                    className={`cd-ds-item${doc.id === contract.id ? ' is-current' : ''}`}
                    style={{ marginLeft: `${depth * 1.25}rem` }}
                  >
                    <span className="cd-ds-id">ID {doc.display_id}</span>
                    <span className={`ds-type-badge is-${doc.record_type}`}>{DOC_TYPE_SHORT[doc.record_type]}</span>
                    <span className="cd-ds-num">{doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'}</span>
                    <span className="cd-ds-date">{doc.contract_date ? formatDate(doc.contract_date) : '—'}</span>
                    <span className="cd-ds-amount">{money(effectiveDocumentAmount(doc))}</span>
                    <span className={`cd-status ${STATUS_CLASS[doc.status] || ''}`}>{STATUS_LABEL[doc.status] || doc.status}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="contract-section">
            <h3>{parties.length > 1 ? 'Реквизиты сторон договора' : 'Реквизиты контрагента'}</h3>
            {parties.length === 0 ? (
              <div className="info-rows"><InfoRow label="Наименование" value={null} /></div>
            ) : parties.map((cp, i) => (
              <div key={cp.id || i} className="info-rows" style={i > 0 ? { marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' } : undefined}>
                {parties.length > 1 && (
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: '0.25rem' }}>
                    {i === 0 ? 'Основной контрагент' : `Сторона ${i + 1}`}
                  </div>
                )}
                <InfoRow label="Наименование" value={cp.name} />
                <InfoRow label="ИНН" value={cp.inn} mono />
                <InfoRow label="КПП" value={cp.kpp} mono />
                <InfoRow label="Юр. адрес" value={cp.legal_address} />
                <InfoRow label="Факт. адрес" value={cp.actual_address} />
                {cp.website && (
                  <InfoRow label="Сайт" value={<a href={cp.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)' }}>{cp.website}</a>} />
                )}
              </div>
            ))}
          </div>

          <div className="contract-section">
            <h3>Сроки работ</h3>
            <div className="info-rows">
              <InfoRow label="Начало работ" value={formatDate(contract.work_start_date)} />
              <InfoRow label="Окончание работ" value={formatDate(contract.work_end_date)} />
            </div>
          </div>

          <div className="contract-section">
            <h3>Гарантийные условия</h3>
            <div className="info-rows">
              <InfoRow label="Срок гарантии" value={contract.warranty_period} />
              <InfoRow label="Гарантийное удержание" value={contract.warranty_retention_percent ? `${contract.warranty_retention_percent}%` : null} />
              <InfoRow label="Срок удержания" value={contract.warranty_retention_period} />
            </div>
          </div>

          {(contract.gen_director_name || contract.phone || contract.email || contract.bsm || contract.comments) && (
            <div className="contract-section">
              <h3>Дополнительно</h3>
              <div className="info-rows">
                {contract.gen_director_name && <InfoRow label="ФИО ген.директора" value={contract.gen_director_name} />}
                {contract.phone && <InfoRow label="Телефон" value={contract.phone} />}
                {contract.email && <InfoRow label="Email" value={contract.email} />}
                {contract.bsm && <InfoRow label="БСМ" value={contract.bsm} />}
                {contract.comments && <InfoRow label="Комментарии" value={contract.comments} />}
              </div>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="contract-section contract-section-wide">
              <h3>Приложения ({attachments.length})</h3>
              <ul className="attachments-readonly">
                {attachments.map(a => (
                  <li key={a.id}>
                    {a.link
                      ? <a href={a.link} target="_blank" rel="noopener noreferrer">{a.name}</a>
                      : <span>{a.name}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hideNotes && (
          <div className="contract-section contract-section-wide">
            <h3>Примечание</h3>
            <textarea
              className="contract-notes"
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Свободный текст: важные нюансы, договорённости, статус согласования и т.п."
              rows={4}
              readOnly={!canEditContracts}
              disabled={!canEditContracts}
            />
            {canEditContracts && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
                <button type="button" className="btn-primary" onClick={handleSaveNotes} disabled={savingNotes || (contract.notes || '') === notesDraft.trim()}>
                  {savingNotes ? 'Сохранение…' : 'Сохранить'}
                </button>
                {contract.notes && contract.notes !== notesDraft && (
                  <button type="button" className="btn-secondary" onClick={() => setNotesDraft(contract.notes || '')}>Отменить</button>
                )}
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* ВКЛАДКА: ПСДЦ / ВОР */}
      {activeTab === 'psdc' && (
        <PsdcPanel
          documentId={contractId}
          displayId={contract.display_id}
          onChanged={() => { fetchContract(); fetchFamily() }}
        />
      )}

      {/* ВКЛАДКА: Авансирование */}
      {activeTab === 'advances' && (
        <div className="advances-tab">
          <div className="psdc-header">
            <span>График авансирования</span>
            <span className="advances-summary">
              Итого по графику: <strong>{formatMoney(advancesTotal, currency)}</strong>
              {documentAmount != null && (
                <span className={advancesTotal > Number(documentAmount) ? ' adv-over' : ''}>
                  {' '}из суммы договора {money(documentAmount)}
                </span>
              )}
            </span>
          </div>

          <table className="psdc-table advances-table">
            <thead>
              <tr>
                <th>Плановая дата</th>
                <th>Сумма</th>
                <th>Комментарий</th>
                <th>Факт. дата выдачи</th>
                {canEditContracts && <th></th>}
              </tr>
            </thead>
            <tbody>
              {advances.length === 0 ? (
                <tr><td colSpan={canEditContracts ? 5 : 4} className="center muted-dash">Траншей пока нет</td></tr>
              ) : advances.map(a => (
                <tr key={a.id}>
                  <td>{a.planned_date ? formatDate(a.planned_date) : '—'}</td>
                  <td className="money">{formatMoney(a.amount, currency) || '—'}</td>
                  <td>{a.description || ''}</td>
                  <td>{a.paid_date ? formatDate(a.paid_date) : '—'}</td>
                  {canEditContracts && (
                    <td className="center">
                      <button className="psdc-del" onClick={() => handleEditAdvance(a)} title="Изменить">✏️</button>
                      <button className="psdc-del" onClick={() => handleDeleteAdvance(a.id)} title="Удалить">🗑️</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {canEditContracts && (
            <form className="advance-form" onSubmit={handleSaveAdvance}>
              <div className="advance-form-row">
                <div>
                  <label>Плановая дата</label>
                  <input type="date" value={advForm.planned_date} onChange={(e) => setAdvForm({ ...advForm, planned_date: e.target.value })} />
                </div>
                <div>
                  <label>Сумма</label>
                  <input type="number" step="0.01" value={advForm.amount} onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })} placeholder="0.00" />
                </div>
                <div className="advance-form-desc">
                  <label>Комментарий</label>
                  <input type="text" value={advForm.description} onChange={(e) => setAdvForm({ ...advForm, description: e.target.value })} placeholder="Например: аванс 30%" />
                </div>
                <div>
                  <label>Факт. дата</label>
                  <input type="date" value={advForm.paid_date} onChange={(e) => setAdvForm({ ...advForm, paid_date: e.target.value })} />
                </div>
              </div>
              <div className="advance-form-actions">
                <button type="submit" className="btn-primary">{editingAdvId ? 'Сохранить транш' : 'Добавить транш'}</button>
                {editingAdvId && (
                  <button type="button" className="btn-secondary" onClick={() => { setEditingAdvId(null); setAdvForm({ planned_date: '', amount: '', description: '', paid_date: '' }) }}>Отмена</button>
                )}
              </div>
            </form>
          )}
        </div>
      )}

      {/* ВКЛАДКА: Документы (S3) */}
      {activeTab === 'clauses' && (
        <ContractClausesTab contractId={contractId} parties={parties} contract={contract} canEdit={canEditContracts && !isDeleted} />
      )}

      {activeTab === 'documents' && (
        <div className="contract-documents-tab">
          <S3DocumentList ownerType="contract" ownerId={contractId} title="Документы договора" excludeCategory="negotiation_template" />
        </div>
      )}

      {/* ВКЛАДКА: История */}
      {activeTab === 'history' && (
        <div className="contract-section contract-section-wide">
          <h3>История изменений ({auditLog.length})</h3>
          {auditLog.length === 0 ? (
            <div className="muted-dash" style={{ padding: '0.5rem 0' }}>Истории пока нет.</div>
          ) : (
            <ul className="audit-list">
              {auditLog.map(ev => (
                <li key={ev.id} className="audit-item">
                  <div className="audit-meta">
                    <span className="audit-type">{EVENT_LABEL[ev.event_type] || ev.event_type}</span>
                    <span className="audit-date">{formatDateTime(ev.changed_at)}</span>
                  </div>
                  <div className="audit-desc">{ev.description || '—'}</div>
                  {(ev.changed_by_name || ev.changed_by_role) && (
                    <div className="audit-who">
                      {ev.changed_by_name || 'без имени'}
                      {ev.changed_by_role ? ` (${ev.changed_by_role})` : ''}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

    </div>
  )
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={`info-value${mono ? ' mono' : ''}`}>{value || '—'}</span>
    </div>
  )
}

export default ContractDetailPage
