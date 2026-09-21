// Сборка тендерного стенда: настоящая страница src/pages/TendersPage.jsx,
// собранная esbuild'ом, с подменой Supabase и RoleContext на заглушки.
//
//   node .tmp-preview/build.mjs           # все варианты
//   node .tmp-preview/build.mjs new       # только рабочее дерево (быстро)
//   node .tmp-preview/build.mjs old cur
//
// Варианты:
//   old — git 09dbcf6 (до рабочего стиля), cur — HEAD, new — живой src/.
// Исходники old/cur выкладываются в .tmp-preview/variants/<v>/src один раз и
// переразворачиваются только при смене ревизии.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const OUT = path.join(HERE, 'out')
const VARIANTS_DIR = path.join(HERE, 'variants')
const STUBS = path.join(HERE, 'stubs')

export const VARIANTS = {
  old: { rev: '09dbcf6', label: 'old · 09dbcf6 «ВОРы и РД»' },
  cur: { rev: 'HEAD', label: 'cur · HEAD' },
  new: { rev: null, label: 'new · рабочее дерево src/' },
}

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()

// src ревизии → .tmp-preview/variants/<name>/src (через git archive + tar).
function materialize(name, rev) {
  const sha = git('rev-parse', rev)
  const dir = path.join(VARIANTS_DIR, name)
  const stamp = path.join(dir, '.rev')
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === sha) return path.join(dir, 'src')

  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tar = path.join(dir, '_src.tar')
  fs.writeFileSync(tar, execFileSync('git', ['-C', REPO, 'archive', '--format=tar', sha, 'src'], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  }))
  // Имя файла — относительное, cwd = dir: GNU tar из Git for Windows принимает
  // «C:\...» за адрес удалённой машины («Cannot connect to C:»).
  execFileSync('tar', ['-xf', '_src.tar'], { cwd: dir, stdio: 'inherit' })
  fs.rmSync(tar, { force: true })
  fs.writeFileSync(stamp, sha)
  console.log(`  ${name}: развёрнут src из ${sha.slice(0, 7)}`)
  return path.join(dir, 'src')
}

// Шрифты Google (Golos Text — базовый шрифт интерфейса, Inter) кладём рядом со
// стендом и отдаём со своего сервера. Иначе висящий fonts.googleapis.com
// блокирует и разбор стилей, и выполнение бандла: страница просто не грузится.
const FONTS_DIR = path.join(HERE, 'assets', 'fonts')
const FONTS_CSS = path.join(FONTS_DIR, 'google.css')
const FONTS_URL = 'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap'
// UA Chrome обязателен: иначе Google отдаёт ttf вместо woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function ensureGoogleFonts() {
  if (fs.existsSync(FONTS_CSS)) return true
  fs.mkdirSync(FONTS_DIR, { recursive: true })
  try {
    const res = await fetch(FONTS_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
    let css = await res.text()
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]))]
    let n = 0
    for (const url of urls) {
      const name = url.split('/').slice(-2).join('-')
      const file = path.join(FONTS_DIR, name)
      if (!fs.existsSync(file)) {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
        n += 1
      }
      css = css.split(url).join(`./${name}`)
    }
    fs.writeFileSync(FONTS_CSS, css)
    console.log(`  шрифты: скачано ${n} файлов → ${path.relative(REPO, FONTS_DIR)}`)
    return true
  } catch (err) {
    console.warn(`  шрифты: не скачались (${err.message}) — стенд возьмёт системные`)
    return false
  }
}

const EXTS = ['', '.jsx', '.js', '.ts', '.tsx', '/index.jsx', '/index.js']
function resolveFile(base) {
  for (const ext of EXTS) {
    const p = base + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

// Заглушки ставятся ПЕРВЫМИ: иначе @variant/contexts/RoleContext уедет в алиас.
function standPlugin(variantSrc) {
  return {
    name: 'stand',
    setup(build) {
      const stubSupabase = path.join(STUBS, 'supabase.js')
      const stubRole = path.join(STUBS, 'RoleContext.jsx')
      const emptyCss = path.join(STUBS, 'empty.css')

      // Абсолютные ссылки из CSS (/fonts/inter/*.woff2, /favicon.svg) отдаёт
      // статический сервер из public/ — в бандл их тянуть не нужно.
      build.onResolve({ filter: /^\/[^/]/ }, (args) => ({ path: args.path, external: true }))

      build.onResolve({ filter: /(^|[\\/])supabase([\\/](client|index)(\.js)?)?$/ }, (args) => {
        if (args.path.startsWith('@supabase/')) return null
        return { path: stubSupabase }
      })
      build.onResolve({ filter: /RoleContext(\.jsx)?$/ }, () => ({ path: stubRole }))
      build.onResolve({ filter: /^@variant\// }, (args) => {
        const rel = args.path.slice('@variant/'.length)
        const found = resolveFile(path.join(variantSrc, rel))
        // Файла в этой ревизии нет (например, mobile.css в старой) — пустышка.
        if (!found) return { path: rel.endsWith('.css') ? emptyCss : null, external: !rel.endsWith('.css') }
        return { path: found }
      })
    },
  }
}

const HTML = (variant, label, fontsLink) => `<!doctype html>
<html lang="ru" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- data:, — чтобы браузер не просил favicon.ico и не сорил 404 в консоль -->
    <link rel="icon" href="data:," />
    <title>Стенд тендеров — ${label}</title>
    ${fontsLink}
    <script>
      // «Сегодня» фиксируем ДО загрузки бандла: снимки вариантов должны
      // совпадать в любой день. ?now=real — настоящая дата.
      (function () {
        var iso = new URLSearchParams(location.search).get('now') || '2026-09-21T10:00:00';
        if (iso === 'real') return;
        var fixed = new Date(iso).getTime();
        var Real = Date;
        function Fake(a, b, c, d, e, f, g) {
          switch (arguments.length) {
            case 0: return new Real(fixed);
            case 1: return new Real(a);
            case 2: return new Real(a, b);
            case 3: return new Real(a, b, c);
            case 4: return new Real(a, b, c, d);
            case 5: return new Real(a, b, c, d, e);
            case 6: return new Real(a, b, c, d, e, f);
            default: return new Real(a, b, c, d, e, f, g);
          }
        }
        Fake.prototype = Real.prototype;
        Fake.now = function () { return fixed; };
        Fake.parse = Real.parse;
        Fake.UTC = Real.UTC;
        window.Date = Fake;
      })();
    </script>
    <link rel="stylesheet" href="./app.css" />
    <style>
      /* Место сайдбара приложения — 200px (components/Sidebar.css). */
      .stand-sidebar { width: 200px; flex: 0 0 200px; height: 100vh; background: #0f1728; }
      @media (max-width: 640px) { .stand-sidebar { display: none; } }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.__STAND_ERRORS__ = [];
      addEventListener('error', function (e) { window.__STAND_ERRORS__.push(String(e.message || e.error)); });
      addEventListener('unhandledrejection', function (e) { window.__STAND_ERRORS__.push('unhandledrejection: ' + String(e.reason && e.reason.message || e.reason)); });
    </script>
    <script src="./app.js"></script>
    <!-- вариант: ${variant} -->
  </body>
</html>
`

export async function buildVariant(name) {
  const cfg = VARIANTS[name]
  if (!cfg) throw new Error(`Неизвестный вариант: ${name}`)
  const started = Date.now()
  const hasLocalFonts = await ensureGoogleFonts()
  const variantSrc = cfg.rev ? materialize(name, cfg.rev) : path.join(REPO, 'src')
  const outdir = path.join(OUT, name)
  fs.mkdirSync(outdir, { recursive: true })

  await esbuild.build({
    entryPoints: [path.join(HERE, 'entry.jsx')],
    outfile: path.join(outdir, 'app.js'),
    bundle: true,
    format: 'iife',
    target: ['chrome110'],
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.woff2': 'file', '.woff': 'file', '.png': 'file', '.svg': 'dataurl' },
    define: {
      'import.meta.env': JSON.stringify({
        MODE: 'development', DEV: true, PROD: false, BASE_URL: '/',
        VITE_SUPABASE_URL: 'http://stand.local', VITE_SUPABASE_ANON_KEY: 'stand',
      }),
      'process.env.NODE_ENV': '"development"',
      __BUILD_ID__: '"stand"',
    },
    plugins: [standPlugin(variantSrc)],
    logLevel: 'warning',
    sourcemap: false,
    absWorkingDir: REPO,
  })

  const fontsLink = hasLocalFonts
    ? '<link rel="stylesheet" href="/assets/fonts/google.css" />'
    : '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" />'
  fs.writeFileSync(path.join(outdir, 'index.html'), HTML(name, cfg.label, fontsLink))
  console.log(`  ${name}: собран за ${Date.now() - started} мс → ${path.relative(REPO, outdir)}`)
  return outdir
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const list = asked.length ? asked : Object.keys(VARIANTS)
  console.log(`Сборка стенда: ${list.join(', ')}`)
  for (const name of list) await buildVariant(name)
  console.log('Готово.')
}
