import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import ContractClausesTab from '../components/ContractClausesTab'
import './ContractorNegotiationsPage.css'

// Кабинет подрядчика: согласование условий договора по пунктам.
// Организация контрагента берётся из user_roles (БД-истина), а не из выбора при входе —
// доступ к пунктам/спорам дополнительно ограничен строгим RLS (migration 20260815).
function ContractorNegotiationsPage() {
  const { user, contractorInfo, logout } = useRole()
  const navigate = useNavigate()

  const [counterpartyId, setCounterpartyId] = useState(null)
  const [contracts, setContracts] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 1) Организация текущего логина из user_roles (свою запись контрагент читать вправе).
  useEffect(() => {
    let cancelled = false
    async function resolveCp() {
      try {
        if (!user?.id) return
        const { data } = await supabase.from('user_roles').select('counterparty_id').eq('user_id', user.id).maybeSingle()
        if (cancelled) return
        setCounterpartyId(data?.counterparty_id || contractorInfo?.id || null)
      } catch {
        if (!cancelled) setCounterpartyId(contractorInfo?.id || null)
      }
    }
    resolveCp()
    return () => { cancelled = true }
  }, [user, contractorInfo])

  // 2) Договоры, где загружен текст для согласования (RLS отдаёт только «свои» пункты).
  const loadContracts = useCallback(async () => {
    if (!counterpartyId) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const { data: cl, error: e1 } = await supabase.from('contract_clauses').select('contract_id')
      if (e1) throw e1
      const ids = [...new Set((cl || []).map((r) => r.contract_id))]
      if (ids.length === 0) { setContracts([]); setLoading(false); return }
      const { data: cs, error: e2 } = await supabase
        .from('contracts')
        .select('id, contract_number, contract_date, objects(name), work_name')
        .in('id', ids)
        .order('created_at', { ascending: false })
      if (e2) throw e2
      setContracts(cs || [])
      setActiveId((prev) => prev || (cs && cs[0]?.id) || null)
    } catch (err) {
      console.error('Загрузка договоров подрядчика:', err)
      setError(err.message || 'Не удалось загрузить договоры.')
    } finally {
      setLoading(false)
    }
  }, [counterpartyId])

  useEffect(() => { loadContracts() }, [loadContracts])

  const activeContract = contracts.find((c) => c.id === activeId) || null

  return (
    <div className="cn-page">
      <header className="cn-header">
        <div>
          <h2>Согласование договоров</h2>
          <p className="cn-sub">{contractorInfo?.name || 'Кабинет подрядчика'}</p>
        </div>
        <div className="cn-header-actions">
          <button type="button" className="btn-secondary" onClick={() => navigate('/contractor/proposals')}>Коммерческие предложения</button>
          <button type="button" className="btn-link" onClick={logout}>Выйти</button>
        </div>
      </header>

      {loading ? (
        <div className="cn-empty">Загрузка…</div>
      ) : error ? (
        <div className="cn-error">{error}</div>
      ) : contracts.length === 0 ? (
        <div className="cn-empty">
          Пока нет договоров, отправленных на согласование. Как только представитель СУ-10 загрузит текст договора, он появится здесь.
        </div>
      ) : (
        <div className="cn-body">
          <aside className="cn-list">
            {contracts.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`cn-list-item${c.id === activeId ? ' is-active' : ''}`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="cn-list-num">{c.contract_number ? `№ ${c.contract_number}` : 'Без номера'}</span>
                <span className="cn-list-obj">{c.objects?.name || '—'}</span>
                {c.work_name && <span className="cn-list-work">{c.work_name}</span>}
              </button>
            ))}
          </aside>
          <main className="cn-main">
            {activeContract && counterpartyId ? (
              <ContractClausesTab
                key={activeContract.id}
                contractId={activeContract.id}
                contract={activeContract}
                side="contractor"
                counterpartyId={counterpartyId}
                canEdit={false}
              />
            ) : (
              <div className="cn-empty">Выберите договор слева.</div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}

export default ContractorNegotiationsPage
