import { useState, useEffect, useMemo } from 'react'
import { db } from '../api'
import {
  TENDER_MAILBOX, formatShortDate, formatShortRange, safeHttpUrl, phoneHref, mailHref, normalizeSearch, searchText,
} from '../utils/publicTenders'
import './PublicTendersPage.css'

// Гость читает ТОЛЬКО представление public_open_tenders: в нём одни публичные поля и уже применён
// отбор открытых основных тендеров (миграция 20261016), ответственный — только ФИО и телефон
// (20261101). Из таблиц tenders, objects и contacts гостю ничего не отдаётся.
const BASE_COLUMNS = 'id, public_tender_number, work_description, start_date, end_date, tender_end_date, tender_package_link, object_name, object_address, object_map_link'
const CONTACT_COLUMNS = 'responsible_name, responsible_phone'

const selectOpen = (columns) => db
  .from('public_open_tenders')
  .select(columns)
  .order('tender_end_date', { ascending: true, nullsFirst: false })

async function loadPublicTenders() {
  let { data, error } = await selectOpen(`${BASE_COLUMNS}, ${CONTACT_COLUMNS}`)
  // Сайт выложен раньше миграции 20261101: колонок ответственного ещё нет — список без них
  // (в контактах остаётся общая почта).
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    ({ data, error } = await selectOpen(BASE_COLUMNS))
  }
  if (error) throw error
  return (data || []).map((t) => ({
    ...t,
    packageUrl: safeHttpUrl(t.tender_package_link),
    mapUrl: safeHttpUrl(t.object_map_link),
    phoneUrl: phoneHref(t.responsible_phone),
    search: searchText(t),
  }))
}

function PinIcon() {
  return (
    <svg className="public-tender-address-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3.2 4.5 8.5 4.5 8.5s4.5-5.3 4.5-8.5A4.5 4.5 0 0 0 8 1.5Zm0 6.25A1.75 1.75 0 1 1 8 4.25a1.75 1.75 0 0 1 0 3.5Z" fill="currentColor" />
    </svg>
  )
}

function TenderContacts({ tender }) {
  const name = tender.responsible_name
  const phone = tender.responsible_phone
  return (
    <>
      {name && <div className="public-contact-name">{name}</div>}
      <div className="public-contact-block">
        {phone && (tender.phoneUrl
          ? <a href={tender.phoneUrl} className="public-contact-line public-contact-phone">{phone}</a>
          : <span className="public-contact-line public-contact-phone">{phone}</span>)}
        <a href={mailHref(tender)} className="public-contact-line public-contact-mail">{TENDER_MAILBOX}</a>
      </div>
    </>
  )
}

function PublicTendersPage() {
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    let alive = true
    loadPublicTenders()
      .then((rows) => { if (alive) setTenders(rows) })
      .catch((err) => {
        console.error('Ошибка загрузки открытых тендеров:', err?.message || err)
        if (alive) setError('Не удалось загрузить открытые тендеры. Попробуйте обновить страницу позже.')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const visibleTenders = useMemo(() => {
    const q = normalizeSearch(searchQuery)
    return q ? tenders.filter((t) => t.search.includes(q)) : tenders
  }, [tenders, searchQuery])

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
            Для участия скачайте тендерный пакет. Вопросы по тендеру — ответственному по телефону или на почту{' '}
            <a href={`mailto:${TENDER_MAILBOX}`} className="public-intro-mail">{TENDER_MAILBOX}</a>; в теме письма
            укажите номер тендера и объект.
          </p>
        </section>

        <div className="public-toolbar">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по номеру, объекту, адресу или описанию работ"
            aria-label="Поиск тендеров"
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
            {searchQuery.trim() ? 'По запросу ничего не найдено. Попробуйте сбросить поиск.' : 'Сейчас открытых тендеров нет.'}
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
                  <th className="col-contact">Контакты</th>
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
                      <div className="public-tender-object">{t.object_name || 'Объект не указан'}</div>
                      {/* task 195: адрес как гиперссылка на карту вместо отдельного столбца */}
                      {t.object_address && (
                        t.mapUrl ? (
                          <a
                            href={t.mapUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="public-tender-address-link"
                            title="Открыть на карте"
                          >
                            <PinIcon />
                            <span>{t.object_address}</span>
                          </a>
                        ) : (
                          <div className="public-tender-address">{t.object_address}</div>
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
                    <td className="col-contact" data-label="Контакты">
                      <TenderContacts tender={t} />
                    </td>
                    <td className="col-package" data-label="Тендерный пакет">
                      {t.packageUrl ? (
                        <a
                          href={t.packageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="public-tender-package-btn"
                          aria-label={`Скачать тендерный пакет${t.public_tender_number != null ? ` тендера № ${t.public_tender_number}` : ''}`}
                        >
                          Скачать
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
