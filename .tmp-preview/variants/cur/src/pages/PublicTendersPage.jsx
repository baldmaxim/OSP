import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import '../components/Tenders.css'
import './PublicTendersPage.css'

const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
]

// task 195: «15 июня» — без года
const formatShortDate = (d) => {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return `${dt.getDate()} ${MONTHS_RU[dt.getMonth()]}`
  } catch { return d }
}

const formatShortRange = (start, end) => {
  if (!start && !end) return '—'
  if (start && end) return `${formatShortDate(start)} — ${formatShortDate(end)}`
  return formatShortDate(start || end)
}

function PublicTendersPage() {
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    fetchPublicTenders()
  }, [])

  const fetchPublicTenders = async () => {
    try {
      setLoading(true)
      const { data, error: err } = await supabase
        .from('tenders')
        .select('id, public_tender_number, work_description, start_date, end_date, tender_start_date, tender_end_date, status, tender_package_link, tender_type, deleted_at, objects(name, address, map_link, status)')
        .eq('status', 'Идет тендерная процедура')
        .order('tender_end_date', { ascending: true, nullsFirst: false })

      if (err) throw err

      // task 195: убираем разделение по отделам — оставляем оба статуса в едином списке
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

  const visibleTenders = tenders.filter(t => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return true
    const haystack = [
      t.objects?.name,
      t.objects?.address,
      t.work_description,
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(q)
  })

  return (
    <div className="public-tenders-page">
      <header className="public-header">
        <div className="public-header-inner">
          <div className="public-brand">
            <h1>ООО «СУ-10»</h1>
            <p className="public-subtitle">Открытые тендеры для подрядчиков</p>
          </div>
          <a href="/partner" className="public-login-link">Войти →</a>
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
          <div className="public-total-count">Всего: {tenders.length}</div>
        </div>

        {loading && (
          <div className="public-state">Загрузка…</div>
        )}
        {error && (
          <div className="public-state public-state-error">{error}</div>
        )}
        {!loading && !error && visibleTenders.length === 0 && (
          <div className="public-state">
            Сейчас открытых тендеров нет.{searchQuery ? ' Попробуйте сбросить поиск.' : ''}
          </div>
        )}

        {!loading && !error && visibleTenders.length > 0 && (
          <div className="public-tenders-table-wrap">
            <table className="public-tenders-table">
              <thead>
                <tr>
                  <th className="col-num">№</th>
                  <th className="col-object">Объект</th>
                  <th className="col-desc">Описание работ</th>
                  <th className="col-dates">Сроки выполнения работ</th>
                  <th className="col-dates">Приём КП</th>
                  <th className="col-package">Тендерный пакет</th>
                </tr>
              </thead>
              <tbody>
                {visibleTenders.map(t => (
                  <tr key={t.id}>
                    <td className="col-num" data-label="№">
                      {t.public_tender_number ?? '—'}
                    </td>
                    <td className="col-object" data-label="Объект">
                      <div className="public-tender-object">{t.objects?.name || 'Объект не указан'}</div>
                      {/* task 195: адрес как гиперссылка на карту вместо отдельного столбца */}
                      {t.objects?.address && (
                        t.objects?.map_link ? (
                          <a
                            href={t.objects.map_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="public-tender-address-link"
                            title="Открыть в Яндекс.Картах"
                          >
                            <span aria-hidden>📍</span> {t.objects.address}
                          </a>
                        ) : (
                          <div className="public-tender-address">{t.objects.address}</div>
                        )
                      )}
                    </td>
                    <td className="col-desc" data-label="Описание работ">
                      <div className="public-tender-description">{t.work_description || '—'}</div>
                    </td>
                    <td className="col-dates" data-label="Сроки выполнения работ">
                      {formatShortRange(t.start_date, t.end_date)}
                    </td>
                    <td className="col-dates" data-label="Приём КП">
                      {t.tender_end_date ? `до ${formatShortDate(t.tender_end_date)}` : '—'}
                    </td>
                    <td className="col-package" data-label="Тендерный пакет">
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
