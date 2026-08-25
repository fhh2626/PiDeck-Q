; PiDeck-Q native installer. Qt WebView2 uses the machine/user Evergreen runtime;
; the installer never ships a Fixed Version WebView2 copy.
Unicode True
RequestExecutionLevel user
Name "PiDeck-Q"
OutFile "PiDeck-Q-Setup.exe"
InstallDir "$LOCALAPPDATA\PiDeck-Q"

!define WEBVIEW2_BOOTSTRAPPER_URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

Page directory
Page instfiles

Function .onInit
  ; WebView2 Evergreen Runtime registers a Client\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} version under HKLM/HKCU.
  ; If absent, download/run Microsoft's signed Evergreen Bootstrapper silently.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    InitPluginsDir
    inetc::get "${WEBVIEW2_BOOTSTRAPPER_URL}" "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /END
    Pop $1
    ${If} $1 == "OK"
      ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
    ${Else}
      MessageBox MB_ICONSTOP "Microsoft Edge WebView2 Runtime is required to run PiDeck-Q."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section
  SetOutPath "$INSTDIR"
  File /r "release\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd
