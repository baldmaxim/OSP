// Миниатюра одной обложки в отдельном процессе (запускает src/lib/coverThumbs.js — renderInChild).
//
// Обложку присылают люди, и файл может оказаться каким угодно: библиотека изображений — машинный код, её сбой
// или нехватка памяти уронили бы весь API, а обложка показывалась бы снова — и API падал бы снова. Здесь упадёт
// только этот процесс, сайт покажет оригинал. Живёт одну обложку, приоритет низкий, родитель снимает по таймауту.
// Замер на обложках прода при потолке службы (384 МБ, 0,45 процессора): 0,4–0,6 с, память — до 94 МБ.
import fs from 'node:fs'
import os from 'node:os'
import sharp from 'sharp'
import { COVER_THUMB_BOX, COVER_THUMB_QUALITY, COVER_THUMB_MAX_PIXELS } from './covers.js'

try { os.setPriority(19) } catch { /* без права менять приоритет — как есть */ }
// Память контейнера общая с API, потолок --max-old-space-size на память библиотеки не действует: при нехватке система
// должна снять этот процесс, а не службу. Повысить себе эту отметку можно без особых прав.
try { fs.writeFileSync('/proc/self/oom_score_adj', '1000') } catch { /* не Linux — как есть */ }
// Один поток и без кэша: процесс живёт одну картинку, а процессор и память службы общие.
sharp.cache(false)
sharp.concurrency(1)

process.once('message', async (msg) => {
  let out
  try {
    const input = Buffer.from(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength)
    // rotate() без аргумента — по отметке EXIF: метаданные в миниатюру не попадают, и снимок с телефона иначе лёг бы набок.
    // fit: 'outside' — миниатюра закрывает всю рамку карточки по обеим сторонам (object-fit: cover обрежет лишнее сам):
    // при ужатии только по ширине панорама растянулась бы по высоте и стала мутной.
    const data = await sharp(input, { limitInputPixels: COVER_THUMB_MAX_PIXELS })
      .rotate()
      .resize({ ...COVER_THUMB_BOX, fit: 'outside', withoutEnlargement: true })
      .webp({ quality: COVER_THUMB_QUALITY })
      .toBuffer()
    out = { bytes: data }
  } catch (e) {
    out = { error: 'broken', message: String(e?.message || e).slice(0, 200) }
  }
  process.send(out, () => process.exit(0))
})
