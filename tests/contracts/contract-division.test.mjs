// Подразделение договора (contracts.division, миграция 20261112): ДС показывают подразделение своего договора,
// коды в обеих базах — те же, что у подразделений ВОР тендеров (src/utils/vorDivisions.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contractDivisionEnabled, contractDivisionOf, contractDivisionSaveError } from '../../src/utils/contractDivision.js'
import { VOR_DIVISIONS } from '../../src/utils/vorDivisions.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const doc = (id, over = {}) => ({ id, record_type: 'dp', parent_contract_id: null, root_contract_id: null, division: null, ...over })

describe('Подразделение договора', () => {
  const k1 = doc('k1', { division: 'monolith' })
  const d1 = doc('d1', { record_type: 'ds_vor', parent_contract_id: 'k1', root_contract_id: 'k1' })
  // ДС к ДС без root_contract_id (прежние строки) — договор ищется вверх по родителям.
  const d2 = doc('d2', { record_type: 'ds_extra', parent_contract_id: 'd1', division: 'general' })
  const orphan = doc('d3', { record_type: 'ds_vor', parent_contract_id: 'нет', division: 'electrical' })
  const byId = new Map([k1, d1, d2, orphan].map((d) => [d.id, d]))

  it('у договора — своё, у ДС — подразделение договора (своё значение ДС не учитывается)', () => {
    assert.equal(contractDivisionOf(k1, byId), 'monolith')
    assert.equal(contractDivisionOf(d1, byId), 'monolith')
    assert.equal(contractDivisionOf(d2, byId), 'monolith')
    assert.equal(contractDivisionOf(doc('k2'), byId), null)
  })

  it('ДС, договор которого не загружен, — своё значение', () => {
    assert.equal(contractDivisionOf(orphan, byId), 'electrical')
  })

  it('колонка есть, если выборка её вернула; без неё — подсказка про миграцию', () => {
    assert.equal(contractDivisionEnabled([{ id: 'a' }]), false)
    assert.equal(contractDivisionEnabled([{ id: 'a', division: null }]), true)
    assert.match(contractDivisionSaveError({ code: 'PGRST204', message: "Could not find the 'division' column" }), /20261112/)
    assert.equal(contractDivisionSaveError({ code: '23514', message: 'нарушение' }), 'Ошибка: нарушение')
  })

  it('обе базы: колонка и те же коды, что у подразделений ВОР; Supabase — одной транзакцией', () => {
    const codes = VOR_DIVISIONS.map((d) => `'${d.value}'`).join(', ')
    for (const f of ['supabase/migrations/20261112_contracts_division.sql', 'migration/yandex/20261112_contracts_division.sql']) {
      const sql = fs.readFileSync(path.join(ROOT, f), 'utf8')
      assert.match(sql, /ALTER TABLE public\.contracts ADD COLUMN IF NOT EXISTS division text;/, f)
      assert.ok(sql.includes(`division IN (${codes})`), `${f}: коды ${codes}`)
    }
    assert.match(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261112_contracts_division.sql'), 'utf8'), /^BEGIN;[\s\S]*^COMMIT;/m)
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'migration/yandex/20261112_contracts_division.sql'), 'utf8'), /^\s*(BEGIN|COMMIT);/m)
  })
})
