import { IconMail, IconPhone } from './icons/ToolbarIcons'
import SoftBreaks from './SoftBreaks'
import { phoneHref } from '../utils/phoneFormat'
import './ParticipantContacts.css'

// Контакты участника тендера одной колонкой «Контакты» (29.10.2026, по просьбе пользователя:
// «контакты и email объедини, но чтобы внутри не соприкасались, перенеси направо») — раскрытая
// строка реестра тендеров и вкладка «Участники» карточки. Контакт — ФИО, должность, каждый
// телефон и каждая почта своей строкой со значком; контакты разделены чертой. Несколько
// телефонов или адресов в одном поле — через «;».
const splitList = (value) => String(value || '').split(';').map(s => s.trim()).filter(Boolean)

// compact — галочка «Свернуть всё» над таблицей: первый контакт одной строкой (ФИО и первый телефон, а без
// телефона — почта), остальные — «ещё N»; все контакты целиком — в подсказке.
function CompactContacts({ list }) {
  const first = list[0]
  const phone = splitList(first.phone)[0]
  const email = phone ? null : splitList(first.email)[0]
  const full = list.map(c => [c.full_name, c.position, c.phone, c.email].filter(Boolean).join(', ')).join('\n')
  return (
    <div className="tcc tcc-compact" title={full}>
      {first.full_name && <span className="tcc-name">{first.full_name}</span>}
      {phone && (
        <a className="tcc-line" href={phoneHref(phone)} title={`Позвонить: ${phone}`}>
          <IconPhone size={13} />
          <span className="tcc-phone">{phone}</span>
        </a>
      )}
      {email && (
        <a className="tcc-line" href={`mailto:${email}`} title={`Написать: ${email}`}>
          <IconMail size={13} />
          <span className="tcc-mail"><SoftBreaks text={email} /></span>
        </a>
      )}
      {list.length > 1 && <span className="tcc-more">ещё {list.length - 1}</span>}
    </div>
  )
}

export default function ParticipantContacts({ contacts, compact = false }) {
  const list = (contacts || []).filter(c => c && (c.full_name || c.position || c.phone || c.email))
  if (list.length === 0) return <span className="tcc-none">—</span>
  if (compact) return <CompactContacts list={list} />
  return (
    <ul className="tcc">
      {list.map((c, i) => (
        <li key={c.id || i} className="tcc-item">
          {c.full_name && <div className="tcc-name">{c.full_name}</div>}
          {c.position && <div className="tcc-pos">{c.position}</div>}
          {splitList(c.phone).map((p, pi) => (
            <a key={`p${pi}`} className="tcc-line" href={phoneHref(p)} title={`Позвонить: ${p}`}>
              <IconPhone size={13} />
              <span className="tcc-phone">{p}</span>
            </a>
          ))}
          {splitList(c.email).map((em, ei) => (
            <a key={`e${ei}`} className="tcc-line" href={`mailto:${em}`} title={`Написать: ${em}`}>
              <IconMail size={13} />
              {/* Перенос — после «@» и точек, а не посреди слова. */}
              <span className="tcc-mail"><SoftBreaks text={em} /></span>
            </a>
          ))}
        </li>
      ))}
    </ul>
  )
}
