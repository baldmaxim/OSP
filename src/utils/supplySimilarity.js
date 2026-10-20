// Похожесть наименований материалов (миграция 20261025): «похожие цены» других тендеров и сопоставление строк
// счёта / КП поставщика с позициями ВОР. Тот же расчёт — в базе (supply_name_stems / supply_name_nums,
// supply_name_score, supply_name_word_share): совпадение сторожит tests/supply/similarity.test.mjs. Меняете здесь —
// меняйте и функции базы (новой миграцией).
//
// Прежняя похожесть (20261023) считала общие слова и числа одной кучей: у клапанов одной серии разных размеров
// («Сигмавент-90-НО-450x350» и «…-300x300») общих было больше половины — на копии прода 15.10 у позиции набиралось
// до полутора сотен «похожих» цен, и нужная терялась среди других размеров. Теперь:
//  • слова и числа считаются отдельно, итог — 0,4 × слова + 0,6 × числа (чисел нет у обоих — только слова; есть у
//    одного — слова × 0,8);
//  • размер «700x700» («700 х 700», «700*700», «400x300» = «300x400») — одно число с двойным весом; у обоих свои
//    числа вместо общих (другой размер, длина, серия) — штраф: это уже другой материал;
//  • слова — по основе («трубы» = «труба», «стальная» = «стальной»), сокращение — по началу слова не короче 4 букв
//    («оцинк.» = «оцинкованная»); двухбуквенные обозначения («НО», «НЗ», «ПП») — тоже слова;
//  • ссылки на ГОСТ / ТУ и единицы со степенью («мм2», «м3/ч») не считаются: их пишут не везде.
// Похожие — слова совпадают не меньше чем на WORDS_MIN и итог не ниже SIMILAR_MIN.

export const SIMILAR_MIN = 0.75
export const WORDS_MIN = 0.6
// Сопоставление строки документа поставщика с позицией ВОР — порог ниже: каждое сопоставление проверяет человек.
export const MATCH_MIN = 0.6
export const MATCH_WORDS_MIN = 0.5

const HOMOGLYPH = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' }
// Служебные слова и единицы внутри наименования — не признак материала (как массив в supply_name_stems).
export const STOP_WORDS = [
  'для', 'или', 'при', 'без', 'тип', 'марка', 'марки', 'на', 'из', 'до', 'от', 'по', 'за', 'не', 'со', 'под', 'над',
  'ед', 'шт', 'мм', 'см', 'дм', 'кг', 'тн', 'мп', 'пм', 'пог', 'кв', 'куб', 'компл', 'комплект', 'квт', 'вт', 'па', 'кпа',
  'мпа', 'гост', 'ту', 'сто', 'снип', 'сп', 'руб', 'ндс', 'mm',
]
const STOP = new Set(STOP_WORDS)
const ENDINGS = 'иями|ями|ами|ием|иях|ого|его|ому|ему|ыми|ими|ией|ий|ый|ой|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ам|ям|ах|ях|ов|ев|ей|ью|ия|ье|а|я|ы|и|е|о|у|ю|ь|й'
const STEM_RE = new RegExp(`^(.{3,}?)(${ENDINGS})$`)

// Основа слова: самое длинное окончание из списка, если от слова остаётся не меньше трёх букв (латиница — как есть).
export const stemWord = (w) => w.replace(STEM_RE, '$1')

// Число «как в документе» → единый вид: ведущие нули целой части и хвостовые нули дроби не важны (032 = 32, 20.0 = 20).
const SIMPLE_NUM = /^[0-9]+(?:\.[0-9]+)?$/
function normPart(p) {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(p)
  if (!m) return p
  const int = m[1].replace(/^0+(?=[0-9])/, '')
  const frac = (m[2] || '').replace(/0+$/, '')
  return frac ? `${int}.${frac}` : int
}
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// Размер — стороны по возрастанию: «400x300» и «300x400» — один размер.
function normNumber(t) {
  const dims = t.split('×').map((dim) => dim.split('/').map(normPart).join('/'))
  if (dims.length < 2) return dims[0]
  return dims.sort((a, b) => {
    const x = SIMPLE_NUM.test(a) ? Number(a) : Infinity
    const y = SIMPLE_NUM.test(b) ? Number(b) : Infinity
    return x !== y ? (x < y ? -1 : 1) : byText(a, b)
  }).join('×')
}

// Подготовка строки — шаг за шагом, как в базе (supply_name_prepare). Все классы символов — явные: \s и \d в
// браузере и в базе понимаются по-разному (неразрывный пробел, цифры других письменностей).
export function prepareName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .toLowerCase()
    // «İ» в браузере — «i» с точкой сверху (два символа), в базе — просто «i»
    .replace(/i\u0307/g, 'i')
    .replace(/ё/g, 'е')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    // всё, кроме букв, цифр и знаков чисел, — пробел (Ø, кавычки, скобки, неразрывные пробелы)
    .replace(/[^a-zа-я0-9.,/×*–—-]+/g, ' ')
    // десятичная запятая → точка
    .replace(/([0-9])[.,](?=[0-9])/g, '$1.')
    // ссылки на стандарты: ГОСТ 10704-91, ГОСТ Р 52134-2003, ТУ 1390-001-…
    .replace(/(^|[^a-zа-я])(гост|ту|сто|снип|сп|din|iso|en) ?(р ?)?[0-9][0-9.–—/-]*/g, '$1 ')
    // единицы со степенью: мм2, м2, м3/ч — число перед ними остаётся
    .replace(/(^|[^a-zа-я])(мм|см|дм|м|m)[23](?![0-9a-zа-я])/g, '$1 ')
    // размер: 700 х 700, 57*3,5, 4x76x700 — одно число через «×»
    .replace(/([0-9]) ?[xх×*] ?(?=[0-9])/g, '$1×')
    // буквы и цифры врозь: dn20 → dn 20, 22cv → 22 cv
    .replace(/([a-zа-я])(?=[0-9])/g, '$1 ')
    .replace(/([0-9])(?=[a-zа-я])/g, '$1 ')
}

const WORD_RE = /^[a-zа-я]+$/
const NUM_RE = /^[0-9.×/]*[0-9][0-9.×/]*$/

// Наименование → { words, nums }: основы слов (без служебных, латиница вместо кириллических двойников) и числа /
// размеры. Оба списка — без повторов, по алфавиту (как массивы в базе).
export function nameParts(name) {
  const words = new Set()
  const nums = new Set()
  for (const raw of prepareName(name).split(/[^a-zа-я0-9.×/]+/)) {
    const chunk = raw.replace(/^[./×]+|[./×]+$/g, '')
    if (!chunk) continue
    const pieces = NUM_RE.test(chunk) ? [chunk] : chunk.split(/[./×]+/)
    for (const t of pieces) {
      if (!t) continue
      if (NUM_RE.test(t)) { nums.add(normNumber(t)); continue }
      if (!WORD_RE.test(t) || t.length < 2 || STOP.has(t)) continue
      words.add(stemWord(t).replace(/[авекмнорстух]/g, (c) => HOMOGLYPH[c]))
    }
  }
  return { words: [...words].sort(byText), nums: [...nums].sort(byText) }
}

// Слово совпадает: то же, или одно — начало другого (оба не короче 4 букв): сокращение, другое окончание.
const sameWord = (x, y) => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)))
const numWeight = (t) => (t.includes('×') ? 2 : 1)
const round3 = (num, den) => (den ? Math.round((1000 * num) / den) / 1000 : 0)
const partsOf = (x) => (typeof x === 'string' ? nameParts(x) : x)

// Похожесть двух наименований (строки или готовые части nameParts): { score, words, sameNums }. score — итог 0…1,
// words — доля совпавших слов с обеих сторон, оба — три знака, половина — вверх (как round(numeric, 3) в базе:
// итог считается дробью целых чисел). sameNums — числа (размеры) у обоих одинаковые.
export function scoreParts(a, b) {
  const pa = partsOf(a)
  const pb = partsOf(b)
  const wDen = pa.words.length + pb.words.length
  let wNum = 0
  for (const x of pa.words) if (pb.words.some((y) => sameWord(x, y))) wNum += 1
  for (const y of pb.words) if (pa.words.some((x) => sameWord(x, y))) wNum += 1
  const na = pa.nums.length
  const nb = pb.nums.length
  let num
  let den
  let sameNums = false
  if (na && nb) {
    const setA = new Set(pa.nums)
    const setB = new Set(pb.nums)
    let common = 0
    let onlyA = 0
    let onlyB = 0
    for (const t of pa.nums) { if (setB.has(t)) common += numWeight(t); else onlyA += numWeight(t) }
    for (const t of pb.nums) if (!setA.has(t)) onlyB += numWeight(t)
    const total = 2 * common + onlyA + onlyB
    // Число есть только у одного (ГОСТ, напряжение дописали не везде) — просто не совпало; у обоих свои числа
    // вместо общих — ещё и штраф.
    const nums = Math.max(0, 2 * common - Math.min(onlyA, onlyB))
    num = 2 * wNum * total + 3 * nums * wDen
    den = 5 * wDen * total
    sameNums = onlyA === 0 && onlyB === 0
  } else if (na || nb) {
    num = 4 * wNum
    den = 5 * wDen
  } else {
    num = wNum
    den = wDen
  }
  return { score: round3(num, den), words: round3(wNum, wDen), sameNums }
}

export const nameScore = (a, b) => scoreParts(a, b).score

// Похожие для «похожих цен»: слова совпадают не меньше чем на WORDS_MIN, итог не ниже SIMILAR_MIN.
export function isSimilar(a, b) {
  const r = scoreParts(a, b)
  return r.words >= WORDS_MIN && r.score >= SIMILAR_MIN
}

// Ед. изм. в едином виде — как kp_norm_unit в базе: «шт.» = «штук», «м.пог.» = «пог. м», «кв.м» = «м2».
const UNIT_MAP = {
  штук: 'шт', штука: 'шт', штуки: 'шт',
  комплект: 'компл', комплекта: 'компл', комплектов: 'компл', 'к-т': 'компл', 'к т': 'компл',
  'кв м': 'м2', квм: 'м2', 'м кв': 'м2',
  'куб м': 'м3', кубм: 'м3', 'м куб': 'м3',
  'м п': 'мп', 'пог м': 'мп', погм: 'мп', 'п м': 'мп', пм: 'мп', 'м пог': 'мп',
}
const UNIT_LATIN = { a: 'а', c: 'с', e: 'е', p: 'р', x: 'х', y: 'у', o: 'о' }
export function normUnit(u) {
  const s = String(u ?? '').toLowerCase().replace(/ё/g, 'е').replace(/²/g, '2').replace(/³/g, '3')
    .replace(/[acepxyo]/g, (c) => UNIT_LATIN[c])
    .replace(/[«»"'`()]/g, '')
    .replace(/[\s.]+/g, ' ')
    .trim()
  return UNIT_MAP[s] || s
}

// Ед. изм. совместимы: одинаковые в едином виде; метр и погонный метр — одно; не указана у одной стороны — не мешает.
const METRE = new Set(['м', 'мп'])
export function unitsCompatible(a, b) {
  const x = normUnit(a)
  const y = normUnit(b)
  if (!x || !y || x === y) return true
  return METRE.has(x) && METRE.has(y)
}
