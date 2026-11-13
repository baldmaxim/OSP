// История сметы КП / ПЗ (kp_estimate_log): запись → строки для человека. Модуль чистый — tests/tender/kp-estimate.test.mjs.
import { FILL_COLORS, fmtQty } from './kpEstimate.js'

const MARK_FIELDS = {
  note: 'Примечание',
  fill: 'Заливка строки',
  cell_fills: 'Заливка ячеек',
  actual_qty: 'Актуальный объём',
  actual_reason: 'Причина изменения объёма',
  responsible_name: 'Ответственный', // до 13.11.2026 — в старых записях истории
}
const ALLOC_FIELDS = {
  tender_label: 'Тендер',
  pz_qty: 'Объём',
  counterparty_name: 'Подрядчик',
  contract_label: 'Договор', // до 13.11.2026: договор и закреплённый объём — в старых записях истории
  contract_qty: 'Закреплённый объём',
  note: 'Примечание',
}
const QTY = new Set(['actual_qty', 'pz_qty', 'contract_qty'])
const colorName = (c) => FILL_COLORS.find((x) => x.key === c)?.label.toLowerCase() || c

function show(key, v) {
  if (v === null || v === undefined || v === '') return '—'
  if (QTY.has(key)) return fmtQty(v)
  if (key === 'fill') return colorName(v)
  if (key === 'cell_fills') {
    const n = Object.keys(v || {}).length
    return n ? `${n} ${n === 1 ? 'ячейка' : n < 5 ? 'ячейки' : 'ячеек'}` : 'нет'
  }
  const s = String(v)
  return s.length > 160 ? `«${s.slice(0, 160)}…»` : `«${s}»`
}

// { title, lines: [строки] }
export function describeLogEntry(e) {
  const ch = e?.changes || {}
  if (e.entity === 'estimate') {
    const lines = []
    if (ch.kp_file || ch.pz_file) lines.push([ch.kp_file && `КП: ${ch.kp_file}`, ch.pz_file && `ПЗ: ${ch.pz_file}`].filter(Boolean).join(' · '))
    if (ch.rows) lines.push(`Строк: ${ch.rows}`)
    if (ch.previous_id) {
      lines.push(`Перенесено с прежней версии: отметок ${ch.moved_marks || 0}, распределений ${ch.moved_allocations || 0}`)
      if (ch.left_marks || ch.left_allocations) lines.push(`Остались у прежней версии (позиций нет в новом файле): отметок ${ch.left_marks || 0}, распределений ${ch.left_allocations || 0}`)
    }
    return { title: `Загружена версия${ch.title ? ` «${ch.title}»` : ''}`, lines }
  }
  if (e.entity === 'allocation') {
    const a = ch._allocation || {}
    const who = [a.tender && `тендер ${a.tender}`, a.counterparty && `подрядчик ${a.counterparty}`].filter(Boolean).join(', ')
    if (e.action === 'insert' || e.action === 'delete') {
      const parts = []
      for (const [key, label] of Object.entries(ALLOC_FIELDS)) {
        const c = ch[key]
        const v = e.action === 'insert' ? c?.new : c?.old
        if (v !== null && v !== undefined && v !== '' && !(QTY.has(key) && Number(v) === 0)) parts.push(`${label}: ${show(key, v)}`)
      }
      return { title: e.action === 'insert' ? 'Распределение добавлено' : 'Распределение удалено', lines: parts }
    }
    const lines = Object.entries(ALLOC_FIELDS).filter(([key]) => ch[key]).map(([key, label]) => `${label}: ${show(key, ch[key].old)} → ${show(key, ch[key].new)}`)
    return { title: `Распределение изменено${who ? ` (${who})` : ''}`, lines }
  }
  const lines = Object.entries(MARK_FIELDS).filter(([key]) => ch[key]).map(([key, label]) => `${label}: ${show(key, ch[key].old)} → ${show(key, ch[key].new)}`)
  return { title: 'Отметки позиции', lines }
}

export function fmtLogTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}
