import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import { saveAs } from 'file-saver'
import { renderAsync } from 'docx-preview'
import { copyToClipboard } from '../utils/clipboard'
import '../components/ContractRegistry.css'

function ContractDetailPage() {
  const { contractId } = useParams()
  const navigate = useNavigate()
  const [contract, setContract] = useState(null)
  const [loading, setLoading] = useState(true)
  const [templateFile, setTemplateFile] = useState(null)
  const [templateName, setTemplateName] = useState(localStorage.getItem('contractTemplateName') || '')
  const [showPreview, setShowPreview] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [customVars, setCustomVars] = useState(() => {
    const saved = localStorage.getItem('contractCustomVars')
    return saved ? JSON.parse(saved) : []
  })
  const [newVarName, setNewVarName] = useState('')
  const [newVarDesc, setNewVarDesc] = useState('')
  const templateInputRef = useRef(null)
  const previewRef = useRef(null)

  useEffect(() => {
    fetchContract()
    // Загрузить шаблон из localStorage
    const saved = localStorage.getItem('contractTemplate')
    if (saved) {
      const binary = atob(saved)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      setTemplateFile(bytes.buffer)
    }
  }, [contractId])

  const fetchContract = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('contracts')
        .select('*, objects(name), counterparties(name, inn, kpp, legal_address, actual_address, website, work_type), tenders(work_description)')
        .eq('id', contractId)
        .single()

      if (error) throw error
      setContract(data)
    } catch (err) {
      console.error('Ошибка загрузки договора:', err.message)
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  }

  const formatAmount = (amount) => {
    if (!amount) return '—'
    return Number(amount).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' руб.'
  }

  const handleTemplateUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setTemplateFile(ev.target.result)
      setTemplateName(file.name)
      localStorage.setItem('contractTemplateName', file.name)
      const base64 = btoa(new Uint8Array(ev.target.result).reduce((d, b) => d + String.fromCharCode(b), ''))
      localStorage.setItem('contractTemplate', base64)
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  const getContractVars = useCallback(() => {
    if (!contract) return {}
    const cp = contract.counterparties || {}
    return {
      contract_number: contract.contract_number || '',
      contract_date: formatDate(contract.contract_date),
      counterparty_name: cp.name || '',
      counterparty_inn: cp.inn || '',
      counterparty_kpp: cp.kpp || '',
      counterparty_address: cp.legal_address || '',
      object_name: contract.objects?.name || '',
      work_description: contract.tenders?.work_description || '',
      contract_amount: contract.contract_amount ? Number(contract.contract_amount).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) : '',
      warranty_retention_percent: contract.warranty_retention_percent || '',
      warranty_retention_period: contract.warranty_retention_period || '',
      work_start_date: formatDate(contract.work_start_date),
      work_end_date: formatDate(contract.work_end_date),
      warranty_period: contract.warranty_period || '',
    }
  }, [contract])

  const generateFilledBlob = () => {
    const zip = new PizZip(templateFile)
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, delimiters: { start: '{', end: '}' } })
    doc.render(getContractVars())
    return doc.getZip().generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  }

  const handleGenerateDocument = () => {
    if (!templateFile || !contract) { alert('Загрузите шаблон .docx'); return }
    try {
      const output = generateFilledBlob()
      const cp = contract.counterparties || {}
      const name = cp.name ? cp.name.substring(0, 20).replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, '_') : ''
      saveAs(output, `Договор_${contract.contract_number || ''}_${name}.docx`)
    } catch (err) {
      console.error('Ошибка генерации:', err)
      alert('Ошибка: ' + (err.message || 'проверьте шаблон'))
    }
  }

  const handlePreview = async () => {
    if (!templateFile || !contract) { alert('Загрузите шаблон .docx'); return }
    setShowPreview(true)
    setPreviewLoading(true)
    try {
      const blob = generateFilledBlob()
      // Ждём пока ref появится в DOM
      setTimeout(async () => {
        if (previewRef.current) {
          previewRef.current.innerHTML = ''
          await renderAsync(blob, previewRef.current, null, {
            className: 'docx-preview-wrapper',
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
          })
        }
        setPreviewLoading(false)
      }, 50)
    } catch (err) {
      console.error('Ошибка предпросмотра:', err)
      setPreviewLoading(false)
      alert('Ошибка предпросмотра: ' + (err.message || ''))
    }
  }

  if (loading) {
    return <div className="contract-registry"><div className="loading" style={{ padding: '3rem', textAlign: 'center' }}>Загрузка...</div></div>
  }

  if (!contract) {
    return <div className="contract-registry"><div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>Договор не найден</div></div>
  }

  const cp = contract.counterparties || {}

  return (
    <div className="contract-registry">
      <div className="registry-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button onClick={() => navigate('/contracts')} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>←</button>
          <div>
            <h2 style={{ margin: 0 }}>Договор № {contract.contract_number}</h2>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>от {formatDate(contract.contract_date)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => templateInputRef.current?.click()}
            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            {templateName ? `Шаблон: ${templateName}` : 'Загрузить шаблон'}
          </button>
          <button
            onClick={handlePreview}
            style={{ padding: '0.375rem 1rem', fontSize: '0.8125rem', border: '1px solid var(--primary-color)', borderRadius: '4px', background: 'transparent', color: 'var(--primary-color)', cursor: 'pointer' }}
          >
            Предпросмотр
          </button>
          <button
            onClick={handleGenerateDocument}
            className="btn-primary"
            style={{ padding: '0.375rem 1rem', fontSize: '0.8125rem' }}
          >
            Скачать .docx
          </button>
        </div>
      </div>

      <input ref={templateInputRef} type="file" accept=".docx" onChange={handleTemplateUpload} style={{ display: 'none' }} />

      <div style={{ padding: '1.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* Основная информация */}
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '1.25rem', border: '1px solid var(--border-color)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Основная информация</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <InfoRow label="№ договора" value={contract.contract_number} />
            <InfoRow label="Дата" value={formatDate(contract.contract_date)} />
            <InfoRow label="Объект" value={contract.objects?.name} />
            <InfoRow label="Описание работ" value={contract.tenders?.work_description} />
            <InfoRow label="Сумма" value={formatAmount(contract.contract_amount)} />
            <InfoRow label="Статус" value={contract.status === 'signed' ? 'Заключён' : 'На согласовании'} />
            {contract.document_link && (
              <InfoRow label="Документ" value={<a href={contract.document_link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)' }}>Открыть на Google Drive</a>} />
            )}
          </div>
        </div>

        {/* Реквизиты контрагента */}
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '1.25rem', border: '1px solid var(--border-color)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Реквизиты контрагента</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <InfoRow label="Наименование" value={cp.name} />
            <InfoRow label="ИНН" value={cp.inn} mono />
            <InfoRow label="КПП" value={cp.kpp} mono />
            <InfoRow label="Юр. адрес" value={cp.legal_address} />
            <InfoRow label="Факт. адрес" value={cp.actual_address} />
            {cp.website && (
              <InfoRow label="Сайт" value={<a href={cp.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)' }}>{cp.website}</a>} />
            )}
          </div>
        </div>

        {/* Сроки */}
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '1.25rem', border: '1px solid var(--border-color)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Сроки работ</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <InfoRow label="Начало работ" value={formatDate(contract.work_start_date)} />
            <InfoRow label="Окончание работ" value={formatDate(contract.work_end_date)} />
          </div>
        </div>

        {/* Гарантия */}
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '1.25rem', border: '1px solid var(--border-color)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Гарантийные условия</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <InfoRow label="Срок гарантии" value={contract.warranty_period} />
            <InfoRow label="Гарантийное удержание" value={contract.warranty_retention_percent ? `${contract.warranty_retention_percent}%` : null} />
            <InfoRow label="Срок удержания" value={contract.warranty_retention_period} />
          </div>
        </div>
      </div>

      {/* Переменные для шаблона */}
      <div style={{ padding: '0 1.5rem 1.5rem' }}>
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
          <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>Переменные для шаблона .docx</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>Нажмите на переменную, чтобы скопировать</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '0.5rem 1rem', textAlign: 'left', fontWeight: 600, fontSize: '0.6875rem', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Переменная</th>
                <th style={{ padding: '0.5rem 1rem', textAlign: 'left', fontWeight: 600, fontSize: '0.6875rem', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Описание</th>
                <th style={{ width: '40px' }}></th>
              </tr>
            </thead>
            <tbody>
              {[
                ['{contract_number}', '№ договора'],
                ['{contract_date}', 'Дата договора'],
                ['{counterparty_name}', 'Наименование контрагента'],
                ['{counterparty_inn}', 'ИНН контрагента'],
                ['{counterparty_kpp}', 'КПП контрагента'],
                ['{counterparty_address}', 'Юридический адрес контрагента'],
                ['{object_name}', 'Наименование объекта'],
                ['{work_description}', 'Описание работ (из тендера)'],
                ['{contract_amount}', 'Сумма договора'],
                ['{warranty_retention_percent}', 'Гарантийное удержание (%)'],
                ['{warranty_retention_period}', 'Срок гарантийного удержания'],
                ['{work_start_date}', 'Дата начала работ'],
                ['{work_end_date}', 'Дата окончания работ'],
                ['{warranty_period}', 'Срок гарантии на работы'],
                ...customVars.map(cv => [cv.name, cv.desc, true]),
              ].map(([name, desc, isCustom], i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.375rem 1rem' }}>
                    <span
                      onClick={() => copyToClipboard(name)}
                      style={{
                        padding: '0.15rem 0.5rem', fontFamily: 'Consolas, Monaco, monospace', fontSize: '0.8125rem',
                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '3px',
                        color: 'var(--primary-color)', cursor: 'pointer', display: 'inline-block',
                      }}
                    >{name}</span>
                  </td>
                  <td style={{ padding: '0.375rem 1rem', color: 'var(--text-secondary)' }}>{desc}</td>
                  <td style={{ padding: '0.375rem 0.5rem', textAlign: 'center' }}>
                    {isCustom && (
                      <button
                        onClick={() => {
                          const updated = customVars.filter(cv => cv.name !== name)
                          setCustomVars(updated)
                          localStorage.setItem('contractCustomVars', JSON.stringify(updated))
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '1rem' }}
                        title="Удалить"
                      >×</button>
                    )}
                  </td>
                </tr>
              ))}
              {/* Форма добавления */}
              <tr>
                <td style={{ padding: '0.375rem 1rem' }}>
                  <input
                    type="text"
                    value={newVarName}
                    onChange={(e) => setNewVarName(e.target.value)}
                    placeholder="{название}"
                    style={{
                      padding: '0.25rem 0.5rem', fontSize: '0.8125rem', fontFamily: 'Consolas, Monaco, monospace',
                      border: '1px solid var(--border-color)', borderRadius: '3px', background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)', width: '160px',
                    }}
                  />
                </td>
                <td style={{ padding: '0.375rem 1rem' }}>
                  <input
                    type="text"
                    value={newVarDesc}
                    onChange={(e) => setNewVarDesc(e.target.value)}
                    placeholder="Описание переменной"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newVarName.trim() && newVarDesc.trim()) {
                        const varName = newVarName.trim().startsWith('{') ? newVarName.trim() : `{${newVarName.trim()}}`
                        const updated = [...customVars, { name: varName, desc: newVarDesc.trim() }]
                        setCustomVars(updated)
                        localStorage.setItem('contractCustomVars', JSON.stringify(updated))
                        setNewVarName('')
                        setNewVarDesc('')
                      }
                    }}
                    style={{
                      padding: '0.25rem 0.5rem', fontSize: '0.8125rem',
                      border: '1px solid var(--border-color)', borderRadius: '3px', background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box',
                    }}
                  />
                </td>
                <td style={{ padding: '0.375rem 0.5rem', textAlign: 'center' }}>
                  <button
                    onClick={() => {
                      if (!newVarName.trim() || !newVarDesc.trim()) return
                      const varName = newVarName.trim().startsWith('{') ? newVarName.trim() : `{${newVarName.trim()}}`
                      const updated = [...customVars, { name: varName, desc: newVarDesc.trim() }]
                      setCustomVars(updated)
                      localStorage.setItem('contractCustomVars', JSON.stringify(updated))
                      setNewVarName('')
                      setNewVarDesc('')
                    }}
                    style={{
                      background: 'var(--primary-color)', border: 'none', borderRadius: '3px',
                      color: 'white', cursor: 'pointer', width: '24px', height: '24px', fontSize: '1rem',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    title="Добавить переменную"
                  >+</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Предпросмотр документа */}
      {showPreview && (
        <div style={{ padding: '0 1.5rem 1.5rem' }}>
          <div style={{
            background: 'white',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0.625rem 1rem', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-color)'
            }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>Предпросмотр договора</span>
              <button
                onClick={() => setShowPreview(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '1.25rem' }}
              >×</button>
            </div>
            {previewLoading && (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>Загрузка предпросмотра...</div>
            )}
            <div
              ref={previewRef}
              style={{
                maxHeight: '80vh',
                overflowY: 'auto',
                padding: '1rem',
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.8125rem', lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-tertiary)', minWidth: '140px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontFamily: mono ? 'Consolas, Monaco, monospace' : 'inherit' }}>{value || '—'}</span>
    </div>
  )
}

export default ContractDetailPage
