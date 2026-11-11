# Antigravity 桌面客户端简体中文汉化引擎

- **汉化版本**：v2.31.0
- **匹配版本**：Antigravity v2.31.0
- **支持平台**：Windows / macOS / Linux
- **环境要求**：Node.js 18+（零第三方依赖，无需 `npm install`）

基于纯 Node.js 原生二进制流修补（`AsarArchive`）的简体中文汉化引擎。采用零外部依赖、`shell: false` 参数数组调用、语法预编译校验（`vm.Script`）、SHA-256 版本化备份与同卷 `fsync` + `renameSync` 原子替换，支持秒级汉化与无损还原；自动隔离用户消息、思考流、代码编辑器与终端输出。

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/helloshu/antigravity-hans.git
cd antigravity-hans
```

### 2. 安装汉化

- **Windows**：双击 `双击安装中文汉化.bat`（若安装在系统保护目录提示权限不足，右键选择“以管理员身份运行”）。
- **macOS**：双击 `双击安装中文汉化.command` 或终端执行 `./install.sh`。
- **Linux**：执行 `./install.sh`（若客户端位于系统目录，脚本会自动请求 `sudo` 提权）。

支持参数：
- `--install-dir "/path/to/Antigravity"`：手动指定客户端安装目录
- `--brand-title english|hidden|translated`：设置左上角品牌标题显示模式
- `--no-kill`：跳过自动关闭与重启正在运行的客户端进程

### 3. 卸载还原

- **Windows**：双击 `双击卸载还原官方英文.bat`
- **macOS**：双击 `双击卸载还原官方英文.command` 或终端执行 `./uninstall.sh`
- **Linux**：执行 `./uninstall.sh`

安装器仅在包内基线哈希与备份 SHA-256 完全匹配时还原官方原包；若客户端已被官方新版本覆盖升级，将自动拒绝使用旧备份降级。

## 目录结构

- `installer.js`：零依赖安装与还原核心（v3.1.0），内置 `AsarArchive` 二进制校验与流式修补、产品身份识别、preload 动态评分定位、`plugin://` 扩展子框架隔离注入（`subframeLocalizationPreload.js`）、SHA-256 版本化备份与原子替换。
- `localization_engine.js`：渲染层翻译注入代码生成器（`generateJs()`），命令行直接调用时自动委托 `installer.js`。
- `dicts/`：模块化翻译词典目录，主版本词典固定为 `dicts/release.json`（`release.json`），分包词典包括 `common.json`、`marketplace_plugins.json`、`menu_nav.json`、`page_agents.json`、`page_mcp_knowledge.json`、`page_settings.json`、`page_workspaces.json`。
- `scripts/verify.js`：非安装式全量词典审计与安全契约验证入口。
- `tests/`：词典产物、渲染层 DOM 契约与合成 ASAR 安全加固测试。
- `install.sh` / `uninstall.sh` / `*.bat` / `*.command`：跨平台安装与还原入口（`.bat` 为受 `.gitattributes` 保护的 GBK/CRLF 文件）。

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
