'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const childProcess = require('child_process');
const {
    generateJs,
    generateSubframeJs,
    SIGNATURE_START,
    SIGNATURE_END,
    LEGACY_SIGNATURE_START = '/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */',
    LEGACY_SIGNATURE_END = '/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */',
    MENU_SIGNATURE_START = '/* --- ANTIGRAVITY MENU LOCALIZATIONV2 START --- */',
    MENU_SIGNATURE_END = '/* --- ANTIGRAVITY MENU LOCALIZATIONV2 END --- */',
    LEGACY_MENU_SIGNATURE_START = '/* --- ANTIGRAVITY MENU LOCALIZATION START --- */',
    LEGACY_MENU_SIGNATURE_END = '/* --- ANTIGRAVITY MENU LOCALIZATION END --- */',
    TRAY_SIGNATURE_START = '/* --- ANTIGRAVITY TRAY LOCALIZATIONV2 START --- */',
    TRAY_SIGNATURE_END = '/* --- ANTIGRAVITY TRAY LOCALIZATIONV2 END --- */',
    LEGACY_TRAY_SIGNATURE_START = '/* --- ANTIGRAVITY TRAY LOCALIZATION START --- */',
    LEGACY_TRAY_SIGNATURE_END = '/* --- ANTIGRAVITY TRAY LOCALIZATION END --- */',
    IPC_CONTEXT_MENU_SIGNATURE_START = '/* --- ANTIGRAVITY IPC CONTEXT MENU LOCALIZATION START --- */',
    IPC_CONTEXT_MENU_SIGNATURE_END = '/* --- ANTIGRAVITY IPC CONTEXT MENU LOCALIZATION END --- */',
    MAIN_SUBFRAME_SIGNATURE_START = "'__ANTIGRAVITY_MAIN_SUBFRAME_LOCALIZATION_START__';",
    MAIN_SUBFRAME_SIGNATURE_END = "'__ANTIGRAVITY_MAIN_SUBFRAME_LOCALIZATION_END__';",
    UTILS_SUBFRAME_SIGNATURE_START = "'__ANTIGRAVITY_UTILS_SUBFRAME_LOCALIZATION_START__';",
    UTILS_SUBFRAME_SIGNATURE_END = "'__ANTIGRAVITY_UTILS_SUBFRAME_LOCALIZATION_END__';",
} = require('./localization_engine');

const SUBFRAME_PRELOAD_BASENAME = 'subframeLocalizationPreload.js';

const ALT_MENU_SIGNATURE_START = '/* --- ANTIGRAVITY NATIVE MENU LOCALIZATION START --- */';
const ALT_MENU_SIGNATURE_END = '/* --- ANTIGRAVITY NATIVE MENU LOCALIZATION END --- */';

const ENGINE_VERSION = '3.1.0';
const METADATA_FILE = 'antigravity-localization.json';
const MANIFEST_FILE = 'app.asar.localization.json';
const BACKUP_FOLDER = '.antigravity-localization-backups';
const TEMP_PREFIX = 'antigravity-localization-';
const ASAR_BLOCK_SIZE = 4 * 1024 * 1024;

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
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function computeAsarIntegrity(buffer) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const blocks = [];
    for (let offset = 0; offset < buffer.length; offset += ASAR_BLOCK_SIZE) {
        const slice = buffer.subarray(offset, Math.min(offset + ASAR_BLOCK_SIZE, buffer.length));
        blocks.push(crypto.createHash('sha256').update(slice).digest('hex'));
    }
    if (blocks.length === 0) {
        blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
    }
    return {
        algorithm: 'SHA256',
        hash,
        blockSize: ASAR_BLOCK_SIZE,
        blocks,
    };
}

function isSafeArchiveEntryName(name) {
    return Boolean(
        typeof name === 'string' &&
        name.length > 0 &&
        name !== '.' &&
        name !== '..' &&
        !name.includes('/') &&
        !name.includes('\\') &&
        !name.includes('\0') &&
        !name.includes(':')
    );
}

class AsarArchive {
    static align4(n) {
        return (n + 3) & ~3;
    }

    static readHeader(asarPath) {
        const stat = fs.statSync(asarPath);
        if (!stat.isFile() || stat.size < 16) {
            throw new InstallerError(`无效的 ASAR 文件（体积过小）: ${asarPath}`);
        }
        const fd = fs.openSync(asarPath, 'r');
        try {
            const sizeBuf = Buffer.alloc(8);
            if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
                throw new InstallerError(`无法读取 ASAR 头部长度: ${asarPath}`);
            }
            const pickleSize = sizeBuf.readUInt32LE(0);
            const headerSize = sizeBuf.readUInt32LE(4);
            if (pickleSize !== 4 || headerSize < 8 || headerSize > 64 * 1024 * 1024 || 8 + headerSize > stat.size) {
                throw new InstallerError(`ASAR 头部尺寸越界或格式损坏: ${asarPath}`);
            }

            const headerBuf = Buffer.alloc(headerSize);
            if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) {
                throw new InstallerError(`无法完整读取 ASAR 头部内容: ${asarPath}`);
            }

            const jsonLen = headerBuf.readUInt32LE(4);
            if (jsonLen === 0 || 8 + jsonLen > headerSize) {
                throw new InstallerError(`ASAR JSON 元数据长度越界: ${asarPath}`);
            }

            const jsonStr = headerBuf.subarray(8, 8 + jsonLen).toString('utf8');
            const header = JSON.parse(jsonStr);
            if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
                throw new InstallerError(`ASAR 头部缺少有效的 files 树: ${asarPath}`);
            }
            const baseOffset = 8 + headerSize;
            return { header, baseOffset, headerSize, jsonLen, fileSize: stat.size };
        } finally {
            fs.closeSync(fd);
        }
    }

    static createHeaderBuffer(headerJson) {
        const jsonBuf = Buffer.from(headerJson, 'utf8');
        const jsonLen = jsonBuf.length;
        const alignedJsonLen = this.align4(jsonLen);

        const headerPayloadSize = 4 + alignedJsonLen;
        const headerBuf = Buffer.alloc(4 + headerPayloadSize);
        headerBuf.writeUInt32LE(headerPayloadSize, 0);
        headerBuf.writeUInt32LE(jsonLen, 4);
        jsonBuf.copy(headerBuf, 8);

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeUInt32LE(4, 0);
        sizeBuf.writeUInt32LE(headerBuf.length, 4);

        return Buffer.concat([sizeBuf, headerBuf]);
    }

    static validate(asarPath) {
        try {
            if (!fs.existsSync(asarPath)) return false;
            const { header, baseOffset, fileSize } = this.readHeader(asarPath);
            let fileCount = 0;

            const validateTree = (dirObj, depth) => {
                if (depth > 128 || !dirObj || typeof dirObj !== 'object') return false;
                for (const [name, entry] of Object.entries(dirObj)) {
                    if (!isSafeArchiveEntryName(name) || !entry || typeof entry !== 'object') {
                        return false;
                    }
                    if (entry.files && typeof entry.files === 'object') {
                        if (!validateTree(entry.files, depth + 1)) return false;
                    } else if (entry.link !== undefined) {
                        if (typeof entry.link !== 'string' || entry.link.includes('..') || path.isAbsolute(entry.link)) {
                            return false;
                        }
                    } else if (entry.unpacked) {
                        fileCount++;
                    } else {
                        if (entry.offset === undefined || entry.size === undefined) return false;
                        const offset = Number(entry.offset);
                        const size = Number(entry.size);
                        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0) {
                            return false;
                        }
                        if (baseOffset + offset + size > fileSize) {
                            return false;
                        }
                        fileCount++;
                    }
                }
                return true;
            };

            return validateTree(header.files, 0) && fileCount > 0;
        } catch (_) {
            return false;
        }
    }

    static list(asarPath) {
        const { header } = this.readHeader(asarPath);
        const result = [];
        const walk = (dirObj, prefix) => {
            for (const [name, entry] of Object.entries(dirObj)) {
                if (!isSafeArchiveEntryName(name)) {
                    throw new InstallerError(`检测到不安全的 ASAR 条目名: ${name}`);
                }
                const relPath = prefix ? `${prefix}/${name}` : name;
                result.push(`/${relPath}`);
                if (entry && entry.files && typeof entry.files === 'object') {
                    walk(entry.files, relPath);
                }
            }
        };
        walk(header.files, '');
        return result;
    }

    static readFile(sourceAsar, relPath, resourcesDir = null) {
        const { header, baseOffset, fileSize } = this.readHeader(sourceAsar);
        const parts = relPath.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
        let cur = header.files;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!isSafeArchiveEntryName(p) || !cur || !cur[p]) return null;
            cur = i < parts.length - 1 ? cur[p].files : cur[p];
        }
        if (!cur || cur.files) return null;
        if (cur.unpacked) {
            const candidates = [`${sourceAsar}.unpacked`];
            if (resourcesDir) candidates.push(path.join(resourcesDir, 'app.asar.unpacked'));
            for (const root of candidates) {
                const unpackedPath = path.join(root, ...parts);
                if (fs.existsSync(unpackedPath)) return fs.readFileSync(unpackedPath);
            }
            return null;
        }
        if (cur.offset === undefined || cur.size === undefined) return null;
        const offset = Number(cur.offset);
        const size = Number(cur.size);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || baseOffset + offset + size > fileSize) {
            throw new InstallerError(`ASAR 文件偏移越界: ${relPath}`);
        }
        const fd = fs.openSync(sourceAsar, 'r');
        try {
            const buf = Buffer.alloc(size);
            fs.readSync(fd, buf, 0, size, baseOffset + offset);
            return buf;
        } finally {
            fs.closeSync(fd);
        }
    }

    static extract(sourceAsar, destDir, resourcesDir = null) {
        if (!this.validate(sourceAsar)) {
            throw new InstallerError(`ASAR 校验失败或包含不安全路径: ${sourceAsar}`);
        }
        const { header, baseOffset } = this.readHeader(sourceAsar);
        fs.mkdirSync(destDir, { recursive: true });
        const fd = fs.openSync(sourceAsar, 'r');
        try {
            const walk = (dirObj, relParts) => {
                for (const [name, entry] of Object.entries(dirObj)) {
                    if (!isSafeArchiveEntryName(name)) {
                        throw new InstallerError(`拒绝解包不安全路径: ${name}`);
                    }
                    const nextParts = [...relParts, name];
                    const targetPath = path.join(destDir, ...nextParts);
                    if (!isPathInside(destDir, targetPath)) {
                        throw new InstallerError(`检测到目录穿越: ${targetPath}`);
                    }
                    if (entry.files && typeof entry.files === 'object') {
                        fs.mkdirSync(targetPath, { recursive: true });
                        walk(entry.files, nextParts);
                    } else if (entry.unpacked) {
                        const unpackedRoots = [`${sourceAsar}.unpacked`];
                        if (resourcesDir) unpackedRoots.push(path.join(resourcesDir, 'app.asar.unpacked'));
                        else unpackedRoots.push(path.join(path.dirname(sourceAsar), 'app.asar.unpacked'));
                        let copied = false;
                        for (const root of unpackedRoots) {
                            const srcUnpacked = path.join(root, ...nextParts);
                            if (fs.existsSync(srcUnpacked)) {
                                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                                fs.copyFileSync(srcUnpacked, targetPath);
                                copied = true;
                                break;
                            }
                        }
                        if (!copied) {
                            throw new InstallerError(`未找到解包目录文件: ${nextParts.join('/')}`);
                        }
                    } else if (entry.offset !== undefined && entry.size !== undefined) {
                        const size = Number(entry.size);
                        const offset = Number(entry.offset);
                        const buf = Buffer.alloc(size);
                        if (size > 0) {
                            fs.readSync(fd, buf, 0, size, baseOffset + offset);
                        }
                        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                        fs.writeFileSync(targetPath, buf);
                        if (entry.executable && process.platform !== 'win32') {
                            try { fs.chmodSync(targetPath, 0o755); } catch (_) {}
                        }
                    }
                }
            };
            walk(header.files, []);
        } finally {
            fs.closeSync(fd);
        }
    }

    static pack(sourceDir, targetAsar, options = {}) {
        const unpackDirs = (options.unpackDirs || []).map(d => d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean);
        const unpackFiles = (options.unpackFiles || []).map(f => f.replace(/\\/g, '/').replace(/^\/+/g, '')).filter(Boolean);

        const isUnpackedPath = relPath => {
            for (const dir of unpackDirs) {
                if (relPath === dir || relPath.startsWith(`${dir}/`)) return true;
            }
            for (const file of unpackFiles) {
                if (relPath === file) return true;
            }
            return false;
        };

        const header = { files: {} };
        const packedPayloads = [];
        let currentOffset = BigInt(0);
        const unpackedRoot = `${targetAsar}.unpacked`;

        const buildTree = (absDir, relPrefix, targetFilesObj) => {
            const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
                const fullPath = path.join(absDir, entry.name);
                if (entry.isDirectory()) {
                    const dirNode = { files: {} };
                    if (isUnpackedPath(relPath)) dirNode.unpacked = true;
                    targetFilesObj[entry.name] = dirNode;
                    buildTree(fullPath, relPath, dirNode.files);
                } else if (entry.isFile()) {
                    const stat = fs.statSync(fullPath);
                    const buf = fs.readFileSync(fullPath);
                    const integrity = computeAsarIntegrity(buf);
                    if (isUnpackedPath(relPath)) {
                        targetFilesObj[entry.name] = {
                            size: stat.size,
                            unpacked: true,
                            integrity,
                        };
                        const destUnpacked = path.join(unpackedRoot, ...relPath.split('/'));
                        fs.mkdirSync(path.dirname(destUnpacked), { recursive: true });
                        fs.copyFileSync(fullPath, destUnpacked);
                    } else {
                        const fileNode = {
                            size: buf.length,
                            offset: currentOffset.toString(),
                            integrity,
                        };
                        if (process.platform !== 'win32' && (stat.mode & 0o111) !== 0) {
                            fileNode.executable = true;
                        }
                        targetFilesObj[entry.name] = fileNode;
                        packedPayloads.push(buf);
                        currentOffset += BigInt(buf.length);
                    }
                }
            }
        };

        buildTree(path.resolve(sourceDir), '', header.files);
        const headerBuf = this.createHeaderBuffer(JSON.stringify(header));
        fs.mkdirSync(path.dirname(path.resolve(targetAsar)), { recursive: true });
        const fd = fs.openSync(targetAsar, 'w');
        try {
            fs.writeSync(fd, headerBuf, 0, headerBuf.length, 0);
            let writePos = headerBuf.length;
            for (const buf of packedPayloads) {
                if (buf.length > 0) {
                    fs.writeSync(fd, buf, 0, buf.length, writePos);
                    writePos += buf.length;
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    static patchArchive(sourceAsar, targetAsar, filePatches) {
        if (!this.validate(sourceAsar)) {
            throw new InstallerError(`源 ASAR 校验失败，拒绝修补: ${sourceAsar}`);
        }
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const normalizedPatches = new Map();
        const newPaths = new Set();

        for (const [rawPath, content] of Object.entries(filePatches || {})) {
            const relPath = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
            const parts = relPath.split('/').filter(Boolean);
            if (parts.length === 0 || !parts.every(isSafeArchiveEntryName)) {
                throw new InstallerError(`非法补丁路径: ${rawPath}`);
            }
            const normalizedPath = parts.join('/');
            normalizedPatches.set(normalizedPath, content);

            let cur = header.files;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!cur[part] || typeof cur[part] !== 'object') {
                    cur[part] = { files: {} };
                } else if (!cur[part].files) {
                    throw new InstallerError(`补丁路径与现有文件冲突: ${relPath}`);
                }
                cur = cur[part].files;
            }
            const leaf = parts[parts.length - 1];
            if (content === null) {
                delete cur[leaf];
            } else if (!cur[leaf]) {
                const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
                newPaths.add(normalizedPath);
                cur[leaf] = {
                    size: buf.length,
                    offset: '0',
                    integrity: computeAsarIntegrity(buf),
                };
            }
        }

        const srcFd = fs.openSync(sourceAsar, 'r');
        let destFd = null;
        try {
            const fileEntries = [];
            const walk = (dir, currentPath) => {
                for (const [name, entry] of Object.entries(dir)) {
                    const fullPath = currentPath ? `${currentPath}/${name}` : name;
                    if (entry.files) {
                        walk(entry.files, fullPath);
                    } else {
                        fileEntries.push({ path: fullPath, entry });
                    }
                }
            };
            walk(header.files, '');

            const packedFiles = fileEntries.filter(f => !f.entry.unpacked && f.entry.offset !== undefined);
            packedFiles.sort((a, b) => {
                const aNew = newPaths.has(a.path) ? 1 : 0;
                const bNew = newPaths.has(b.path) ? 1 : 0;
                if (aNew !== bNew) return aNew - bNew;
                const diff = Number(a.entry.offset) - Number(b.entry.offset);
                return diff !== 0 ? diff : a.path.localeCompare(b.path);
            });

            for (const item of packedFiles) {
                item.oldOffset = Number(item.entry.offset);
                item.oldSize = Number(item.entry.size);
                if (normalizedPatches.has(item.path)) {
                    const patch = normalizedPatches.get(item.path);
                    const patchBuf = Buffer.isBuffer(patch) ? patch : Buffer.from(String(patch), 'utf8');
                    item.patchBuffer = patchBuf;
                    item.entry.size = patchBuf.length;
                    item.entry.integrity = computeAsarIntegrity(patchBuf);
                }
            }

            let currentOffset = BigInt(0);
            for (const item of packedFiles) {
                item.entry.offset = currentOffset.toString();
                currentOffset += BigInt(item.entry.size);
            }

            const newHeaderBuf = this.createHeaderBuffer(JSON.stringify(header));
            destFd = fs.openSync(targetAsar, 'w');
            fs.writeSync(destFd, newHeaderBuf, 0, newHeaderBuf.length, 0);

            let writePos = newHeaderBuf.length;
            const copyBufSize = 256 * 1024;
            const copyBuf = Buffer.allocUnsafe(copyBufSize);

            for (const item of packedFiles) {
                if (item.patchBuffer) {
                    if (item.patchBuffer.length > 0) {
                        fs.writeSync(destFd, item.patchBuffer, 0, item.patchBuffer.length, writePos);
                        writePos += item.patchBuffer.length;
                    }
                } else {
                    let remaining = item.oldSize;
                    let readPos = baseOffset + item.oldOffset;
                    while (remaining > 0) {
                        const toRead = Math.min(remaining, copyBufSize);
                        fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
                        fs.writeSync(destFd, copyBuf, 0, toRead, writePos);
                        readPos += toRead;
                        writePos += toRead;
                        remaining -= toRead;
                    }
                }
            }
        } finally {
            fs.closeSync(srcFd);
            if (destFd !== null) fs.closeSync(destFd);
        }
    }
}

function parseUnpackPattern(pattern) {
    if (!pattern) return [];
    const trimmed = String(pattern).trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return trimmed.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }
    return [trimmed];
}

function runAsar(args) {
    try {
        if (!Array.isArray(args) || args.length === 0) {
            return { success: false, status: 1, stdout: '', stderr: '缺少 ASAR 子命令' };
        }
        const command = args[0];
        if (command === 'list') {
            const archivePath = args[args.length - 1];
            const lines = AsarArchive.list(archivePath);
            return { success: true, status: 0, stdout: lines.join('\n') + '\n', stderr: '' };
        }
        if (command === 'extract') {
            const archivePath = args[1];
            const destDir = args[2];
            AsarArchive.extract(archivePath, destDir);
            return { success: true, status: 0, stdout: '', stderr: '' };
        }
        if (command === 'pack') {
            const unpackDirs = [];
            const unpackFiles = [];
            const positional = [];
            for (let i = 1; i < args.length; i++) {
                if (args[i] === '--unpack-dir') {
                    unpackDirs.push(...parseUnpackPattern(args[++i]));
                } else if (args[i] === '--unpack') {
                    unpackFiles.push(...parseUnpackPattern(args[++i]));
                } else {
                    positional.push(args[i]);
                }
            }
            const [sourceDir, targetAsar] = positional;
            AsarArchive.pack(sourceDir, targetAsar, { unpackDirs, unpackFiles });
            return { success: true, status: 0, stdout: '', stderr: '' };
        }
        return { success: false, status: 1, stdout: '', stderr: `不支持的 ASAR 命令: ${command}` };
    } catch (error) {
        return { success: false, status: 1, stdout: '', stderr: error.message };
    }
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

function validateArchive(archivePath) {
    return AsarArchive.validate(archivePath);
}

function isAsarFile(targetPath) {
    try {
        return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
    } catch (_) {
        return false;
    }
}

function listTargetFiles(target, predicate = () => true) {
    if (isAsarFile(target)) {
        const { header } = AsarArchive.readHeader(target);
        const results = [];
        const walk = (dirObj, prefix) => {
            for (const [name, entry] of Object.entries(dirObj)) {
                const relPath = prefix ? `${prefix}/${name}` : name;
                if (entry && entry.files) {
                    walk(entry.files, relPath);
                } else if (entry && !entry.unpacked && predicate(relPath, entry)) {
                    results.push(relPath);
                }
            }
        };
        walk(header.files, '');
        return results;
    }
    return walkFiles(target, fullPath => predicate(path.relative(target, fullPath).replace(/\\/g, '/')));
}

function readTargetTextFile(target, relPath, maxBytes = 32 * 1024 * 1024) {
    if (isAsarFile(target)) {
        const buf = AsarArchive.readFile(target, relPath);
        if (!buf || buf.length > maxBytes) return null;
        return buf.toString('utf8');
    }
    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(target, relPath);
    if (!fs.existsSync(fullPath)) return null;
    return readTextFileBounded(fullPath, maxBytes);
}

function detectAppInfo(target) {
    const jsonRelPaths = listTargetFiles(
        target,
        relPath => ['package.json', 'product.json'].includes(path.posix.basename(relPath).toLowerCase())
    );
    const candidates = [];

    for (const itemPath of jsonRelPaths) {
        const relPath = isAsarFile(target) ? itemPath : path.relative(target, itemPath);
        const normRel = relPath.replace(/\\/g, '/');
        if (normRel.split('/').length > 4) continue;
        const text = readTargetTextFile(target, itemPath, 2 * 1024 * 1024);
        if (!text) continue;
        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            continue;
        }
        if (!data || typeof data !== 'object') continue;

        const names = [
            data.productName,
            data.name,
            data.applicationName,
            data.displayName,
            data.appId,
        ].filter(value => typeof value === 'string');
        const depth = normRel.split('/').length;
        const joined = names.join(' ');
        const verified = /antigravity/i.test(joined) && depth <= 3;
        let score = verified ? 100 : 0;
        if (normRel.toLowerCase() === 'package.json') score += 20;
        if (normRel.toLowerCase().endsWith('/product.json') || normRel.toLowerCase() === 'product.json') score += 10;

        candidates.push({
            name: names[0] || 'unknown',
            version: typeof data.version === 'string' ? data.version : 'unknown',
            verified,
            evidenceFile: relPath,
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

function scorePreloadCandidate(relativePathNormalized, content) {
    const lowerRel = relativePathNormalized.replace(/\\/g, '/').toLowerCase();
    const baseName = path.posix.basename(lowerRel);
    let score = 0;
    if (lowerRel === 'dist/preload.js') score += 300;
    if (baseName === 'preload.js') score += 180;
    else if (baseName.includes('preload')) score += 100;
    if (/contextBridge/.test(content)) score += 50;
    if (/ipcRenderer/.test(content)) score += 40;
    if (/require\(["']electron["']\)|from\s+["']electron["']/.test(content)) score += 20;
    score -= lowerRel.split('/').length;
    return score;
}

function hasPreloadEvidence(content) {
    return /contextBridge|ipcRenderer|webFrame|process\.contextIsolated|process\.once\(["']loaded["']|require\(["']electron["']\)|from\s+["']electron["']/.test(content);
}

function discoverPreload(target) {
    const isArchive = isAsarFile(target);
    const jsFiles = listTargetFiles(target, relPath => {
        if (!/\.(?:js|cjs|mjs)$/i.test(relPath)) return false;
        return path.posix.basename(relPath.replace(/\\/g, '/')).toLowerCase() !== SUBFRAME_PRELOAD_BASENAME.toLowerCase();
    });
    const namedCandidates = jsFiles.filter(p => path.basename(p).toLowerCase().includes('preload'));
    const candidates = [];
    const inspected = new Set();

    const inspectFiles = filePaths => {
        for (const itemPath of filePaths) {
            if (inspected.has(itemPath)) continue;
            inspected.add(itemPath);
            const relPath = isArchive ? itemPath : path.relative(target, itemPath).replace(/\\/g, '/');
            const content = readTargetTextFile(target, itemPath);
            if (content === null || !hasPreloadEvidence(content)) continue;
            const score = scorePreloadCandidate(relPath, content);
            if (score > 0) {
                candidates.push({
                    filePath: isArchive ? relPath : itemPath,
                    relativePath: relPath,
                    content,
                    score,
                });
            }
        }
    };

    inspectFiles(namedCandidates);
    if (candidates.length === 0) inspectFiles(jsFiles);

    candidates.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

    if (candidates.length === 0 || candidates[0].score < 40) {
        throw new InstallerError('未能可靠定位 Electron preload 脚本；为避免破坏未知版本，安装已停止。');
    }
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
        const tied = candidates.filter(c => c.score === candidates[0].score).map(c => c.relativePath);
        throw new InstallerError(`检测到多个同等可信的 preload 候选，拒绝猜测: ${tied.join(', ')}`);
    }
    return candidates[0];
}

function readLocalizationMetadata(target) {
    const text = readTargetTextFile(target, METADATA_FILE, 1024 * 1024);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function archiveContainsLocalization(target) {
    if (readLocalizationMetadata(target)) return true;
    const jsFiles = listTargetFiles(target, relPath => /\.(?:js|cjs|mjs)$/i.test(relPath));
    const priority = jsFiles.filter(p => /preload|menu|tray|ipcHandlers|utils/i.test(p));
    const rest = jsFiles.filter(p => !/preload|menu|tray|ipcHandlers|utils/i.test(p));
    for (const itemPath of [...priority, ...rest]) {
        const content = readTargetTextFile(target, itemPath);
        if (
            content &&
            (content.includes(SIGNATURE_START) ||
                content.includes(LEGACY_SIGNATURE_START) ||
                content.includes(UTILS_SUBFRAME_SIGNATURE_START))
        ) {
            return true;
        }
    }
    return false;
}

function cleanMarkedBlock(content, startMarker, endMarker) {
    const pattern = new RegExp(
        escapeRegExp(startMarker) + '[\\s\\S]*?' + escapeRegExp(endMarker),
        'g'
    );
    return content.replace(pattern, '');
}

function cleanLocalizationBlock(content) {
    let result = cleanMarkedBlock(content, SIGNATURE_START, SIGNATURE_END);
    result = cleanMarkedBlock(result, LEGACY_SIGNATURE_START, LEGACY_SIGNATURE_END);
    return result.replace(
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', typeof globalThis.__agTranslateContextMenuItems === 'function' ? globalThis.__agTranslateContextMenuItems(items) : items),",
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', items),"
    );
}

function compileCheckJs(source, label) {
    try {
        new vm.Script(source, { filename: label });
    } catch (error) {
        throw new InstallerError(`生成的补丁脚本语法校验失败 (${label}): ${error.message}`);
    }
}

function buildPatchedPreloadContent(rawPreloadContent, generatedJs = null) {
    let cleaned = cleanLocalizationBlock(rawPreloadContent).trimEnd();
    cleaned = cleaned.replace(
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', items),",
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', typeof globalThis.__agTranslateContextMenuItems === 'function' ? globalThis.__agTranslateContextMenuItems(items) : items),"
    );
    const generated = generatedJs || generateJs();
    compileCheckJs(generated, 'generated-localization-injection.js');
    const combined = `${cleaned}\n\n${generated}\n`;
    compileCheckJs(combined, 'preload.patched.js');
    return combined;
}

function buildSubframeLocalizationContent(generatedJs = null) {
    const generated = generatedJs || generateJs();
    const subframeJs = generateSubframeJs(generated);
    compileCheckJs(subframeJs, SUBFRAME_PRELOAD_BASENAME);
    return subframeJs;
}

function patchPreload(extractedDir) {
    const candidate = discoverPreload(extractedDir);
    const patched = buildPatchedPreloadContent(candidate.content);
    fs.writeFileSync(candidate.filePath, patched, 'utf8');
    return path.relative(extractedDir, candidate.filePath);
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
        'Zoom': '缩放', 'Actual Size': '实际大小', 'Reset Zoom': '重置缩放', 'Zoom In': '放大', 'Zoom Out': '缩小',
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
            else if (__agMenuTranslations[label]) item.label = __agMenuTranslations[label];
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

function replaceStringLiteral(content, original, translated) {
    const pattern = new RegExp(`(["'])${escapeRegExp(original)}\\1`, 'g');
    return content.replace(pattern, (_, quote) => `${quote}${translated}${quote}`);
}

function buildPatchedMenuContent(rawContent) {
    const setMenuPattern = /((?:[A-Za-z_$][\w$]*\.)*Menu\.setApplicationMenu\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?)/;
    const setMenuGlobalPattern = /((?:[A-Za-z_$][\w$]*\.)*Menu\.setApplicationMenu\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?)/g;
    let content = cleanMarkedBlock(rawContent, MENU_SIGNATURE_START, MENU_SIGNATURE_END);
    content = cleanMarkedBlock(content, LEGACY_MENU_SIGNATURE_START, LEGACY_MENU_SIGNATURE_END);
    content = cleanMarkedBlock(content, ALT_MENU_SIGNATURE_START, ALT_MENU_SIGNATURE_END);
    if (!setMenuPattern.test(content)) return null;

    let patched = content.replace(
        setMenuGlobalPattern,
        (fullMatch, callExpr, menuVar) => `${buildMenuTranslationBlock(menuVar)}\n${callExpr}`
    );
    patched = patched.replace(
        /\(\(item\)\s*=>\s*item\.label\s*===\s*submenuLabel\)/g,
        '((item) => item.label === submenuLabel || item.__agOrigLabel === submenuLabel)'
    );
    patched = replaceStringLiteral(patched, 'Connect to WSL', '连接至 WSL');
    patched = replaceStringLiteral(patched, 'Reopen Locally', '在本地重新打开');
    compileCheckJs(patched, 'menu.patched.js');
    return patched;
}

function patchNativeMenu(extractedDir) {
    const candidates = [];
    for (const filePath of walkFiles(extractedDir, p => /\.(?:js|cjs|mjs)$/i.test(p))) {
        const content = readTextFileBounded(filePath);
        if (!content || (!content.includes('setApplicationMenu') && !content.includes(MENU_SIGNATURE_START) && !content.includes(ALT_MENU_SIGNATURE_START))) {
            continue;
        }
        const patched = buildPatchedMenuContent(content);
        if (patched) {
            candidates.push({
                filePath,
                patched,
                score: path.basename(filePath).toLowerCase() === 'menu.js' ? 20 : 0,
            });
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    if (candidates.length === 0) return null;
    const selected = candidates[0];
    fs.writeFileSync(selected.filePath, selected.patched, 'utf8');
    return path.relative(extractedDir, selected.filePath);
}

function applyOptionalMainProcessPatch(content, relPath = 'main-process.js') {
    let result = cleanMarkedBlock(content, TRAY_SIGNATURE_START, TRAY_SIGNATURE_END);
    result = cleanMarkedBlock(result, LEGACY_TRAY_SIGNATURE_START, LEGACY_TRAY_SIGNATURE_END);
    result = cleanMarkedBlock(result, IPC_CONTEXT_MENU_SIGNATURE_START, IPC_CONTEXT_MENU_SIGNATURE_END);
    result = cleanMarkedBlock(result, MAIN_SUBFRAME_SIGNATURE_START, MAIN_SUBFRAME_SIGNATURE_END);
    result = cleanMarkedBlock(result, UTILS_SUBFRAME_SIGNATURE_START, UTILS_SUBFRAME_SIGNATURE_END);
    result = result
        .replace("await electron_1.dialog.showErrorBox('WSL 设置失败', msg);", "await electron_1.dialog.showErrorBox('WSL setup failed', msg);")
        .replace('`未能将服务端安装至 WSL 分发版 "${WSL_DISTRO}"：\\n${err.message}`', '`Failed to install the server into WSL distro "${WSL_DISTRO}":\\n${err.message}`');

    const looksLikeTray = /No agents running|createTray\s*\(|new\s+Tray\s*\(/.test(result);
    if (looksLikeTray) {
        const createTrayMatch = result.match(/function\s+createTray\s*\(\s*actions(?:\s*,\s*onClick)?\s*\)\s*\{/);
        if (createTrayMatch) {
            const matchedFuncHeader = createTrayMatch[0];
            const replacementCreate = `${matchedFuncHeader}
    ${TRAY_SIGNATURE_START}
    const __agTrayTranslations = {
        'No agents running': '无运行中的智能体',
        'Open Antigravity': '打开 Antigravity',
        'Quit': '退出',
        'Connect to WSL': '连接至 WSL',
        'Reopen Locally': '在本地重新打开'
    };
    if (Array.isArray(actions)) {
        for (const item of actions) {
            if (item && __agTrayTranslations[item.label]) {
                item.label = __agTrayTranslations[item.label];
            }
        }
    }
    ${TRAY_SIGNATURE_END}`;
            result = result.replace(matchedFuncHeader, replacementCreate);
        }

        const targetInsert = 'function insertTrayMenuItem(position, options) {';
        if (result.includes(targetInsert)) {
            const replacementInsert = `function insertTrayMenuItem(position, options) {
    ${TRAY_SIGNATURE_START}
    const __agAsyncTrayTranslations = {
        'Connect to WSL': '连接至 WSL',
        'Reopen Locally': '在本地重新打开'
    };
    if (options && __agAsyncTrayTranslations[options.label]) {
        options.label = __agAsyncTrayTranslations[options.label];
    }
    ${TRAY_SIGNATURE_END}`;
            result = result.replace(targetInsert, replacementInsert);
        }

        result = replaceStringLiteral(result, 'No agents running', '无运行中的智能体');
        result = replaceStringLiteral(result, 'Open Antigravity', '打开 Antigravity');
        result = result.replace(/`Open \$\{([^}]+)\}`/g, '`打开 ${$1}`');
        result = replaceStringLiteral(result, 'Quit', '退出');
        result = replaceStringLiteral(result, 'Connect to WSL', '连接至 WSL');
        result = replaceStringLiteral(result, 'Reopen Locally', '在本地重新打开');
        result = result.replace(
            /countItem\.label\s*=\s*\([\s\S]*?' running';/g,
            "countItem.label = count > 0 ? `${count} 个智能体运行中` : '无运行中的智能体';"
        );
    }

    if (result.includes('createProvisionSplash') || result.includes('Setting up WSL:')) {
        result = result.replace(
            '<div>Setting up WSL: ${escapeHtml(distro)}</div>',
            '<div>正在设置 WSL：${escapeHtml(distro)}</div>'
        );
    }

    if (result.includes('Downloading the Antigravity binary')) {
        result = result
            .replace("onStatus?.('Downloading the Antigravity binary\\u2026');", "onStatus?.('正在下载 Antigravity 二进制文件\\u2026');")
            .replace("onStatus?.(`Installing into ${distro}\\u2026`);", "onStatus?.(`正在安装至 ${distro}\\u2026`);");
    }

    if (result.includes('WSL setup failed')) {
        result = result
            .replace("await electron_1.dialog.showErrorBox('WSL setup failed', msg);", "await electron_1.dialog.showErrorBox('WSL 设置失败', msg);")
            .replace('`Failed to install the server into WSL distro "${WSL_DISTRO}":\\n${err.message}`', '`未能将服务端安装至 WSL 分发版 "${WSL_DISTRO}"：\\n${err.message}`');
    }

    const looksLikeUpdater = result.includes('Check for Updates') && result.includes('No updates available');
    if (looksLikeUpdater) {
        result = replaceStringLiteral(result, 'Check for Updates', '检查更新');
        result = replaceStringLiteral(result, 'No updates available', '暂无可用更新');
        result = replaceStringLiteral(result, 'OK', '确定');
    }

    result = result.replace(
        '<div class="text">Loading Antigravity</div>',
        '<div class="text">Antigravity 正在启动...</div>'
    );

    const looksLikeWizardHtml = result.includes('Welcome to the new Antigravity!') || result.includes('Explore the new Antigravity');
    if (looksLikeWizardHtml) {
        result = result
            .replace('<title>Welcome to Antigravity</title>', '<title>欢迎使用 Antigravity</title>')
            .replace('<div class="text" style="font-size: 13px; opacity: 0.6; letter-spacing: 0.03em;">Setting up…</div>', '<div class="text" style="font-size: 13px; opacity: 0.6; letter-spacing: 0.03em;">正在设置…</div>')
            .replace('<h1>Welcome to the new Antigravity!</h1>', '<h1>欢迎使用全新 Antigravity！</h1>')
            .replace("<p>Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.</p>", '<p>Antigravity 经过重新设计，以智能体为核心并带来全新能力。如果您仍希望使用代码编辑器，可将其作为名为 <b>Antigravity IDE</b> 的独立应用下载</p>')
            .replace('<span>Download the Antigravity IDE</span>', '<span>下载 Antigravity IDE</span>')
            .replace('<button class="btn-primary" id="btn-skip">Explore the new Antigravity</button>', '<button class="btn-primary" id="btn-skip">探索全新 Antigravity</button>');
    }

    const contextMenuMatch = result.match(/function\s+buildContextMenuTemplate\s*\(\s*items\s*,\s*onSelect\s*\)\s*\{/);
    if (contextMenuMatch) {
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
        "Stop": "停止",
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
        "Comment": "评论",
        "Quote": "引用",
        "Add to Chat": "添加到聊天",
        "Add to Chat/Quote": "添加到聊天/引用",
        "Copy Image": "复制图片",
        "Save Image": "保存图片",
        "Copy Video": "复制视频",
        "Save Video": "保存视频",
        "Close Tab": "关闭标签页",
        "Close Other Tabs": "关闭其他标签页",
        "Close Tabs to the Right": "关闭右侧标签页",
        "Back": "后退",
        "Forward": "前进",
        "Reload": "重新加载",
        "Open in External Browser": "在外部浏览器中打开",
        "Open in Built-in Browser": "在内置浏览器中打开",
        "Open in Browser": "在浏览器中打开",
        "Open in": "打开方式",
        "Open In": "打开方式",
        "Built-in Browser (Default)": "内置浏览器 (默认)",
        "External Browser": "外部浏览器",
        "Settings": "设置",
        "Copy Message": "复制消息",
        "Undo to Here": "撤销至此处",
        "Copy Link": "复制链接",
        "Reopen Closed Tab": "重新打开关闭的标签页",
        "Move Conversation Up": "向上移动会话",
        "Move Conversation Down": "向下移动会话",
        "Background Commands": "后台命令",
        "Background Tasks": "后台任务"
    };
    function translateIpcContextMenuItems(menuItems) {
        if (!Array.isArray(menuItems)) return menuItems;
        return menuItems.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const itemId = String(item.id || '');
            if (/^group-(?!new$|remove$)/i.test(itemId)) return item;
            const rawLabel = typeof item.label === 'string' ? item.label.trim() : '';
            const translatedLabel = rawLabel && contextMenuTranslations[rawLabel] ? contextMenuTranslations[rawLabel] : item.label;
            let next = translatedLabel !== item.label ? Object.assign({}, item, { label: translatedLabel }) : item;
            if (Array.isArray(next.submenu)) {
                next = Object.assign({}, next, { submenu: translateIpcContextMenuItems(next.submenu) });
            }
            if (Array.isArray(next.items)) {
                next = Object.assign({}, next, { items: translateIpcContextMenuItems(next.items) });
            }
            return next;
        });
    }
    if (Array.isArray(items)) {
        items = translateIpcContextMenuItems(items);
    }
    ${IPC_CONTEXT_MENU_SIGNATURE_END}`;
        result = result.replace(matchedHeader, replacementHeader);
    }

    const onAnchor = "hubContents.on?.('page-title-updated', handleTitleUpdate);";
    const offAnchor = "hubContents.off?.('page-title-updated', handleTitleUpdate);";
    if (result.includes(onAnchor) && result.includes(offAnchor)) {
        const onHookJs = `${UTILS_SUBFRAME_SIGNATURE_START}
    let cachedSubframeLocalizationScript = null;
    const findSubframeById = (frame, processId, routingId) => {
        if (!frame) {
            return null;
        }
        if (frame.processId === processId && frame.routingId === routingId) {
            return frame;
        }
        const children = Array.isArray(frame.framesInSubtree)
            ? frame.framesInSubtree
            : (Array.isArray(frame.frames) ? frame.frames : []);
        for (const child of children) {
            if (!child || child === frame) {
                continue;
            }
            if (child.processId === processId && child.routingId === routingId) {
                return child;
            }
            const nested = Array.isArray(frame.framesInSubtree) ? null : findSubframeById(child, processId, routingId);
            if (nested) {
                return nested;
            }
        }
        return null;
    };
    const localizePluginSubframe = (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        try {
            if (isMainFrame || (typeof win !== 'undefined' && win?.isDestroyed?.()) || hubContents.isDestroyed?.()) {
                return;
            }
            const electronMod = typeof electron_1 !== 'undefined' && electron_1 ? electron_1 : require('electron');
            const frame = _event?.frame
                || electronMod.webFrameMain?.fromId?.(frameProcessId, frameRoutingId)
                || findSubframeById(hubContents.mainFrame, frameProcessId, frameRoutingId);
            if (!frame || frame === hubContents.mainFrame || frame.isDestroyed?.() || frame.detached) {
                return;
            }
            const frameUrl = typeof frame.url === 'string' ? frame.url : '';
            if (!frameUrl.startsWith('plugin://')) {
                return;
            }
            if (cachedSubframeLocalizationScript === null) {
                const pathMod = typeof path_1 !== 'undefined' && path_1?.default ? path_1.default : require('path');
                const fsMod = typeof fs !== 'undefined' && fs && typeof fs.readFileSync === 'function' ? fs : require('fs');
                const scriptPath = pathMod.join(__dirname, '${SUBFRAME_PRELOAD_BASENAME}');
                if (!fsMod.existsSync(scriptPath)) {
                    return;
                }
                cachedSubframeLocalizationScript = fsMod.readFileSync(scriptPath, 'utf-8');
            }
            if (cachedSubframeLocalizationScript) {
                void Promise.resolve(frame.executeJavaScript(cachedSubframeLocalizationScript, false)).catch(() => undefined);
            }
        }
        catch (_err) {}
    };
    hubContents.on?.('did-frame-finish-load', localizePluginSubframe);${UTILS_SUBFRAME_SIGNATURE_END}`;
        const offHookJs = `${UTILS_SUBFRAME_SIGNATURE_START}
        hubContents.off?.('did-frame-finish-load', localizePluginSubframe);
        cachedSubframeLocalizationScript = null;${UTILS_SUBFRAME_SIGNATURE_END}`;
        result = result
            .replace(onAnchor, onAnchor + onHookJs)
            .replace(offAnchor, offAnchor + offHookJs);
    }

    if (result !== content) {
        compileCheckJs(result, relPath);
    }
    return result;
}

function buildArchivePatches(baseArchive) {
    const filePatches = {};
    const generatedJs = generateJs();
    compileCheckJs(generatedJs, 'generated-localization-injection.js');
    const preloadCandidate = discoverPreload(baseArchive);
    filePatches[preloadCandidate.relativePath] = buildPatchedPreloadContent(preloadCandidate.content, generatedJs);

    const jsRelPaths = listTargetFiles(baseArchive, relPath => {
        if (!/\.(?:js|cjs|mjs)$/i.test(relPath)) return false;
        return path.posix.basename(relPath.replace(/\\/g, '/')).toLowerCase() !== SUBFRAME_PRELOAD_BASENAME.toLowerCase();
    });
    let menuPath = null;
    const menuCandidates = [];

    for (const relPath of jsRelPaths) {
        if (relPath === preloadCandidate.relativePath) continue;
        const content = readTargetTextFile(baseArchive, relPath);
        if (!content) continue;
        if (content.includes('setApplicationMenu') || content.includes(MENU_SIGNATURE_START) || content.includes(ALT_MENU_SIGNATURE_START)) {
            const patchedMenu = buildPatchedMenuContent(content);
            if (patchedMenu) {
                menuCandidates.push({
                    relPath,
                    patchedMenu,
                    score: path.posix.basename(relPath).toLowerCase() === 'menu.js' ? 20 : 0,
                });
            }
        }
    }

    menuCandidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    if (menuCandidates.length > 0) {
        menuPath = menuCandidates[0].relPath;
        filePatches[menuPath] = menuCandidates[0].patchedMenu;
    }

    const optionalFiles = [];
    let subframeScript = null;
    for (const relPath of jsRelPaths) {
        if (relPath === preloadCandidate.relativePath) continue;
        const sourceContent = filePatches[relPath] || readTargetTextFile(baseArchive, relPath);
        if (!sourceContent) continue;
        const patchedContent = applyOptionalMainProcessPatch(sourceContent, relPath);
        if (patchedContent !== sourceContent) {
            filePatches[relPath] = patchedContent;
            if (relPath !== menuPath) optionalFiles.push(relPath);
        }
        if (patchedContent.includes(UTILS_SUBFRAME_SIGNATURE_START)) {
            if (subframeScript === null) {
                subframeScript = buildSubframeLocalizationContent(generatedJs);
            }
            const normalizedRel = relPath.replace(/\\/g, '/');
            const dirName = path.posix.dirname(normalizedRel);
            const subframeRelPath = dirName && dirName !== '.'
                ? `${dirName}/${SUBFRAME_PRELOAD_BASENAME}`
                : SUBFRAME_PRELOAD_BASENAME;
            filePatches[subframeRelPath] = subframeScript;
            if (!optionalFiles.includes(subframeRelPath)) {
                optionalFiles.push(subframeRelPath);
            }
        }
    }

    return {
        filePatches,
        preloadPath: preloadCandidate.relativePath,
        menuPath,
        optionalFiles,
    };
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

function prepareBaseArchive(resourcesDir, currentArchive) {
    if (!validateArchive(currentArchive)) {
        throw new InstallerError(`当前 app.asar 结构校验失败: ${currentArchive}`);
    }
    const currentMetadata = readLocalizationMetadata(currentArchive);
    const currentIsLocalized = archiveContainsLocalization(currentArchive);
    const currentHash = hashFile(currentArchive);

    if (!currentIsLocalized) {
        return {
            baseArchive: currentArchive,
            baseHash: currentHash,
            migratedLegacyBackup: false,
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
    if (archiveContainsLocalization(backupPath)) {
        throw new InstallerError('候选备份本身含有汉化标记，不能视为官方原版。');
    }

    return {
        baseArchive: backupPath,
        baseHash: backupHash,
        migratedLegacyBackup: path.basename(backupPath).toLowerCase() === 'app.asar.bak',
    };
}

function fsyncFile(filePath) {
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
    fs.renameSync(stagedArchive, targetArchive);
}

function createStagedArchive(resourcesDir, extractedDir) {
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const stagedArchive = path.join(resourcesDir, `app.asar.localized-${nonce}.tmp`);
    AsarArchive.pack(extractedDir, stagedArchive);
    if (!validateArchive(stagedArchive)) {
        if (fs.existsSync(stagedArchive)) fs.unlinkSync(stagedArchive);
        throw new InstallerError('ASAR 打包或验证失败。');
    }
    return stagedArchive;
}

function installLocalization(resourcesDir, options = {}) {
    const currentArchive = path.join(resourcesDir, 'app.asar');
    if (!fs.existsSync(currentArchive)) {
        throw new InstallerError(`未找到 app.asar: ${currentArchive}`);
    }

    let stagedArchive = null;
    try {
        console.log('[检查] 正在识别当前客户端结构与官方基线...');
        const base = prepareBaseArchive(resourcesDir, currentArchive);
        const appInfo = detectAppInfo(base.baseArchive);
        if (!appInfo.verified && !options.allowUnverifiedProduct) {
            throw new InstallerError(
                `无法从 ${appInfo.evidenceFile || 'ASAR 元数据'} 确认这是 Antigravity。` +
                '如已人工核实，可显式追加 --allow-unverified-product。'
            );
        }

        console.log(`[识别] 产品: ${appInfo.name}; 版本: ${appInfo.version}; 依据: ${appInfo.evidenceFile || '未知'}`);
        const backup = ensureVersionedBackup(resourcesDir, base.baseArchive, base.baseHash);
        const { filePatches, preloadPath, menuPath, optionalFiles } = buildArchivePatches(base.baseArchive);

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
        filePatches[METADATA_FILE] = JSON.stringify(metadata, null, 2) + '\n';

        console.log(`[修改] preload: ${preloadPath}`);
        if (menuPath) console.log(`[修改] 原生菜单: ${menuPath}`);
        if (optionalFiles.length > 0) console.log(`[修改] 其他主进程界面文件: ${optionalFiles.length} 个`);

        const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
        stagedArchive = path.join(resourcesDir, `app.asar.localized-${nonce}.tmp`);
        AsarArchive.patchArchive(base.baseArchive, stagedArchive, filePatches);
        if (!validateArchive(stagedArchive)) {
            throw new InstallerError('修补后的 ASAR 包未能通过完整性校验。');
        }

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

        if (process.platform === 'darwin') {
            resignAppOnMac(resourcesDir);
        }

        console.log(`[完成] 已部署汉化引擎；官方基线 SHA-256: ${base.baseHash}`);
        return { appInfo, baseHash: base.baseHash, localizedHash, backupPath: backup.backupPath };
    } finally {
        if (stagedArchive && fs.existsSync(stagedArchive)) fs.unlinkSync(stagedArchive);
    }
}

function restoreLocalization(resourcesDir) {
    const currentArchive = path.join(resourcesDir, 'app.asar');
    if (!fs.existsSync(currentArchive)) {
        throw new InstallerError(`未找到 app.asar: ${currentArchive}`);
    }
    if (!validateArchive(currentArchive)) {
        throw new InstallerError(`当前 app.asar 结构无效: ${currentArchive}`);
    }

    let stagedArchive = null;
    try {
        const metadata = readLocalizationMetadata(currentArchive);
        const isLocalized = archiveContainsLocalization(currentArchive);
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
        if (archiveContainsLocalization(backupPath)) {
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

        const restoredInfo = detectAppInfo(currentArchive);
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

        if (process.platform === 'darwin') {
            resignAppOnMac(resourcesDir);
        }

        console.log(`[完成] 已按 SHA-256 校验还原官方包: ${backupHash}`);
        return { restoredHash: backupHash, backupPath };
    } finally {
        if (stagedArchive && fs.existsSync(stagedArchive)) fs.unlinkSync(stagedArchive);
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

function findMacAppBundle(resourcesDir) {
    if (!resourcesDir) return null;
    let current = path.resolve(resourcesDir);
    while (current && current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.app') && fs.existsSync(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    return null;
}

function resignAppOnMac(resourcesDir) {
    if (process.platform !== 'darwin') return true;
    let targetApp = findMacAppBundle(resourcesDir);
    if (!targetApp) return true;
    try { targetApp = fs.realpathSync(targetApp); } catch (_) {}

    const xattr = trustedUnixTool('xattr');
    if (xattr) {
        runTool(xattr, ['-cr', targetApp]);
    }
    const codesign = trustedUnixTool('codesign');
    if (!codesign) return true;

    const frameworksDir = path.join(targetApp, 'Contents', 'Frameworks');
    if (fs.existsSync(frameworksDir)) {
        try {
            for (const entry of fs.readdirSync(frameworksDir)) {
                const fullPath = path.join(frameworksDir, entry);
                if (entry.endsWith('.framework') || entry.endsWith('.app')) {
                    runTool(codesign, ['--force', '--deep', '--sign', '-', fullPath]);
                } else if (entry.endsWith('.dylib')) {
                    runTool(codesign, ['--force', '--sign', '-', fullPath]);
                }
            }
        } catch (_) {}
    }

    const res = runTool(codesign, ['--force', '--deep', '--sign', '-', targetApp]);
    if (res.status !== 0) {
        throw new InstallerError(`macOS 应用自签名失败: ${res.stderr || res.stdout}`);
    }
    return true;
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

function closeRunningAntigravity() {
    console.log('[等待] 检测到 Antigravity 正在运行，正在关闭客户端进程...');
    if (process.platform === 'win32') {
        const taskkill = trustedWindowsTool('taskkill.exe');
        if (!taskkill) throw new InstallerError('未找到可信的 Windows taskkill.exe。');
        runTool(taskkill, ['/f', '/im', 'Antigravity.exe', '/t'], { stdio: 'ignore' });
    } else {
        const pkill = trustedUnixTool('pkill');
        if (!pkill) throw new InstallerError('未找到可信的系统 pkill。');
        runTool(pkill, ['-TERM', '-x', '-i', 'antigravity'], { stdio: 'ignore' });
        for (let i = 0; i < 20 && checkIfAppIsRunning(); i++) {
            sleep(250);
        }
        if (checkIfAppIsRunning()) {
            runTool(pkill, ['-x', '-i', 'antigravity'], { stdio: 'ignore' });
        }
    }
    sleep(1000);
    if (checkIfAppIsRunning()) {
        throw new InstallerError('关闭后仍检测到 Antigravity 进程，已停止修改以保护运行中的客户端。');
    }
}

function detectInstallationDir(manualDir, options = {}) {
    const quiet = Boolean(options.quiet);
    if (manualDir) {
        if (!fs.existsSync(manualDir)) {
            if (quiet) return null;
            throw new InstallerError(`指定路径不存在: ${manualDir}`);
        }
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
        add('C:\\Program Files (x86)\\Antigravity');
        if (process.env.LOCALAPPDATA) {
            add(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity'));
            add(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'));
            add(path.join(process.env.LOCALAPPDATA, 'Antigravity'));
            add(path.join(process.env.LOCALAPPDATA, 'antigravity'));
        }
    } else if (process.platform === 'darwin') {
        add('/Applications/Antigravity.app');
        if (process.env.HOME) add(path.join(process.env.HOME, 'Applications', 'Antigravity.app'));
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root' && /^[A-Za-z0-9._-]+$/.test(process.env.SUDO_USER)) {
            add(path.join('/Users', process.env.SUDO_USER, 'Applications', 'Antigravity.app'));
        }
    } else {
        const homeDirs = [];
        if (process.env.HOME) homeDirs.push(process.env.HOME);
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root' && /^[A-Za-z0-9._-]+$/.test(process.env.SUDO_USER)) {
            const getent = trustedUnixTool('getent');
            if (getent) {
                const res = runTool(getent, ['passwd', process.env.SUDO_USER]);
                if (res.status === 0 && res.stdout) {
                    const parts = res.stdout.trim().split(':');
                    if (parts.length >= 6 && parts[5]) homeDirs.push(parts[5]);
                }
            }
            homeDirs.push(path.join('/home', process.env.SUDO_USER));
        }

        for (const candidate of [
            '/opt/Antigravity', '/opt/Antigravity/Antigravity-x64', '/opt/antigravity',
            '/opt/antigravity/antigravity-x64', '/usr/share/antigravity', '/usr/share/Antigravity',
            '/usr/local/share/antigravity', '/usr/local/share/Antigravity',
            '/usr/lib/antigravity', '/usr/lib/Antigravity',
        ]) add(candidate);

        for (const homeDir of homeDirs) {
            add(path.join(homeDir, '.local', 'share', 'antigravity'));
            add(path.join(homeDir, '.local', 'share', 'Antigravity'));
            add(path.join(homeDir, 'antigravity'));
            add(path.join(homeDir, 'Antigravity'));
        }

        const desktopFiles = [
            '/usr/share/applications/antigravity.desktop',
            '/usr/share/applications/Antigravity.desktop',
            ...homeDirs.flatMap(h => [
                path.join(h, '.local', 'share', 'applications', 'antigravity.desktop'),
                path.join(h, '.local', 'share', 'applications', 'Antigravity.desktop'),
            ]),
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
        for (const command of ['antigravity', 'agy', 'Antigravity']) {
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
    if (quiet) return null;
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
    if (process.platform === 'darwin') {
        const appBundle = findMacAppBundle(resourcesDir);
        if (appBundle) fs.accessSync(appBundle, fs.constants.W_OK | fs.constants.X_OK);
    }
}

function parseArguments(argv) {
    const options = {
        restore: false,
        installDir: '',
        forceKill: false,
        noKill: false,
        checkWrite: false,
        allowUnverifiedProduct: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--huifu' || argument === '--restore') options.restore = true;
        else if (argument === '--install-dir') options.installDir = argv[++index] || '';
        else if (argument.startsWith('--install-dir=')) options.installDir = argument.slice('--install-dir='.length);
        else if (argument === '--force-kill') options.forceKill = true;
        else if (argument === '--no-kill') options.noKill = true;
        else if (argument === '--check-write') options.checkWrite = true;
        else if (argument === '--allow-unverified-product') options.allowUnverifiedProduct = true;
        else if (argument === '--brand-title') index++;
    }
    return options;
}

function launchApp(installDir, resourcesDir = null) {
    if (process.platform !== 'win32') {
        const runningUnderSudo = typeof process.getuid === 'function' &&
            process.getuid() === 0 &&
            process.env.SUDO_USER &&
            process.env.SUDO_USER !== 'root';
        if (runningUnderSudo) {
            console.log('[提示] 当前通过 sudo 运行；为避免以 root 身份启动桌面应用，请手动启动 Antigravity。');
            return true;
        }
        if (process.platform === 'darwin') {
            const openBin = trustedUnixTool('open');
            const targetApp = findMacAppBundle(resourcesDir || installDir) || (installDir.endsWith('.app') ? installDir : null);
            if (openBin && targetApp && fs.existsSync(targetApp)) {
                const child = childProcess.spawn(openBin, [targetApp], { detached: true, stdio: 'ignore', shell: false });
                child.unref();
                return true;
            }
        }
    }

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
    const options = parseArguments(argv);

    if (options.checkWrite) {
        const installDir = detectInstallationDir(options.installDir, { quiet: true });
        if (!installDir) {
            process.exitCode = 3;
            return false;
        }
        try {
            const resourcesDir = resolveResourcesDir(installDir);
            ensureWritable(resourcesDir);
            process.exitCode = 0;
            return true;
        } catch (error) {
            process.exitCode = ['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? 2 : 3;
            return false;
        }
    }

    try {
        const installDir = detectInstallationDir(options.installDir);
        const resourcesDir = resolveResourcesDir(installDir);
        ensureWritable(resourcesDir);

        const wasRunning = checkIfAppIsRunning();
        if (wasRunning && !options.noKill) {
            closeRunningAntigravity();
        }

        if (options.restore) restoreLocalization(resourcesDir);
        else installLocalization(resourcesDir, options);

        if (wasRunning && !options.noKill && !launchApp(installDir, resourcesDir)) {
            console.warn('[提示] 未能自动重新启动客户端，请手动启动 Antigravity。');
        }
        return true;
    } catch (error) {
        const prefix = error instanceof InstallerError ? '[安全停止]' : '[错误]';
        console.error(`${prefix} ${error.message}`);
        if (process.platform !== 'win32' && ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
            console.error('[提示] 此安装目录需要管理员权限，请使用 sudo 重新执行脚本。');
        }
        process.exitCode = 1;
        return false;
    }
}

module.exports = {
    AsarArchive,
    ENGINE_VERSION,
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
    restoreLocalization,
    runAsar,
    safeRemoveTempRoot,
    validateArchive,
};

if (require.main === module) main();
