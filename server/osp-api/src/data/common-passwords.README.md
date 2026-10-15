# common-passwords.txt.gz — список запрета для новых паролей

Новый пароль (смена, временный от администратора) сравнивается целиком с этим списком
(`src/lib/auth/policy.js`, NIST SP 800-63B-4: проверка по списку распространённых и утёкших паролей).

- **Источник:** SecLists, `Passwords/Common-Credentials/Pwdb_top-10000000.txt` — 10 млн самых частых паролей
  из утёкших баз; коммит `12274c98fdebe98c7a7284914436a472ed469aed` (2025-03-22), лицензия MIT.
  sha256 исходного файла: `18dc49ca32b62455a61e3398f4ab9f93eb700ff142fa0d4b9fd11a727f3b80e4`.
- **Отбор:** строка → NFC → нижний регистр; оставлены строки длиной 15–128 кодовых точек (короче 15 новый
  пароль не принимается и так), без повторов, в исходном порядке. 122 473 строки.
- **Файл:** gzip (mtime 0), sha256 `6559be0fcc6e29ee18b0348c50e6427a4cceb643a3187d45674b25d38ba86648`;
  тест сверяет сумму, чтобы подмена списка была видна в diff.

Пересобрать:
```bash
python3 -I -c "import sys,unicodedata,gzip; seen=set(); out=[]
for line in open(sys.argv[1], encoding='utf-8'):
    s = unicodedata.normalize('NFC', line.rstrip('\r\n')).lower()
    if 15 <= len(s) <= 128 and s not in seen: seen.add(s); out.append(s)
g = gzip.GzipFile(sys.argv[2], 'wb', mtime=0); g.write(('\n'.join(out) + '\n').encode()); g.close()" \
  Pwdb_top-10000000.txt server/osp-api/src/data/common-passwords.txt.gz
```
