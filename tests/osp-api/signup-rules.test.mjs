// Правила полей регистрации (src/utils/contractorSignupRules.js — одни для страницы и службы), задача на вычисление: страница и
// служба считают одинаково, адаптер регистрации повторяет запрос только при устаревшей задаче.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  companyNameKey, companyNameProblem, emailProblem, isPublicMailDomain, isValidInn, isValidKpp, normalizePhone, personNameProblem, validateSignup,
} from '../../src/utils/contractorSignupRules.js'
import { createSignupClient, sha256Ascii, solveChallenge } from '../../src/api/contractorSignupClient.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const server = (...p) => pathToFileURL(path.join(ROOT, 'server', 'osp-api', 'src', ...p)).href

describe('правила полей регистрации', () => {
  it('ИНН: контрольная сумма; все нули и регион 00 — нет', () => {
    for (const ok of ['7707083893', '500100732259', '7736050003']) assert.equal(isValidInn(ok), true, ok)
    for (const bad of ['7707083894', '500100732258', '0000000000', '000000000000', '0012345678', '123', '12345678901', '77070838931', 'abcdefghij', '', null]) {
      assert.equal(isValidInn(bad), false, String(bad))
    }
  })

  it('КПП: 9 знаков, не все нули', () => {
    assert.equal(isValidKpp('770101001'), true)
    assert.equal(isValidKpp('7701AB001'), true)
    for (const bad of ['000000000', '77010100', '7701010011', '7701ab001', '']) assert.equal(isValidKpp(bad), false, bad)
  })

  it('телефон: приводится к одному виду, разметки и лишних знаков нет', () => {
    assert.equal(normalizePhone('+7 (916) 123-45-67'), '+79161234567')
    assert.equal(normalizePhone('8 916 123 45 67'), '+79161234567')
    assert.equal(normalizePhone('9161234567'), '+79161234567')
    assert.equal(normalizePhone('+375 29 123-45-67'), '+375291234567')
    for (const bad of ['123', '<script>', '+0123456789', '8916123456789012', 'тел. 89161234567', '']) assert.equal(normalizePhone(bad), null, bad)
  })

  it('почта: обычный адрес; кавычки, переводы строк и временные службы — нет', () => {
    for (const ok of ['ivanov@company.ru', 'i.ivanov+t@sub.company-name.ru', 'A_B@X.RU']) assert.equal(emailProblem(ok), null, ok)
    for (const bad of ['', 'a', 'a@b', 'a..b@c.ru', '.a@c.ru', 'a.@c.ru', 'a b@c.ru', 'x"y@c.ru', 'a@b.ru\r\nBcc: x@y.ru', 'a@-b.ru', 'почта@сайт.рф', `${'a'.repeat(65)}@c.ru`, `a@${'b'.repeat(250)}.ru`, 'x@yopmail.com', 'x@MAILINATOR.com']) {
      assert.ok(emailProblem(bad), JSON.stringify(bad))
    }
  })

  it('название: без формул Excel, разметки, ссылок и невидимых знаков', () => {
    for (const ok of ['ООО «Ромашка»', 'ИП Иванов И.И.', 'АО "СК-10"', 'ТОО Build & Co']) assert.equal(companyNameProblem(ok), null, ok)
    for (const bad of ['', 'Я', '12345', '=cmd()', '+1', '-a', '@a', '<b>x</b>', 'ООО https://evil.ru', 'www.evil.ru', 'зайдите на evil.ru', `ООО${String.fromCharCode(0x202e)}Ромашка`, `ООО${String.fromCharCode(0x200b)}Ромашка`, 'Я'.repeat(301)]) {
      assert.ok(companyNameProblem(bad), bad)
    }
  })

  it('контактное лицо: только буквы, пробел, точка, дефис', () => {
    for (const ok of ['Иванов И.И.', 'Салтыков-Щедрин Михаил', "O'Neil John"]) assert.equal(personNameProblem(ok), null, ok)
    for (const bad of ['', 'Я', '12345', 'Иван<script>', 'Иван=1', 'Я'.repeat(201)]) assert.ok(personNameProblem(bad), bad)
  })

  it('сравнение с ЧС: форма собственности, кавычки и регистр не мешают; общая почтовая служба ничего не значит', () => {
    const key = companyNameKey('ООО «Ромашка»')
    for (const same of ['Ромашка ООО', '"РОМАШКА"', 'Общество с ограниченной ответственностью Ромашка', 'АО Ромашка']) assert.equal(companyNameKey(same), key, same)
    assert.notEqual(companyNameKey('ООО Ромашка-2'), key)
    assert.equal(companyNameKey('ООО Pомaшкa'), key, 'латиница, похожая на кириллицу')
    assert.equal(isPublicMailDomain('gmail.com'), true)
    assert.equal(isPublicMailDomain('company.ru'), false)
  })

  it('вся форма: значения приведены; у ИП нет КПП; согласие обязательно', () => {
    const form = { email: ' a@b.ru ', companyName: '  ООО  Ромашка ', inn: '77 07 083 893', kpp: '770101001', contactName: ' Иванов  И. ', phone: '8 916 123-45-67', consent: true }
    assert.deepEqual(validateSignup(form), { ok: true, value: { email: 'a@b.ru', companyName: 'ООО Ромашка', inn: '7707083893', kpp: '770101001', contactName: 'Иванов И.', phone: '+79161234567' } })
    assert.equal(validateSignup({ ...form, inn: '500100732259' }).field, 'kpp')
    assert.equal(validateSignup({ ...form, inn: '500100732259', kpp: '' }).ok, true)
    assert.equal(validateSignup({ ...form, consent: 'да' }).field, 'consent')
    assert.equal(validateSignup({}).field, 'email')
  })
})

describe('задача на вычисление', () => {
  it('SHA-256 страницы совпадает с настоящим на строках разной длины', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'challenge.1234567890123.18.signature:12345']) {
      const words = sha256Ascii(text)
      const hex = words.map((w) => w.toString(16).padStart(8, '0')).join('')
      assert.equal(hex, crypto.createHash('sha256').update(text).digest('hex'), JSON.stringify(text))
    }
  })

  it('служба принимает решение страницы; подделка, чужая сложность, устаревшая и повторная — нет', async () => {
    const { createProofOfWork, leadingZeroBits } = await import(server('lib', 'auth', 'proofOfWork.js'))
    assert.equal(leadingZeroBits(Buffer.from([0, 0x7f])), 9)
    assert.equal(leadingZeroBits(Buffer.from([0x80])), 0)
    let t = 1_000_000_000_000
    const pow = createProofOfWork({ bits: 8, ttlMs: 1000, now: () => t })
    const { challenge, bits } = pow.issue()
    assert.equal(bits, 8)
    const answer = await solveChallenge(challenge, bits, { batch: 1000, pause: async () => {} })
    assert.equal(pow.verify('x', answer), false)
    assert.equal(pow.verify(`${challenge}x`, answer), false)
    assert.equal(pow.verify(challenge, 'не число'), false)
    // Другая сложность в задаче ломает подпись.
    const weaker = challenge.replace(/\.8\./, '.1.')
    assert.equal(pow.verify(weaker, '0'), false)
    // Неверное решение: ищем число, которое задачу не решает.
    let wrong = 0
    while (crypto.createHash('sha256').update(`${challenge}:${wrong}`).digest()[0] === 0) wrong++
    assert.equal(pow.verify(challenge, String(wrong)), false)
    assert.equal(pow.verify(challenge, answer), true)
    assert.equal(pow.verify(challenge, answer), false, 'одноразовая')
    const late = pow.issue()
    const lateAnswer = await solveChallenge(late.challenge, 8, { batch: 1000, pause: async () => {} })
    t += 1001
    assert.equal(pow.verify(late.challenge, lateAnswer), false, 'срок вышел')
  })

  it('адаптер: задача устарела — одна повторная попытка; остальные отказы — как есть, с полем', async () => {
    const calls = []
    const answers = [
      { status: 200, body: { challenge: 'c1', bits: 1 } }, { status: 400, body: { error: 'устарела', code: 'OSP_POW' } },
      { status: 200, body: { challenge: 'c2', bits: 1 } }, { status: 202, body: { ok: true } },
    ]
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      const a = answers.shift()
      return { ok: a.status < 400, status: a.status, json: async () => a.body }
    }
    const client = createSignupClient({ fetchImpl, solve: async () => '7' })
    assert.deepEqual(await client.register({ email: 'a@b.ru' }), { ok: true })
    assert.equal(calls.length, 4)
    const body = JSON.parse(calls.at(-1).init.body)
    assert.deepEqual(body, { email: 'a@b.ru', challenge: 'c2', answer: '7' })
    assert.equal(calls.at(-1).init.credentials, 'same-origin')

    answers.push({ status: 200, body: { challenge: 'c3', bits: 1 } }, { status: 400, body: { error: 'ИНН', code: 'OSP_SIGNUP_FIELD', field: 'inn' } })
    await assert.rejects(client.register({}), (e) => e.field === 'inn' && e.status === 400 && e.message === 'ИНН')
    const down = createSignupClient({ fetchImpl: async () => { throw new Error('offline') } })
    await assert.rejects(down.confirm('t'), (e) => e.status === 0)
  })
})

describe('разбор ВОР для подрядчика', () => {
  it('скрытый лист не читается, даже если похож на ВОР; лишние колонки не попадают', async () => {
    const XLSX = await import('xlsx')
    const { readBidFileBytes } = await import('../../src/utils/bidVor.js')
    const { positionsPayload } = await import(server('lib', 'bidPositions.js'))
    const wb = XLSX.utils.book_new()
    const header = ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу', 'Себестоимость СУ-10']
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['служебный'], header, ['1', 'Р', 'Скрытая работа', 'м3', 5, '', 999999]]), 'Внутренний')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ['1', 'Р', 'Видимая работа', 'м3', 5, '', 777777], ['', 'мат.', 'Видимый материал', 'м3', 5, 5, 888888]]), 'КП')
    wb.Workbook = { Sheets: [{ name: 'Внутренний', Hidden: 1 }, { name: 'КП', Hidden: 0 }] }
    const parsed = readBidFileBytes(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
    assert.ok(!parsed.error, JSON.stringify(parsed))
    const payload = positionsPayload(parsed)
    assert.deepEqual(payload.positions.map((p) => p.name).sort(), ['Видимая работа', 'Видимый материал'])
    assert.deepEqual(Object.keys(payload.positions[0]).sort(), ['itemKey', 'key', 'kind', 'name', 'rows', 'unit', 'unitKey', 'volume'])
    const text = JSON.stringify(payload)
    for (const secret of ['Скрытая', '999999', '777777', '888888', 'Себестоимость']) assert.ok(!text.includes(secret), secret)
    assert.equal(positionsPayload(parsed, { maxPositions: 1 }).error, 'too_many')
  })
})
