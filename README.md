# PaperBridge

PaperBridge 是一个运行在 Windows 本地的中英文 LaTeX 论文修改工具。

它适合需要反复修改英文论文、但更习惯先用中文组织和调整内容的研究者。使用时可以在左侧修改中文工作稿，由 AI 更新右侧对应的英文 LaTeX，并随时在 PDF 预览中检查英文版本的实际排版。英文 LaTeX 始终是最终排版依据，因此可以及时发现页数变化、公式或引用异常、段落换页，以及图片和表格位置变化。

PaperBridge 不代替作者决定论文内容。它主要用于保持中文修改、英文表达和 LaTeX 排版之间的对应关系，让多轮修改更容易检查和管理。

主要功能包括：

- 中英文段落对照编辑，支持调整字号和拖动分栏。
- 修改中文后，按段落调用 AI 更新对应英文，不会每次重写整篇论文。
- 可以在任意正文段落之前或之后新增段落，也可以删除不再需要的段落；新增时输入中文，由 AI 生成对应英文 LaTeX。
- AI 新增危险 LaTeX 命令时会直接阻止写入；新增其他原文中没有的 LaTeX 命令时，会先列出命令并要求人工确认。
- 导入 ZIP 或本地项目时，只识别正文和摘要等可编辑内容，自动排除 LaTeX 导言区、作者信息、宏定义、公式、图表、算法代码和参考文献。
- 本地编译并预览英文 PDF，支持缩放、拖动和导出。
- 通过 Overleaf Git，或 GitHub、GitLab 等 HTTPS Git 仓库拉取和推送项目。
- 支持 OpenAI 兼容接口、DeepSeek、Anthropic 和 Gemini。
- 完成修改后进行英文语法、表达和全文连贯性检查。
- 根据 Word、PDF、TeX 或 ZIP 模板分析并迁移论文格式。

![PaperBridge 中英文对照编辑与 PDF 排版预览](docs/images/paperbridge-overview.png)

> 示意图使用单独授权的模板项目。

## 基础配置

### 1. 启动 PaperBridge

Windows 只提供一个完整安装版：`PaperBridge-Setup.exe`[下载 PaperBridge Windows 安装程序](https://github.com/liyunjie-phd/PaperBridge/releases/download/0.2.0/PaperBridge-0.2.0-Windows.zip)。

安装程序已包含 PaperBridge、Git 和 TeX 编译环境，无需另外安装 Node.js。

安装版包含内置 Tectonic 排版组件，电脑上没有安装 TeX Live 或 MiKTeX 也可以编译论文。安装后会创建桌面和开始菜单快捷方式，论文默认保存在 `文档\PaperBridge Projects`。如果电脑已经安装 TeX Live 或 MiKTeX，并且可以使用 `latexmk`，PaperBridge 会优先使用本机 LaTeX 环境；否则自动使用内置 Tectonic。

当前版本没有商业代码签名证书。Windows 首次运行时可能显示“Windows 已保护你的电脑”，确认文件来源和 SHA-256 后，可以选择“更多信息”并继续运行。

安装版可以从 Windows 的 **设置 > 应用 > 已安装的应用** 中卸载。卸载程序会询问是否同时删除本地数据：选择“否”会保留论文和设置；选择“是”会永久删除 `文档\PaperBridge Projects` 中的全部项目，以及 PaperBridge 的本地设置和缓存。执行删除前应先备份需要保留的论文。

### 2. 连接 Overleaf 项目

首次启动时选择 **Overleaf**，然后填写：

1. **Overleaf 项目链接**：直接粘贴浏览器地址，例如 `https://cn.overleaf.com/project/...`。
2. **Overleaf Git Token**：用于 PaperBridge 自动完成项目克隆、拉取和推送。

Overleaf 的 Git 集成属于高级功能，需要个人订阅、团队订阅或学校提供的 Overleaf Commons 权限。可以在项目左侧的 **Integrations > Git** 中确认当前账户是否已经开通 Git 集成。详细说明见 [Overleaf Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration)。

如果拉取时出现 `no git access`、`repository not found` 或“项目没有 Git 访问权限”，PaperBridge 会显示中文说明。常见原因包括项目链接错误、项目不存在、当前账户没有项目权限，或项目所有者没有开通 Overleaf Git 高级功能。没有该功能时，可以从 Overleaf 下载 ZIP，再通过 **ZIP 文件** 导入 PaperBridge。

#### 获取 Overleaf Git Token

1. 登录 Overleaf。
2. 打开 [Overleaf Account Settings](https://cn.overleaf.com/user/settings)。
3. 找到 **Git integration authentication tokens**。
4. 选择生成新的 Token。
5. 将 Token 填入 PaperBridge 的 **Overleaf Git Token** 输入框。

PaperBridge 会在本机加密保存 Token，并在 Git 操作时自动使用用户名 `git` 和该 Token 完成认证，不需要再输入所谓的“Git 密码”。如果 Token 到期或被删除，可以在 PaperBridge 设置页中更新。

Token 与密码具有相同的访问能力，请不要截图、上传或发送给他人。Overleaf 的 Token 规则和使用方法见 [Git integration authentication tokens](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens)。

如果当前账户没有 Overleaf Git 权限，也可以从 Overleaf 下载项目 ZIP，然后在首次配置中选择 **ZIP 文件** 导入。

进入编辑界面后，左侧“文档”标题旁的文件夹加号用于添加或切换论文项目。切换项目时会继续使用已经保存的 AI 配置和 Overleaf Git Token。顶部的 **拉取** 和 **推送** 用于同步当前 Overleaf 项目。

每个正文段落右上角的加号用于新增段落，可以选择插入到当前段落之前或之后。输入中文工作稿后，PaperBridge 会调用段落翻译接口生成一个新的英文 LaTeX 段落并重新编译。垃圾桶按钮用于删除当前段落；删除会同时移除对应的英文 TeX 内容和本地中文工作稿。

### 3. 连接 GitHub 或 GitLab

PaperBridge 支持普通 HTTPS Git 仓库，使用时有两种方式：

1. 首次配置选择 **Git 仓库**，填写 GitHub 或 GitLab 的 HTTPS 仓库地址，PaperBridge 会克隆该仓库。
2. 选择 **ZIP 文件** 或 **本地文件夹** 时，勾选 **同时连接 GitHub / GitLab 仓库**。建议连接一个新建的空仓库。导入时只验证和连接，不会立即上传；检查论文无误后，再点击顶部的 **推送**。

公开仓库可以不填写 Token。私有仓库需要填写 Git 用户名和 Personal Access Token。目前不支持 SSH 地址。Token 在 Windows 本地加密保存，也不会写入 Git 远端地址。

如果远端仓库已经存在与本地无关的提交历史，PaperBridge 会拒绝覆盖。此时应改为使用 **Git 仓库** 来源克隆远端，再把需要的论文文件合并进去。

ZIP 或本地项目首次推送到普通 Git 仓库前，PaperBridge 会显示完整文件清单。默认只选择 TeX、参考文献、样式文件和图像；其他文件需要手动勾选。已经存在于本地 Git 提交历史中的文件会随历史记录完整上传，因此会显示为不可取消的“已有提交”。

### 4. 获取 DeepSeek API

1. 登录 [DeepSeek 开放平台](https://platform.deepseek.com/)。
2. 打开 [API Keys](https://platform.deepseek.com/api_keys)。
3. 创建一个新的 API Key，并在创建后妥善保存。
4. 在 [Usage](https://platform.deepseek.com/usage) 页面查看余额和 API 使用量；如余额不足，需要先充值。

API Key 只应保存在自己的电脑中，不要提交到 GitHub，也不要随论文项目一起发送。

### 5. 在 PaperBridge 中配置 DeepSeek

首次配置时填写：

| 设置项 | 建议值 |
| --- | --- |
| API 服务类型 | `DeepSeek / OpenAI 兼容接口` |
| 模型 | `DeepSeek V4 Flash`，需要更高质量时可选择 `DeepSeek V4 Pro` |
| Base URL | `https://api.deepseek.com` |
| API Key | 在 DeepSeek 开放平台创建的 Key |

模型可以直接从下拉框选择，不需要手动输入 `deepseek-chat`。DeepSeek 官方已经提供 `deepseek-v4-flash` 和 `deepseek-v4-pro`，旧的 `deepseek-chat` 与 `deepseek-reasoner` 将停止使用。当前模型和接口说明以 [DeepSeek API 文档](https://api-docs.deepseek.com/) 为准。

填写完成后，先点击 **测试连接**。连接成功后再进入 PaperBridge。首次配置会使用同一个模型进行段落翻译和全文审校，之后可以在设置中分别调整两套模型。

## 数据位置与隐私

- PaperBridge 在 Windows 本地运行和编译 LaTeX。
- 只有需要翻译、审校或格式分析的文字会发送给所配置的 AI API。
- API Key、Overleaf Git Token 和 GitHub/GitLab Token 在桌面版本中通过 Windows 安全存储加密。
- 中文工作稿保存在 PaperBridge 数据目录中，不写入英文论文的 Git 仓库。
- 中文工作稿按项目串行保存，使用临时文件原子替换，并仅保留一份最近备份。备份位于 PaperBridge 数据目录，不会扩大论文项目或 Git 仓库。
- PaperBridge 会验证 TeX 文件的真实路径，并拒绝编辑指向项目目录之外的符号链接。
- 上传未公开论文前，应确认所使用 AI 服务的数据处理和隐私政策符合所在单位要求。

## 本地开发

```powershell
npm install
npm test
npm run desktop
```

生成 Windows 完整安装版：

```powershell
npm run build:setup
```
