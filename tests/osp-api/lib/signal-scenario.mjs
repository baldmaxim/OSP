// Сцена для тестов сверки с Signal (P4): два объекта, два корня со снимком папок, договоры и сотрудники разных прав.
// Всё синтетическое: названия вымышленные, идентификаторы — …-0000-4000-8000-…, ссылки — на хост signal.example.test.
//
//   const s = await seedScenario(db)           // объекты, корни, снимок (поколение 1), договоры (в очереди)
//   s.contracts.c1 … s.folders.f1 … s.users.editor …
//
//   Снимок «Альфа» (объект A):  Корпус 1 (k1) / ДП АЛФ-ДП-26-001 ООО Ромашка (f1, с файлами и подпапкой «Акты»)
//                                         / ДП АЛФ-ДП-26-002 ООО Ромашка (f2, файл «Договор подряда.pdf») / ДС-1 (fds1)
//                                Корпус 2 / ДП АЛФ-ДП-26-004 ООО Ромашка (f4)
//   Снимок «Бета» (объект B):   ДП БЕТ-ДП-26-001 ООО Лютик (fb1)
//   Договоры: c1 (АЛФ-ДП-26-001, ссылки нет → предложена f1), c2 (…002, ссылка на f2 → сверено), c3 (…009, папки нет → нет ссылки),
//             c4 (…003, ссылка на f4 → противоречие номера), cb (БЕТ-ДП-26-001 → предложена fb1), ds1 (ДС-1 к c2 → предложена fds1).
import { nodeTree, folderUrl } from './signal-app.mjs'

export async function seedScenario(db) {
  const { seed } = db
  const A = seed.object({ name: 'Тест: ЖК Альфа', code: 'АЛФ' })
  const B = seed.object({ name: 'Тест: ЖК Бета', code: 'БЕТ' })
  const cpR = seed.counterparty({ name: 'ООО Ромашка' })
  const cpL = seed.counterparty({ name: 'ООО Лютик' })

  const srcA = seed.source({ objectIds: [A], name: 'Тест: проект Альфа', rootPath: 'Тест: проект Альфа / Документы Альфа' })
  const srcB = seed.source({ objectIds: [B], name: 'Тест: проект Бета', rootPath: 'Тест: проект Бета / Документы Бета' })
  const treeA = await nodeTree({
    name: 'Документы Альфа',
    children: [
      {
        name: 'Корпус 1',
        children: [
          { name: 'ДП АЛФ-ДП-26-001 ООО Ромашка', items: [{ name: 'Договор.pdf', version: 2 }, { name: 'Приложение 1.xlsx' }], children: [{ name: 'Акты', items: [{ name: 'Акт 1.pdf' }] }] },
          { name: 'ДП АЛФ-ДП-26-002 ООО Ромашка', items: [{ name: 'Договор подряда.pdf' }], children: [{ name: 'ДС-1' }] },
        ],
      },
      { name: 'Корпус 2', children: [{ name: 'ДП АЛФ-ДП-26-004 ООО Ромашка' }] },
    ],
  })
  const snapA = seed.snapshot(srcA.id, treeA, { generation: 1 })
  const treeB = await nodeTree({ name: 'Документы Бета', children: [{ name: 'ДП БЕТ-ДП-26-001 ООО Лютик' }] })
  const snapB = seed.snapshot(srcB.id, treeB, { generation: 1 })
  const id = (snap, p) => {
    if (!snap.ids[p]) throw new Error(`сцена: нет папки «${p}»`)
    return snap.ids[p]
  }
  const folders = {
    rootA: srcA.folderId,
    k1: id(snapA, 'Документы Альфа / Корпус 1'),
    k2: id(snapA, 'Документы Альфа / Корпус 2'),
    f1: id(snapA, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-001 ООО Ромашка'),
    f1acts: id(snapA, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-001 ООО Ромашка / Акты'),
    f2: id(snapA, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-002 ООО Ромашка'),
    fds1: id(snapA, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-002 ООО Ромашка / ДС-1'),
    f4: id(snapA, 'Документы Альфа / Корпус 2 / ДП АЛФ-ДП-26-004 ООО Ромашка'),
    rootB: srcB.folderId,
    fb1: id(snapB, 'Документы Бета / ДП БЕТ-ДП-26-001 ООО Лютик'),
  }
  const itemOf = (snap, folderPath, name) => id(snap, `${folderPath} / ${name}`)
  const files = {
    contractPdf: itemOf(snapA, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-001 ООО Ромашка', 'Договор.pdf'),
    f2pdf: itemOf(snapA, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-002 ООО Ромашка', 'Договор подряда.pdf'),
  }

  const c1 = seed.contract({ number: 'АЛФ-ДП-26-001', objectId: A, counterparties: [cpR] })
  const c2 = seed.contract({ number: 'АЛФ-ДП-26-002', objectId: A, counterparties: [cpR], signalLink: folderUrl(srcA.projectId, folders.f2) })
  const c3 = seed.contract({ number: 'АЛФ-ДП-26-009', objectId: A, counterparties: [cpR] })
  const c4 = seed.contract({ number: 'АЛФ-ДП-26-003', objectId: A, counterparties: [cpR], signalLink: folderUrl(srcA.projectId, folders.f4) })
  const cb = seed.contract({ number: 'БЕТ-ДП-26-001', objectId: B, counterparties: [cpL] })
  const ds1 = seed.contract({ number: 'ДС-1', objectId: A, counterparties: [cpR], recordType: 'ds_vor', parent: c2 })

  const users = {
    viewer: seed.user({ contracts: 'view' }),
    editor: seed.user({ contracts: 'edit' }),
    editorB: seed.user({ contracts: 'edit', objectIds: [B], objectScoped: true }),
    viewerB: seed.user({ contracts: 'view', objectIds: [B], objectScoped: true }),
    noRight: seed.user({ contracts: null }),
    admin: seed.admin(),
    contractor: seed.contractor(),
  }
  return {
    A, B, cpR, cpL, srcA, srcB, snapA, snapB, folders, files,
    projectA: srcA.projectId, projectB: srcB.projectId,
    contracts: { c1, c2, c3, c4, cb, ds1 }, users,
    urlOf: (folderId, project = srcA.projectId) => folderUrl(project, folderId),
  }
}

// Строка из базы одним значением (служебная операция).
export const one = (db, text) => db.sql(text).split('\n').filter(Boolean).at(-1) ?? ''
