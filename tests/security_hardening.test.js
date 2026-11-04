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
    restoreLocalization,
    runAsar,
} = require('../installer');
const { SIGNATURE_START } = require('../localization_engine');

function makeDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function packSyntheticApp(resourcesDir, version, options = {}) {
    const sourceDir = makeDirectory(path.join(resourcesDir, `source-${version}-${Date.now()}`));
    const productName = options.productName || 'Antigravity';
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
        name: productName.toLowerCase().replace(/\s+/g, '-'),
        productName,
        version,
        main: 'build/main.js',
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

    const mainPath = path.join(sourceDir, 'build', 'main.js');
    makeDirectory(path.dirname(mainPath));
    fs.writeFileSync(mainPath, [
        "const electron_1 = require('electron');",
        "const menu = { items: [{ label: 'File', submenu: { items: [{ label: 'Quit' }] } }] };",
        'electron_1.Menu.setApplicationMenu(menu);',
    ].join('\n'));
    fs.writeFileSync(
        path.join(sourceDir, 'build', 'tray.js'),
        "function createTray(actions) { return actions; }\nconst labels = ['No agents running', 'Open Antigravity', 'Quit'];\n"
    );
    fs.writeFileSync(
        path.join(sourceDir, 'build', 'updater.js'),
        "const dialog = { title: 'Check for Updates', message: 'No updates available', buttons: ['OK'] };\n"
    );

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

function run() {
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

        // v2.29.0+ 带 app.asar.unpacked 解包目录的安装、覆盖重装与 SHA-256 无损还原。
        const unpackedOfficial = packSyntheticApp(resourcesDir, '2.29.0', { unpackedModule: 'chrome-devtools-mcp' });
        assert.strictEqual(fs.existsSync(`${unpackedOfficial.archivePath}.unpacked`), true);
        const unpackedFirstInstall = installLocalization(resourcesDir);
        assert.strictEqual(unpackedFirstInstall.baseHash, unpackedOfficial.baseHash);
        const unpackedReinstall = installLocalization(resourcesDir);
        assert.strictEqual(unpackedReinstall.baseHash, unpackedOfficial.baseHash);
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
