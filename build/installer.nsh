!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $1 ""
    IfFileExists "$APPDATA\paper-bridge\storage-location.txt" 0 paperBridgeStorageReadDone
    FileOpen $0 "$APPDATA\paper-bridge\storage-location.txt" r
    FileRead $0 $1
    FileClose $0

    paperBridgeStorageReadDone:
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 PaperBridge 保存的全部本地数据？$\r$\n$\r$\n选择“是”将永久删除：$\r$\n- 用户选择的数据目录中的论文、中文工作稿和备份$\r$\n- PaperBridge 的本地设置、API 配置和缓存$\r$\n$\r$\n当前数据目录：$1$\r$\n此操作无法撤销。" IDNO paperBridgeKeepData

    IfFileExists "$1\.paperbridge-storage" 0 paperBridgeSkipCustomStorage
    RMDir /r "$1"

    paperBridgeSkipCustomStorage:

    RMDir /r "$DOCUMENTS\PaperBridge Projects"
    RMDir /r "$APPDATA\paper-bridge"
    RMDir /r "$LOCALAPPDATA\paper-bridge"
    RMDir /r "$LOCALAPPDATA\paper-bridge-updater"

    paperBridgeKeepData:
  ${endIf}
!macroend
