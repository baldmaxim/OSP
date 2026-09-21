// Круглый аватар с инициалами. Цвет фона детерминированно выводится из имени/почты,
// чтобы разных людей было легче различать, но палитра приглушённая (не пёстрая).
const AVATAR_TONES = ['adm-ava-a', 'adm-ava-b', 'adm-ava-c', 'adm-ava-d', 'adm-ava-e', 'adm-ava-f']

function initials(name, email) {
  const n = (name || '').trim()
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return parts[0].slice(0, 2).toUpperCase()
  }
  const e = (email || '').trim()
  return e ? e.slice(0, 2).toUpperCase() : '—'
}

function toneFor(seed) {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]
}

export default function UserAvatar({ name, email }) {
  return (
    <span className={`adm-ava ${toneFor(name || email)}`} aria-hidden>
      {initials(name, email)}
    </span>
  )
}
