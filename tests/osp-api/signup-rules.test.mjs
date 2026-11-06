// Правила полей регистрации (src/utils/contractorSignupRules.js — одни для страницы и службы), задача на вычисление: страница и
// служба считают одинаково, адаптер регистрации повторяет запрос только при устаревшей задаче.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  cleanKppInput, companyNameKey, companyNameProblem, emailProblem, guessLegalForm, isPublicMailDomain, isValidInn, isValidKpp, legalFormsForInn, normalizePhone,
  parsePhoneInput, personNameProblem, phoneMainDigits, splitLegalForm, validateSignup,
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

  it('КПП: 9 знаков, буквы только в 5–6 знаках, не все нули', () => {
    assert.equal(isValidKpp('770101001'), true)
    assert.equal(isValidKpp('7701AB001'), true)
    for (const bad of ['000000000', '77010100', '7701010011', '7701ab001', 'AB0101001', '77010100A', '']) assert.equal(isValidKpp(bad), false, bad)
  })

  it('поле КПП: лишнее не вводится; буквы — только в 5–6 знаках, заглавные и латинские', () => {
    assert.equal(cleanKppInput('770101001999'), '770101001')
    assert.equal(cleanKppInput('7701ab001'), '7701AB001')
    assert.equal(cleanKppInput('7701АВ001'), '7701AB001', 'русские А и В — как латинские')
    assert.equal(cleanKppInput('КПП 7701-01 001'), '770101001', 'подпись и разделители')
    assert.equal(cleanKppInput('77ab0101001'), '770101001', 'буквы не на своём месте')
    assert.equal(cleanKppInput('7701A1B001'), '7701A1001')
    assert.equal(cleanKppInput(''), '')
  })

  it('телефон: приводится к одному виду, разметки и лишних знаков нет', () => {
    assert.equal(normalizePhone('+7 (916) 123-45-67'), '+79161234567')
    assert.equal(normalizePhone('8 916 123 45 67'), '+79161234567')
    assert.equal(normalizePhone('9161234567'), '+79161234567')
    assert.equal(normalizePhone('+375 29 123-45-67'), '+375291234567')
    for (const bad of ['123', '<script>', '+0123456789', '8916123456789012', 'тел. 89161234567', '']) assert.equal(normalizePhone(bad), null, bad)
    // После +7 — ровно 10 цифр: раньше короткий «+7 916 123» проходил как номер другой страны.
    for (const bad of ['+7916123', '+7 916 123-45', '+791612345678', '+7916abc4567']) assert.equal(normalizePhone(bad), null, bad)
  })

  it('телефон: добавочный — до 6 цифр, той же записью, что у контактов; сравнение с контактами его не считает', () => {
    assert.equal(normalizePhone('+79161234567 доб. 123'), '+79161234567 доб. 123')
    assert.equal(normalizePhone('8 916 123-45-67 доб 123456'), '+79161234567 доб. 123456')
    for (const bad of ['+79161234567 доб. 1234567', '+79161234567 доб.', '+79161234567 доб. 12а', 'доб. 123', '+7 доб. 123']) assert.equal(normalizePhone(bad), null, bad)
    assert.equal(phoneMainDigits('+79161234567 доб. 123'), '9161234567')
    assert.equal(phoneMainDigits('+79161234567'), '9161234567')
  })

  it('поле номера после +7: только цифры, не больше 10; лишние 7 и 8 в начале убираются, настоящие коды остаются', () => {
    const number = (text) => parsePhoneInput(text).number
    assert.equal(number('9161234567'), '9161234567')
    assert.equal(number('9а1б6 123-45-67'), '9161234567', 'буквы и разметка')
    assert.equal(number('916123456789'), '9161234567', 'лишние цифры')
    assert.equal(number('8'), '8', 'пока не ясно')
    assert.equal(number('89'), '9', 'мобильный с восьмёрки — сразу')
    assert.equal(number('89161234567'), '9161234567')
    assert.equal(number('+7 (916) 123-45-67'), '9161234567')
    assert.equal(number('8121234567'), '8121234567', 'код Петербурга')
    assert.equal(number('88121234567'), '8121234567')
    assert.equal(number('84951234567'), '4951234567')
    assert.equal(number('7011234567'), '7011234567', 'код 701')
    assert.equal(number('77011234567'), '7011234567')
    assert.equal(number('81212345679'), '8121234567', 'лишняя цифра в конце номер не сдвигает')
    assert.deepEqual(parsePhoneInput('+7 916 123-45-67 доб. 123'), { number: '9161234567', ext: '123' }, 'вставлен с добавочным')
    assert.deepEqual(parsePhoneInput('9161234567 вн 12345678'), { number: '9161234567', ext: '123456' })
  })

  it('почта: обычный адрес; кавычки, переводы строк и временные службы — нет', () => {
    for (const ok of ['ivanov@company.ru', 'i.ivanov+t@sub.company-name.ru', 'A_B@X.RU']) assert.equal(emailProblem(ok), null, ok)
    for (const bad of ['', 'a', 'a@b', 'a..b@c.ru', '.a@c.ru', 'a.@c.ru', 'a b@c.ru', 'x"y@c.ru', 'a@b.ru\r\nBcc: x@y.ru', 'a@-b.ru', 'почта@сайт.рф', `${'a'.repeat(65)}@c.ru`, `a@${'b'.repeat(250)}.ru`, 'x@yopmail.com', 'x@MAILINATOR.com']) {
      assert.ok(emailProblem(bad), JSON.stringify(bad))
    }
  })

  it('почта: без @ — своё замечание; не длиннее 100 знаков', () => {
    assert.match(emailProblem('ivanov.company.ru'), /знак @/)
    const ofLength = (n) => `${'a'.repeat(40)}@${'b'.repeat(n - 44)}.ru`
    assert.equal(emailProblem(ofLength(100)), null)
    assert.match(emailProblem(ofLength(101)), /не длиннее 100/)
  })

  it('форма организации: берётся из начала названия, сокращением или целиком; незаконченное слово — не форма', () => {
    for (const [text, form, name] of [
      ['ООО «Ромашка»', 'ООО', '«Ромашка»'], ['ооо"Ромашка"', 'ООО', '"Ромашка"'], ['OOO Ромашка', 'ООО', 'Ромашка'],
      ['ИП Иванов И.И.', 'ИП', 'Иванов И.И.'], ['СЗ Иванов', 'СЗ', 'Иванов'], ['Самозанятая Иванова', 'СЗ', 'Иванова'],
      ['АО Ромашка', 'АО', 'Ромашка'], ['ПАО Сбер', 'ПАО', 'Сбер'], ['ЗАО «Икс»', 'ЗАО', '«Икс»'], ['ОАО Икс', 'ОАО', 'Икс'], ['НАО Икс', 'НАО', 'Икс'],
      ['АНО Развитие', 'АНО', 'Развитие'], ['ГУП Икс', 'ГУП', 'Икс'], ['МУП Икс', 'МУП', 'Икс'], ['ФГУП Икс', 'ФГУП', 'Икс'], ['ГБУ Икс', 'ГБУ', 'Икс'],
      ['Общество с ограниченной ответственностью «Ромашка»', 'ООО', '«Ромашка»'], ['Индивидуальный предприниматель Иванов', 'ИП', 'Иванов'],
      ['Акционерное общество Икс', 'АО', 'Икс'], ['Публичное акционерное общество Икс', 'ПАО', 'Икс'], ['Автономная некоммерческая организация Икс', 'АНО', 'Икс'],
    ]) assert.deepEqual(splitLegalForm(text), { form, name }, text)
    for (const not of ['', 'Ромашка', 'ООО', 'ИП', 'ИПотека', 'СЗМК', 'Аотека', 'Ромашка ООО', '«СЗ Инвест»', 'ГК Стройка']) assert.equal(splitLegalForm(not), null, not)
  })

  it('форма по ИНН: только когда цифр столько, сколько бывает; список при известном ИНН сужается', () => {
    assert.equal(guessLegalForm('7707083893'), 'ООО')
    assert.equal(guessLegalForm('500100732259'), 'ИП')
    for (const unknown of ['', '770708', '77070838931', null]) assert.equal(guessLegalForm(unknown), '', String(unknown))
    assert.deepEqual(legalFormsForInn('500100732259').map((f) => f.code), ['ИП', 'СЗ'])
    const orgs = legalFormsForInn('7707083893').map((f) => f.code)
    assert.ok(orgs.includes('ООО') && orgs.includes('АО') && !orgs.includes('ИП'), orgs.join())
    assert.equal(legalFormsForInn('').length, orgs.length + 2)
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
    assert.equal(companyNameKey('СЗ Иванов Иван'), companyNameKey('ИП Иванов Иван'), 'самозанятый и ИП — один человек')
    for (const same of ['АНО Ромашка', 'ГУП Ромашка', 'ФГУП Ромашка', 'Публичное акционерное общество Ромашка']) assert.equal(companyNameKey(same), key, same)
    assert.equal(isPublicMailDomain('gmail.com'), true)
    assert.equal(isPublicMailDomain('company.ru'), false)
  })

  it('вся форма: значения приведены; форма подставлена в название; длина ИНН по форме; у ИП и СЗ нет КПП; согласие обязательно', () => {
    const form = { email: ' a@b.ru ', legalForm: 'ООО', companyName: '  «Ромашка»  2 ', inn: '77 07 083 893', kpp: '770101001', contactName: ' Иванов  И. ', phone: '8 916 123-45-67 доб. 12', consent: true }
    assert.deepEqual(validateSignup(form), { ok: true, value: { email: 'a@b.ru', companyName: 'ООО «Ромашка» 2', inn: '7707083893', kpp: '770101001', contactName: 'Иванов И.', phone: '+79161234567 доб. 12' } })
    const ip = { ...form, legalForm: 'ИП', companyName: 'Иванов И.И.', inn: '500100732259', kpp: '' }
    assert.equal(validateSignup(ip).value.companyName, 'ИП Иванов И.И.')
    assert.equal(validateSignup({ ...ip, legalForm: 'СЗ' }).value.companyName, 'СЗ Иванов И.И.')
    assert.equal(validateSignup({ ...ip, kpp: '770101001' }).field, 'kpp')
    assert.equal(validateSignup({ ...form, legalForm: 'ПАО' }).value.companyName, 'ПАО «Ромашка» 2')
    assert.equal(validateSignup({ ...form, kpp: '7701ab001' }).value.kpp, '7701AB001', 'КПП с буквами')
    assert.equal(validateSignup({ ...form, kpp: 'AB0101001' }).field, 'kpp')
    assert.equal(validateSignup({ ...form, legalForm: 'constructor' }).field, 'companyName')
    assert.match(validateSignup({ ...form, inn: '500100732259', kpp: '' }).message, /ИНН у ООО — 10 цифр/)
    assert.match(validateSignup({ ...form, legalForm: 'СЗ', inn: '7707083893', kpp: '' }).message, /ИНН у СЗ — 12 цифр/)
    assert.match(validateSignup({ ...form, inn: 'ИНН 7707083893' }).message, /только цифры/)
    assert.equal(validateSignup({ ...form, consent: 'да' }).field, 'consent')
    assert.equal(validateSignup({}).field, 'email')
  })

  it('вся форма: форма необязательна; не передана — из названия; снятая человеком — название как есть', () => {
    const form = { email: 'a@b.ru', inn: '7707083893', contactName: 'Иванов И.', phone: '9161234567', consent: true }
    const name = (over) => validateSignup({ ...form, ...over }).value?.companyName
    assert.equal(name({ companyName: 'Ромашка' }), 'Ромашка', 'формы нет — и не надо')
    assert.equal(name({ companyName: 'ао  «Ромашка»' }), 'АО «Ромашка»', 'из названия, в одном написании')
    assert.equal(name({ companyName: 'Акционерное общество Ромашка' }), 'АО Ромашка')
    assert.equal(name({ companyName: 'ООО Ромашка', legalForm: 'ООО' }), 'ООО Ромашка', 'форма не задваивается')
    assert.equal(name({ companyName: 'СЗ Инвест', legalForm: 'ООО' }), 'ООО СЗ Инвест', 'другая форма в названии — часть названия')
    assert.equal(name({ companyName: 'СЗ Инвест', legalForm: '' }), 'СЗ Инвест', 'человек убрал форму')
    assert.equal(name({ companyName: 'Иванов', inn: '500100732259' }), 'Иванов', 'служба по ИНН форму не ставит')
    for (const empty of [{ companyName: 'ООО' }, { companyName: 'ООО', legalForm: 'ООО' }, { companyName: 'Я', legalForm: 'ООО' }, { companyName: '' }]) {
      assert.equal(validateSignup({ ...form, ...empty }).field, 'companyName', JSON.stringify(empty))
    }
    assert.equal(validateSignup({ ...form, companyName: 'ООО =cmd()' }).field, 'companyName', 'формула после формы')
    assert.equal(name({ companyName: 'Я'.repeat(295), legalForm: 'ФГУП' }).length, 300, 'с самой длинной формой — в пределах базы')
    assert.equal(validateSignup({ ...form, companyName: 'Я'.repeat(296), legalForm: 'ООО' }).field, 'companyName')
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
