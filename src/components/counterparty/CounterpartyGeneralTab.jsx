import { useMemo, useState } from 'react'
import AutoGrowTextarea from '../AutoGrowTextarea'
import CounterpartyContracts from './CounterpartyContracts'
import CounterpartySu10Org from './CounterpartySu10Org'
import CounterpartyVatSelect from './CounterpartyVatSelect'
import { VAT_NONE, vatSelectValue, vatText } from '../../utils/counterpartyVat'
import { phoneHref } from '../../utils/phoneFormat'
import { CP_LIMITED_HINT, CP_LIMITED_LABEL, cpStatusLabel } from '../../utils/counterpartyStatus'
import './CounterpartyGeneral.css'

const AFFILIATE_SEARCH_LIMIT = 8

function Field({ label, children }) {
  return (
    <div className="cpg-field">
      <div className="cpg-field-label">{label}</div>
      <div className="cpg-field-value">{children || <span className="muted-dash">—</span>}</div>
    </div>
  )
}

// Вкладка «Общая информация» карточки контрагента: реквизиты, НДС, примечание, аффилированные компании, а снизу —
// дерево «объект → договоры → ДС и заявки на ДС» (CounterpartyContracts; заявки — при праве просмотра «Заявок на ДС»).
// Аффилированные — группа связанных контрагентов (counterparty_relations, читается группами —
// utils/counterpartyGroups.js). Записи делает страница (onSave…, onAdd…, onRemove…, onContractLinkChange):
// у неё список контрагентов и журнал правок; договоры прикрепляет и открепляет само дерево.
export default function CounterpartyGeneralTab({
  counterparty,
  counterparties,
  canEdit,
  isAdmin,
  canViewContracts,
  canViewDcRequests = false,
  isPhone,
  vatSupported,
  affiliates,
  onSaveNotes,
  onSaveVat,
  onAddAffiliate,
  onRemoveAffiliate,
  onOpenCounterparty,
  onContractLinkChange,
}) {
  const [search, setSearch] = useState('')
  const cp = counterparty
  const contacts = cp.counterparty_contacts || []
  const vatValue = vatSelectValue(cp)

  const affiliateIds = useMemo(() => new Set(affiliates.map(a => a.id)), [affiliates])
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const out = []
    for (const c of counterparties) {
      if (c.id === cp.id || c.deleted_at || affiliateIds.has(c.id)) continue
      if (!((c.name || '').toLowerCase().includes(q) || (c.inn || '').includes(q))) continue
      out.push(c)
      if (out.length >= AFFILIATE_SEARCH_LIMIT) break
    }
    return out
  }, [search, counterparties, cp.id, affiliateIds])

  const handleAdd = async (other) => {
    if (await onAddAffiliate(other)) setSearch('')
  }

  return (
    <div className="cpg">
      <div className="cpg-grid">
        <section className="cpg-section">
          <h4 className="cpg-section-title">Реквизиты</h4>
          <div className="cpg-fields">
            <Field label="ИНН">{cp.inn && <span className="cpg-mono">{cp.inn}</span>}</Field>
            <Field label="КПП">{cp.kpp && <span className="cpg-mono">{cp.kpp}</span>}</Field>
            <Field label="НДС">
              {canEdit && vatSupported ? (
                <CounterpartyVatSelect counterparty={cp} onSave={onSaveVat} className="cpg-vat-select" />
              ) : vatSupported ? (
                <span className={vatValue === VAT_NONE ? 'cpg-muted' : undefined}>{vatText(cp)}</span>
              ) : (
                <span className="cpg-muted" title="Нужна миграция базы 20261026">появится после обновления базы</span>
              )}
            </Field>
            <Field label="Статус">
              <span
                className={cp.status === 'blacklist' ? 'cpg-blacklist' : cp.status === 'limited' ? 'cpg-limited' : undefined}
                title={cp.status === 'limited' ? CP_LIMITED_HINT : undefined}
              >
                {cpStatusLabel(cp.status)}
              </span>
            </Field>
            <Field label="Юридический адрес">{cp.legal_address}</Field>
            <Field label="Фактический адрес">{cp.actual_address}</Field>
            <Field label="Сайт">
              {cp.website && (
                <a href={cp.website} target="_blank" rel="noopener noreferrer" className="cpg-link">{cp.website}</a>
              )}
            </Field>
            {cp.department && <Field label="Категория работ">{cp.department}</Field>}
            <Field label="Виды работ">
              {cp.work_type && (
                <div className="cpg-tags">
                  {cp.work_type.split(',').map(s => s.trim()).filter(Boolean).map(wt => (
                    <span key={wt} className="cpg-tag">{wt}</span>
                  ))}
                </div>
              )}
            </Field>
          </div>

          {contacts.length > 0 && (
            <>
              <h4 className="cpg-section-title cpg-subtitle">Контактные лица</h4>
              <ul className="cpg-contacts">
                {contacts.map(c => (
                  <li key={c.id} className="cpg-contact">
                    <div className="cpg-contact-name">
                      {c.full_name}
                      {c.position && <span className="cpg-contact-pos">{c.position}</span>}
                    </div>
                    <div className="cpg-contact-links">
                      {(c.phone || '').split(';').map(p => p.trim()).filter(Boolean).map(p => (
                        <a key={p} href={phoneHref(p)} className="cpg-link">{p}</a>
                      ))}
                      {(c.email || '').split(';').map(m => m.trim()).filter(Boolean).map(m => (
                        <a key={m} href={`mailto:${m}`} className="cpg-link">{m}</a>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <div className="cpg-col">
          <section className="cpg-section">
            <h4 className="cpg-section-title">Примечание</h4>
            {canEdit ? (
              <AutoGrowTextarea
                key={cp.id}
                className="cpg-notes"
                defaultValue={cp.notes || ''}
                placeholder="Примечание к контрагенту…"
                minHeight={72}
                rows={3}
                onBlur={(e) => {
                  if (e.target.value.trim() !== (cp.notes || '')) onSaveNotes(e.target.value)
                }}
              />
            ) : cp.notes ? (
              <div className="cpg-notes-text">{cp.notes}</div>
            ) : (
              <div className="cpg-muted">Примечания нет.</div>
            )}
          </section>

          <section className="cpg-section">
            <h4 className="cpg-section-title">
              Аффилированные компании{affiliates.length > 0 ? ` (${affiliates.length})` : ''}
            </h4>
            <p className="cpg-hint">
              Компании группы связаны между собой: добавленная видна в карточке каждой.
            </p>
            {affiliates.length === 0 ? (
              <div className="cpg-muted">Не указаны.</div>
            ) : (
              <ul className="cpg-affiliates">
                {affiliates.map(a => (
                  <li key={a.id} className="cpg-affiliate">
                    <button type="button" className="cpg-affiliate-name" onClick={() => onOpenCounterparty(a)}
                            title="Открыть карточку компании">
                      {a.name}
                    </button>
                    {a.status === 'blacklist' && <span className="cpg-bl-badge" title="Чёрный список">ЧС</span>}
                    {a.status === 'limited' && <span className="cpg-limited-badge" title={CP_LIMITED_HINT}>{CP_LIMITED_LABEL}</span>}
                    {a.inn && <span className="cpg-affiliate-inn">ИНН {a.inn}</span>}
                    {canEdit && (
                      <button
                        type="button"
                        className="cpg-icon-btn"
                        onClick={() => onRemoveAffiliate(a)}
                        title="Исключить из группы аффилированных"
                        aria-label={`Исключить ${a.name} из аффилированных`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="cpg-affiliate-add">
                <input
                  type="text"
                  className="cpg-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Добавить: название или ИНН из реестра контрагентов"
                  aria-label="Поиск компании для добавления в аффилированные"
                />
                {search.trim() && (
                  <ul className="cpg-search-results">
                    {candidates.length === 0 ? (
                      <li className="cpg-muted cpg-search-empty">Не найдено в реестре контрагентов</li>
                    ) : candidates.map(c => (
                      <li key={c.id}>
                        <button type="button" className="cpg-search-option" onClick={() => handleAdd(c)}>
                          <span className="cpg-search-name">{c.name}</span>
                          {c.inn && <span className="cpg-search-inn">ИНН {c.inn}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Организация СУ-10: по ней подрядчик входит через СУ-10 с этим контрагентом (только администратор). */}
          {isAdmin && <CounterpartySu10Org counterpartyId={cp.id} />}
        </div>
      </div>

      {/* Объект → договоры → ДС и заявки на ДС: где контрагент работает или работал. */}
      <section className="cpg-section cpg-contracts">
        <h4 className="cpg-section-title">Объекты, договоры и ДС</h4>
        {canViewContracts || canViewDcRequests
          ? <CounterpartyContracts key={cp.id} counterpartyId={cp.id} isPhone={isPhone} canEdit={canEdit}
              isAdmin={isAdmin} canViewContracts={canViewContracts} canViewDcRequests={canViewDcRequests}
              onLinkChange={onContractLinkChange} />
          : <div className="cpg-muted">Нет доступа к разделу «Реестр по договорам».</div>}
      </section>
    </div>
  )
}
