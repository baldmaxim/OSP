import { avatarTone, initialsOf } from '../../utils/taskHelpers'

// task 433: аватарка сотрудника инициалами. Фото в системе нет, поэтому цветной
// кружок с инициалами — самый компактный способ показать исполнителя на карточке.
// Тон устойчив по user_id: у сотрудника всегда один и тот же цвет.
// size: 'sm' (карточка/таблица) | 'md' (карточка задачи, колонка доски).
function UserAvatar({ userId, name, size = 'sm', title }) {
  const empty = !userId
  return (
    <span
      className={`task-avatar task-avatar-${size} ${empty ? 'is-empty' : `tone-${avatarTone(userId)}`}`}
      title={title || name || 'Не назначен'}
      aria-hidden={!title}
    >
      {empty ? '—' : initialsOf(name)}
    </span>
  )
}

export default UserAvatar
