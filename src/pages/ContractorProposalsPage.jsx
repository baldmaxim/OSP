import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import { cleanNumeric } from '../utils/parseProposalExcel'
import { fetchAllRows } from '../utils/fetchAllRows'
import './ContractorProposalsPage.css'

function ContractorProposalsPage() {
  const navigate = useNavigate()
  const { contractorInfo, isContractor, logout } = useRole()

  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedTender, setSelectedTender] = useState(null)
  const [estimateItems, setEstimateItems] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)

  // Редирект если не подрядчик
  useEffect(() => {
    if (!isContractor) {
      navigate('/partner')
    }
  }, [isContractor, navigate])

  const fetchTenders = useCallback(async () => {
    if (!contractorInfo?.id) return
    setLoading(true)
    try {
      // Получаем тендеры, где подрядчик является участником
      const { data: participations, error: partError } = await supabase
        .from('tender_counterparties')
        .select(`
          tender_id,
          status,
          tenders (
            id,
            work_description,
            tender_start_date,
            tender_end_date,
            status,
            objects (name)
          )
        `)
        .eq('counterparty_id', contractorInfo.id)

      if (partError) throw partError

      // Фильтруем только активные тендеры
      const activeTenders = (participations || [])
        .filter(p => p.tenders && p.tenders.status !== 'completed')
        .map(p => ({
          ...p.tenders,
          participationStatus: p.status
        }))

      // Когда КП по каждому тендеру реально ушло на сайт — самая свежая строка расценок.
      // По одному запросу на тендер (их единицы), ошибки не критичны.
      const uploaded = await Promise.all(activeTenders.map(t =>
        supabase
          .from('tender_counterparty_proposals')
          .select('created_at')
          .eq('tender_id', t.id)
          .eq('counterparty_id', contractorInfo.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(r => r?.data?.created_at || null, () => null)
      ))

      setTenders(activeTenders.map((t, i) => ({ ...t, uploadedAt: uploaded[i] })))
    } catch (error) {
      console.error('Ошибка загрузки тендеров:', error)
    } finally {
      setLoading(false)
    }
  }, [contractorInfo?.id])

  // Загружаем тендеры, в которых участвует подрядчик
  useEffect(() => {
    if (contractorInfo?.id) {
      fetchTenders()
    }
  }, [contractorInfo?.id, fetchTenders])

  const fetchEstimateItems = async (tenderId) => {
    try {
      // Постранично — ВОР может превышать потолок PostgREST в 1000 строк.
      const data = await fetchAllRows((from, to) => supabase
        .from('tender_estimate_items')
        .select('*')
        .eq('tender_id', tenderId)
        .order('row_number')
        .order('id')
        .range(from, to))
      setEstimateItems(data || [])
    } catch (error) {
      console.error('Ошибка загрузки сметы:', error)
    }
  }

  const handleTenderSelect = (tender) => {
    setSelectedTender(tender)
    setUploadSuccess(false)
    fetchEstimateItems(tender.id)
  }

  const handleDownloadTemplate = () => {
    if (!selectedTender || estimateItems.length === 0) return

    const headerRow = [
      '№ п/п', 'КОД', 'Вид затрат', 'Наименование затрат', 'Примечание к расчету',
      'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу',
      'Цена за ед. Матер./Обор. с НДС', 'Цена за ед. СМР/ПНР с НДС',
      'ИТОГО цена за ед. с НДС', 'Стоим. Матер./Обор. с НДС', 'Стоим. СМР/ПНР с НДС',
      'ИТОГО стоимость с НДС', 'Общая стоимость с НДС', 'Примечание участника',
      // Скрытый якорь: по нему цены возвращаются ровно на свои позиции. Номер
      // «№ п/п» для этого не годится — он уникален только внутри одного ВОРа, а
      // в тендере их бывает несколько, и цены уезжали в чужой документ.
      'ID (не изменять)',
    ]

    const dataRows = estimateItems.map((item, idx) => {
      const rowNum = idx + 2
      // Раздел — это заголовок группы, а не позиция: формулы и якорь ему не
      // нужны, иначе цена на разделе прибавлялась бы к стоимости его же строк.
      if (item.is_section) {
        return [
          item.row_number, '', '', item.cost_name || '', '', '', '', '',
          '', '', '', '', '', '', '', '', '',
        ]
      }
      return [
        item.row_number,
        item.code || '',
        item.cost_type || '',
        item.cost_name || '',
        item.calculation_note || '',
        item.unit || '',
        item.work_volume || '',
        item.material_consumption || '',
        '', // Цена материалы
        '', // Цена СМР
        { f: `I${rowNum}+J${rowNum}` },
        { f: `I${rowNum}*G${rowNum}` },
        { f: `J${rowNum}*G${rowNum}` },
        { f: `L${rowNum}+M${rowNum}` },
        { f: `N${rowNum}` },
        '', // Примечание
        item.id,
      ]
    })

    const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows])

    ws['!cols'] = [
      { wch: 8 }, { wch: 12 }, { wch: 15 }, { wch: 40 }, { wch: 25 },
      { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 22 }, { wch: 20 },
      { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 25 },
      { wch: 38, hidden: true },   // якорь: скрыт, но переносится при копировании
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'КП')

    const fileName = `КП_${selectedTender.objects?.name || 'Тендер'}_${contractorInfo.name}.xlsx`
      .replace(/[/\\?%*:|"<>]/g, '_')
    XLSX.writeFile(wb, fileName)
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file || !selectedTender) return

    setUploading(true)
    setUploadSuccess(false)

    try {
      // Читаем файл await'ом, а не через FileReader с колбэком: с колбэком
      // finally срабатывал до окончания разбора, и кнопка «Загрузить КП»
      // разблокировалась раньше, чем данные уходили в базу.
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

      await parseAndSaveProposals(jsonData)
      setUploadSuccess(true)
      // Обновляем список — чтобы сразу показать дату загрузки КП.
      await fetchTenders()
    } catch (error) {
      console.error('Ошибка загрузки КП:', error)
      alert('Не удалось загрузить КП: ' + (error.message || error))
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const parseAndSaveProposals = async (excelData) => {
    const proposalsToInsert = []

    // Как позиция файла находит позицию ВОР.
    //
    // 1) Есть скрытый столбец-якорь (ID позиции) — сопоставляем ТОЛЬКО по нему,
    //    без запасного варианта: строка без якоря в таком файле — это раздел или
    //    дописанная вручную строка, и подставлять её по номеру нельзя.
    // 2) Якоря нет (файл выгружен до его появления) — сопоставляем по «№ п/п»,
    //    но лишь когда в тендере ОДИН ВОР. Номер уникален только внутри одного
    //    документа; при нескольких ВОРах цены уезжали в чужой документ.
    const byId = new Map(estimateItems.map(it => [String(it.id), it]))
    const docNames = new Set(estimateItems.map(it => it.estimate_name || 'Основная смета'))
    const byRowNumber = new Map()
    for (const it of estimateItems) {
      if (it.is_section) continue
      const key = String(it.row_number)
      if (!byRowNumber.has(key)) byRowNumber.set(key, it)
    }
    const headerCells = (excelData[0] || []).map(c => String(c ?? '').toLowerCase())
    const anchorCol = headerCells.findIndex(h => h.includes('не изменя'))
    const canMatchByNumber = anchorCol < 0 && docNames.size <= 1
    let skippedAmbiguous = 0

    for (let i = 1; i < excelData.length; i++) {
      const row = excelData[i]
      if (!row || row.length === 0) continue

      let estimateItem = null
      if (anchorCol >= 0) {
        const rawId = String(row[anchorCol] ?? '').trim()
        if (!rawId) continue                       // раздел/посторонняя строка
        estimateItem = byId.get(rawId) || null
      } else {
        const rowNumber = parseInt(row[0])
        if (isNaN(rowNumber)) continue
        if (!canMatchByNumber) { skippedAmbiguous++; continue }
        estimateItem = byRowNumber.get(String(rowNumber)) || null
      }
      if (!estimateItem) continue
      // Раздел — заголовок группы: цена на нём удвоила бы стоимость его позиций.
      if (estimateItem.is_section) continue

      // cleanNumeric чистит пробелы/валюту/запятые — иначе текстовая ячейка «1 200,50»
      // усечётся parseFloat'ом и исказит цену.
      const unitPriceMaterials = cleanNumeric(row[8])
      const unitPriceWorks = cleanNumeric(row[9])
      const participantNote = row[15] || ''

      const workVolume = estimateItem.work_volume || 0
      const totalUnitPrice = unitPriceMaterials + unitPriceWorks
      const totalMaterials = unitPriceMaterials * workVolume
      const totalWorks = unitPriceWorks * workVolume
      const totalCost = totalMaterials + totalWorks

      proposalsToInsert.push({
        tender_id: selectedTender.id,
        counterparty_id: contractorInfo.id,
        estimate_item_id: estimateItem.id,
        unit_price_materials: unitPriceMaterials,
        unit_price_works: unitPriceWorks,
        total_unit_price: totalUnitPrice,
        total_materials: totalMaterials,
        total_works: totalWorks,
        total_cost: totalCost,
        participant_note: participantNote
      })
    }

    if (proposalsToInsert.length > 0) {
      // Удаляем старые предложения
      await supabase
        .from('tender_counterparty_proposals')
        .delete()
        .eq('tender_id', selectedTender.id)
        .eq('counterparty_id', contractorInfo.id)

      // Вставляем новые
      const { error } = await supabase
        .from('tender_counterparty_proposals')
        .insert(proposalsToInsert)

      if (error) throw error

      // Статус участия. Значение — из ENUM tender_counterparty_status
      // ('request_sent' | 'declined' | 'proposal_provided'): раньше писали
      // 'proposal_submitted', такого значения в типе нет, поэтому UPDATE молча
      // падал и у сотрудников участник навсегда оставался в «Запрос отправлен».
      const { error: statusError } = await supabase
        .from('tender_counterparties')
        .update({ status: 'proposal_provided' })
        .eq('tender_id', selectedTender.id)
        .eq('counterparty_id', contractorInfo.id)
      if (statusError) console.error('Не удалось обновить статус участия:', statusError.message)
    }

    if (skippedAmbiguous > 0) {
      alert(
        `Загружено позиций: ${proposalsToInsert.length}.
` +
        `Пропущено строк: ${skippedAmbiguous}. В тендере несколько ВОРов, а в файле нет ` +
        'служебного столбца «ID (не изменять)» — по одному номеру позиции нельзя понять, ' +
        'к какому ВОРу она относится. Скачайте шаблон заново на этой странице и заполните его: ' +
        'в нём этот столбец есть, и цены встают на свои места.'
      )
    } else if (proposalsToInsert.length === 0) {
      alert('В файле не нашлось ни одной позиции из ВОР этого тендера. Заполните шаблон, скачанный на этой странице.')
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  // Момент загрузки КП на сайт — с временем, чтобы было видно «когда именно».
  const formatDateTime = (dateString) => {
    if (!dateString) return ''
    const d = new Date(dateString)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString('ru-RU') + ', ' +
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }

  const getStatusLabel = (status) => {
    const labels = {
      'request_sent': 'Запрос отправлен',
      'proposal_provided': 'КП загружено',
      'accepted_for_work': 'Принято в работу',
      'declined': 'Отказ',
      'under_review': 'На рассмотрении',
      'winner': 'Победитель',
      'rejected': 'Отклонено'
    }
    return labels[status] || status
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  if (!isContractor) return null

  return (
    <div className="contractor-page">
      {/* Header */}
      <header className="contractor-header">
        <div className="header-left">
          <h1>Личный кабинет подрядчика</h1>
          <p className="company-name">{contractorInfo?.name}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn-secondary" onClick={() => navigate('/contractor/negotiations')}>
            Согласование договоров
          </button>
          <button className="logout-button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      <div className="contractor-content">
        {/* Список тендеров */}
        <aside className="tenders-sidebar">
          <h2>Ваши тендеры</h2>

          {loading ? (
            <div className="loading">Загрузка...</div>
          ) : tenders.length === 0 ? (
            <div className="empty">Нет активных тендеров</div>
          ) : (
            <div className="tenders-list">
              {tenders.map(tender => (
                <button
                  key={tender.id}
                  className={`tender-item ${selectedTender?.id === tender.id ? 'active' : ''}`}
                  onClick={() => handleTenderSelect(tender)}
                >
                  <div className="tender-object">{tender.objects?.name || 'Без объекта'}</div>
                  <div className="tender-desc">{tender.work_description}</div>
                  <div className="tender-meta">
                    <span className="tender-date">
                      до {formatDate(tender.tender_end_date)}
                    </span>
                    <span className={`tender-status status-${tender.participationStatus}`}>
                      {getStatusLabel(tender.participationStatus)}
                    </span>
                  </div>
                  {tender.uploadedAt && (
                    <div className="tender-uploaded" title="Когда КП загрузили на сайт">
                      КП загружено {formatDateTime(tender.uploadedAt)}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Основной контент */}
        <main className="proposal-main">
          {!selectedTender ? (
            <div className="select-tender-prompt">
              <div className="prompt-icon">📋</div>
              <h2>Выберите тендер</h2>
              <p>Выберите тендер из списка слева, чтобы загрузить коммерческое предложение</p>
            </div>
          ) : (
            <div className="proposal-content">
              <div className="tender-info-header">
                <h2>{selectedTender.objects?.name}</h2>
                <p>{selectedTender.work_description}</p>
                <div className="tender-dates">
                  <span>Срок подачи: {formatDate(selectedTender.tender_start_date)} — {formatDate(selectedTender.tender_end_date)}</span>
                  {(() => {
                    // Берём дату из списка: после загрузки список обновляется и она появляется здесь же.
                    const uploadedAt = tenders.find(t => t.id === selectedTender.id)?.uploadedAt
                    return uploadedAt
                      ? <span title="Когда КП загрузили на сайт">КП загружено: {formatDateTime(uploadedAt)}</span>
                      : null
                  })()}
                </div>
              </div>

              {uploadSuccess && (
                <div className="success-message">
                  ✅ Коммерческое предложение успешно загружено!
                </div>
              )}

              <div className="proposal-actions">
                <div className="action-card download">
                  <div className="action-icon">📥</div>
                  <h3>Шаг 1: Скачайте шаблон</h3>
                  <p>Скачайте Excel-файл со сметой тендера и заполните цены</p>
                  <button
                    className="action-button"
                    onClick={handleDownloadTemplate}
                    disabled={estimateItems.length === 0}
                  >
                    Скачать шаблон КП
                  </button>
                  {estimateItems.length === 0 && (
                    <span className="action-note">Смета ещё не добавлена</span>
                  )}
                </div>

                <div className="action-card upload">
                  <div className="action-icon">📤</div>
                  <h3>Шаг 2: Загрузите КП</h3>
                  <p>Заполните шаблон и загрузите готовое коммерческое предложение</p>
                  <label className="action-button upload-label">
                    {uploading ? 'Загрузка...' : 'Загрузить КП'}
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={handleFileUpload}
                      disabled={uploading || estimateItems.length === 0}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
              </div>

              {/* Превью сметы */}
              {estimateItems.length > 0 && (
                <div className="estimate-preview">
                  <h3>Позиции сметы ({estimateItems.length})</h3>
                  <div className="estimate-table-wrapper">
                    <table className="estimate-preview-table">
                      <thead>
                        <tr>
                          <th>№</th>
                          <th>Наименование</th>
                          <th>Ед.изм.</th>
                          <th>Объём</th>
                        </tr>
                      </thead>
                      <tbody>
                        {estimateItems.slice(0, 10).map(item => (
                          <tr key={item.id}>
                            <td>{item.row_number}</td>
                            <td>{item.cost_name}</td>
                            <td>{item.unit || '-'}</td>
                            <td>{item.work_volume || '-'}</td>
                          </tr>
                        ))}
                        {estimateItems.length > 10 && (
                          <tr>
                            <td colSpan="4" className="more-items">
                              ...и ещё {estimateItems.length - 10} позиций
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default ContractorProposalsPage
