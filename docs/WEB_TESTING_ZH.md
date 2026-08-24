# PaperBridge 网页版小范围测试

这套方式面向约 10 名受邀请用户。PaperBridge 仍运行在你的 Windows 主机上，外部用户通过 HTTPS 隧道访问。每个用户使用独立的设置目录、项目目录、中文工作稿、凭据和编译进程。

下面的命令必须在 PaperBridge 源码目录（能看到 `package.json`、`server.js` 和 `web-gateway.mjs` 的目录）中执行，而不是在 `C:\Users\你的用户名` 主目录中执行：

```powershell
Set-Location "E:\25INFOCOM-CEDAR\ACM\paper-bridge"
```

## 数据隔离结构

默认数据保存在项目旁边的 `web-data`，也可以使用 `PAPERBRIDGE_WEB_DATA_ROOT` 指向其他磁盘：

```text
web-data/
├─ users.json
└─ users/
   └─ <用户 ID>/
      ├─ Settings/
      └─ Projects/
```

不要把 `web-data` 上传到 GitHub。`users.json` 中只有加盐后的密码摘要，但仍应当作为服务器私有数据保存。

## 1. 建立测试账号

推荐使用“公开链接 + 邀请码”模式。所有人都可以打开同一个链接，但首次注册必须填写管理员提供的邀请码；注册成功后每个邮箱拥有独立的项目空间。启动网关前设置：

```powershell
$env:PAPERBRIDGE_WEB_INVITE_CODE="只发给测试用户的邀请码"
$env:PAPERBRIDGE_WEB_MAX_USERS="10"
```

用户在网页中填写邮箱、密码和邀请码即可注册。密码至少 10 个字符，之后使用邮箱和密码登录，邀请码可以留空。

如果需要由管理员预先建立账号，也可以在 PowerShell 中执行：

```powershell
$env:PAPERBRIDGE_WEB_DATA_ROOT="E:\PaperBridge-Web-Data"
$env:PAPERBRIDGE_WEB_PASSWORD="为该用户设置的临时密码"
npm.cmd run web:user -- add alice
Remove-Item Env:PAPERBRIDGE_WEB_PASSWORD
```

查看、修改密码或删除账号：

```powershell
npm.cmd run web:user -- list
npm.cmd run web:user -- set-password alice
npm.cmd run web:user -- remove alice
```

不要在聊天、邮件或公开文档中发送所有用户共用的密码。建议每个人使用不同账号和密码。

## 2. 启动网页版网关

通过 HTTPS 隧道访问时，应当启用 Secure Cookie：

```powershell
$env:PAPERBRIDGE_WEB_COOKIE_SECURE="1"
$env:PAPERBRIDGE_WEB_INVITE_CODE="只发给测试用户的邀请码"
$env:PAPERBRIDGE_WEB_HOST="127.0.0.1"
$env:PAPERBRIDGE_WEB_PORT="8080"
$env:PAPERBRIDGE_WEB_DATA_ROOT="E:\PaperBridge-Web-Data"
npm.cmd run web
```

网关只监听 `127.0.0.1`，不应直接把 8080 或用户后端端口暴露到公网。每个用户首次登录后，网关会在本机为其启动一个独立 PaperBridge 服务。

如果只是先在本机检查登录页面，可暂时不设置 `PAPERBRIDGE_WEB_COOKIE_SECURE`，然后访问 `http://127.0.0.1:8080`。

## 3. 接入 HTTPS

推荐使用 Cloudflare Tunnel 或其他能够提供 HTTPS 的反向隧道，将公网 HTTPS 地址转发到：

```text
http://127.0.0.1:8080
```

HTTPS 在隧道入口终止，本机网关仍只接受回环地址请求。不要使用路由器端口转发直接暴露 PaperBridge。

## 4. 测试范围与限制

- 每个账号只能看到自己的项目和配置。
- 网页版禁止更改服务器数据保存目录。
- 网页版禁止通过任意本机路径打开项目，防止访问其他用户或主机文件。
- 第一阶段支持新建项目、Overleaf 和 HTTPS Git 仓库。
- 网页版 ZIP 使用浏览器上传，服务器不会读取用户填写的本机路径；桌面版仍可选择本地 ZIP 路径。
- 会话保存在内存中，重启网关后所有用户需要重新登录。
- 未签名或不可信的 TeX 仍应使用编译超时、命令白名单和路径检查。

## 5. 备份与资源建议

- 每天备份 `PAPERBRIDGE_WEB_DATA_ROOT`，不要只备份编译后的 PDF。
- 10 人测试建议先限制同时编译和 AI 翻译任务数量，观察 CPU、内存和上传带宽。
- 不要让用户共享 AI、Git 或 Overleaf Token；每个用户在自己的隔离空间中配置。
- 用户退出测试后，先停用账号，再由管理员备份或删除该用户目录。
