import { IconMail, IconPhone } from './icons/ToolbarIcons'
import SoftBreaks from './SoftBreaks'
import { copyWithToast } from './CopyToast'
import { phoneHref } from '../utils/phoneFormat'
import './ParticipantContacts.css'

// Контакты участника тендера одной колонкой «Контакты» (29.10.2026, по просьбе пользователя:
// «контакты и email объедини, но чтобы внутри не соприкасались, перенеси направо») — раскрытая
// строка реестра тендеров и вкладка «Участники» карточки. Контакт — ФИО, должность, каждый
// телефон и каждая почта своей строкой со значком; контакты разделены чертой. Несколько
// телефонов или адресов в одном поле — через «;».
//
// 30.10.2026 (по просьбе пользователя): нажатие на телефон или почту копирует их, внизу — плашка
// «Номер скопирован» / «Email скопирован» (CopyToast); в свёрнутом виде видна и почта.
const splitList = (value) => String(value || '').split(';').map(s => s.trim()).filter(Boolean)

// Телефон или почта: нажатие копирует. Ссылка tel: / mailto: остаётся — с Ctrl, Shift или колёсиком
// мыши и долгим нажатием на телефоне по-прежнему можно позвонить или написать.
function CopyLine({ kind, value }) {
  const phone = kind === 'phone'
  const handleClick = (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    copyWithToast(value, phone ? 'Номер скопирован' : 'Email скопирован')
  }
  return (
    <a
      className="tcc-line"
      href={phone ? phoneHref(value) : `mailto:${value}`}
      title={`Скопировать ${phone ? 'номер' : 'email'}: ${value}`}
      onClick={handleClick}
    >
      {phone ? <IconPhone size={13} /> : <IconMail size={13} />}
      {phone
        ? <span className="tcc-phone">{value}</span>
        // Перенос — после «@» и точек, а не посреди слова.
        : <span className="tcc-mail"><SoftBreaks text={value} /></span>}
    </a>
  )
}

// compact — галочка «Свернуть всё» над таблицей: первый контакт одной строкой (ФИО, первый телефон и
// почта; у первого контакта почты нет — первая почта остальных), остальные — «ещё N»; все контакты
// целиком — в подсказке.
function CompactContacts({ list }) {
  const first = list[0]
  const phone = splitList(first.phone)[0]
  const email = splitList(first.email)[0] || list.map(c => splitList(c.email)[0]).find(Boolean)
  const full = list.map(c => [c.full_name, c.position, c.phone, c.email].filter(Boolean).join(', ')).join('\n')
  return (
    <div className="tcc tcc-compact" title={full}>
      {first.full_name && <span className="tcc-name">{first.full_name}</span>}
      {phone && <CopyLine kind="phone" value={phone} />}
      {email && <CopyLine kind="email" value={email} />}
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
          {splitList(c.phone).map((p, pi) => <CopyLine key={`p${pi}`} kind="phone" value={p} />)}
          {splitList(c.email).map((em, ei) => <CopyLine key={`e${ei}`} kind="email" value={em} />)}
        </li>
      ))}
    </ul>
  )
}
