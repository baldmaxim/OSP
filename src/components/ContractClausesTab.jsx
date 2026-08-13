import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import AutoGrowTextarea from './AutoGrowTextarea'
import { parseDocxClauses } from '../utils/docxClauses'
import './ContractClausesTab.css'

const DISPUTE_STATUS = [
  { value: 'open', label: 'Открыт' },
  { value: 'in_review', label: 'На рассмотрении' },
  { value: 'agreed', label: 'Согласовано' },
  { value: 'rejected', label: 'Отклонено' },
]

function chunks(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
function fmtDateTime(s) {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Вкладка «Согласование» (сторона сотрудника): шаблон договора по пунктам +
// протокол разногласий (наша / контрагент / итоговая редакция) + обсуждение.
function ContractClausesTab({ contractId, parties = [], canEdit }) {
  const { userProfile } = useRole()
  const authorName = userProfile?.full_name || 'Сотрудник'

  const [clauses, setClauses] = useState([])
  const [disputes, setDisputes] = useState([])
  const [commentsByDispute, setCommentsByDispute] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [importing, setImporting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [activeCpId, setActiveCpId] = useState(parties[0]?.id || null)
  const [replyDrafts, setReplyDrafts] = useState({})
  const [replyNonce, setReplyNonce] = useState({}) // bump → remount textarea, чтобы очистить после отправки
  const fileRef = useRef(null)

  useEffect(() => { if (!activeCpId && parties[0]) setActiveCpId(parties[0].id) }, [parties, activeCpId])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const { data: cl, error: e1 } = await supabase
        .from('contract_clauses').select('*').eq('contract_id', contractId).order('order_index', { ascending: true })
      if (e1) throw e1
      const { data: ds, error: e2 } = await supabase
        .from('contract_clause_disputes').select('*').eq('contract_id', contractId).order('created_at', { ascending: true })
      if (e2) throw e2
      setClauses(cl || [])
      setDisputes(ds || [])
      const ids = (ds || []).map((d) => d.id)
      if (ids.length) {
        const { data: cm } = await supabase
          .from('contract_clause_comments').select('*').in('dispute_id', ids).order('created_at', { ascending: true })
        const map = {}
        ;(cm || []).forEach((c) => { (map[c.dispute_id] = map[c.dispute_id] || []).push(c) })
        setCommentsByDispute(map)
      } else {
        setCommentsByDispute({})
      }
    } catch (err) {
      console.error('Загрузка согласования:', err)
      setLoadError(err.message || 'Ошибка загрузки. Возможно, миграция 20260815 ещё не применена.')
    } finally {
      setLoading(false)
    }
  }, [contractId])

  useEffect(() => { load() }, [load])

  const activeDisputes = useMemo(
    () => disputes.filter((d) => !activeCpId || d.counterparty_id === activeCpId),
    [disputes, activeCpId],
  )

  async function handleImport(e) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    if (clauses.length > 0 && !window.confirm('Заменить текущий текст договора новым из файла? Существующие споры протокола сохранятся.')) return
    setImporting(true)
    try {
      const buf = await file.arrayBuffer()
      const parsed = parseDocxClauses(buf)
      if (parsed.length === 0) { alert('Не удалось извлечь пункты из файла.'); return }
      // Заменяем набор пунктов: удаляем старые, вставляем новые.
      const { error: delErr } = await supabase.from('contract_clauses').delete().eq('contract_id', contractId)
      if (delErr) throw delErr
      const rows = parsed.map((c) => ({ ...c, contract_id: contractId }))
      for (const ch of chunks(rows, 200)) {
        const { error } = await supabase.from('contract_clauses').insert(ch)
        if (error) throw error
      }
      await load()
      alert(`Загружено пунктов: ${parsed.length}`)
    } catch (err) {
      console.error('Импорт .docx:', err)
      alert('Ошибка импорта: ' + (err.message || err))
    } finally {
      setImporting(false)
    }
  }

  async function addClause() {
    const order = clauses.length ? Math.max(...clauses.map((c) => c.order_index)) + 1 : 0
    const { error } = await supabase.from('contract_clauses')
      .insert({ contract_id: contractId, clause_number: '', body: '', order_index: order, level: 1 })
    if (error) return alert('Ошибка: ' + error.message)
    load()
  }
  async function saveClause(id, patch) {
    const { error } = await supabase.from('contract_clauses').update(patch).eq('id', id)
    if (error) alert('Ошибка сохранения: ' + error.message)
  }
  async function deleteClause(id) {
    if (!window.confirm('Удалить пункт?')) return
    const { error } = await supabase.from('contract_clauses').delete().eq('id', id)
    if (error) return alert('Ошибка: ' + error.message)
    setSelected((p) => { const n = new Set(p); n.delete(id); return n })
    load()
  }
  function toggleSelect(id) {
    setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function createDispute() {
    if (!activeCpId) return alert('У договора нет контрагента — протокол вести не с кем.')
    const picked = clauses.filter((c) => selected.has(c.id)).sort((a, b) => a.order_index - b.order_index)
    if (picked.length === 0) return alert('Отметьте пункт(ы) для выноса в протокол.')
    const nums = picked.map((c) => c.clause_number).filter(Boolean)
    const label = nums.length ? `п. ${nums[0]}${nums.length > 1 ? '–' + nums[nums.length - 1] : ''}` : 'Пункт'
    const ourText = picked.map((c) => `${c.clause_number ? c.clause_number + '. ' : ''}${c.body}`).join('\n\n')
    try {
      const { data, error } = await supabase.from('contract_clause_disputes')
        .insert({ contract_id: contractId, counterparty_id: activeCpId, label, our_text: ourText, created_by_side: 'employee' })
        .select('id').single()
      if (error) throw error
      const links = picked.map((c) => ({ dispute_id: data.id, clause_id: c.id }))
      await supabase.from('contract_clause_dispute_clauses').insert(links)
      setSelected(new Set())
      load()
    } catch (err) {
      alert('Ошибка создания разногласия: ' + (err.message || err))
    }
  }

  async function saveDispute(id, patch) {
    const { error } = await supabase.from('contract_clause_disputes').update(patch).eq('id', id)
    if (error) alert('Ошибка: ' + error.message)
    else setDisputes((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }
  async function deleteDispute(id) {
    if (!window.confirm('Удалить разногласие из протокола?')) return
    const { error } = await supabase.from('contract_clause_disputes').delete().eq('id', id)
    if (error) return alert('Ошибка: ' + error.message)
    load()
  }
  async function addComment(dispute) {
    const body = (replyDrafts[dispute.id] || '').trim()
    if (!body) return
    const { error } = await supabase.from('contract_clause_comments').insert({
      dispute_id: dispute.id, counterparty_id: dispute.counterparty_id,
      author_side: 'employee', author_name: authorName, body,
    })
    if (error) return alert('Ошибка: ' + error.message)
    setReplyDrafts((p) => ({ ...p, [dispute.id]: '' }))
    setReplyNonce((p) => ({ ...p, [dispute.id]: (p[dispute.id] || 0) + 1 }))
    load()
  }

  if (loading) return <div className="cct-wrap"><div className="cct-empty">Загрузка…</div></div>
  if (loadError) return <div className="cct-wrap"><div className="cct-error">{loadError}</div></div>

  return (
    <div className="cct-wrap">
      {/* Тулбар */}
      <div className="cct-toolbar">
        <div className="cct-toolbar-left">
          {canEdit && (
            <>
              <label className={`btn-primary cct-file${importing ? ' is-disabled' : ''}`}>
                {importing ? 'Загрузка…' : (clauses.length ? 'Заменить шаблон (.docx)' : 'Загрузить шаблон (.docx)')}
                <input ref={fileRef} type="file" accept=".docx" hidden disabled={importing} onChange={handleImport} />
              </label>
              <button type="button" className="btn-secondary" onClick={addClause}>+ Пункт</button>
            </>
          )}
        </div>
        {parties.length > 1 && (
          <div className="cct-party-pick">
            <span>Протокол с:</span>
            <select value={activeCpId || ''} onChange={(e) => setActiveCpId(e.target.value)}>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Текст договора по пунктам */}
      <section className="cct-section">
        <h3>Текст договора {clauses.length > 0 && <span className="cct-count">{clauses.length} пунктов</span>}</h3>
        {clauses.length === 0 ? (
          <div className="cct-empty">
            Загрузите шаблон договора из .docx — он разобьётся на пункты, которые можно обсуждать.
          </div>
        ) : (
          <>
            {canEdit && selected.size > 0 && (
              <div className="cct-selbar">
                Выбрано пунктов: {selected.size}
                <button type="button" className="btn-primary" onClick={createDispute}>Вынести в протокол разногласий</button>
                <button type="button" className="btn-link" onClick={() => setSelected(new Set())}>Сбросить</button>
              </div>
            )}
            <div className="cct-clauses">
              {clauses.map((c) => (
                <div key={c.id} className={`cct-clause${c.is_heading ? ' is-heading' : ''}`} style={{ marginLeft: `${(c.level - 1) * 1.25}rem` }}>
                  {canEdit && !c.is_heading && (
                    <input type="checkbox" className="cct-clause-cb" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} />
                  )}
                  <span className="cct-clause-num">{c.clause_number}</span>
                  {canEdit ? (
                    <AutoGrowTextarea
                      className="cct-clause-body"
                      minHeight={36}
                      defaultValue={c.body}
                      onBlur={(e) => e.target.value !== c.body && saveClause(c.id, { body: e.target.value })}
                    />
                  ) : (
                    <div className="cct-clause-body ro">{c.body}</div>
                  )}
                  {canEdit && (
                    <button type="button" className="cct-clause-del" title="Удалить пункт" onClick={() => deleteClause(c.id)}>×</button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Протокол разногласий */}
      <section className="cct-section">
        <h3>Протокол разногласий {activeDisputes.length > 0 && <span className="cct-count">{activeDisputes.length}</span>}</h3>
        {activeDisputes.length === 0 ? (
          <div className="cct-empty">Разногласий пока нет. Контрагент вносит пункты на обсуждение из своего кабинета, либо отметьте пункты выше и вынесите сами.</div>
        ) : (
          <div className="cct-disputes">
            {activeDisputes.map((d) => (
              <div key={d.id} className="cct-dispute">
                <div className="cct-dispute-head">
                  <span className="cct-dispute-label">{d.label || 'Пункт'}</span>
                  <select className="cct-status" value={d.status} disabled={!canEdit} onChange={(e) => saveDispute(d.id, { status: e.target.value })}>
                    {DISPUTE_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  {canEdit && <button type="button" className="cct-clause-del" title="Удалить" onClick={() => deleteDispute(d.id)}>×</button>}
                </div>
                <div className="cct-editions">
                  <div className="cct-ed">
                    <div className="cct-ed-label">Наша редакция</div>
                    <div className="cct-ed-text ro">{d.our_text || '—'}</div>
                  </div>
                  <div className="cct-ed">
                    <div className="cct-ed-label">Редакция контрагента</div>
                    <div className="cct-ed-text ro">{d.counterparty_text || '—'}</div>
                  </div>
                  <div className="cct-ed">
                    <div className="cct-ed-label">Итоговая редакция</div>
                    {canEdit ? (
                      <AutoGrowTextarea className="cct-ed-text" minHeight={60} defaultValue={d.final_text}
                        onBlur={(e) => e.target.value !== d.final_text && saveDispute(d.id, { final_text: e.target.value })} />
                    ) : (
                      <div className="cct-ed-text ro">{d.final_text || '—'}</div>
                    )}
                  </div>
                </div>
                {/* Обсуждение */}
                <div className="cct-thread">
                  {(commentsByDispute[d.id] || []).map((c) => (
                    <div key={c.id} className={`cct-msg cct-msg-${c.author_side}`}>
                      <div className="cct-msg-meta">
                        <span className="cct-msg-author">{c.author_side === 'employee' ? (c.author_name || 'Сотрудник') : (c.author_name || 'Контрагент')}</span>
                        <span className="cct-msg-date">{fmtDateTime(c.created_at)}</span>
                      </div>
                      <div className="cct-msg-body">{c.body}</div>
                    </div>
                  ))}
                  <div className="cct-reply">
                    <AutoGrowTextarea key={`r-${d.id}-${replyNonce[d.id] || 0}`} className="cct-reply-input" minHeight={36}
                      defaultValue={replyDrafts[d.id] || ''}
                      onInput={(e) => setReplyDrafts((p) => ({ ...p, [d.id]: e.target.value }))}
                      placeholder="Ответить в обсуждении…" />
                    <button type="button" className="btn-secondary" onClick={() => addComment(d)}>Отправить</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default ContractClausesTab
