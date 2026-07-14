!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 PaperBridge 保存的全部本地数据？$\r$\n$\r$\n选择“是”将永久删除：$\r$\n- 文档\PaperBridge Projects 中的全部论文项目$\r$\n- PaperBridge 的本地设置、API 配置和缓存$\r$\n$\r$\n此操作无法撤销。" IDNO paperBridgeKeepData

    RMDir /r "$DOCUMENTS\PaperBridge Projects"
    RMDir /r "$APPDATA\paper-bridge"
    RMDir /r "$LOCALAPPDATA\paper-bridge"
    RMDir /r "$LOCALAPPDATA\paper-bridge-updater"

    paperBridgeKeepData:
  ${endIf}
!macroend
