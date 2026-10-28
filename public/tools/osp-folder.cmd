@if (@X)==(@Y) @end /* OSP portal folder helper: batch part, then JScript
@echo off
start "" "%SystemRoot%\System32\wscript.exe" //E:JScript //Nologo "%~f0" %*
exit /b
*/

// Помощник «Открыть папку» портала ОСП (tender.su10.ru): путь к папке на сайте открывается в проводнике Windows.
//
// Браузер сам на file:// и на сетевой путь со страницы по https не переходит (Chrome и Edge молча блокируют), поэтому
// сайт открывает ссылку своей схемы osp-folder:<путь, закодированный encodeURIComponent>, а этот файл её обрабатывает:
// проверяет путь и открывает папку в проводнике. Ничего не запускает: файл по такому пути только выделяется в папке.
//
// Один файл — и установщик, и обработчик. Двойной щелчок (без аргументов) — установка для текущего пользователя, без
// прав администратора: копия в %LOCALAPPDATA%\OSP\osp-folder.js и схема osp-folder в HKCU\Software\Classes. Ключ
// /uninstall — удалить. С аргументом-ссылкой — открыть папку. Первые строки — пакетный файл Windows (cmd запускает
// этот же файл в wscript), для JScript они — условная компиляция и комментарий.
//
// Файл — в ANSI-кодировке Windows Script Host: строки с кириллицей записаны кодами \uXXXX, русский текст — в
// комментарии над ними. Синтаксис — ES3 (JScript 5.8): без let/const, стрелок, trim, indexOf у массивов, JSON.
// Проверка — tests/tender/folder-open.test.mjs (разбор ES3, обработка ссылок и установка на подделках WScript).

var SCHEME = 'osp-folder'
var CLASSES_KEY = 'HKCU\\Software\\Classes\\' + SCHEME + '\\'

// Сетевой путь — только к серверу локальной сети: имя без точки (как \\su10-fs), адрес 10.*, 172.16–31.*, 192.168.*
// или имя в этих доменах. Чужой сервер не пускаем: обращаясь к сетевой папке, Windows передаёт серверу данные входа.
// Свой домен файловых серверов, если он другой, — дописать сюда.
var SERVER_DOMAINS = ['su10.ru', 'su10.local', 'local', 'lan']

// Портал ОСП — открыть папку
var TITLE = '\u041f\u043e\u0440\u0442\u0430\u043b \u041e\u0421\u041f \u2014 \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0430\u043f\u043a\u0443'
var MSG = {
  // Установить помощник «Открыть папку» для портала ОСП? …
  install: '\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c \u043f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u00ab\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0430\u043f\u043a\u0443\u00bb \u0434\u043b\u044f \u043f\u043e\u0440\u0442\u0430\u043b\u0430 \u041e\u0421\u041f?\n\n'
    + '\u041f\u043e\u0441\u043b\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438 \u043f\u0443\u0442\u044c \u043a \u043f\u0430\u043f\u043a\u0435 \u043d\u0430 \u0441\u0430\u0439\u0442\u0435 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442\u0441\u044f \u0432 \u043f\u0440\u043e\u0432\u043e\u0434\u043d\u0438\u043a\u0435 Windows \u043e\u0434\u043d\u0438\u043c \u043d\u0430\u0436\u0430\u0442\u0438\u0435\u043c. '
    + '\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0442\u043e\u043b\u044c\u043a\u043e \u043f\u0430\u043f\u043a\u0438 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e\u0439 \u0441\u0435\u0442\u0438 (\\\\\u0441\u0435\u0440\u0432\u0435\u0440\\\u043f\u0430\u043f\u043a\u0430 \u0438\u043b\u0438 X:\\\u043f\u0430\u043f\u043a\u0430) \u0438 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430\u0435\u0442.',
  // Помощник уже установлен. Да — установить заново, Нет — удалить, Отмена — ничего не менять.
  reinstall: '\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u00ab\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0430\u043f\u043a\u0443\u00bb \u0443\u0436\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d.\n\n'
    + '\u0414\u0430 \u2014 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c \u0437\u0430\u043d\u043e\u0432\u043e, \u041d\u0435\u0442 \u2014 \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u043e\u043c\u043e\u0449\u043d\u0438\u043a, \u041e\u0442\u043c\u0435\u043d\u0430 \u2014 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043c\u0435\u043d\u044f\u0442\u044c.',
  // Готово. Вернитесь на сайт и нажмите на путь к папке. …
  installed: '\u0413\u043e\u0442\u043e\u0432\u043e. \u0412\u0435\u0440\u043d\u0438\u0442\u0435\u0441\u044c \u043d\u0430 \u0441\u0430\u0439\u0442 \u0438 \u043d\u0430\u0436\u043c\u0438\u0442\u0435 \u043d\u0430 \u043f\u0443\u0442\u044c \u043a \u043f\u0430\u043f\u043a\u0435.\n\n'
    + '\u0411\u0440\u0430\u0443\u0437\u0435\u0440 \u043e\u0434\u0438\u043d \u0440\u0430\u0437 \u0441\u043f\u0440\u043e\u0441\u0438\u0442, \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u043b\u0438 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435, \u2014 \u043e\u0442\u043c\u0435\u0442\u044c\u0442\u0435 \u00ab\u0412\u0441\u0435\u0433\u0434\u0430 \u0440\u0430\u0437\u0440\u0435\u0448\u0430\u0442\u044c\u00bb \u0438 \u043d\u0430\u0436\u043c\u0438\u0442\u0435 \u00ab\u041e\u0442\u043a\u0440\u044b\u0442\u044c\u00bb.',
  // Помощник удалён.
  removed: '\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u00ab\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0430\u043f\u043a\u0443\u00bb \u0443\u0434\u0430\u043b\u0451\u043d.',
  // Это не путь к папке локальной сети: …
  badPath: '\u042d\u0442\u043e \u043d\u0435 \u043f\u0443\u0442\u044c \u043a \u043f\u0430\u043f\u043a\u0435 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e\u0439 \u0441\u0435\u0442\u0438:\n',
  // Помощник открывает только пути вида \\сервер\папка или X:\папка.
  badPathHint: '\n\n\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0442\u043e\u043b\u044c\u043a\u043e \u043f\u0443\u0442\u0438 \u0432\u0438\u0434\u0430 \\\\\u0441\u0435\u0440\u0432\u0435\u0440\\\u043f\u0430\u043f\u043a\u0430 \u0438\u043b\u0438 X:\\\u043f\u0430\u043f\u043a\u0430.',
  // Сервер не из локальной сети: …
  badServer: '\u0421\u0435\u0440\u0432\u0435\u0440 \u043d\u0435 \u0438\u0437 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e\u0439 \u0441\u0435\u0442\u0438 \u2014 \u043f\u0430\u043f\u043a\u0443 \u043d\u0435 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u044e:\n',
  // Папка не найдена или к ней нет доступа: …
  notFound: '\u041f\u0430\u043f\u043a\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430 \u0438\u043b\u0438 \u043a \u043d\u0435\u0439 \u043d\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0430:\n',
  // Проверьте путь на сайте и доступ к сетевой папке.
  notFoundHint: '\n\n\u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u043f\u0443\u0442\u044c \u043d\u0430 \u0441\u0430\u0439\u0442\u0435 \u0438 \u0434\u043e\u0441\u0442\u0443\u043f \u043a \u0441\u0435\u0442\u0435\u0432\u043e\u0439 \u043f\u0430\u043f\u043a\u0435.',
  // Не удалось: …
  failed: '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c: '
}

var shell = new ActiveXObject('WScript.Shell')
var fso = new ActiveXObject('Scripting.FileSystemObject')

function popup(text, type) {
  return shell.Popup(text, 0, TITLE, type)
}

function handlerPath() {
  return shell.ExpandEnvironmentStrings('%LOCALAPPDATA%') + '\\OSP\\osp-folder.js'
}

function systemRoot() {
  return shell.ExpandEnvironmentStrings('%SystemRoot%')
}

// Ссылка osp-folder:<путь> → путь. Браузер передаёт ссылку как есть, с кодами %XX.
function pathFromUrl(url) {
  var m = /^osp-folder:(.*)$/i.exec(String(url))
  if (!m) return null
  var raw = m[1].replace(/^\/\//, '').replace(/\/+$/, '')
  var path
  try { path = decodeURIComponent(raw) } catch (e) { return null }
  return path.replace(/^\s+|\s+$/g, '').replace(/\//g, '\\')
}

function endsWith(text, tail) {
  return text.length >= tail.length && text.slice(text.length - tail.length) === tail
}

function serverAllowed(host) {
  var h = String(host).toLowerCase()
  if (/^[a-z0-9_][a-z0-9_-]*$/.test(h)) return true
  var ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ip) {
    var a = Number(ip[1])
    var b = Number(ip[2])
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  for (var i = 0; i < SERVER_DOMAINS.length; i++) {
    if (endsWith(h, '.' + SERVER_DOMAINS[i])) return true
  }
  return false
}

// Почему путь не открываем: 'format' — не путь к папке Windows, 'server' — сервер не из локальной сети; null — можно.
// До проверки на диске: обращение к сетевому пути — уже соединение с сервером.
function rejectPath(path) {
  if (!path || path.length > 1024 || /[\x00-\x1f"<>|*?]/.test(path)) return 'format'
  var unc = /^\\\\([^\\]+)\\[^\\]+/.exec(path)
  if (unc) return serverAllowed(unc[1]) ? null : 'server'
  if (/^[A-Za-z]:\\/.test(path)) return null
  return 'format'
}

// Аргумент проводника: корень диска — как есть («C:\»), остальное — в кавычках и без «\» в конце.
function explorerArg(path) {
  if (/^[A-Za-z]:\\$/.test(path)) return path
  return '"' + path.replace(/\\+$/, '') + '"'
}

function openFolder(url) {
  var path = pathFromUrl(url)
  var why = path == null ? 'format' : rejectPath(path)
  if (why === 'server') return popup(MSG.badServer + path, 48)
  if (why) return popup(MSG.badPath + (path == null ? url : path) + MSG.badPathHint, 48)
  var explorer = '"' + systemRoot() + '\\explorer.exe" '
  if (fso.FolderExists(path)) return shell.Run(explorer + explorerArg(path), 1, false)
  // Путь к файлу — показать файл в его папке, не открывая его.
  if (fso.FileExists(path)) return shell.Run(explorer + '/select,' + explorerArg(path), 1, false)
  return popup(MSG.notFound + path + MSG.notFoundHint, 48)
}

function installed() {
  try { shell.RegRead(CLASSES_KEY + 'shell\\open\\command\\') } catch (e) { return false }
  return fso.FileExists(handlerPath())
}

function uninstall(quiet) {
  var keys = ['shell\\open\\command\\', 'shell\\open\\', 'shell\\', '']
  // Ключа нет или файл занят — удаляем, что можно.
  for (var i = 0; i < keys.length; i++) {
    try { shell.RegDelete(CLASSES_KEY + keys[i]) } catch (e) { }
  }
  try { if (fso.FileExists(handlerPath())) fso.DeleteFile(handlerPath(), true) } catch (e) { }
  if (!quiet) popup(MSG.removed, 64)
}

function install() {
  // Да / Нет / Отмена: 6 / 7 / 2.
  var answer = installed() ? popup(MSG.reinstall, 3 + 32) : popup(MSG.install, 4 + 32)
  if (answer === 7 && installed()) return uninstall(false)
  if (answer !== 6) return null
  var target = handlerPath()
  var dir = fso.GetParentFolderName(target)
  if (!fso.FolderExists(dir)) fso.CreateFolder(dir)
  // Копия — побайтно через ADODB.Stream: CopyFile перенёс бы отметку «скачано из интернета» (Zone.Identifier).
  var stream = new ActiveXObject('ADODB.Stream')
  stream.Type = 1
  stream.Open()
  stream.LoadFromFile(WScript.ScriptFullName)
  stream.SaveToFile(target, 2)
  stream.Close()
  var wscript = systemRoot() + '\\System32\\wscript.exe'
  shell.RegWrite(CLASSES_KEY, 'URL:OSP folder', 'REG_SZ')
  shell.RegWrite(CLASSES_KEY + 'URL Protocol', '', 'REG_SZ')
  shell.RegWrite(CLASSES_KEY + 'shell\\open\\command\\',
    '"' + wscript + '" //E:JScript //Nologo "' + target + '" "%1"', 'REG_SZ')
  return popup(MSG.installed, 64)
}

function main() {
  var args = WScript.Arguments
  if (args.length === 0) return install()
  var first = String(args.Item(0))
  if (/^[\/-]uninstall$/i.test(first)) return uninstall(false)
  return openFolder(first)
}

try {
  main()
} catch (e) {
  popup(MSG.failed + (e.message || e), 16)
}
