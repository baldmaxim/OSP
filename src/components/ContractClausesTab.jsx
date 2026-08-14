import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import AutoGrowTextarea from './AutoGrowTextarea'
import { uploadFile, fetchDocuments, deleteDocument } from '../services/s3'
import './ContractClausesTab.css'

// docx-preview крупный — грузим лениво, только когда открыта вкладка «Согласование».
const DocxPreview = lazy(() => import('./DocxPreview'))

const TEMPLATE_CATEGORY = 'negotiation_template'

const DISPUTE_STATUS = [
  { value: 'open', label: 'Открыт' },
  { value: 'in_review', label: 'На рассмотрении' },
  { value: 'agreed', label: 'Согласовано' },
  { value: 'rejected', label: 'Отклонено' },
]
const STATUS_LABEL = Object.fromEntries(DISPUTE_STATUS.map((s) => [s.value, s.label]))

function fmtDateTime(s) {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Согласование условий договора: Word-предпросмотр текста + протокол разногласий
// (наша / контрагент / итоговая редакция) + обсуждение.
// side='employee' — СУ-10 (грузит шаблон, правит итоговую редакцию/статус).
// side='contractor' — кабинет подрядчика (читает договор, вносит свою редакцию + комментарии).
function ContractClausesTab({ contractId, parties = [], canEdit, side = 'employee', counterpartyId = null }) {
  const { userProfile, contractorInfo } = useRole()
  const isEmployee = side === 'employee'
  const authorName = isEmployee ? (userProfile?.full_name || 'Сотрудник') : (contractorInfo?.name || userProfile?.full_name || 'Контрагент')

  const [templateDoc, setTemplateDoc] = useState(null)
  const [disputes, setDisputes] = useState([])
  const [commentsByDispute, setCommentsByDispute] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [importing, setImporting] = useState(false)
  const [activeCpId, setActiveCpId] = useState(isEmployee ? (parties[0]?.id || null) : counterpartyId)
  const [replyDrafts, setReplyDrafts] = useState({})
  const [replyNonce, setReplyNonce] = useState({})
  const fileRef = useRef(null)
  const previewRef = useRef(null) // контейнер docx-preview — читаем из него выделение

  useEffect(() => {
    if (!isEmployee) { setActiveCpId(counterpartyId); return }
    if (!activeCpId && parties[0]) setActiveCpId(parties[0].id)
  }, [parties, activeCpId, isEmployee, counterpartyId])

  const canUpload = isEmployee && canEdit           // грузить/заменять шаблон
  const canCreateDispute = isEmployee ? !!canEdit : true
  const canEditFinal = isEmployee && canEdit        // итоговая редакция + статус
  const canEditOwnEdition = !isEmployee             // подрядчик правит свою редакцию

  const loadTemplate = useCallback(async () => {
    try {
      const docs = await fetchDocuments('contract', contractId, TEMPLATE_CATEGORY)
      setTemplateDoc(docs[0] || null) // fetchDocuments сортирует created_at desc → [0] новейший
    } catch (err) {
      console.error('Загрузка шаблона согласования:', err)
    }
  }, [contractId])

  const loadDisputes = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      let dq = supabase.from('contract_clause_disputes').select('*').eq('contract_id', contractId)
      if (!isEmployee && counterpartyId) dq = dq.eq('counterparty_id', counterpartyId)
      const { data: ds, error } = await dq.order('created_at', { ascending: true })
      if (error) throw error
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
      console.error('Загрузка протокола:', err)
      setLoadError(err.message || 'Ошибка загрузки. Возможно, миграция 20260815 ещё не применена.')
    } finally {
      setLoading(false)
    }
  }, [contractId, isEmployee, counterpartyId])

  useEffect(() => { loadTemplate(); loadDisputes() }, [loadTemplate, loadDisputes])

  const activeDisputes = useMemo(
    () => disputes.filter((d) => !activeCpId || d.counterparty_id === activeCpId),
    [disputes, activeCpId],
  )

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    if (/\.doc$/i.test(file.name)) {
      alert('Формат .doc не поддерживается. Откройте файл в Word и сохраните как .docx (Файл → Сохранить как → Документ Word .docx), затем загрузите его.')
      return
    }
    if (!/\.docx$/i.test(file.name)) { alert('Нужен файл .docx.'); return }
    if (templateDoc && !window.confirm('Заменить текущий шаблон договора? Существующие разногласия протокола сохранятся.')) return
    setImporting(true)
    try {
      // Убираем прежние шаблоны, чтобы всегда был ровно один актуальный.
      const old = await fetchDocuments('contract', contractId, TEMPLATE_CATEGORY)
      for (const d of old) { try { await deleteDocument(d) } catch { /* лучшее усилие */ } }
      await uploadFile({ file, ownerType: 'contract', ownerId: contractId, category: TEMPLATE_CATEGORY })
      await loadTemplate()
    } catch (err) {
      console.error('Загрузка шаблона:', err)
      alert('Ошибка загрузки шаблона: ' + (err.message || err))
    } finally {
      setImporting(false)
    }
  }

  // Текст выделения — только если оно внутри предпросмотра договора.
  function getSelectionText() {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return ''
    const c = previewRef.current
    if (c && (!c.contains(sel.anchorNode) || !c.contains(sel.focusNode))) return ''
    return sel.toString().trim()
  }

  async function createDisputeFromSelection() {
    if (!activeCpId) return alert('У договора нет контрагента — протокол вести не с кем.')
    const text = getSelectionText()
    if (!text) return alert('Сначала выделите мышью нужный фрагмент договора в предпросмотре.')
    const numMatch = text.match(/^\s*(\d+(?:\.\d+)*)/)
    const label = numMatch ? `п. ${numMatch[1]}` : (text.slice(0, 40) + (text.length > 40 ? '…' : ''))
    try {
      const { error } = await supabase.from('contract_clause_disputes')
        .insert({ contract_id: contractId, counterparty_id: activeCpId, label, our_text: text, created_by_side: side })
      if (error) throw error
      window.getSelection()?.removeAllRanges()
      loadDisputes()
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
    loadDisputes()
  }
  async function addComment(dispute) {
    const body = (replyDrafts[dispute.id] || '').trim()
    if (!body) return
    const { error } = await supabase.from('contract_clause_comments').insert({
      dispute_id: dispute.id, counterparty_id: dispute.counterparty_id,
      author_side: side, author_name: authorName, body,
    })
    if (error) return alert('Ошибка: ' + error.message)
    setReplyDrafts((p) => ({ ...p, [dispute.id]: '' }))
    setReplyNonce((p) => ({ ...p, [dispute.id]: (p[dispute.id] || 0) + 1 }))
    loadDisputes()
  }

  return (
    <div className="cct-wrap">
      {/* Тулбар */}
      <div className="cct-toolbar">
        <div className="cct-toolbar-left">
          {canUpload && (
            <label className={`btn-primary cct-file${importing ? ' is-disabled' : ''}`}>
              {importing ? 'Загрузка…' : (templateDoc ? 'Заменить шаблон (.docx)' : 'Загрузить шаблон (.docx)')}
              <input ref={fileRef} type="file" accept=".docx" hidden disabled={importing} onChange={handleUpload} />
            </label>
          )}
          {templateDoc && canCreateDispute && (
            <button type="button" className="btn-secondary" onClick={createDisputeFromSelection}>
              Вынести выделенное в протокол
            </button>
          )}
        </div>
        {isEmployee && parties.length > 1 && (
          <div className="cct-party-pick">
            <span>Протокол с:</span>
            <select value={activeCpId || ''} onChange={(e) => setActiveCpId(e.target.value)}>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Текст договора — предпросмотр как в Word */}
      <section className="cct-section">
        <h3>Текст договора</h3>
        {!templateDoc ? (
          <div className="cct-empty">
            {isEmployee
              ? 'Загрузите шаблон договора (.docx) — он отобразится как в Word, и можно будет выделять пункты для протокола.'
              : 'Текст договора пока не загружен представителем СУ-10.'}
          </div>
        ) : (
          <>
            {templateDoc && canCreateDispute && (
              <p className="cct-preview-hint">
                Выделите нужный пункт (или несколько) мышью и нажмите «Вынести выделенное в протокол».
                {activeDisputes.length > 0 && <span className="cct-hint-legend"> Пункты в протоколе подсвечены <span className="cct-hint-swatch" />.</span>}
              </p>
            )}
            <Suspense fallback={<div className="cct-empty">Загрузка предпросмотра…</div>}>
              <DocxPreview
                s3Key={templateDoc.s3_key}
                containerRef={previewRef}
                highlights={activeDisputes.map((d) => d.our_text)}
              />
            </Suspense>
          </>
        )}
      </section>

      {/* Протокол разногласий */}
      <section className="cct-section">
        <h3>Протокол разногласий {activeDisputes.length > 0 && <span className="cct-count">{activeDisputes.length}</span>}</h3>
        {loadError ? (
          <div className="cct-error">{loadError}</div>
        ) : loading ? (
          <div className="cct-empty">Загрузка…</div>
        ) : activeDisputes.length === 0 ? (
          <div className="cct-empty">
            {isEmployee
              ? 'Разногласий пока нет. Контрагент вносит пункты из своего кабинета, либо выделите текст выше и вынесите сами.'
              : 'Разногласий пока нет. Выделите пункт в договоре и нажмите «Вынести выделенное в протокол», чтобы предложить свою редакцию.'}
          </div>
        ) : (
          <div className="cct-disputes">
            {activeDisputes.map((d) => (
              <div key={d.id} className="cct-dispute">
                <div className="cct-dispute-head">
                  <span className="cct-dispute-label">{d.label || 'Пункт'}</span>
                  {canEditFinal ? (
                    <select className="cct-status" value={d.status} onChange={(e) => saveDispute(d.id, { status: e.target.value })}>
                      {DISPUTE_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  ) : (
                    <span className="cct-status-ro">{STATUS_LABEL[d.status] || d.status}</span>
                  )}
                  {canEditFinal && <button type="button" className="cct-clause-del" title="Удалить" onClick={() => deleteDispute(d.id)}>×</button>}
                </div>
                <div className="cct-editions">
                  <div className="cct-ed">
                    <div className="cct-ed-label">Наша редакция</div>
                    <div className="cct-ed-text ro">{d.our_text || '—'}</div>
                  </div>
                  <div className="cct-ed">
                    <div className="cct-ed-label">Редакция контрагента</div>
                    {canEditOwnEdition ? (
                      <AutoGrowTextarea className="cct-ed-text" minHeight={60} defaultValue={d.counterparty_text}
                        placeholder="Ваша предлагаемая формулировка пункта…"
                        onBlur={(e) => e.target.value !== d.counterparty_text && saveDispute(d.id, { counterparty_text: e.target.value })} />
                    ) : (
                      <div className="cct-ed-text ro">{d.counterparty_text || '—'}</div>
                    )}
                  </div>
                  <div className="cct-ed">
                    <div className="cct-ed-label">Итоговая редакция</div>
                    {canEditFinal ? (
                      <AutoGrowTextarea className="cct-ed-text" minHeight={60} defaultValue={d.final_text}
                        onBlur={(e) => e.target.value !== d.final_text && saveDispute(d.id, { final_text: e.target.value })} />
                    ) : (
                      <div className="cct-ed-text ro">{d.final_text || '—'}</div>
                    )}
                  </div>
                </div>
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
