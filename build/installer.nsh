; ============================================================
; DSH Desktop — 自定义 NSIS 段（electron-builder 自动加载）
; 把安装目录从 %LOCALAPPDATA%\Programs\dsh-desktop
; 改成   %LOCALAPPDATA%\Programs\@dsh-aidesktop
; （对齐 opencode 桌面的 @opencode-aidesktop 目录命名风格）
; exe 路径/快捷方式使用 PRODUCT_FILENAME，不受影响。
; ============================================================
!undef APP_FILENAME
!define APP_FILENAME "@dsh-aidesktop"
