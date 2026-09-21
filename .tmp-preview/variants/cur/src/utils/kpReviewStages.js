// Этапы (стадии) проверки КП: прямое определение этапа по записи и обратная
// таблица «этап → поля». Лежат рядом намеренно: разъедутся — вкладки начнут
// показывать не тот этап, который выставили руками.
//
// Этап не хранится отдельным полем, он выводится из четырёх:
// review_status, remarks_send_required, summary_added, remarks_sent.
//
// После вердикта аналитика путь расходится, и занесение в сводную таблицу есть в
// каждой ветке — но это разные очереди работы, поэтому и этапы разные
// (миграции 20260824, 20260826):
//
//   pending           — на проверке, ждёт аналитика (общее начало всех веток)
//
//   ветка «без замечаний»:
//   ok_summary        — вердикт «нет замечаний», в сводную ещё не внесено
//   ok_done           — внесено, работа по КП закончена
//
//   ветка «с замечаниями» → подветка «для отправки подрядчику»:
//   remarks_work      — общая очередь на две ПАРАЛЛЕЛЬНЫЕ задачи инженера:
//                       занести в сводную и отправить замечания подрядчику.
//                       Порядок не важен, этап закрыт, когда сделано и то, и то
//   remarks_sent      — обе задачи выполнены, работа по КП закончена
//
//   ветка «с замечаниями» → подветка «без отправки подрядчику»:
//   nosend_summary    — в сводную ещё не внесено
//   nosend_done       — внесено, работа по КП закончена (отправки нет)
//
// remarks_send_required читаем строго через === false: у КП, проверенных до
// миграции 20260826, поля нет, и они должны остаться на прежнем маршруте.
export function stageOf(r) {
  if (r.review_status === 'approved') return r.summary_added ? 'ok_done' : 'ok_summary'
  if (r.review_status === 'has_remarks') {
    if (r.remarks_send_required === false) {
      return r.summary_added ? 'nosend_done' : 'nosend_summary'
    }
    return r.summary_added && r.remarks_sent ? 'remarks_sent' : 'remarks_work'
  }
  return 'pending'
}

export const STAGE_KEYS = [
  'pending',
  'ok_summary', 'ok_done',
  'remarks_work', 'remarks_sent',
  'nosend_summary', 'nosend_done',
]

// Обратная таблица: какой набор полей даёт этот этап. Проверяется о stageOf —
// stageOf(STAGE_FIELDS[k]) === k для каждого ключа.
export const STAGE_FIELDS = {
  pending: { review_status: 'pending', remarks_send_required: true, summary_added: false, remarks_sent: false },
  ok_summary: { review_status: 'approved', remarks_send_required: true, summary_added: false, remarks_sent: false },
  ok_done: { review_status: 'approved', remarks_send_required: true, summary_added: true, remarks_sent: false },
  remarks_work: { review_status: 'has_remarks', remarks_send_required: true, summary_added: false, remarks_sent: false },
  remarks_sent: { review_status: 'has_remarks', remarks_send_required: true, summary_added: true, remarks_sent: true },
  nosend_summary: { review_status: 'has_remarks', remarks_send_required: false, summary_added: false, remarks_sent: false },
  nosend_done: { review_status: 'has_remarks', remarks_send_required: false, summary_added: true, remarks_sent: false },
}

// Узлы схемы = очереди работы = вкладки, один в один. tone — цветовой тон,
// actor — кто делает следующий шаг, title — полная подпись для всплывающей
// подсказки (в трёх ветках есть одноимённые узлы «К занесению в сводную»).
// terminal — конечная точка ветки, помечаем галочкой.
export const TAB_META = {
  pending: { label: 'На проверке', tone: 'pending', actor: 'аналитик' },
  ok_summary: { label: 'К занесению в сводную', tone: 'summary', actor: 'аналитик-экономист', title: 'Без замечаний · к занесению в сводную таблицу' },
  ok_done: { label: 'Готово', tone: 'ok', terminal: true, title: 'Без замечаний · работа по КП закончена' },
  // Один этап на две параллельные задачи инженера — порядок между ними не
  // навязываем, важно лишь, чтобы к концу этапа обе были выполнены.
  remarks_work: {
    label: 'Сводная + отправка',
    tone: 'warn',
    actor: 'инженер · параллельно',
    title: 'С замечаниями · параллельно: занести в сводную таблицу и отправить замечания подрядчику',
  },
  remarks_sent: { label: 'Отправлено', tone: 'sent', actor: 'инженер', terminal: true, title: 'С замечаниями · внесено в сводную и отправлено подрядчику' },
  nosend_summary: { label: 'К занесению в сводную', tone: 'summary', actor: 'аналитик-экономист', title: 'С замечаниями · без отправки подрядчику · к занесению в сводную таблицу' },
  nosend_done: { label: 'Готово', tone: 'ok', terminal: true, title: 'С замечаниями · без отправки подрядчику · работа по КП закончена' },
  all: { label: 'Все', tone: 'all', title: 'Все КП независимо от этапа' },
}

// Ветки для меню ручной установки этапа: заголовок + этапы по порядку.
export const STAGE_GROUPS = [
  { title: 'Начало', keys: ['pending'] },
  { title: 'Без замечаний', keys: ['ok_summary', 'ok_done'] },
  { title: 'С замечаниями · с отправкой подрядчику', keys: ['remarks_work', 'remarks_sent'] },
  { title: 'С замечаниями · без отправки', keys: ['nosend_summary', 'nosend_done'] },
]
