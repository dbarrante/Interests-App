' ============================================================
'  Silent launcher for the Interests App local server.
'  Runs python's http.server on port 3456, hidden (no window),
'  serving this app folder. A copy of this file is placed in the
'  Windows Startup folder so the server is available after login.
'  To stop it, end the python process in Task Manager.
' ============================================================
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\Dropbox\Documents\Claude\Projects\Interests App"
' window style 0 = hidden, False = don't wait. Try the py launcher, then python.
sh.Run "cmd /c py -m http.server 3456 || python -m http.server 3456", 0, False
