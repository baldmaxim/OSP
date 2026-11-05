// Заранее сжатые копии файлов сборки (scripts/precompress-dist.mjs): nginx отдаёт их готовыми (gzip_static). Копия — только
// у того, что сжимается и лежит в подкаталоге; служебные файлы корня и уже сжатое не трогаем; копия распаковывается в исходник.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { precompress, MIN_BYTES } from '../../scripts/precompress-dist.mjs'

describe('Сжатие файлов сборки', () => {
  it('копии — у кода и стилей в assets; маленькие, несжимаемые и файлы корня — без копий', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-precompress-'))
    try {
      fs.mkdirSync(path.join(dir, 'assets'))
      fs.mkdirSync(path.join(dir, 'fonts', 'inter'), { recursive: true })
      const js = 'export const a = "повтор";\n'.repeat(500)
      fs.writeFileSync(path.join(dir, 'assets', 'chunk-abc.js'), js)
      fs.writeFileSync(path.join(dir, 'assets', 'style-abc.css'), 'a{color:red}\n'.repeat(500))
      fs.writeFileSync(path.join(dir, 'assets', 'small.js'), 'x'.repeat(MIN_BYTES - 1))
      fs.writeFileSync(path.join(dir, 'assets', 'noise.js'), crypto.randomBytes(20000))
      fs.writeFileSync(path.join(dir, 'assets', 'logo.png'), crypto.randomBytes(5000))
      fs.writeFileSync(path.join(dir, 'fonts', 'inter', 'inter.woff2'), crypto.randomBytes(5000))
      fs.writeFileSync(path.join(dir, 'index.html'), '<div></div>'.repeat(500))
      fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ buildId: 'x'.repeat(2000) }))
      fs.writeFileSync(path.join(dir, 'sw.js'), 'self;'.repeat(500))

      const stats = await precompress(dir)
      const copies = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.gz')).map(String).sort()
      assert.deepEqual(copies, [path.join('assets', 'chunk-abc.js.gz'), path.join('assets', 'style-abc.css.gz')])
      assert.equal(stats.files, 2)
      assert.ok(stats.after < stats.before / 5)
      assert.equal(gunzipSync(fs.readFileSync(path.join(dir, 'assets', 'chunk-abc.js.gz'))).toString('utf8'), js)
      assert.ok(fs.existsSync(path.join(dir, 'assets', 'chunk-abc.js')), 'исходный файл остаётся: он нужен браузеру без gzip')

      // Повтор безопасен: сжатые копии не сжимаются ещё раз.
      await precompress(dir)
      assert.equal(fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.gz.gz')).length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
