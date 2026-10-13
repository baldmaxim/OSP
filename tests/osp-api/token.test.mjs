// Проверка токена входа на сервере (server/osp-api/src/lib/token.js) — без обращения к Supabase.
// Проверяем, что принимается только настоящий токен вошедшего пользователя этого проекта, а всё, что
// на него похоже, отклоняется: чужая подпись, другой алгоритм, просроченный, ключи самого проекта.
// База и сеть не нужны; нужны зависимости сервера (npm ci --prefix server/osp-api).
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET, OTHER_SECRET, signToken, userToken, projectKey } from './lib/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'jose')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const URL_ = 'https://testproject.supabase.co'
const USER = '11111111-1111-4111-8111-111111111111'
const nowS = () => Math.floor(Date.now() / 1000)

describe('osp-api: токен входа проверяется на сервере', { skip }, () => {
  let createTokenVerifier
  let verifier
  const rejected = (token, why) => assert.rejects(verifier.verify(token), undefined, why)

  before(async () => {
    ;({ createTokenVerifier } = await import(path.join(SERVER, 'src', 'lib', 'token.js')))
    verifier = createTokenVerifier({ secret: SECRET, supabaseUrl: `${URL_}/` })
  })

  it('настоящий токен вошедшего — принят: идентификатор и почта из токена', async () => {
    assert.deepEqual(await verifier.verify(userToken(URL_, USER, { email: 'user@example.ru' })), { id: USER, email: 'user@example.ru' })
    // Почты в токене может не быть (вход по телефону) — это не отказ.
    assert.deepEqual(await verifier.verify(userToken(URL_, USER, { email: undefined })), { id: USER, email: '' })
  })

  it('чужая подпись и подмена содержимого — отказ', async () => {
    await rejected(userToken(URL_, USER, {}, OTHER_SECRET), 'подписан секретом другого проекта')
    // Содержимое заменено на другого пользователя, подпись оставлена прежней.
    const [head, , signature] = userToken(URL_, USER).split('.')
    const forged = Buffer.from(JSON.stringify({ iss: `${URL_}/auth/v1`, aud: 'authenticated', role: 'authenticated',
      sub: '99999999-9999-4999-8999-999999999999', exp: nowS() + 3600 })).toString('base64url')
    await rejected(`${head}.${forged}.${signature}`, 'подмена пользователя')
    await rejected('', 'пусто')
    await rejected('не-токен', 'не токен')
    await rejected('a.b.c', 'мусор из трёх частей')
  })

  it('алгоритм — только HS256: «без подписи» и другие алгоритмы отклоняются', async () => {
    const claims = { iss: `${URL_}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: USER, exp: nowS() + 3600 }
    await rejected(signToken(claims, SECRET, { alg: 'none', typ: 'JWT' }), 'alg none')
    await rejected(signToken(claims, SECRET, { alg: 'None', typ: 'JWT' }), 'alg None')
    await rejected(signToken(claims, SECRET, { alg: 'HS512', typ: 'JWT' }), 'HS512 тем же секретом')
    await rejected(signToken(claims, SECRET, { alg: 'HS384', typ: 'JWT' }), 'HS384 тем же секретом')
    // Заголовок заявляет асимметричный алгоритм, подпись — HMAC секретом (подмена алгоритма).
    const [, body] = signToken(claims).split('.')
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const { createHmac } = await import('node:crypto')
    await rejected(`${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`, 'RS256 в заголовке')
  })

  it('срок: просроченный и бессрочный — отказ; небольшое расхождение часов допускается', async () => {
    await rejected(userToken(URL_, USER, { exp: nowS() - 60 }), 'истёк минуту назад')
    await rejected(userToken(URL_, USER, { exp: undefined }), 'без срока')
    await rejected(userToken(URL_, USER, { nbf: nowS() + 600 }), 'ещё не действует')
    assert.equal((await verifier.verify(userToken(URL_, USER, { exp: nowS() - 3 }))).id, USER, 'три секунды — в пределах допуска')
  })

  it('ключи самого проекта подписаны тем же секретом, но токеном пользователя не являются', async () => {
    await rejected(projectKey('anon'), 'публичный ключ сайта')
    await rejected(projectKey('service_role'), 'служебный ключ')
    // Даже если такому ключу приписать издателя и назначение — роль не «вошедший».
    await rejected(userToken(URL_, USER, { role: 'service_role' }), 'роль service_role')
    await rejected(userToken(URL_, USER, { role: 'anon' }), 'роль anon')
    await rejected(userToken(URL_, USER, { role: undefined }), 'без роли')
  })

  it('издатель, назначение, пользователь: токен другого проекта, не для входа, без uuid, анонимный — отказ', async () => {
    await rejected(userToken('https://another.supabase.co', USER), 'издан другим проектом')
    await rejected(userToken(URL_, USER, { iss: undefined }), 'без издателя')
    await rejected(userToken(URL_, USER, { aud: 'anon' }), 'назначение не «вошедший»')
    await rejected(userToken(URL_, USER, { aud: undefined }), 'без назначения')
    await rejected(userToken(URL_, USER, { sub: undefined }), 'без пользователя')
    await rejected(userToken(URL_, "1' or '1'='1"), 'пользователь — не uuid')
    await rejected(userToken(URL_, USER, { is_anonymous: true }), 'анонимный вход')
  })

  it('самопроверка настройки: секрет сверяется с публичным ключом сайта', async () => {
    assert.equal(await verifier.matchesProjectKey(projectKey('anon')), true, 'секрет от этого проекта')
    assert.equal(await verifier.matchesProjectKey(projectKey('anon', OTHER_SECRET)), false, 'секрет от другого проекта')
    assert.equal(await verifier.matchesProjectKey(signToken({ iss: 'supabase', role: 'anon', exp: nowS() - 100 })), true, 'ключ просрочен, но подпись верна')
    assert.equal(await verifier.matchesProjectKey(signToken({ iss: 'supabase', role: 'anon' }, SECRET, { alg: 'ES256', typ: 'JWT' })), false, 'проект подписывает другим алгоритмом')
    assert.equal(await verifier.matchesProjectKey('sb_publishable_abcdefghijklmnop'), null, 'ключ нового вида — проверить нечем')
    assert.equal(await verifier.matchesProjectKey(''), null)
  })

  it('без секрета, с коротким секретом и без адреса проекта проверка не создаётся', () => {
    assert.throws(() => createTokenVerifier({ secret: '', supabaseUrl: URL_ }), /короче 32 символов/)
    assert.throws(() => createTokenVerifier({ secret: 'short-secret', supabaseUrl: URL_ }), /короче 32 символов/)
    assert.throws(() => createTokenVerifier({ secret: SECRET, supabaseUrl: '' }), /нужен адрес Supabase/)
  })
})
