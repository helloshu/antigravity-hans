'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const {
    generateJs,
    SIGNATURE_START,
    SIGNATURE_END,
} = require('./localization_engine');

const LEGACY_SIGNATURE_START = '/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */';
const LEGACY_SIGNATURE_END = '/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */';

const ENGINE_VERSION = '3.0.0';
const ASAR_PACKAGE_VERSION = '4.2.1';
const METADATA_FILE = 'antigravity-localization.json';
const MANIFEST_FILE = 'app.asar.localization.json';
const BACKUP_FOLDER = '.antigravity-localization-backups';
const TEMP_PREFIX = 'antigravity-localization-';
const MENU_SIGNATURE_START = '/* --- ANTIGRAVITY NATIVE MENU LOCALIZATION START --- */';
const MENU_SIGNATURE_END = '/* --- ANTIGRAVITY NATIVE MENU LOCALIZATION END --- */';
const IPC_CONTEXT_MENU_SIGNATURE_START = '/* --- ANTIGRAVITY IPC CONTEXT MENU LOCALIZATION START --- */';
const IPC_CONTEXT_MENU_SIGNATURE_END = '/* --- ANTIGRAVITY IPC CONTEXT MENU LOCALIZATION END --- */';

let cachedAsarCli = null;

class InstallerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InstallerError';
    }
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparablePath(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, child) {
    const normalizedParent = normalizeComparablePath(parent);
    const normalizedChild = normalizeComparablePath(child);
    return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + path.sep);
}

function readJsonFile(filePath, required = false) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (required) {
            throw new InstallerError(`无法读取 JSON 文件 ${filePath}: ${error.message}`);
        }
        return null;
    }
}

function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const fileDescriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fileDescriptor);
    }
    return hash.digest('hex');
}

function assertSupportedNode() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) {
        throw new InstallerError(`Node.js 版本过低: ${process.versions.node}；要求 22.12.0 或更高版本。`);
    }
}

function resolveAsarCli() {
    if (cachedAsarCli) return cachedAsarCli;
    assertSupportedNode();

    const nodeModulesRoot = path.join(__dirname, 'node_modules');
    const packageRoot = path.join(__dirname, 'node_modules', '@electron', 'asar');
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const lockPath = path.join(__dirname, 'package-lock.json');

    if (!fs.existsSync(packageJsonPath) || !fs.existsSync(lockPath)) {
        throw new InstallerError(
            '缺少经过锁文件校验的 @electron/asar。请先以普通用户身份在汉化包目录运行：npm ci --ignore-scripts'
        );
    }

    const packageJson = readJsonFile(packageJsonPath, true);
    const packageLock = readJsonFile(lockPath, true);
    const lockedPackage = packageLock.packages && packageLock.packages['node_modules/@electron/asar'];

    if (packageJson.version !== ASAR_PACKAGE_VERSION ||
        !lockedPackage ||
        lockedPackage.version !== ASAR_PACKAGE_VERSION ||
        !lockedPackage.integrity) {
        throw new InstallerError(
            `@electron/asar 版本或完整性锁不匹配；要求精确版本 ${ASAR_PACKAGE_VERSION}。请删除 node_modules 后重新运行 npm ci --ignore-scripts。`
        );
    }

    const binEntry = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin && (packageJson.bin.asar || Object.values(packageJson.bin)[0]);
    if (!binEntry) {
        throw new InstallerError('@electron/asar 包未声明 CLI 入口。');
    }

    const nodeModulesRootReal = fs.realpathSync(nodeModulesRoot);
    const packageRootReal = fs.realpathSync(packageRoot);
    if (!isPathInside(nodeModulesRootReal, packageRootReal)) {
        throw new InstallerError('拒绝使用指向项目 node_modules 之外的 @electron/asar 包。');
    }
    const cliPath = fs.realpathSync(path.resolve(packageRoot, binEntry));
    if (!isPathInside(packageRootReal, cliPath)) {
        throw new InstallerError('拒绝执行指向 @electron/asar 包目录之外的 CLI。');
    }

    cachedAsarCli = cliPath;
    return cliPath;
}

function runAsar(args) {
    const cliPath = resolveAsarCli();
    const result = childProcess.spawnSync(process.execPath, [cliPath, ...args], {
        cwd: __dirname,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
    });

    return {
        success: !result.error && result.status === 0,
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || (result.error && result.error.message) || '',
    };
}

function createTempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
}

function safeRemoveTempRoot(tempRoot) {
    if (!tempRoot || !fs.existsSync(tempRoot)) return;
    const resolvedTemp = path.resolve(tempRoot);
    const systemTemp = path.resolve(os.tmpdir());
    if (!isPathInside(systemTemp, resolvedTemp) || !path.basename(resolvedTemp).startsWith(TEMP_PREFIX)) {
        throw new InstallerError(`拒绝清理非本工具临时目录: ${resolvedTemp}`);
    }
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
}

function walkFiles(rootDir, predicate = () => true, maxFiles = 50000) {
    const files = [];
    const stack = [path.resolve(rootDir)];
    let visitedEntries = 0;

    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            visitedEntries++;
            if (visitedEntries > maxFiles) {
                throw new InstallerError(`解包条目数量超过安全上限 ${maxFiles}。`);
            }
            const fullPath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile() && predicate(fullPath)) {
                files.push(fullPath);
            }
        }
    }
    return files;
}

function readTextFileBounded(filePath, maxBytes = 32 * 1024 * 1024) {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
}

function readAsarUnpackSpec(archivePath) {
    let fd = null;
    try {
        const stat = fs.statSync(archivePath);
        if (stat.size < 16) return { hasUnpacked: false, unpackDirs: [], unpackFiles: [] };
        fd = fs.openSync(archivePath, 'r');
        const prefix = Buffer.alloc(16);
        if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) {
            return { hasUnpacked: false, unpackDirs: [], unpackFiles: [] };
        }
        const jsonSize = prefix.readUInt32LE(12);
        if (jsonSize === 0 || jsonSize > 64 * 1024 * 1024 || 16 + jsonSize > stat.size) {
            return { hasUnpacked: false, unpackDirs: [], unpackFiles: [] };
        }
        const jsonBuf = Buffer.alloc(jsonSize);
        if (fs.readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) {
            return { hasUnpacked: false, unpackDirs: [], unpackFiles: [] };
        }
        const header = JSON.parse(jsonBuf.toString('utf8'));
        const inspectNode = (entry, relPath) => {
            if (!entry || typeof entry !== 'object') {
                return { allUnpacked: false, anyUnpacked: false, unpackDirs: [], unpackFiles: [] };
            }
            if (!entry.files || typeof entry.files !== 'object') {
                const isUnpacked = Boolean(entry.unpacked);
                return {
                    allUnpacked: isUnpacked,
                    anyUnpacked: isUnpacked,
                    unpackDirs: [],
                    unpackFiles: isUnpacked && relPath ? [relPath] : [],
                };
            }
            const names = Object.keys(entry.files);
            if (names.length === 0) {
                const isUnpacked = Boolean(entry.unpacked);
                return {
                    allUnpacked: isUnpacked,
                    anyUnpacked: isUnpacked,
                    unpackDirs: isUnpacked && relPath ? [relPath] : [],
                    unpackFiles: [],
                };
            }
            let allUnpacked = true;
            let anyUnpacked = false;
            const unpackDirs = [];
            const unpackFiles = [];
            for (const name of names) {
                if (name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) continue;
                const childPath = relPath ? `${relPath}/${name}` : name;
                const childRes = inspectNode(entry.files[name], childPath);
                if (!childRes.allUnpacked) allUnpacked = false;
                if (childRes.anyUnpacked) anyUnpacked = true;
                unpackDirs.push(...childRes.unpackDirs);
                unpackFiles.push(...childRes.unpackFiles);
            }
            if (allUnpacked && relPath) {
                return { allUnpacked: true, anyUnpacked: true, unpackDirs: [relPath], unpackFiles: [] };
            }
            return { allUnpacked: false, anyUnpacked, unpackDirs, unpackFiles };
        };
        const rootRes = inspectNode(header, '');
        return {
            hasUnpacked: rootRes.anyUnpacked,
            unpackDirs: rootRes.unpackDirs,
            unpackFiles: rootRes.unpackFiles,
        };
    } catch {
        return { hasUnpacked: false, unpackDirs: [], unpackFiles: [] };
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
        }
    }
}

function removeStagedUnpackedLinkOrCopy(targetPath) {
    if (!targetPath) return;
    let stat;
    try {
        stat = fs.lstatSync(targetPath);
    } catch {
        return;
    }
    if (stat.isSymbolicLink()) {
        try {
            fs.unlinkSync(targetPath);
        } catch {
            fs.rmdirSync(targetPath);
        }
    } else {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function extractArchive(archivePath, destination, resourcesDir = null) {
    if (fs.existsSync(destination)) {
        throw new InstallerError(`解包目标已存在，拒绝覆盖: ${destination}`);
    }
    if (!validateArchive(archivePath)) {
        throw new InstallerError(`ASAR 列表校验失败或包含不安全路径: ${archivePath}`);
    }
    const spec = readAsarUnpackSpec(archivePath);
    const directUnpackedDir = `${archivePath}.unpacked`;
    if (!spec.hasUnpacked || fs.existsSync(directUnpackedDir)) {
        const result = runAsar(['extract', archivePath, destination]);
        if (!result.success || !fs.existsSync(destination)) {
            throw new InstallerError(`ASAR 解包失败: ${result.stderr || result.stdout}`);
        }
        return;
    }

    const sharedUnpackedDir = resourcesDir ? path.join(resourcesDir, 'app.asar.unpacked') : null;
    if (!sharedUnpackedDir || !fs.existsSync(sharedUnpackedDir)) {
        throw new InstallerError(`ASAR 包含解包目录引用，但未找到对应的 app.asar.unpacked: ${sharedUnpackedDir || directUnpackedDir}`);
    }

    const stagedSourceAsar = `${destination}.source.asar`;
    const stagedSourceUnpacked = `${stagedSourceAsar}.unpacked`;
    try {
        fs.copyFileSync(archivePath, stagedSourceAsar);
        try {
            fs.symlinkSync(sharedUnpackedDir, stagedSourceUnpacked, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            fs.cpSync(sharedUnpackedDir, stagedSourceUnpacked, { recursive: true });
        }
        const result = runAsar(['extract', stagedSourceAsar, destination]);
        if (!result.success || !fs.existsSync(destination)) {
            throw new InstallerError(`ASAR 解包失败: ${result.stderr || result.stdout}`);
        }
    } finally {
        removeStagedUnpackedLinkOrCopy(stagedSourceUnpacked);
        if (fs.existsSync(stagedSourceAsar)) fs.unlinkSync(stagedSourceAsar);
    }
}

function validateArchive(archivePath) {
    if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size < 1024) return false;
    const result = runAsar(['list', archivePath]);
    if (!result.success || result.stdout.trim().length === 0) return false;
    for (const listedPath of result.stdout.split(/\r?\n/)) {
        if (!listedPath.trim()) continue;
        const normalized = listedPath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (/^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) {
            return false;
        }
    }
    return true;
}

function detectAppInfo(extractedDir) {
    const jsonFiles = walkFiles(
        extractedDir,
        filePath => ['package.json', 'product.json'].includes(path.basename(filePath).toLowerCase()),
        50000
    );
    const candidates = [];

    for (const jsonPath of jsonFiles) {
        const stat = fs.statSync(jsonPath);
        if (stat.size > 2 * 1024 * 1024) continue;
        const data = readJsonFile(jsonPath);
        if (!data || typeof data !== 'object') continue;

        const names = [
            data.productName,
            data.name,
            data.applicationName,
            data.displayName,
            data.appId,
        ].filter(value => typeof value === 'string');
        const relativePath = path.relative(extractedDir, jsonPath);
        const depth = relativePath.split(path.sep).length;
        const joined = names.join(' ');
        // 产品证据必须位于包根部附近，避免把深层依赖包的名称误认为宿主产品。
        const verified = /antigravity/i.test(joined) && depth <= 3;
        let score = verified ? 100 : 0;
        if (relativePath.toLowerCase() === 'package.json') score += 20;
        if (relativePath.toLowerCase().endsWith(`${path.sep}product.json`)) score += 10;

        candidates.push({
            name: names[0] || 'unknown',
            version: typeof data.version === 'string' ? data.version : 'unknown',
            verified,
            evidenceFile: relativePath,
            score,
        });
    }

    candidates.sort((a, b) => b.score - a.score || a.evidenceFile.localeCompare(b.evidenceFile));
    return candidates[0] || {
        name: 'unknown',
        version: 'unknown',
        verified: false,
        evidenceFile: null,
        score: 0,
    };
}

function listJavaScriptFiles(extractedDir) {
    return walkFiles(extractedDir, filePath => /\.(?:js|cjs|mjs)$/i.test(filePath));
}

function scorePreloadCandidate(extractedDir, filePath, content) {
    const relativePath = path.relative(extractedDir, filePath).replace(/\\/g, '/').toLowerCase();
    const baseName = path.basename(filePath).toLowerCase();
    let score = 0;
    if (relativePath === 'dist/preload.js') score += 300;
    if (baseName === 'preload.js') score += 180;
    else if (baseName.includes('preload')) score += 100;
    if (/contextBridge/.test(content)) score += 50;
    if (/ipcRenderer/.test(content)) score += 40;
    if (/require\(["']electron["']\)|from\s+["']electron["']/.test(content)) score += 20;
    score -= relativePath.split('/').length;
    return score;
}

function hasPreloadEvidence(content) {
    return /contextBridge|ipcRenderer|webFrame|process\.contextIsolated|process\.once\(["']loaded["']|require\(["']electron["']\)|from\s+["']electron["']/.test(content);
}

function discoverPreload(extractedDir) {
    const jsFiles = listJavaScriptFiles(extractedDir);
    const namedCandidates = jsFiles.filter(filePath => path.basename(filePath).toLowerCase().includes('preload'));
    const candidates = [];
    const inspected = new Set();
    const inspectFiles = filePaths => {
        for (const filePath of filePaths) {
            if (inspected.has(filePath)) continue;
            inspected.add(filePath);
            const content = readTextFileBounded(filePath);
            if (content === null || !hasPreloadEvidence(content)) continue;
            const score = scorePreloadCandidate(extractedDir, filePath, content);
            if (score > 0) candidates.push({ filePath, content, score });
        }
    };
    inspectFiles(namedCandidates);
    if (candidates.length === 0) inspectFiles(jsFiles);

    candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

    if (candidates.length === 0 || candidates[0].score < 40) {
        throw new InstallerError('未能可靠定位 Electron preload 脚本；为避免破坏未知版本，安装已停止。');
    }
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
        const tied = candidates.filter(candidate => candidate.score === candidates[0].score)
            .map(candidate => path.relative(extractedDir, candidate.filePath));
        throw new InstallerError(`检测到多个同等可信的 preload 候选，拒绝猜测: ${tied.join(', ')}`);
    }
    return candidates[0];
}

function readLocalizationMetadata(extractedDir) {
    return readJsonFile(path.join(extractedDir, METADATA_FILE));
}

function archiveContainsLocalization(extractedDir) {
    if (readLocalizationMetadata(extractedDir)) return true;
    for (const filePath of listJavaScriptFiles(extractedDir)) {
        const content = readTextFileBounded(filePath);
        if (content && (content.includes(SIGNATURE_START) || content.includes(LEGACY_SIGNATURE_START))) return true;
    }
    return false;
}

function cleanLocalizationBlock(content) {
    let result = content;
    const patterns = [
        new RegExp(escapeRegExp(SIGNATURE_START) + '[\\s\\S]*?' + escapeRegExp(SIGNATURE_END), 'g'),
        new RegExp(escapeRegExp(LEGACY_SIGNATURE_START) + '[\\s\\S]*?' + escapeRegExp(LEGACY_SIGNATURE_END), 'g'),
    ];
    for (const pattern of patterns) {
        result = result.replace(pattern, '');
    }
    return result.replace(
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', typeof globalThis.__agTranslateContextMenuItems === 'function' ? globalThis.__agTranslateContextMenuItems(items) : items),",
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', items),"
    );
}

function patchPreload(extractedDir) {
    const candidate = discoverPreload(extractedDir);
    let cleaned = cleanLocalizationBlock(candidate.content).trimEnd();
    cleaned = cleaned.replace(
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', items),",
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', typeof globalThis.__agTranslateContextMenuItems === 'function' ? globalThis.__agTranslateContextMenuItems(items) : items),"
    );
    const generated = generateJs();
    fs.writeFileSync(candidate.filePath, `${cleaned}\n\n${generated}\n`, 'utf8');
    return path.relative(extractedDir, candidate.filePath);
}

function cleanMarkedBlock(content, startMarker, endMarker) {
    const pattern = new RegExp(
        escapeRegExp(startMarker) + '[\\s\\S]*?' + escapeRegExp(endMarker),
        'g'
    );
    return content.replace(pattern, '');
}

function buildMenuTranslationBlock(menuVariable) {
    return `${MENU_SIGNATURE_START}
{
    const __agMenuTranslations = {
        'File': '文件', 'Edit': '编辑', 'View': '视图', 'Workspace': '工作区', 'Window': '窗口', 'Help': '帮助',
        'New Window': '新建窗口', 'Create Project': '创建项目', 'Command Palette': '命令面板',
        'Docs': '文档', 'Check for Updates': '检查更新', 'Toggle Developer Tools': '切换开发者工具',
        'Undo': '撤销', 'Redo': '重做', 'Cut': '剪切', 'Copy': '复制', 'Paste': '粘贴',
        'Select All': '全选', 'Minimize': '最小化', 'Maximize': '最大化', 'Close': '关闭',
        'Reset Zoom': '重置缩放', 'Zoom In': '放大', 'Zoom Out': '缩小',
        'Toggle Full Screen': '切换全屏', 'Version': '版本',
        'About Antigravity': '关于 Antigravity', 'Services': '服务',
        'Hide Antigravity': '隐藏 Antigravity', 'Hide Others': '隐藏其他',
        'Show All': '显示全部', 'Quit Antigravity': '退出 Antigravity',
        'Quit': '退出', 'Connect to WSL': '连接至 WSL', 'Reopen Locally': '在本地重新打开'
    };
    const __agTranslateMenuItems = (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const label = typeof item.label === 'string' ? item.label : '';
            const cleanLabel = label.replace('&', '');
            if (cleanLabel && !item.__agOrigLabel) item.__agOrigLabel = cleanLabel;
            const mnemonic = /&([a-zA-Z])/.test(label) ? '(&' + label.match(/&([a-zA-Z])/)[1] + ')' : '';
            if (__agMenuTranslations[cleanLabel]) item.label = __agMenuTranslations[cleanLabel] + mnemonic;
            else if (/^Version\\s*([\\d.]+)?$/i.test(cleanLabel)) {
                item.label = cleanLabel.replace(/^Version\\s*([\\d.]+)?$/i, (_, version) => version ? '版本 ' + version : '版本');
            }
            if (item.submenu && Array.isArray(item.submenu.items)) __agTranslateMenuItems(item.submenu.items);
        }
    };
    __agTranslateMenuItems(${menuVariable} && ${menuVariable}.items);
}
${MENU_SIGNATURE_END}`;
}

function patchNativeMenu(extractedDir) {
    const setMenuPattern = /((?:[A-Za-z_$][\w$]*\.)*Menu\.setApplicationMenu\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?)/;
    const setMenuGlobalPattern = /((?:[A-Za-z_$][\w$]*\.)*Menu\.setApplicationMenu\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?)/g;
    const candidates = [];

    for (const filePath of listJavaScriptFiles(extractedDir)) {
        let content = readTextFileBounded(filePath);
        if (!content || (!content.includes('setApplicationMenu') && !content.includes(MENU_SIGNATURE_START))) continue;
        content = cleanMarkedBlock(content, MENU_SIGNATURE_START, MENU_SIGNATURE_END);
        const match = content.match(setMenuPattern);
        if (match) candidates.push({ filePath, content, match, score: path.basename(filePath).toLowerCase() === 'menu.js' ? 20 : 0 });
    }

    candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    if (candidates.length === 0) return null;

    const selected = candidates[0];
    let patched = selected.content.replace(
        setMenuGlobalPattern,
        (fullMatch, callExpr, menuVar) => `${buildMenuTranslationBlock(menuVar)}\n${callExpr}`
    );
    patched = patched.replace(
        /\(\(item\)\s*=>\s*item\.label\s*===\s*submenuLabel\)/g,
        '((item) => item.label === submenuLabel || item.__agOrigLabel === submenuLabel)'
    );
    patched = replaceStringLiteral(patched, 'Connect to WSL', '连接至 WSL');
    patched = replaceStringLiteral(patched, 'Reopen Locally', '在本地重新打开');
    fs.writeFileSync(selected.filePath, patched, 'utf8');
    return path.relative(extractedDir, selected.filePath);
}

function replaceStringLiteral(content, original, translated) {
    const pattern = new RegExp(`(["'])${escapeRegExp(original)}\\1`, 'g');
    return content.replace(pattern, (_, quote) => `${quote}${translated}${quote}`);
}

function patchOptionalMainProcessStrings(extractedDir) {
    const changedFiles = [];
    for (const filePath of listJavaScriptFiles(extractedDir)) {
        let content = readTextFileBounded(filePath);
        if (!content) continue;
        const original = content;

        const looksLikeTray = /No agents running|createTray\s*\(|new\s+Tray\s*\(/.test(content);
        if (looksLikeTray) {
            content = replaceStringLiteral(content, 'No agents running', '无运行中的智能体');
            content = replaceStringLiteral(content, 'Open Antigravity', '打开 Antigravity');
            content = content.replace(/`Open \$\{([^}]+)\}`/g, '`打开 ${$1}`');
            content = replaceStringLiteral(content, 'Quit', '退出');
            content = replaceStringLiteral(content, 'Connect to WSL', '连接至 WSL');
            content = replaceStringLiteral(content, 'Reopen Locally', '在本地重新打开');
            content = content.replace(
                /countItem\.label\s*=\s*\([\s\S]*?' running';/g,
                "countItem.label = count > 0 ? `${count} 个智能体运行中` : '无运行中的智能体';"
            );
        }

        if (content.includes('createProvisionSplash')) {
            content = content.replace(
                '<div>Setting up WSL: ${escapeHtml(distro)}</div>',
                '<div>正在配置 WSL：${escapeHtml(distro)}</div>'
            );
        }

        const looksLikeUpdater = content.includes('Check for Updates') && content.includes('No updates available');
        if (looksLikeUpdater) {
            content = replaceStringLiteral(content, 'Check for Updates', '检查更新');
            content = replaceStringLiteral(content, 'No updates available', '暂无可用更新');
            content = replaceStringLiteral(content, 'OK', '确定');
        }
        content = content.replace(
            '<div class="text">Loading Antigravity</div>',
            '<div class="text">Antigravity 正在启动...</div>'
        );

        const looksLikeWizardHtml = content.includes('Welcome to the new Antigravity!') || content.includes('Explore the new Antigravity');
        if (looksLikeWizardHtml) {
            content = content
                .replace('<title>Welcome to Antigravity</title>', '<title>欢迎使用 Antigravity</title>')
                .replace('<div class="text" style="font-size: 13px; opacity: 0.6; letter-spacing: 0.03em;">Setting up…</div>', '<div class="text" style="font-size: 13px; opacity: 0.6; letter-spacing: 0.03em;">正在设置…</div>')
                .replace('<h1>Welcome to the new Antigravity!</h1>', '<h1>欢迎使用全新 Antigravity！</h1>')
                .replace("<p>Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.</p>", '<p>Antigravity 经过重新设计，以智能体为核心并带来全新能力。如果您仍希望使用代码编辑器，可将其作为名为 <b>Antigravity IDE</b> 的独立应用下载</p>')
                .replace('<span>Download the Antigravity IDE</span>', '<span>下载 Antigravity IDE</span>')
                .replace('<button class="btn-primary" id="btn-skip">Explore the new Antigravity</button>', '<button class="btn-primary" id="btn-skip">探索全新 Antigravity</button>');
        }

        const contextMenuMatch = content.match(/function\s+buildContextMenuTemplate\s*\(\s*items\s*,\s*onSelect\s*\)\s*\{/);
        if (contextMenuMatch) {
            content = cleanMarkedBlock(content, IPC_CONTEXT_MENU_SIGNATURE_START, IPC_CONTEXT_MENU_SIGNATURE_END);
            const matchedHeader = contextMenuMatch[0];
            const replacementHeader = `${matchedHeader}
    ${IPC_CONTEXT_MENU_SIGNATURE_START}
    const contextMenuTranslations = {
        "Rename": "重命名",
        "Mark Unread": "标记为未读",
        "Mark Read": "标记为已读",
        "Cut": "剪切",
        "Copy": "复制",
        "Paste": "粘贴",
        "Select All": "全选",
        "Split": "拆分",
        "Archive": "归档",
        "Delete": "删除",
        "Pin": "置顶",
        "Unpin": "取消置顶",
        "Conversation Name": "会话名称",
        "Conversation ID": "会话 ID",
        "Project Name": "项目名称",
        "Workspace Name": "工作区名称",
        "Worktree Name": "工作树名称",
        "Copy Project Name": "复制项目名称",
        "Project Settings": "项目设置",
        "Show in File Explorer": "在文件资源管理器中显示",
        "Show in Finder": "在 Finder 中显示",
        "Show in File Manager": "在文件管理器中显示",
        "Reveal in File Explorer": "在文件资源管理器中显示",
        "Reveal in Finder": "在 Finder 中显示",
        "Delete Project": "删除项目",
        "Split Right": "向右拆分",
        "Split Down": "向下拆分",
        "Replace with New": "替换为新会话",
        "Replace With New": "替换为新会话",
        "Remove from Split": "从拆分中移除",
        "Remove From Split": "从拆分中移除",
        "Copy File Path": "复制文件路径",
        "Copy File Name": "复制文件名称",
        "Add to Chat": "添加到聊天",
        "Copy Image": "复制图片",
        "Save Image": "保存图片",
        "Copy Video": "复制视频",
        "Save Video": "保存视频",
        "Stop": "停止",
        "Close Tab": "关闭标签页",
        "Close Other Tabs": "关闭其他标签页",
        "Close Tabs to the Right": "关闭右侧标签页",
        "Back": "后退",
        "Forward": "前进",
        "Reload": "重新加载",
        "Open in External Browser": "在外部浏览器中打开",
        "Open in Built-in Browser": "在内置浏览器中打开",
        "Open in Browser": "在浏览器中打开",
        "Copy Link": "复制链接",
        "Reopen Closed Tab": "重新打开已关闭的标签页",
        "Move Conversation Up": "上移会话",
        "Move Conversation Down": "下移会话",
        "Background Commands": "后台命令"
    };
    if (Array.isArray(items)) {
        items = items.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const itemId = String(item.id || '');
            if (/^group-(?!new$|remove$)/i.test(itemId)) return item;
            const rawLabel = typeof item.label === 'string' ? item.label.trim() : '';
            const translatedLabel = rawLabel && contextMenuTranslations[rawLabel] ? contextMenuTranslations[rawLabel] : item.label;
            return translatedLabel !== item.label ? Object.assign({}, item, { label: translatedLabel }) : item;
        });
    }
    ${IPC_CONTEXT_MENU_SIGNATURE_END}`;
            content = content.replace(matchedHeader, replacementHeader);
        }

        if (content !== original) {
            fs.writeFileSync(filePath, content, 'utf8');
            changedFiles.push(path.relative(extractedDir, filePath));
        }
    }
    return changedFiles;
}

function getManifestPath(resourcesDir) {
    return path.join(resourcesDir, MANIFEST_FILE);
}

function getBackupFolder(resourcesDir) {
    return path.join(resourcesDir, BACKUP_FOLDER);
}

function resolveRelativeWithin(baseDir, relativePath) {
    if (!relativePath || path.isAbsolute(relativePath)) return null;
    const resolved = path.resolve(baseDir, relativePath);
    return isPathInside(baseDir, resolved) ? resolved : null;
}

function writeJsonWithRollback(targetPath, data) {
    const parent = path.dirname(targetPath);
    fs.mkdirSync(parent, { recursive: true });
    const nonce = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const staged = `${targetPath}.new-${nonce}`;
    const previous = `${targetPath}.previous-${nonce}`;
    fs.writeFileSync(staged, JSON.stringify(data, null, 2) + '\n', 'utf8');

    let movedPrevious = false;
    try {
        if (fs.existsSync(targetPath)) {
            fs.renameSync(targetPath, previous);
            movedPrevious = true;
        }
        fs.renameSync(staged, targetPath);
        if (movedPrevious && fs.existsSync(previous)) fs.unlinkSync(previous);
    } catch (error) {
        if (fs.existsSync(staged)) fs.unlinkSync(staged);
        if (movedPrevious && !fs.existsSync(targetPath) && fs.existsSync(previous)) {
            fs.renameSync(previous, targetPath);
        }
        throw error;
    }
}

function ensureVersionedBackup(resourcesDir, sourceArchive, sourceHash) {
    const backupFolder = getBackupFolder(resourcesDir);
    fs.mkdirSync(backupFolder, { recursive: true });
    const backupPath = path.join(backupFolder, `app.asar.original-${sourceHash}.bak`);

    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(sourceArchive, backupPath, fs.constants.COPYFILE_EXCL);
    }
    const backupHash = hashFile(backupPath);
    if (backupHash !== sourceHash) {
        throw new InstallerError(`版本化备份哈希不匹配，拒绝继续: ${backupPath}`);
    }
    return {
        backupPath,
        backupRelativePath: path.relative(resourcesDir, backupPath).replace(/\\/g, '/'),
    };
}

function findManagedBackup(resourcesDir, metadata, manifest) {
    const candidates = [];
    if (metadata && metadata.backupFile) candidates.push(metadata.backupFile);
    if (manifest && manifest.activeBackup) candidates.push(manifest.activeBackup);

    for (const relativePath of candidates) {
        const resolved = resolveRelativeWithin(resourcesDir, relativePath);
        if (resolved && fs.existsSync(resolved)) return resolved;
    }

    const legacyBackup = path.join(resourcesDir, 'app.asar.bak');
    if (fs.existsSync(legacyBackup)) return legacyBackup;
    return null;
}

function prepareBaseArchive(resourcesDir, currentArchive, tempRoot) {
    const inspectDir = path.join(tempRoot, 'inspect-current');
    extractArchive(currentArchive, inspectDir, resourcesDir);
    const currentMetadata = readLocalizationMetadata(inspectDir);
    const currentIsLocalized = archiveContainsLocalization(inspectDir);
    const currentHash = hashFile(currentArchive);

    if (!currentIsLocalized) {
        return {
            baseArchive: currentArchive,
            baseHash: currentHash,
            extractedDir: inspectDir,
            migratedLegacyBackup: false,
            unpackSpec: readAsarUnpackSpec(currentArchive),
        };
    }

    const manifest = readJsonFile(getManifestPath(resourcesDir));
    const backupPath = findManagedBackup(resourcesDir, currentMetadata, manifest);
    if (!backupPath) {
        throw new InstallerError(
            '当前 app.asar 已包含汉化标记，但没有可验证的官方备份。请先重新安装官方客户端，再运行本工具。'
        );
    }

    const backupHash = hashFile(backupPath);
    const expectedHash = currentMetadata && currentMetadata.baseHash;
    if (expectedHash && backupHash !== expectedHash) {
        throw new InstallerError('备份文件与汉化包内记录的官方哈希不一致，拒绝使用。');
    }
    if (!validateArchive(backupPath)) {
        throw new InstallerError(`备份不是有效的 ASAR 包: ${backupPath}`);
    }

    const baseDir = path.join(tempRoot, 'base-from-backup');
    extractArchive(backupPath, baseDir, resourcesDir);
    if (archiveContainsLocalization(baseDir)) {
        throw new InstallerError('候选备份本身含有汉化标记，不能视为官方原版。');
    }

    return {
        baseArchive: backupPath,
        baseHash: backupHash,
        extractedDir: baseDir,
        migratedLegacyBackup: path.basename(backupPath).toLowerCase() === 'app.asar.bak',
        unpackSpec: readAsarUnpackSpec(backupPath),
    };
}

function fsyncFile(filePath) {
    // Windows 的 FlushFileBuffers 需要可写句柄；文件已经由本进程生成，因此
    // 这里使用 r+，不会改变文件内容。
    const descriptor = fs.openSync(filePath, 'r+');
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function atomicReplaceArchive(stagedArchive, targetArchive, expectedHash) {
    const targetStat = fs.statSync(targetArchive);
    if (process.platform !== 'win32') fs.chmodSync(stagedArchive, targetStat.mode);
    const stagedHash = hashFile(stagedArchive);
    if (stagedHash !== expectedHash) throw new InstallerError('暂存 app.asar 哈希校验失败。');
    fsyncFile(stagedArchive);

    // stagedArchive 与 targetArchive 位于同一目录/卷。Node 在 Windows 使用
    // MOVEFILE_REPLACE_EXISTING，在 POSIX 使用 rename(2)，因此这是单步替换：
    // 失败时旧文件仍在，成功时不会出现 app.asar 暂时缺失的窗口。
    fs.renameSync(stagedArchive, targetArchive);
}

function createStagedArchive(resourcesDir, extractedDir, unpackSpec = null) {
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const stagedArchive = path.join(resourcesDir, `app.asar.localized-${nonce}.tmp`);
    const stagedUnpacked = `${stagedArchive}.unpacked`;
    const packArgs = ['pack'];
    if (unpackSpec && unpackSpec.hasUnpacked && fs.existsSync(path.join(resourcesDir, 'app.asar.unpacked'))) {
        if (unpackSpec.unpackDirs.length === 1) {
            packArgs.push('--unpack-dir', unpackSpec.unpackDirs[0]);
        } else if (unpackSpec.unpackDirs.length > 1) {
            packArgs.push('--unpack-dir', `{${unpackSpec.unpackDirs.join(',')}}`);
        }
        if (unpackSpec.unpackFiles.length === 1) {
            packArgs.push('--unpack', unpackSpec.unpackFiles[0]);
        } else if (unpackSpec.unpackFiles.length > 1) {
            packArgs.push('--unpack', `{${unpackSpec.unpackFiles.join(',')}}`);
        }
    }
    packArgs.push(extractedDir, stagedArchive);
    let packResult;
    try {
        packResult = runAsar(packArgs);
    } finally {
        if (fs.existsSync(stagedUnpacked)) {
            fs.rmSync(stagedUnpacked, { recursive: true, force: true });
        }
    }
    if (!packResult.success || !validateArchive(stagedArchive)) {
        if (fs.existsSync(stagedArchive)) fs.unlinkSync(stagedArchive);
        throw new InstallerError(`ASAR 打包或验证失败: ${packResult.stderr || packResult.stdout}`);
    }
    return stagedArchive;
}

function installLocalization(resourcesDir, options = {}) {
    const currentArchive = path.join(resourcesDir, 'app.asar');
    if (!fs.existsSync(currentArchive)) {
        throw new InstallerError(`未找到 app.asar: ${currentArchive}`);
    }
    resolveAsarCli();

    const tempRoot = createTempRoot();
    let stagedArchive = null;
    try {
        console.log('[检查] 正在识别当前客户端结构与官方基线...');
        const base = prepareBaseArchive(resourcesDir, currentArchive, tempRoot);
        const appInfo = detectAppInfo(base.extractedDir);
        if (!appInfo.verified && !options.allowUnverifiedProduct) {
            throw new InstallerError(
                `无法从 ${appInfo.evidenceFile || 'ASAR 元数据'} 确认这是 Antigravity。` +
                '如已人工核实，可显式追加 --allow-unverified-product。'
            );
        }

        console.log(`[识别] 产品: ${appInfo.name}; 版本: ${appInfo.version}; 依据: ${appInfo.evidenceFile || '未知'}`);
        const backup = ensureVersionedBackup(resourcesDir, base.baseArchive, base.baseHash);

        const preloadPath = patchPreload(base.extractedDir);
        const menuPath = patchNativeMenu(base.extractedDir);
        const optionalFiles = patchOptionalMainProcessStrings(base.extractedDir);
        const metadata = {
            schemaVersion: 1,
            engineVersion: ENGINE_VERSION,
            installedAt: new Date().toISOString(),
            product: appInfo.name,
            appVersion: appInfo.version,
            baseHash: base.baseHash,
            backupFile: backup.backupRelativePath,
            preloadFile: preloadPath.replace(/\\/g, '/'),
        };
        fs.writeFileSync(
            path.join(base.extractedDir, METADATA_FILE),
            JSON.stringify(metadata, null, 2) + '\n',
            'utf8'
        );

        console.log(`[修改] preload: ${preloadPath}`);
        if (menuPath) console.log(`[修改] 原生菜单: ${menuPath}`);
        if (optionalFiles.length > 0) console.log(`[修改] 其他主进程界面文件: ${optionalFiles.length} 个`);

        stagedArchive = createStagedArchive(resourcesDir, base.extractedDir, base.unpackSpec);
        const localizedHash = hashFile(stagedArchive);
        atomicReplaceArchive(stagedArchive, currentArchive, localizedHash);
        stagedArchive = null;

        const manifest = {
            schemaVersion: 1,
            engineVersion: ENGINE_VERSION,
            status: 'installed',
            updatedAt: new Date().toISOString(),
            product: appInfo.name,
            appVersion: appInfo.version,
            originalHash: base.baseHash,
            localizedHash,
            activeBackup: backup.backupRelativePath,
            migratedLegacyBackup: base.migratedLegacyBackup,
        };
        try {
            writeJsonWithRollback(getManifestPath(resourcesDir), manifest);
        } catch (error) {
            console.warn(`[警告] 客户端已安全替换，但外部清单写入失败；包内元数据仍可用于还原: ${error.message}`);
        }

        console.log(`[完成] 已部署版本无关汉化引擎；官方基线 SHA-256: ${base.baseHash}`);
        return { appInfo, baseHash: base.baseHash, localizedHash, backupPath: backup.backupPath };
    } finally {
        if (stagedArchive && fs.existsSync(stagedArchive)) fs.unlinkSync(stagedArchive);
        safeRemoveTempRoot(tempRoot);
    }
}

function restoreLocalization(resourcesDir) {
    const currentArchive = path.join(resourcesDir, 'app.asar');
    if (!fs.existsSync(currentArchive)) {
        throw new InstallerError(`未找到 app.asar: ${currentArchive}`);
    }
    resolveAsarCli();

    const tempRoot = createTempRoot();
    let stagedArchive = null;
    try {
        const inspectDir = path.join(tempRoot, 'inspect-restore');
        extractArchive(currentArchive, inspectDir, resourcesDir);
        const metadata = readLocalizationMetadata(inspectDir);
        const isLocalized = archiveContainsLocalization(inspectDir);
        if (!isLocalized) {
            console.log('[提示] 当前 app.asar 不含本工具的汉化标记，无需还原；不会使用陈旧备份覆盖它。');
            return { alreadyOfficial: true };
        }

        const manifest = readJsonFile(getManifestPath(resourcesDir));
        const backupPath = findManagedBackup(resourcesDir, metadata, manifest);
        if (!backupPath) {
            throw new InstallerError('未找到与当前汉化包关联的官方备份，拒绝猜测或降级。');
        }

        const backupHash = hashFile(backupPath);
        const expectedHash = metadata && metadata.baseHash;
        if (expectedHash && backupHash !== expectedHash) {
            throw new InstallerError('官方备份哈希与包内元数据不一致，拒绝还原。');
        }
        if (!validateArchive(backupPath)) {
            throw new InstallerError('官方备份不是有效的 ASAR 包。');
        }

        const verifyDir = path.join(tempRoot, 'verify-backup');
        extractArchive(backupPath, verifyDir, resourcesDir);
        if (archiveContainsLocalization(verifyDir)) {
            throw new InstallerError('官方备份包含汉化标记，拒绝还原。');
        }

        const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
        stagedArchive = path.join(resourcesDir, `app.asar.restore-${nonce}.tmp`);
        fs.copyFileSync(backupPath, stagedArchive, fs.constants.COPYFILE_EXCL);
        const stagedHash = hashFile(stagedArchive);
        if (stagedHash !== backupHash || !validateArchive(stagedArchive)) {
            throw new InstallerError('还原暂存文件校验失败。');
        }
        atomicReplaceArchive(stagedArchive, currentArchive, backupHash);
        stagedArchive = null;

        const restoredInfo = detectAppInfo(verifyDir);
        try {
            writeJsonWithRollback(getManifestPath(resourcesDir), {
                schemaVersion: 1,
                engineVersion: ENGINE_VERSION,
                status: 'restored',
                updatedAt: new Date().toISOString(),
                product: restoredInfo.name,
                appVersion: restoredInfo.version,
                originalHash: backupHash,
                activeBackup: path.relative(resourcesDir, backupPath).replace(/\\/g, '/'),
            });
        } catch (error) {
            console.warn(`[警告] 官方包已还原，但状态清单更新失败: ${error.message}`);
        }

        console.log(`[完成] 已按 SHA-256 校验还原官方包: ${backupHash}`);
        return { restoredHash: backupHash, backupPath };
    } finally {
        if (stagedArchive && fs.existsSync(stagedArchive)) fs.unlinkSync(stagedArchive);
        safeRemoveTempRoot(tempRoot);
    }
}

function runTool(command, args, options = {}) {
    return childProcess.spawnSync(command, args, {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        ...options,
    });
}

function trustedWindowsTool(fileName) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const candidate = path.join(systemRoot, 'System32', fileName);
    return fs.existsSync(candidate) ? candidate : null;
}

function trustedUnixTool(fileName) {
    for (const folder of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
        const candidate = path.join(folder, fileName);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function checkIfAppIsRunning() {
    try {
        if (process.platform === 'win32') {
            const tasklist = trustedWindowsTool('tasklist.exe');
            if (!tasklist) return false;
            const result = runTool(tasklist, ['/fi', 'imagename eq Antigravity.exe', '/nh']);
            return result.status === 0 && /antigravity\.exe/i.test(result.stdout || '');
        }
        const pgrep = trustedUnixTool('pgrep');
        if (!pgrep) return false;
        const result = runTool(pgrep, ['-x', '-i', 'antigravity']);
        return result.status === 0 && (result.stdout || '').trim().length > 0;
    } catch (_) {
        return false;
    }
}

function sleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function forceCloseAntigravity() {
    console.warn('[强制关闭] 用户已显式启用 --force-kill，正在结束 Antigravity 进程。');
    if (process.platform === 'win32') {
        const taskkill = trustedWindowsTool('taskkill.exe');
        if (!taskkill) throw new InstallerError('未找到可信的 Windows taskkill.exe。');
        runTool(taskkill, ['/f', '/im', 'Antigravity.exe', '/t'], { stdio: 'ignore' });
    } else {
        const pkill = trustedUnixTool('pkill');
        if (!pkill) throw new InstallerError('未找到可信的系统 pkill。');
        runTool(pkill, ['-x', '-i', 'antigravity'], { stdio: 'ignore' });
    }
    sleep(1200);
    if (checkIfAppIsRunning()) {
        throw new InstallerError('强制关闭后仍检测到 Antigravity 进程，拒绝修改正在使用的文件。');
    }
}

function detectInstallationDir(manualDir) {
    if (manualDir) {
        if (!fs.existsSync(manualDir)) throw new InstallerError(`指定路径不存在: ${manualDir}`);
        let resolved = path.resolve(manualDir);
        if (fs.statSync(resolved).isFile() && path.basename(resolved).toLowerCase() === 'app.asar') {
            resolved = path.dirname(resolved);
        }
        return resolved;
    }

    const candidates = [];
    const seen = new Set();
    const add = candidate => {
        if (!candidate) return;
        const resolved = path.resolve(candidate);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(resolved);
        }
    };
    const hasResources = candidate =>
        fs.existsSync(path.join(candidate, 'resources', 'app.asar')) ||
        fs.existsSync(path.join(candidate, 'app.asar')) ||
        fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'app.asar'));

    add(process.env.ANTIGRAVITY_INSTALL_DIR);
    add(process.env.ANTIGRAVITY_HOME);

    if (process.platform === 'win32') {
        const registryRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        ];
        const reg = trustedWindowsTool('reg.exe');
        for (const root of registryRoots) {
            if (!reg) break;
            const result = runTool(reg, ['query', root, '/s', '/f', 'Antigravity', '/d']);
            if (result.status !== 0) continue;
            for (const line of (result.stdout || '').split(/\r?\n/)) {
                const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                if (!match) continue;
                let value = match[2].trim().replace(/^"|"$/g, '');
                if (/Antigravity\.exe/i.test(value)) value = path.dirname(value);
                add(value);
            }
        }
        for (const drive of ['C', 'D', 'E', 'F']) {
            add(`${drive}:\\Programs\\Antigravity`);
            add(`${drive}:\\Antigravity`);
        }
        add('C:\\Program Files\\Antigravity');
        if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'));
    } else {
        const homeDir = process.env.HOME || '';
        for (const candidate of [
            '/opt/Antigravity', '/opt/Antigravity/Antigravity-x64', '/opt/antigravity',
            '/opt/antigravity/antigravity-x64', '/usr/share/antigravity', '/usr/share/Antigravity',
            '/usr/lib/antigravity', '/usr/lib/Antigravity',
        ]) add(candidate);
        if (homeDir) {
            add(path.join(homeDir, '.local', 'share', 'antigravity'));
            add(path.join(homeDir, '.local', 'share', 'Antigravity'));
            add(path.join(homeDir, 'antigravity'));
        }

        const desktopFiles = [
            '/usr/share/applications/antigravity.desktop',
            '/usr/share/applications/Antigravity.desktop',
            path.join(homeDir, '.local', 'share', 'applications', 'antigravity.desktop'),
            path.join(homeDir, '.local', 'share', 'applications', 'Antigravity.desktop'),
        ];
        for (const desktopFile of desktopFiles) {
            if (!desktopFile || !fs.existsSync(desktopFile)) continue;
            const content = fs.readFileSync(desktopFile, 'utf8');
            const match = content.match(/^Exec=(?:"([^"]+)"|(\S+))/m);
            const executable = match && (match[1] || match[2]);
            if (executable && fs.existsSync(executable)) {
                let realExecutable = executable;
                try { realExecutable = fs.realpathSync(executable); } catch (_) {}
                add(path.dirname(realExecutable));
            }
        }

        const which = trustedUnixTool('which');
        for (const command of ['antigravity', 'agy']) {
            if (!which) break;
            const result = runTool(which, [command]);
            const executable = result.status === 0 ? (result.stdout || '').trim() : '';
            if (executable && fs.existsSync(executable)) {
                let realExecutable = executable;
                try { realExecutable = fs.realpathSync(executable); } catch (_) {}
                add(path.dirname(realExecutable));
            }
        }
    }

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        if (hasResources(candidate)) return candidate;
        try {
            if (!fs.statSync(candidate).isDirectory()) continue;
            for (const child of fs.readdirSync(candidate)) {
                const childPath = path.join(candidate, child);
                if (fs.existsSync(childPath) && fs.statSync(childPath).isDirectory() && hasResources(childPath)) {
                    return childPath;
                }
            }
        } catch (_) {}
    }
    throw new InstallerError('未找到 Antigravity 安装目录；请使用 --install-dir 明确指定。');
}

function resolveResourcesDir(installDir) {
    const candidates = [
        path.join(installDir, 'resources'),
        path.join(installDir, 'Contents', 'Resources'),
        installDir,
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'app.asar'))) return candidate;
    }
    throw new InstallerError(`无法在安装目录中定位 resources/app.asar: ${installDir}`);
}

function ensureWritable(resourcesDir) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    fs.accessSync(resourcesDir, fs.constants.W_OK | fs.constants.X_OK);
    fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
}

function parseArguments(argv) {
    const options = {
        restore: false,
        installDir: '',
        forceKill: false,
        allowUnverifiedProduct: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--huifu' || argument === '--restore') options.restore = true;
        else if (argument === '--install-dir') options.installDir = argv[++index] || '';
        else if (argument.startsWith('--install-dir=')) options.installDir = argument.slice('--install-dir='.length);
        else if (argument === '--force-kill') options.forceKill = true;
        else if (argument === '--allow-unverified-product') options.allowUnverifiedProduct = true;
        else if (argument === '--brand-title') index++;
    }
    return options;
}

function launchApp(installDir) {
    const candidates = process.platform === 'win32'
        ? [path.join(installDir, 'Antigravity.exe')]
        : [
            path.join(installDir, 'antigravity'),
            path.join(installDir, 'Antigravity'),
            path.join(installDir, 'bin', 'antigravity'),
        ];
    for (const executable of candidates) {
        if (!fs.existsSync(executable)) continue;
        const child = childProcess.spawn(executable, [], { detached: true, stdio: 'ignore', shell: false });
        child.unref();
        return true;
    }
    return false;
}

function main(argv = process.argv.slice(2)) {
    try {
        const options = parseArguments(argv);
        resolveAsarCli();
        const installDir = detectInstallationDir(options.installDir);
        const resourcesDir = resolveResourcesDir(installDir);
        ensureWritable(resourcesDir);

        const wasRunning = checkIfAppIsRunning();
        if (wasRunning && !options.forceKill) {
            throw new InstallerError(
                '检测到 Antigravity 正在运行。为保护未保存内容，默认不会强制结束进程；请正常退出后重试，或显式使用 --force-kill。'
            );
        }
        if (wasRunning) forceCloseAntigravity();

        if (options.restore) restoreLocalization(resourcesDir);
        else installLocalization(resourcesDir, options);

        if (wasRunning && options.forceKill && !launchApp(installDir)) {
            console.warn('[提示] 未能自动重新启动客户端，请手动启动 Antigravity。');
        }
        return true;
    } catch (error) {
        const prefix = error instanceof InstallerError ? '[安全停止]' : '[错误]';
        console.error(`${prefix} ${error.message}`);
        if (process.platform !== 'win32' && ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
            console.error('[提示] 请先以普通用户运行 npm ci --ignore-scripts，再使用 sudo 执行安装脚本。');
        }
        process.exitCode = 1;
        return false;
    }
}

module.exports = {
    ENGINE_VERSION,
    ASAR_PACKAGE_VERSION,
    InstallerError,
    archiveContainsLocalization,
    atomicReplaceArchive,
    checkIfAppIsRunning,
    createStagedArchive,
    detectAppInfo,
    discoverPreload,
    hashFile,
    installLocalization,
    main,
    parseArguments,
    patchNativeMenu,
    patchPreload,
    resolveAsarCli,
    restoreLocalization,
    runAsar,
    safeRemoveTempRoot,
};

if (require.main === module) main();
