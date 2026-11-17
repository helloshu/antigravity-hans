'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    archiveContainsLocalization,
    detectAppInfo,
    discoverPreload,
    hashFile,
    installLocalization,
    parseArguments,
    restoreLocalization,
    runAsar,
} = require('../installer');
const {
    CTX_BRIDGE_PRELOAD_START,
    CTX_MONITOR_MAIN_START,
    SIGNATURE_START,
    UTILS_SUBFRAME_SIGNATURE_START,
} = require('../localization_engine');

function makeDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function packSyntheticApp(resourcesDir, version, options = {}) {
    const sourceDir = makeDirectory(path.join(resourcesDir, `source-${version}-${Date.now()}`));
    const productName = options.productName || 'Antigravity';
    const mainEntry = options.distMain ? 'dist/main.js' : 'build/main.js';
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
        name: productName.toLowerCase().replace(/\s+/g, '-'),
        productName,
        version,
        main: mainEntry,
    }, null, 2));

    const preloadRelative = options.hashedLayout
        ? path.join('build', 'assets', `preload-${version.replace(/\D/g, '')}.js`)
        : path.join('dist', 'preload.js');
    const preloadPath = path.join(sourceDir, preloadRelative);
    makeDirectory(path.dirname(preloadPath));
    fs.writeFileSync(
        preloadPath,
        "const { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('fixture', { ping: () => ipcRenderer.send('ping') });\n"
    );

    const mainPath = path.join(sourceDir, mainEntry);
    makeDirectory(path.dirname(mainPath));
    fs.writeFileSync(mainPath, [
        "const electron_1 = require('electron');",
        "const menu = { items: [{ label: 'File', submenu: { items: [{ label: 'Quit' }, { label: 'Actual Size' }] } }] };",
        'electron_1.Menu.setApplicationMenu(menu);',
        'electron_1.app.whenReady().then(async () => {});',
        "async function reportWslError(WSL_DISTRO, err) { const msg = `Failed to install the server into WSL distro \"${WSL_DISTRO}\":\\n${err.message}`; await electron_1.dialog.showErrorBox('WSL setup failed', msg); }",
    ].join('\n'));
    const updaterDir = options.distMain ? path.join(sourceDir, 'dist') : path.join(sourceDir, 'build');
    makeDirectory(updaterDir);
    fs.writeFileSync(
        path.join(updaterDir, 'tray.js'),
        "function createTray(actions) { return actions; }\nconst labels = ['No agents running', 'Open Antigravity', 'Quit'];\n"
    );
    fs.writeFileSync(
        path.join(updaterDir, 'updater.js'),
        [
            'const MenuUpdateStep = {};',
            'MenuUpdateStep["CheckForUpdates"] = "Check for Updates";',
            'MenuUpdateStep["CheckingForUpdates"] = "Checking for Updates...";',
            'MenuUpdateStep["DownloadingUpdate"] = "Downloading Update...";',
            'MenuUpdateStep["RestartToUpdate"] = "Restart to Update";',
            "const dialog = { title: 'Check for Updates', message: 'No updates available', buttons: ['OK'] };",
        ].join('\n') + '\n'
    );

    if (options.withSubframeUtils) {
        const utilsPath = path.join(sourceDir, 'dist', 'utils.js');
        makeDirectory(path.dirname(utilsPath));
        fs.writeFileSync(utilsPath, [
            "const electron_1 = require('electron');",
            "const path_1 = { default: require('path') };",
            "const fs = require('fs');",
            "function attachHub(win, hubContents, handleTitleUpdate) {",
            "    hubContents.on?.('page-title-updated', handleTitleUpdate);",
            "    return () => {",
            "        hubContents.off?.('page-title-updated', handleTitleUpdate);",
            "    };",
            "}",
            "module.exports = { attachHub };",
        ].join('\n'));
    }

    if (options.unpackedModule) {
        const unpackedFile = path.join(sourceDir, 'node_modules', options.unpackedModule, 'index.js');
        makeDirectory(path.dirname(unpackedFile));
        fs.writeFileSync(unpackedFile, "module.exports = { unpacked: true };\n");
    }

    const archivePath = path.join(resourcesDir, 'app.asar');
    const unpackedPath = `${archivePath}.unpacked`;
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    if (fs.existsSync(unpackedPath)) fs.rmSync(unpackedPath, { recursive: true, force: true });
    const packArgs = options.unpackedModule
        ? ['pack', '--unpack-dir', `node_modules/${options.unpackedModule}`, sourceDir, archivePath]
        : ['pack', sourceDir, archivePath];
    const result = runAsar(packArgs);
    assert.strictEqual(result.success, true, result.stderr || result.stdout);
    const baseHash = hashFile(archivePath);
    fs.rmSync(sourceDir, { recursive: true, force: true });
    return { archivePath, baseHash, preloadRelative };
}

function inspectArchive(archivePath, inspectionRoot) {
    const result = runAsar(['extract', archivePath, inspectionRoot]);
    assert.strictEqual(result.success, true, result.stderr || result.stdout);
    return inspectionRoot;
}

function verifyZeroShellConcatenation() {
    const rootDir = path.resolve(__dirname, '..');
    const targetJsFiles = [
        'localization_engine.js',
        'installer.js',
        'context_monitor.js',
        'scripts/verify.js',
        'scripts/lib/dictionary-audit.js',
        'scripts/lib/fake-dom.js',
        'scripts/lib/load-engine.js',
        '.agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js',
    ];
    for (const rel of targetJsFiles) {
        const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
        assert.strictEqual(/\bexecSync\s*\(|\bexecFileSync\s*\(/.test(content), false, `${rel} 包含禁止的 execSync/execFileSync`);
        assert.strictEqual(/\bshell\s*:\s*true\b/.test(content), false, `${rel} 包含禁止的 shell: true`);
        assert.strictEqual(/\bnpx\s+|\bcurl\s+-/.test(content), false, `${rel} 包含禁止的 npx/curl 调用`);
    }
}

function run() {
    verifyZeroShellConcatenation();
    assert.strictEqual(parseArguments(['--no-context-monitor']).contextMonitor, false);
    assert.strictEqual(parseArguments([]).contextMonitor, true);

    // 路径特意包含 shell 元字符。所有 ASAR 调用都使用 shell:false 参数数组，
    // 因此这些字符只能作为普通文件名处理。
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-safe-$()-&-'));
    const resourcesDir = makeDirectory(path.join(testRoot, 'Antigravity', 'resources'));

    try {
        const firstOfficial = packSyntheticApp(resourcesDir, '2.6.0');
        const firstInstall = installLocalization(resourcesDir);
        assert.strictEqual(firstInstall.baseHash, firstOfficial.baseHash);

        const firstInspect = inspectArchive(
            firstOfficial.archivePath,
            path.join(testRoot, 'inspect-localized-1')
        );
        assert.strictEqual(archiveContainsLocalization(firstInspect), true);
        assert.strictEqual(detectAppInfo(firstInspect).version, '2.6.0');
        const firstPreload = discoverPreload(firstInspect);
        assert.ok(firstPreload.content.includes(SIGNATURE_START));

        const firstRestore = restoreLocalization(resourcesDir);
        assert.strictEqual(firstRestore.restoredHash, firstOfficial.baseHash);
        assert.strictEqual(hashFile(firstOfficial.archivePath), firstOfficial.baseHash);

        // 模拟官方升级：旧清单和旧备份仍然存在，但新的未汉化 app.asar 应成为
        // 新基线，不能被旧 app.asar.bak/旧清单降级覆盖。
        const secondOfficial = packSyntheticApp(resourcesDir, '11.4.7', { hashedLayout: true });
        assert.notStrictEqual(secondOfficial.baseHash, firstOfficial.baseHash);
        const secondInstall = installLocalization(resourcesDir);
        assert.strictEqual(secondInstall.baseHash, secondOfficial.baseHash);

        const secondInspect = inspectArchive(
            secondOfficial.archivePath,
            path.join(testRoot, 'inspect-localized-2')
        );
        assert.strictEqual(detectAppInfo(secondInspect).version, '11.4.7');
        assert.strictEqual(archiveContainsLocalization(secondInspect), true);
        assert.ok(discoverPreload(secondInspect).content.includes(SIGNATURE_START));

        const secondRestore = restoreLocalization(resourcesDir);
        assert.strictEqual(secondRestore.restoredHash, secondOfficial.baseHash);
        assert.strictEqual(hashFile(secondOfficial.archivePath), secondOfficial.baseHash);

        // v2.32.1+: 带 app.asar.unpacked、plugin:// 子框架钩子及 contextMonitor.js 上下文监控
        const unpackedOfficial = packSyntheticApp(resourcesDir, '2.32.1', {
            unpackedModule: 'chrome-devtools-mcp',
            withSubframeUtils: true,
            distMain: true,
        });
        assert.strictEqual(fs.existsSync(`${unpackedOfficial.archivePath}.unpacked`), true);
        const unpackedFirstInstall = installLocalization(resourcesDir);
        assert.strictEqual(unpackedFirstInstall.baseHash, unpackedOfficial.baseHash);
        assert.strictEqual(unpackedFirstInstall.contextMonitor, true);

        const v232Inspect = inspectArchive(
            unpackedOfficial.archivePath,
            path.join(testRoot, 'inspect-localized-232')
        );
        const patchedUtils = fs.readFileSync(path.join(v232Inspect, 'dist', 'utils.js'), 'utf8');
        const patchedSubframe = fs.readFileSync(path.join(v232Inspect, 'dist', 'subframeLocalizationPreload.js'), 'utf8');
        const patchedContextMonitor = fs.readFileSync(path.join(v232Inspect, 'dist', 'contextMonitor.js'), 'utf8');
        const patchedMain = fs.readFileSync(path.join(v232Inspect, 'dist', 'main.js'), 'utf8');
        const patchedPreload = fs.readFileSync(path.join(v232Inspect, 'dist', 'preload.js'), 'utf8');
        const patchedUpdater = fs.readFileSync(path.join(v232Inspect, 'dist', 'updater.js'), 'utf8');
        assert.ok(patchedUtils.includes(UTILS_SUBFRAME_SIGNATURE_START), 'utils.js 未注入 plugin:// 子框架钩子');
        assert.ok(patchedSubframe.includes('__agSubframeLocalizationInstalled'), 'subframeLocalizationPreload.js 缺少子框架守卫');
        assert.ok(
            patchedContextMonitor.includes('ag-ctx:metrics')
                && patchedContextMonitor.includes('injectIntoWebContents')
                && patchedContextMonitor.includes('isRemoteContents'),
            'contextMonitor.js 未注入或缺少远端窗口防护'
        );
        assert.ok(patchedMain.includes(CTX_MONITOR_MAIN_START), 'dist/main.js 未注入 contextMonitor 启动块');
        assert.ok(patchedPreload.includes(CTX_BRIDGE_PRELOAD_START), 'dist/preload.js 未注入 agContextMonitor IPC 桥');
        assert.ok(patchedUpdater.includes('MenuUpdateStep["CheckingForUpdates"] = "正在检查更新...";'), 'updater.js MenuUpdateStep 未同步汉化');
        assert.ok(patchedMain.includes("'Actual Size': '实际大小'"), '原生菜单缺少 Actual Size 词条');
        assert.ok(patchedMain.includes("showErrorBox('WSL 设置失败'"), 'main.js WSL 错误弹窗未汉化');
        assert.strictEqual(discoverPreload(v232Inspect).relativePath, 'dist/preload.js', '辅助模块干扰了主 preload 定位');

        // 覆盖重装时显式关闭上下文监控 (--no-context-monitor) 必须干净剥离注入且保持基线哈希不变
        const noMonitorReinstall = installLocalization(resourcesDir, { contextMonitor: false });
        assert.strictEqual(noMonitorReinstall.baseHash, unpackedOfficial.baseHash);
        assert.strictEqual(noMonitorReinstall.contextMonitor, false);
        const noMonitorInspect = inspectArchive(
            unpackedOfficial.archivePath,
            path.join(testRoot, 'inspect-localized-232-no-ctx')
        );
        assert.strictEqual(fs.existsSync(path.join(noMonitorInspect, 'dist', 'contextMonitor.js')), false, '--no-context-monitor 仍残留 contextMonitor.js');
        assert.strictEqual(
            fs.readFileSync(path.join(noMonitorInspect, 'dist', 'main.js'), 'utf8').includes(CTX_MONITOR_MAIN_START),
            false,
            '--no-context-monitor 仍残留 main.js 监控启动块'
        );
        assert.strictEqual(
            fs.readFileSync(path.join(noMonitorInspect, 'dist', 'preload.js'), 'utf8').includes(CTX_BRIDGE_PRELOAD_START),
            false,
            '--no-context-monitor 仍残留 preload.js 监控桥'
        );

        const unpackedRestore = restoreLocalization(resourcesDir);
        assert.strictEqual(unpackedRestore.restoredHash, unpackedOfficial.baseHash);
        assert.strictEqual(hashFile(unpackedOfficial.archivePath), unpackedOfficial.baseHash);
        fs.rmSync(`${unpackedOfficial.archivePath}.unpacked`, { recursive: true, force: true });

        // 非 Antigravity 包必须失败关闭，且不得改写原文件。
        const unrelated = packSyntheticApp(resourcesDir, '99.0.0', { productName: 'Unrelated Electron App' });
        assert.throws(() => installLocalization(resourcesDir), /确认这是 Antigravity/);
        assert.strictEqual(hashFile(unrelated.archivePath), unrelated.baseHash);

        console.log('security_hardening.test.js: PASS');
    } finally {
        const resolvedRoot = path.resolve(testRoot);
        assert.ok(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
}

run();
