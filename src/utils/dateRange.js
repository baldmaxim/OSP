// Срок «с … по …» коротким текстом: «10.09 — 23.09.2026»; год у начала —
// только если годы разные. Даты — строки 'YYYY-MM-DD'.

function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  return m ? { y: m[1], m: m[2], d: m[3] } : null
}

export function formatDateRange(start, end) {
  const s = parts(start)
  const e = parts(end)
  if (s && e) {
    const left = s.y === e.y ? `${s.d}.${s.m}` : `${s.d}.${s.m}.${s.y}`
    return `${left} — ${e.d}.${e.m}.${e.y}`
  }
  if (s) return `с ${s.d}.${s.m}.${s.y}`
  if (e) return `до ${e.d}.${e.m}.${e.y}`
  return ''
}
