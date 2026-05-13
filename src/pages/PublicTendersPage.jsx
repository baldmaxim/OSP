import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import '../components/Tenders.css'
import './PublicTendersPage.css'

function PublicTendersPage() {
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [department, setDepartment] = useState('all') // 'all' | 'construction' | 'warranty'
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    fetchPublicTenders()
  }, [])

  const fetchPublicTenders = async () => {
    try {
      setLoading(true)
      // Только открытые тендеры (идёт тендерная процедура), не дочерние на материалы,
      // не удалённые. Поля минимальные: гостям доступен ограниченный набор данных.
      // Сортировка по дате окончания приёма КП (по возрастанию) — самые горящие сверху.
      const { data, error: err } = await supabase
        .from('tenders')
        .select('id, public_tender_number, work_description, start_date, end_date, tender_start_date, tender_end_date, status, tender_package_link, tender_type, deleted_at, objects(name, address, map_link, status)')
        .eq('status', 'Идет тендерная процедура')
        .order('tender_end_date', { ascending: true, nullsFirst: false })

      if (err) throw err

      const filtered = (data || []).filter(t =>
        !t.deleted_at
        && (!t.tender_type || t.tender_type === 'main')
        && (t.objects?.status === 'main_construction' || t.objects?.status === 'warranty_service')
      )
      setTenders(filtered)
    } catch (err) {
      console.error('Ошибка загрузки открытых тендеров:', err.message)
      setError('Не удалось загрузить открытые тендеры. Попробуйте обновить страницу позже.')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (d) => {
    if (!d) return '—'
    try { return new Date(d).toLocaleDateString('ru-RU') } catch { return d }
  }

  const formatDateRange = (start, end) => {
    if (!start && !end) return '—'
    return `${formatDate(start)} — ${formatDate(end)}`
  }

  const visibleTenders = tenders.filter(t => {
    if (department === 'construction' && t.objects?.status !== 'main_construction') return false
    if (department === 'warranty' && t.objects?.status !== 'warranty_service') return false
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      const haystack = [
        t.objects?.name,
        t.objects?.address,
        t.work_description,
      ].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const countConst = tenders.filter(t => t.objects?.status === 'main_construction').length
  const countWar = tenders.filter(t => t.objects?.status === 'warranty_service').length

  return (
    <div className="public-tenders-page">
      <header className="public-header">
        <div className="public-header-inner">
          <div className="public-brand">
            <h1>ООО «СУ-10»</h1>
            <p className="public-subtitle">Открытые тендеры для подрядчиков</p>
          </div>
          <a href="/login" className="public-login-link">Войти →</a>
        </div>
      </header>

      <main className="public-content">
        <section className="public-intro">
          <h2>Активные тендерные процедуры</h2>
          <p>
            Ниже представлены открытые тендеры, по которым принимаются коммерческие предложения от подрядчиков.
            Для участия скачайте тендерный пакет и направьте КП через контактное лицо, указанное в документации.
          </p>
        </section>

        <div className="public-toolbar">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="🔍 Поиск по объекту, адресу или описанию работ..."
            className="public-search"
          />
          <div className="public-dept-tabs">
            <button
              className={`public-dept-tab ${department === 'all' ? 'active' : ''}`}
              onClick={() => setDepartment('all')}
            >
              Все <span className="public-dept-count">{tenders.length}</span>
            </button>
            <button
              className={`public-dept-tab ${department === 'construction' ? 'active' : ''}`}
              onClick={() => setDepartment('construction')}
            >
              Основное строительство <span className="public-dept-count">{countConst}</span>
            </button>
            <button
              className={`public-dept-tab ${department === 'warranty' ? 'active' : ''}`}
              onClick={() => setDepartment('warranty')}
            >
              Гарантийный отдел <span className="public-dept-count">{countWar}</span>
            </button>
          </div>
        </div>

        {loading && (
          <div className="public-state">Загрузка…</div>
        )}
        {error && (
          <div className="public-state public-state-error">{error}</div>
        )}
        {!loading && !error && visibleTenders.length === 0 && (
          <div className="public-state">
            Сейчас открытых тендеров нет.{searchQuery || department !== 'all' ? ' Попробуйте сбросить фильтры.' : ''}
          </div>
        )}

        {!loading && !error && visibleTenders.length > 0 && (
          <div className="public-tenders-table-wrap">
            <table className="public-tenders-table">
              <thead>
                <tr>
                  <th className="col-num">№</th>
                  <th className="col-object">Объект</th>
                  <th className="col-address">Адрес</th>
                  <th className="col-desc">Описание работ</th>
                  <th className="col-dates">Планируемые сроки<br />выполнения работ</th>
                  <th className="col-dates">Сроки приёма КП</th>
                  <th className="col-package">Тендерный пакет</th>
                </tr>
              </thead>
              <tbody>
                {visibleTenders.map(t => (
                  <tr key={t.id}>
                    <td className="col-num">
                      {t.public_tender_number ?? '—'}
                    </td>
                    <td className="col-object">
                      <div className="public-tender-object">{t.objects?.name || 'Объект не указан'}</div>
                      <span className={`public-dept-badge ${t.objects?.status === 'warranty_service' ? 'warranty' : 'construction'}`}>
                        {t.objects?.status === 'warranty_service' ? '🛡️ Гарантийный отдел' : '🏗️ Основное строительство'}
                      </span>
                    </td>
                    <td className="col-address">
                      <div className="public-tender-address">{t.objects?.address || '—'}</div>
                      {t.objects?.map_link && (
                        <a
                          href={t.objects.map_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="yandex-map-link"
                        >
                          <span aria-hidden>🗺️</span>
                          <span>На карте</span>
                        </a>
                      )}
                    </td>
                    <td className="col-desc">
                      <div className="public-tender-description">{t.work_description || '—'}</div>
                    </td>
                    <td className="col-dates">
                      {formatDateRange(t.start_date, t.end_date)}
                    </td>
                    <td className="col-dates">
                      {formatDateRange(t.tender_start_date, t.tender_end_date)}
                    </td>
                    <td className="col-package">
                      {t.tender_package_link ? (
                        <a
                          href={t.tender_package_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="public-tender-package-btn"
                        >
                          📎 Скачать
                        </a>
                      ) : (
                        <span className="public-tender-package-empty">не приложен</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <footer className="public-footer">
        <span>© ООО «СУ-10», Отдел сопровождения подрядчиков</span>
      </footer>
    </div>
  )
}

export default PublicTendersPage
