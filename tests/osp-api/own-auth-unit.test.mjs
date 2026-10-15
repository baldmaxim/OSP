// Свой вход — части без базы (server/osp-api/src/lib/auth): шифрование отпечатков ключом сервера, отпечатки
// scrypt / bcrypt, очередь расчётов, одинаковое время проверки, правила новых паролей, cookie.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'bcryptjs')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'
const lib = (name) => import(path.join(SERVER, 'src', 'lib', 'auth', name))
const key = () => crypto.randomBytes(32).toString('base64')

describe('свой вход: шифрование отпечатков ключом сервера', { skip }, () => {
  let createSecretBox, parseKeyRing, keyIdOf
  before(async () => { ({ createSecretBox, parseKeyRing, keyIdOf } = await lib('secretBox.js')) })

  it('шифрует и расшифровывает; чужая привязка (другой пользователь) и чужой ключ — отказ', () => {
    const k1 = key()
    const box = createSecretBox(`k1:${k1}`)
    const blob = box.encrypt('$2a$10$abc', 'user-a')
    assert.match(blob, /^v1:k1:[A-Za-z0-9+/]+={0,2}$/)
    assert.equal(box.decrypt(blob, 'user-a'), '$2a$10$abc')
    assert.notEqual(box.encrypt('$2a$10$abc', 'user-a'), blob, 'вектор случайный — одинаковые пароли дают разные строки')
    assert.throws(() => box.decrypt(blob, 'user-b'), (e) => e.code === 'OSP_AUTH_KEY_MISMATCH', 'строку нельзя переставить другому')
    const other = createSecretBox(`k1:${key()}`)
    assert.throws(() => other.decrypt(blob, 'user-a'), (e) => e.code === 'OSP_AUTH_KEY_MISMATCH')
    assert.throws(() => createSecretBox(`k9:${key()}`).decrypt(blob, 'user-a'), (e) => e.code === 'OSP_AUTH_KEY_UNKNOWN')
    assert.equal(keyIdOf(blob), 'k1')
  })

  it('несколько ключей: шифрует текущим (первым), расшифровывает любым из списка', () => {
    const k1 = key()
    const k2 = key()
    const old = createSecretBox(`k1:${k1}`).encrypt('секрет', 'u')
    const ring = createSecretBox(`k2:${k2},k1:${k1}`)
    assert.equal(ring.currentKeyId, 'k2')
    assert.equal(ring.decrypt(old, 'u'), 'секрет')
    assert.equal(keyIdOf(ring.encrypt('x', 'u')), 'k2')
  })

  it('негодная настройка ключей — отказ без значения ключа в тексте', () => {
    const k = key()
    for (const spec of ['', 'k1', `K1:${k}`, `k1:${k},k1:${k}`, 'k1:short', `слишком-длинное-имя-ключа:${k}`]) {
      assert.throws(() => parseKeyRing(spec), (e) => !e.message.includes(k), spec)
    }
  })
})

describe('свой вход: отпечатки, очередь, одинаковое время', { skip, timeout: 120000 }, () => {
  let pw
  let bcrypt
  before(async () => {
    pw = await lib('passwords.js')
    bcrypt = (await import(path.join(SERVER, 'node_modules', 'bcryptjs', 'index.js'))).default
  })

  it('scrypt: строка самодостаточна (параметры, соль 16 байт, ключ 32 байта); NFC — одна и та же форма', async () => {
    const h = await pw.hashPassword('пароль-фраза ёлка')
    assert.match(h, /^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/)
    const parsed = pw.parseScrypt(h)
    assert.equal(parsed.salt.length, 16)
    assert.equal(parsed.key.length, 32)
    assert.equal(pw.algoOf(h), 'scrypt')
    assert.equal(pw.needsRehash(h), false)
    const v = pw.createPasswordVerifier()
    assert.equal((await v.verify('пароль-фраза ёлка', h)).ok, true)
    // «ё» одной кодовой точкой и «е» + знак — после NFC одно и то же.
    assert.equal((await v.verify('пароль-фраза ёлка', h)).ok, true)
    assert.equal((await v.verify('пароль-фраза елка', h)).ok, false)
  })

  it('bcrypt из Supabase ($2a$10$) проверяется и требует пересчёта; негодная строка — не пароль', async () => {
    const legacy = (await bcrypt.hash('Old-Pass-1', 10)).replace(/^\$2b\$/, '$2a$')
    assert.equal(pw.algoOf(legacy), 'bcrypt')
    assert.equal(pw.needsRehash(legacy), true)
    const v = pw.createPasswordVerifier()
    assert.deepEqual(await v.verify('Old-Pass-1', legacy), { ok: true, algo: 'bcrypt' })
    assert.equal((await v.verify('old-pass-1', legacy)).ok, false)
    for (const bad of [null, '', 'plain', '$scrypt$ln=30,r=8,p=3$AAAA$BBBB', '$2a$10$short']) {
      assert.equal((await v.verify('x', bad)).ok, false, String(bad))
    }
  })

  it('время проверки не выдаёт учётку: несуществующая, bcrypt и scrypt считаются одинаково (оба расчёта всегда)', async () => {
    const v = pw.createPasswordVerifier()
    await v.warmUp()
    const legacy = await bcrypt.hash('x-legacy-pass', 10)
    const own = await pw.hashPassword('x-own-password-long')
    const time = async (stored) => {
      const t = process.hrtime.bigint()
      for (let i = 0; i < 3; i++) await v.verify('wrong-password', stored)
      return Number(process.hrtime.bigint() - t) / 3e6
    }
    const [none, b, s] = [await time(null), await time(legacy), await time(own)]
    const max = Math.max(none, b, s)
    const min = Math.min(none, b, s)
    assert.ok(max / min < 1.6, `время расходится: нет учётки ${none.toFixed(0)} мс, bcrypt ${b.toFixed(0)} мс, scrypt ${s.toFixed(0)} мс`)
  })

  it('очередь расчётов: одновременно — не больше заданного, очередь ограничена, долгое ожидание — отказ', async () => {
    const gate = pw.createHashGate({ concurrency: 2, maxQueue: 2, waitMs: 150 })
    let running = 0
    let peak = 0
    const slow = () => gate.run(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 100)); running-- })
    const jobs = [slow(), slow(), slow(), slow()]
    await assert.rejects(slow(), (e) => e.code === 'OSP_AUTH_BUSY', 'пятый — сверх очереди')
    await Promise.all(jobs)
    assert.equal(peak, 2)
    const stuck = pw.createHashGate({ concurrency: 1, maxQueue: 5, waitMs: 50 })
    const long = stuck.run(() => new Promise((r) => setTimeout(r, 300)))
    await assert.rejects(stuck.run(async () => 1), (e) => e.code === 'OSP_AUTH_BUSY', 'ждал дольше предела')
    await long
  })
})

describe('свой вход: правила новых паролей (NIST SP 800-63B-4)', { skip }, () => {
  let policy
  let blocklist
  before(async () => {
    policy = await lib('policy.js')
    blocklist = policy.loadBlocklist()
  })

  it('список запрета: файл тот, что описан (сумма), отобраны пароли от 15 знаков', () => {
    const file = path.join(SERVER, 'src', 'data', 'common-passwords.txt.gz')
    const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(sum, '6559be0fcc6e29ee18b0348c50e6427a4cceb643a3187d45674b25d38ba86648', 'список заменён — обновите README рядом с ним')
    assert.ok(blocklist.size > 100000)
    for (const p of blocklist) { assert.ok([...p].length >= 15); break }
  })

  it('длина — в кодовых точках после NFC; 15–128; правил состава нет', () => {
    const check = (p) => policy.checkNewPassword(p, {}, blocklist)?.code ?? null
    assert.equal(check('коротко'), 'password_too_short')
    assert.equal(check('четырнадцатьзн'), 'password_too_short')
    assert.equal(check('ёжик в тумане уходит'), null, 'фраза строчными без цифр — годится')
    assert.equal(check('😀'.repeat(15)), null, 'эмодзи — по одной кодовой точке')
    assert.equal(check('a'.repeat(129)), 'password_too_long')
  })

  it('пароль целиком из списка запрета или равный производной почты, ФИО, слов сервиса — отказ; подстроки не ищутся', () => {
    const ctx = { email: 'Ivanov.Petr@su10.ru', fullName: 'Иванов Пётр Сергеевич' }
    const check = (p) => policy.checkNewPassword(p, ctx, blocklist)?.code ?? null
    const common = [...blocklist][0]
    assert.equal(check(common), 'password_common')
    assert.equal(check(common.toUpperCase()), 'password_common', 'регистр не спасает')
    assert.equal(check('ivanov.petr@su10.ru'), 'password_personal')
    assert.equal(check('Ivanov.Petr2025!!'), 'password_personal', 'часть почты до @ с цифрами в конце')
    assert.equal(check('ИвановПётрСергеевич'), 'password_personal')
    assert.equal(check('tender-su10-2025'), 'password_personal')
    assert.equal(check('у Иванова ёлка выросла до крыши'), null, 'фраза, в которой есть фамилия, — допустима')
  })

  it('временный пароль: 20 знаков без похожих символов, каждый раз новый, проходит правила', () => {
    const a = policy.generateTemporaryPassword()
    const b = policy.generateTemporaryPassword()
    assert.equal(a.length, 20)
    assert.notEqual(a, b)
    assert.doesNotMatch(a, /[0O1lI]/)
    assert.equal(policy.checkNewPassword(a, { email: 'x@y.ru' }, blocklist), null)
  })
})

describe('свой вход: cookie', { skip }, () => {
  let cookies
  before(async () => { cookies = await lib('cookies.js') })

  it('__Host-: Secure, Path=/, без Domain; сессия — HttpOnly, CSRF — нет; срок — Max-Age', () => {
    const [session, csrf] = cookies.sessionCookies({ sessionToken: 'a'.repeat(43), csrf: 'b'.repeat(32), maxAgeSec: 2592000 })
    assert.match(session, /^__Host-osp_session=a{43}; Path=\/; Max-Age=2592000; Secure; SameSite=Lax; HttpOnly$/)
    assert.match(csrf, /^__Host-osp_csrf=b{32}; Path=\/; Max-Age=2592000; Secure; SameSite=Lax$/)
    assert.doesNotMatch(session + csrf, /Domain/i)
    for (const c of cookies.clearedCookies()) assert.match(c, /Max-Age=0/)
  })

  it('повторённое имя (подложено соседним сайтом) — признак подмены; чужой вид значения — не токен', () => {
    const t = 'x'.repeat(43)
    assert.deepEqual(cookies.readToken(`a=1; __Host-osp_session=${t}`, '__Host-osp_session'), { value: t })
    assert.deepEqual(cookies.readToken(`__Host-osp_session=${t}; __Host-osp_session=${'y'.repeat(43)}`, '__Host-osp_session'), { duplicate: true })
    assert.deepEqual(cookies.readToken('__Host-osp_session=<script>', '__Host-osp_session'), {})
    assert.deepEqual(cookies.readToken('', '__Host-osp_session'), {})
  })
})
