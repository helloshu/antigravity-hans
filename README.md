# Antigravity 中文汉化（安全加固版）

- **汉化版本**：v2.29.0
- **匹配版本**：Antigravity v2.29.0
- **支持平台**：Windows / Linux
- **环境要求**：Node.js 22.12+ 与 npm

基于受控 ASAR 解包与重包的简体中文汉化工具。采用锁定依赖（`@electron/asar@4.2.1`）、`shell: false` 参数调用、SHA-256 版本化备份与同卷单步原子替换，支持一键汉化与无损还原；自动隔离用户消息、思考流、代码编辑器与终端输出。

## 快速开始

### 1. 获取代码并安装依赖

```bash
git clone https://github.com/helloshu/antigravity-hans.git
cd antigravity-hans
npm ci --ignore-scripts
```

> `npm ci --ignore-scripts` 请务必以**普通用户**执行，切勿使用管理员权限或 `sudo`。

### 2. 安装汉化

先保存工作并正常退出 Antigravity（安装器默认不强杀运行进程，需自动结束进程可追加 `--force-kill`）：

- **Windows**：双击 `双击安装中文汉化.bat`（仅提示权限不足时右键“以管理员身份运行”）。
- **Linux**：执行 `./install.sh`（仅客户端位于系统只读目录且提示权限不足时使用 `sudo ./install.sh`）。

支持通过 `--install-dir "/path/to/Antigravity"` 指定自定义安装路径，通过 `--brand-title english|hidden|translated` 指定左上角品牌显示方式。

### 3. 卸载还原

退出 Antigravity 后执行：

- **Windows**：双击 `双击卸载还原官方英文.bat`
- **Linux**：执行 `./uninstall.sh`

安装器仅在包内基线哈希与备份 SHA-256 完全匹配时还原官方原包；若客户端已被官方新版本覆盖更新，将自动拒绝旧备份降级。

## 目录结构

- `installer.js`：安装与还原核心（v3.0.0），负责产品校验、preload 评分定位、备份、`app.asar.unpacked` 兼容与原子替换。
- `localization_engine.js`：渲染层翻译注入代码生成器（`generateJs()`），命令行调用自动委托 `installer.js`。
- `dicts/`：模块化翻译词典目录，当前版本词典为 `dicts/v2.29.0.json`（`v2.29.0.json`）及 `common.json`、`marketplace_plugins.json`、`menu_nav.json`、`page_agents.json`、`page_mcp_knowledge.json`、`page_settings.json`、`page_workspaces.json`。
- `scripts/verify.js`：非安装式全量词典审计与安全契约验证入口。
- `tests/`：词典产物、渲染层 DOM 契约与合成 ASAR 安全加固测试。
- `install.sh` / `uninstall.sh` / `*.bat` / `*.command`：各平台安装与还原入口（`.bat` 为受 `.gitattributes` 保护的 GBK/CRLF 文件）。

## 开发验证

修改词典或代码后，在仓库根目录执行（不会触碰本机已安装的客户端）：

```bash
node scripts/verify.js
npm run check
npm test
```

如需验证与官方客户端 `preload.js` 的合并编译：

```bash
node scripts/verify.js --preload "/absolute/path/to/preload.js"
```

## 常见问题

- **提示缺少 `@electron/asar`**：确认 Node.js >= 22.12.0，在仓库目录以普通用户执行 `npm ci --ignore-scripts`。
- **提示权限不足**：先以普通用户完成 `npm ci --ignore-scripts`，再用管理员身份运行 `.bat` 或 `sudo ./install.sh`。
- **客户端版本更新后失效**：退出客户端后重新运行一次安装脚本，安装器会基于新版 `app.asar` 自动建立新的 SHA-256 备份并重新注入。
