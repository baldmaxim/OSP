// Отметка «ТГ» в реестре тендеров (src/utils/tgPublish.js): три состояния по кругу и
// поведение до применения миграции 20261017 (колонки tg_skip ещё нет).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TG_NONE, TG_PUBLISHED, TG_SKIP, tgState, nextTgState, tgPatch, tgSkipSupported, tgEventDescription,
} from '../../src/utils/tgPublish.js'

const AT = '2026-10-15T09:00:00.000Z'

describe('Отметка «ТГ»: три состояния', () => {
  it('состояние строки тендера', () => {
    assert.equal(tgState({ tg_published: false, tg_skip: false }), TG_NONE)
    assert.equal(tgState({ tg_published: true, tg_skip: false }), TG_PUBLISHED)
    assert.equal(tgState({ tg_published: false, tg_skip: true }), TG_SKIP)
    assert.equal(tgState({ tg_published: false }), TG_NONE, 'колонки tg_skip ещё нет')
  })

  it('по кругу: серый → зелёный → красный → серый', () => {
    assert.equal(nextTgState(TG_NONE), TG_PUBLISHED)
    assert.equal(nextTgState(TG_PUBLISHED), TG_SKIP)
    assert.equal(nextTgState(TG_SKIP), TG_NONE)
  })

  it('поля: «кто / когда» только у выставленного состояния, оба флага сразу не ставятся', () => {
    assert.deepEqual(tgPatch(TG_PUBLISHED, 'Иванов', AT), {
      tg_published: true, tg_published_at: AT, tg_published_by: 'Иванов',
      tg_skip: false, tg_skip_at: null, tg_skip_by: null,
    })
    assert.deepEqual(tgPatch(TG_SKIP, 'Иванов', AT), {
      tg_published: false, tg_published_at: null, tg_published_by: null,
      tg_skip: true, tg_skip_at: AT, tg_skip_by: 'Иванов',
    })
    assert.deepEqual(tgPatch(TG_NONE, 'Иванов', AT), {
      tg_published: false, tg_published_at: null, tg_published_by: null,
      tg_skip: false, tg_skip_at: null, tg_skip_by: null,
    })
  })

  it('запись в журнал тендера', () => {
    assert.equal(tgEventDescription(TG_NONE, TG_PUBLISHED), 'Отмечена публикация в ТГ-канале')
    assert.equal(tgEventDescription(TG_PUBLISHED, TG_SKIP), 'Отмечено: не публиковать в ТГ-канале')
    assert.equal(tgEventDescription(TG_SKIP, TG_NONE), 'Снята отметка «Не публиковать в ТГ-канале»')
    assert.equal(tgEventDescription(TG_PUBLISHED, TG_NONE), 'Снята отметка о публикации в ТГ-канале')
  })
})

describe('Отметка «ТГ»: до миграции 20261017', () => {
  const legacy = { id: 't1', tg_published: true, tg_published_at: AT, tg_published_by: 'Иванов' }

  it('без колонки tg_skip — два состояния, как раньше', () => {
    assert.equal(tgSkipSupported(legacy), false)
    assert.equal(tgSkipSupported({ ...legacy, tg_skip: false }), true)
    assert.equal(nextTgState(TG_NONE, false), TG_PUBLISHED)
    assert.equal(nextTgState(TG_PUBLISHED, false), TG_NONE)
  })

  it('без колонки tg_skip поля tg_skip* в запрос не попадают', () => {
    for (const state of [TG_NONE, TG_PUBLISHED]) {
      const patch = tgPatch(state, 'Иванов', AT, false)
      assert.deepEqual(Object.keys(patch).sort(), ['tg_published', 'tg_published_at', 'tg_published_by'])
    }
  })
})
