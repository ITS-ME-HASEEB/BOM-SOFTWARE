; installer.nsh — Demo installer hooks (electron-builder NSIS include)
; Custom pages / data-preservation logic. The app saves data in its install
; folder when writable; when Windows protects the install folder (e.g. Program
; Files) it falls back to %APPDATA%\Demo\data. On uninstall we must
; never delete user data: copy the install-folder data into a preserved folder
; in AppData so nothing is lost.

!macro customInstall
  ; If the user is reinstalling over an old install, restore data that was
  ; preserved by a previous uninstall (or by a prior install's data folder).
  ; Nothing to do here by default — data lives in the app folder or AppData
  ; and survives install/uninstall either way.
!macroend

!macro customUnInstall
  ; Preserve the app's data folder before the installer removes the program.
  ; $INSTDIR\data (the preferred location) is copied into the user profile so
  ; a later reinstall can pick it up again.
  ClearErrors
  IfFileExists "$INSTDIR\data\*.*" 0 done_preserve
    CreateDirectory "$APPDATA\Demo"
    CreateDirectory "$APPDATA\Demo\preserved-data"
    CopyFiles /SILENT "$INSTDIR\data\*.*" "$APPDATA\Demo\preserved-data\"
    RMDir /r "$INSTDIR\data"
  done_preserve:
!macroend
