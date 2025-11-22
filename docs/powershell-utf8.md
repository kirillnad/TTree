# PowerShell и UTF-8

Чтобы не ловить кракозябры при работе с проектом:

1. Включите UTF-8 в сессии: `chcp 65001` (лучше добавить в профиль или запускать оболочку с этим флагом).
2. Всегда задавайте кодировку при записи файлов: `Set-Content -Encoding UTF8`, `Out-File -Encoding UTF8`, или используйте .NET API: `[IO.File]::WriteAllText(path, content, [Text.UTF8Encoding]::new($false))`.
3. Избегайте редактирования русских строк через консоль без явной кодировки. Правьте через IDE или `apply_patch`.
4. Для временного принудительного сохранения всех текстовых файлов в UTF-8:
   ```powershell
   $enc = [Text.UTF8Encoding]::new($false)
   Get-ChildItem client -Recurse -Include *.js,*.css,*.html | ForEach-Object {
     $c = [IO.File]::ReadAllText($_.FullName)
     [IO.File]::WriteAllText($_.FullName, $c, $enc)
   }
   Get-ChildItem servpy/app -Recurse -Include *.py | ForEach-Object {
     $c = [IO.File]::ReadAllText($_.FullName)
     [IO.File]::WriteAllText($_.FullName, $c, $enc)
   }
   ```
5. Если нужен чистый вывод в консоль, запускайте PowerShell/Windows Terminal с `-ExecutionPolicy Bypass` и `chcp 65001`.

Держите этот файл под рукой и напоминайте себе запускать `chcp 65001` перед консольными правками.
