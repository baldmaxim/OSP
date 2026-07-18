import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { parseEstimateSheet, formatMoney } from '../utils/estimateImport'
import S3DocumentList from '../components/S3DocumentList'
import AccessDenied from '../components/AccessDenied'
import '../components/ContractRegistry.css'

const STATUS_LABEL = {
  new_request: 'Новая заявка',
  in_work: 'В работе',
  paused: 'Приостановка',
  completed: 'Завершено',
}

const EVENT_LABEL = {
  created: '🆕 Создание',
  status_changed: '🔄 Смена статуса',
  field_updated: '✏️ Изменение полей',
  soft_deleted: '🗑️ В корзину',
  restored: '↩ Восстановление',
  psdc_imported: '📊 Импорт ПСДЦ',
  psdc_approved: '✅ Утверждение ПСДЦ',
  advance_updated: '💸 График авансирования',
}

const TABS = [
  { key: 'info', label: 'Информация' },
  { key: 'psdc', label: 'ПСДЦ' },
  { key: 'advances', label: 'Авансирование' },
  { key: 'documents', label: 'Документы' },
  { key: 'history', label: 'История' },
]

function ContractDetailPage() {
  const { contractId } = useParams()
  const navigate = useNavigate()
  const { userProfile, canEdit, scopedObjectId } = useRole()
  // Руководитель строительства (привязан к объекту) не видит примечание юриста.
  const hideNotes = !!scopedObjectId
  // task 333: гейт редактирования раздела «contracts»
  const canEditContracts = canEdit('contracts')

  const [activeTab, setActiveTab] = useState('info')
  const [contract, setContract] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [auditLog, setAuditLog] = useState([])
  const [psdcItems, setPsdcItems] = useState([])
  const [advances, setAdvances] = useState([])
  const [loading, setLoading] = useState(true)
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  // ПСДЦ: импорт
  const [showImportModal, setShowImportModal] = useState(false)
  const [pendingWorkbook, setPendingWorkbook] = useState(null)
  const [sheetNames, setSheetNames] = useState([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [importMode, setImportMode] = useState('separate')
  const [startRow, setStartRow] = useState('2')
  const [endRow, setEndRow] = useState('')
  const [vatPercent, setVatPercent] = useState('')
  const [collapsedSections, setCollapsedSections] = useState(new Set())
  const psdcFileRef = useRef(null)

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

  const fetchPsdc = useCallback(async () => {
    const { data } = await supabase
      .from('contract_psdc_items')
      .select('*')
      .eq('contract_id', contractId)
      .is('agreement_id', null)
      .order('row_number', { ascending: true })
    setPsdcItems(data || [])
  }, [contractId])

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
    Promise.all([fetchContract(), fetchPsdc(), fetchAdvances()]).finally(() => setLoading(false))
  }, [fetchContract, fetchPsdc, fetchAdvances])

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

  // --- ПСДЦ: расчёты ---
  const calcMaterials = (it) => (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price_materials) || 0)
  const calcWorks = (it) => (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price_works) || 0)
  const calcTotal = (it) => {
    const mw = calcMaterials(it) + calcWorks(it)
    return mw || (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0)
  }
  // Давальческие строки в суммы НЕ входят, но объём отображается.
  const isSummable = (it) => !it.is_section && !it.is_davalchesky
  const psdcTotalMaterials = psdcItems.filter(isSummable).reduce((s, i) => s + calcMaterials(i), 0)
  const psdcTotalWorks = psdcItems.filter(isSummable).reduce((s, i) => s + calcWorks(i), 0)
  const psdcTotal = psdcItems.filter(isSummable).reduce((s, i) => s + calcTotal(i), 0)
  const psdcVat = psdcItems.length > 0 ? (parseFloat(psdcItems[0]?.vat_percent) || 0) : 0
  const isCombined = psdcItems.length > 0 && psdcItems[0]?.import_mode === 'combined'
  const isPsdcApproved = psdcItems.length > 0 && psdcItems[0]?.is_approved
  const hasSections = psdcItems.some(i => i.is_section)

  const toggleSection = (id) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // id раздела, под которым находится строка (для скрытия при сворачивании)
  const sectionOf = (() => {
    const map = {}
    let current = null
    for (const it of psdcItems) {
      if (it.is_section) current = it.id
      else map[it.id] = current
    }
    return map
  })()

  const sectionTotals = (sectionId, calc) => psdcItems
    .filter(i => sectionOf[i.id] === sectionId && isSummable(i))
    .reduce((s, i) => s + calc(i), 0)

  const recomputeContractAmount = async (items) => {
    const total = (items || []).filter(isSummable).reduce((s, i) => s + calcTotal(i), 0)
    await supabase.from('contracts').update({ contract_amount: total || null }).eq('id', contractId)
  }

  const handlePsdcFile = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const wb = XLSX.read(data, { type: 'array' })
      setPendingWorkbook(wb)
      setSheetNames(wb.SheetNames || [])
      setSelectedSheet(wb.SheetNames?.[0] || '')
      setShowImportModal(true)
    } catch (err) {
      alert('Ошибка чтения файла: ' + err.message)
    }
    if (psdcFileRef.current) psdcFileRef.current.value = ''
  }

  const handleImportPsdc = async () => {
    if (!pendingWorkbook) return
    setShowImportModal(false)
    try {
      const parsed = parseEstimateSheet(pendingWorkbook, { sheet: selectedSheet, startRow, endRow, importMode, vat: vatPercent })
      if (parsed.length === 0) { alert('Не найдено позиций в файле'); return }
      const rows = parsed.map(r => ({ ...r, contract_id: contractId }))
      await supabase.from('contract_psdc_items').delete().eq('contract_id', contractId).is('agreement_id', null)
      const { error } = await supabase.from('contract_psdc_items').insert(rows)
      if (error) throw error
      await recomputeContractAmount(rows)
      await logEvent('psdc_imported', { description: `Импортирована ПСДЦ: ${rows.filter(r => !r.is_section).length} позиций` })
      await Promise.all([fetchPsdc(), fetchContract()])
    } catch (err) {
      alert('Ошибка импорта: ' + err.message)
    } finally {
      setPendingWorkbook(null)
    }
  }

  const handleDeletePsdcItem = async (itemId) => {
    try {
      const { error } = await supabase.from('contract_psdc_items').delete().eq('id', itemId)
      if (error) throw error
      const updated = psdcItems.filter(i => i.id !== itemId)
      setPsdcItems(updated)
      await recomputeContractAmount(updated)
      fetchContract()
    } catch (err) {
      alert('Ошибка удаления: ' + err.message)
    }
  }

  const handleClearPsdc = async () => {
    if (!window.confirm('Удалить все строки ПСДЦ?')) return
    try {
      const { error } = await supabase.from('contract_psdc_items').delete().eq('contract_id', contractId).is('agreement_id', null)
      if (error) throw error
      setPsdcItems([])
      await supabase.from('contracts').update({ contract_amount: null }).eq('id', contractId)
      fetchContract()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const setPsdcApproved = async (value) => {
    if (!value && !window.confirm('Снять утверждение ПСДЦ? Станет доступно редактирование.')) return
    try {
      const { error } = await supabase.from('contract_psdc_items')
        .update({ is_approved: value }).eq('contract_id', contractId).is('agreement_id', null)
      if (error) throw error
      setPsdcItems(prev => prev.map(i => ({ ...i, is_approved: value })))
      if (value) await logEvent('psdc_approved', { description: 'ПСДЦ утверждена' })
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const toggleDavalchesky = async (item) => {
    const next = !item.is_davalchesky
    try {
      const { error } = await supabase.from('contract_psdc_items').update({ is_davalchesky: next }).eq('id', item.id)
      if (error) throw error
      const updated = psdcItems.map(i => i.id === item.id ? { ...i, is_davalchesky: next } : i)
      setPsdcItems(updated)
      await recomputeContractAmount(updated)
      fetchContract()
    } catch (err) {
      alert('Ошибка: ' + err.message)
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
  if (contract && scopedObjectId && contract.object_id !== scopedObjectId) {
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

  return (
    <div className="contract-registry contract-detail">
      <div className="registry-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button onClick={() => navigate('/contracts')} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>←</button>
          <div>
            <h2 style={{ margin: 0 }}>
              {contract.contract_number
                ? `Договор № ${contract.contract_number}`
                : <>Договор <span className="cds-missing">(№ не присвоен)</span></>}
              {isDeleted && <span className="deleted-marker"> (удалён)</span>}
            </h2>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
              {contract.contract_date
                ? `от ${formatDate(contract.contract_date)}`
                : <span className="cds-missing">дата не указана</span>}
              {' · '}<span className={`status-badge-inline status-${contract.status}`}>{statusLabel}</span>
            </span>
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
            {t.key === 'psdc' && psdcItems.filter(i => !i.is_section).length > 0 && <span className="contract-tab-badge">{psdcItems.filter(i => !i.is_section).length}</span>}
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
              <InfoRow label="№ договора" value={contract.contract_number} />
              <InfoRow label="Дата" value={formatDate(contract.contract_date)} />
              <InfoRow label="Объект" value={contract.objects?.name} />
              <InfoRow label="Описание работ" value={contract.work_name || contract.tenders?.work_description} />
              <InfoRow label="Сумма" value={money(contract.contract_amount)} />
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

      {/* ВКЛАДКА: ПСДЦ */}
      {activeTab === 'psdc' && (
        <div className="psdc-tab">
          <div className="psdc-header">
            <span>
              ПСДЦ {psdcItems.length > 0 && `(${psdcItems.filter(i => !i.is_section).length} позиций${psdcVat ? `, НДС ${psdcVat}%` : ''})`}
            </span>
            <div className="psdc-header-actions">
              {psdcItems.length > 0 && canEditContracts && (
                isPsdcApproved ? (
                  <button className="btn-secondary" onClick={() => setPsdcApproved(false)}>Снять утверждение</button>
                ) : (
                  <>
                    <button className="btn-primary" onClick={() => setPsdcApproved(true)}>Утвердить</button>
                    <button className="btn-danger" onClick={handleClearPsdc}>Очистить</button>
                  </>
                )
              )}
              {!isPsdcApproved && canEditContracts && (
                <label className="btn-primary psdc-import-label">
                  Импорт из Excel
                  <input ref={psdcFileRef} type="file" accept=".xlsx,.xls" onChange={handlePsdcFile} style={{ display: 'none' }} />
                </label>
              )}
            </div>
          </div>

          {psdcItems.length > 0 ? (
            <div className="psdc-table-wrapper">
              <table className="psdc-table">
                <thead>
                  <tr>
                    {hasSections && <th></th>}
                    <th>Код</th>
                    <th>№</th>
                    <th>Наименование работ</th>
                    <th>Ед. изм.</th>
                    <th>Кол-во</th>
                    {isCombined ? (
                      <>
                        <th>Цена за ед.</th>
                        <th>Стоимость</th>
                      </>
                    ) : (
                      <>
                        <th>Цена мат.</th>
                        <th>Цена работ</th>
                        <th>Стоим. мат.</th>
                        <th>Стоим. работ</th>
                        <th>Итого</th>
                      </>
                    )}
                    <th title="Давальческий материал — объём учитывается, в сумму не входит">Дав.</th>
                    <th>Примечание</th>
                    {!isPsdcApproved && canEditContracts && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {psdcItems.map(item => {
                    if (!item.is_section && collapsedSections.has(sectionOf[item.id])) return null
                    const isCollapsed = item.is_section && collapsedSections.has(item.id)
                    if (item.is_section) {
                      return (
                        <tr key={item.id} className={`psdc-section-row${isCollapsed ? ' collapsed' : ''}`}>
                          {hasSections && (
                            <td className="psdc-toggle-cell">
                              <button className="psdc-toggle" onClick={() => toggleSection(item.id)}>{isCollapsed ? '+' : '−'}</button>
                            </td>
                          )}
                          <td colSpan={5} className="psdc-section-name" onClick={() => toggleSection(item.id)}>{item.cost_name}</td>
                          {isCombined ? (
                            <>
                              <td></td>
                              <td className="money">{formatMoney(sectionTotals(item.id, calcTotal), currency)}</td>
                            </>
                          ) : (
                            <>
                              <td></td>
                              <td></td>
                              <td className="money">{formatMoney(sectionTotals(item.id, calcMaterials), currency)}</td>
                              <td className="money">{formatMoney(sectionTotals(item.id, calcWorks), currency)}</td>
                              <td className="money">{formatMoney(sectionTotals(item.id, calcTotal), currency)}</td>
                            </>
                          )}
                          <td></td>
                          <td></td>
                          {!isPsdcApproved && canEditContracts && <td className="center"><button className="psdc-del" onClick={() => handleDeletePsdcItem(item.id)}>×</button></td>}
                        </tr>
                      )
                    }
                    return (
                      <tr key={item.id} className={item.is_davalchesky ? 'psdc-davalchesky' : ''}>
                        {hasSections && <td></td>}
                        <td className="center">{item.code || ''}</td>
                        <td className="center">{item.row_number}</td>
                        <td>{item.cost_name}</td>
                        <td className="center">{item.unit || ''}</td>
                        <td className="money">{item.quantity || ''}</td>
                        {isCombined ? (
                          <>
                            <td className="money">{formatMoney(item.unit_price, currency)}</td>
                            <td className="money">{item.is_davalchesky ? '—' : formatMoney(item.total_price, currency)}</td>
                          </>
                        ) : (
                          <>
                            <td className="money">{formatMoney(item.unit_price_materials, currency)}</td>
                            <td className="money">{formatMoney(item.unit_price_works, currency)}</td>
                            <td className="money">{item.is_davalchesky ? '—' : formatMoney(calcMaterials(item), currency)}</td>
                            <td className="money">{item.is_davalchesky ? '—' : formatMoney(calcWorks(item), currency)}</td>
                            <td className="money">{item.is_davalchesky ? '—' : formatMoney(calcTotal(item), currency)}</td>
                          </>
                        )}
                        <td className="center">
                          <input
                            type="checkbox"
                            checked={!!item.is_davalchesky}
                            onChange={() => toggleDavalchesky(item)}
                            disabled={isPsdcApproved || !canEditContracts}
                            title="Давальческий материал"
                          />
                        </td>
                        <td>{item.notes || ''}</td>
                        {!isPsdcApproved && canEditContracts && <td className="center"><button className="psdc-del" onClick={() => handleDeletePsdcItem(item.id)}>×</button></td>}
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    {isCombined ? (
                      <>
                        <td colSpan={hasSections ? 7 : 6}><strong>ИТОГО (без давальческих)</strong></td>
                        <td className="money"><strong>{formatMoney(psdcTotal, currency)}</strong></td>
                        <td colSpan={!isPsdcApproved && canEditContracts ? 3 : 2}></td>
                      </>
                    ) : (
                      <>
                        <td colSpan={hasSections ? 8 : 7}><strong>ИТОГО (без давальческих)</strong></td>
                        <td className="money"><strong>{formatMoney(psdcTotalMaterials, currency)}</strong></td>
                        <td className="money"><strong>{formatMoney(psdcTotalWorks, currency)}</strong></td>
                        <td className="money"><strong>{formatMoney(psdcTotal, currency)}</strong></td>
                        <td colSpan={!isPsdcApproved && canEditContracts ? 3 : 2}></td>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="psdc-empty">
              <p>ПСДЦ не загружена</p>
              <p className="psdc-hint">
                Импортируйте Excel с колонками:<br />
                Раздельно: A — код, B — наименование, C — ед. изм., D — кол-во, E — мат., F — работы, G — примечание<br />
                Совместно: A — код, B — наименование, C — ед. изм., D — кол-во, E — цена, F — примечание
              </p>
            </div>
          )}
        </div>
      )}

      {/* ВКЛАДКА: Авансирование */}
      {activeTab === 'advances' && (
        <div className="advances-tab">
          <div className="psdc-header">
            <span>График авансирования</span>
            <span className="advances-summary">
              Итого по графику: <strong>{formatMoney(advancesTotal, currency)}</strong>
              {contract.contract_amount && (
                <span className={advancesTotal > Number(contract.contract_amount) ? ' adv-over' : ''}>
                  {' '}из суммы договора {money(contract.contract_amount)}
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
      {activeTab === 'documents' && (
        <div className="contract-documents-tab">
          <S3DocumentList ownerType="contract" ownerId={contractId} title="Документы договора" />
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

      {/* Модалка импорта ПСДЦ */}
      {showImportModal && (
        <div className="modal-overlay">
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Импорт ПСДЦ</h3>
              <button onClick={() => { setShowImportModal(false); setPendingWorkbook(null) }}>×</button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleImportPsdc() }}>
              <div className="modal-body">
                {sheetNames.length > 1 && (
                  <div className="form-group">
                    <label>Лист Excel</label>
                    <select value={selectedSheet} onChange={(e) => setSelectedSheet(e.target.value)}>
                      {sheetNames.map(name => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </div>
                )}
                <div className="form-group">
                  <label>Формат расценок</label>
                  <select value={importMode} onChange={(e) => setImportMode(e.target.value)}>
                    <option value="separate">Материалы и работы (E — мат., F — работы, G — примечание)</option>
                    <option value="combined">Комплекты (E — цена, F — примечание)</option>
                  </select>
                </div>
                <div className="form-row-3" style={{ display: 'flex', gap: '0.75rem' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label>Со строки</label>
                    <input type="number" step="1" min="1" value={startRow} onChange={(e) => setStartRow(e.target.value)} placeholder="2" />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label>По строку</label>
                    <input type="number" step="1" min="1" value={endRow} onChange={(e) => setEndRow(e.target.value)} placeholder="Все" />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label>% НДС</label>
                    <input type="number" step="1" min="0" max="100" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} placeholder={contract.vat_rate != null ? String(contract.vat_rate) : '22'} />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => { setShowImportModal(false); setPendingWorkbook(null) }}>Отмена</button>
                <button type="submit" className="btn-primary">Импортировать</button>
              </div>
            </form>
          </div>
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
