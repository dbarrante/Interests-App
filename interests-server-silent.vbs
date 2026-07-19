' ============================================================
'  RETIRED 2026-07-18. This launcher used to start a hidden
'  python http.server on port 3456 (pre-Electron era) — and a
'  copy in the Windows Startup folder kept resurrecting it,
'  squatting the installed app's port at every login. If run
'  now, it just opens the real app.
' ============================================================
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\Interests App\Interests App.exe""", 1, False
