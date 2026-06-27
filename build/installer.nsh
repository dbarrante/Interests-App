; build/installer.nsh — Interests App custom NSIS include.
; Goals:
;   1) Preserve the live library ($INSTDIR\data) across UPDATES.
;   2) On full uninstall, ask before deleting the saved library (default No).

; Replaces electron-builder's default app-file removal so we can spare $INSTDIR\data.
!macro customRemoveFiles
  ${if} ${isUpdated}
    ; Updating in place: remove app files but KEEP the user's data folder.
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\LICENSE*"
    Delete "$INSTDIR\version"
    ; NOTE: deliberately do NOT touch "$INSTDIR\data".
  ${else}
    ; Fresh (re)install over an existing dir: clear everything EXCEPT data.
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\LICENSE*"
    Delete "$INSTDIR\version"
  ${endif}
!macroend

; Runs during uninstall. Offer to delete the saved library; default is No (keep it).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\data\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also delete your saved library?$\r$\n$\r$\nThis permanently removes your cards, saved clips, and images stored in:$\r$\n$INSTDIR\data$\r$\n$\r$\nChoose No to keep your library (recommended)." \
        /SD IDNO IDYES uninstLibraryYes IDNO uninstLibraryNo
      uninstLibraryYes:
        RMDir /r "$INSTDIR\data"
        Goto uninstLibraryDone
      uninstLibraryNo:
        ; Keep the library; leave $INSTDIR\data in place.
      uninstLibraryDone:
    ${endif}
  ${endif}
!macroend
