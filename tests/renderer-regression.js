'use strict';

const assert = require('assert');
const { createFakeDomEnvironment } = require('../scripts/lib/fake-dom');

const GENERATIVE_UI_DESCRIPTION =
    'How to render rich interactive HTML widgets inline in the chat or as standalone artifacts. ' +
    'Use this skill when you want to show the user diagrams, data visualizations, interactive controls, ' +
    'educational walkthroughs, or any rich visual content beyond plain text and markdown.';

function runRendererRegression(generatedSource) {
    const dom = createFakeDomEnvironment(generatedSource);
    const { element, text, mount, dispatchAdded, dispatchCharacterData, reset } = dom;
    let assertions = 0;

    function equal(actual, expected, message) {
        assert.strictEqual(actual, expected, message);
        assertions++;
    }

    function same(actual, expected, message) {
        assert.strictEqual(actual, expected, message);
        assertions++;
    }

    function makeCommitRow({ count = '4', branch = 'main' } = {}) {
        const prefixNode = text('Commit ');
        const countNode = text(count);
        const fileNode = text(' file ');
        const changesNode = text('changes ');
        const toNode = text('to ');
        const arrowNode = element('svg');
        arrowNode.clickHandler = () => 'preserved';
        const branchNode = text(branch);
        const row = element(
            'div',
            prefixNode,
            countNode,
            fileNode,
            changesNode,
            toNode,
            arrowNode,
            element('span', branchNode)
        );
        return {
            row,
            prefixNode,
            countNode,
            fileNode,
            changesNode,
            toNode,
            arrowNode,
            branchNode
        };
    }

    // Fixed dictionaries are audited exhaustively elsewhere. These cases only
    // prove that the generated renderer map and its normalization are wired up.
    reset();
    const exactNode = text('Push succeeded');
    mount(element('div', exactNode));
    equal(exactNode.nodeValue, '推送成功', '固定词条未通过生成的 renderer map 翻译');

    const normalizedNode = text('  Push  succeeded  ');
    mount(element('div', normalizedNode));
    equal(normalizedNode.nodeValue, '  推送成功  ', '固定词条空白规范化与首尾空白保留失效');

    const longTextNode = text('Status: Conversation unavailable.');
    mount(element('div', longTextNode));
    equal(longTextNode.nodeValue, 'Status: 会话不可用.', '长词条未在独立 UI 文本中替换');

    const boundaryNode = text('XConversation unavailableY');
    mount(element('div', boundaryNode));
    equal(boundaryNode.nodeValue, 'XConversation unavailableY', '长词条跨英文单词边界误匹配');

    // Attribute translation and protected-content contracts.
    reset();
    const commitInput = element('textarea');
    commitInput.setAttribute('placeholder', 'Describe your changes, or leave empty to auto-generate');
    mount(element('div', commitInput));
    equal(commitInput.getAttribute('placeholder'), '描述您的更改，或留空以自动生成', 'UI placeholder 未翻译');

    const userText = text('Push succeeded');
    const userInput = element('div', userText);
    userInput.setAttribute('data-testid', 'user-input-step');
    mount(userInput);
    equal(userText.nodeValue, 'Push succeeded', '用户消息被翻译');
    equal(userText.writeCount, 0, '用户消息发生 DOM 写入');

    const skippedText = text('Push succeeded');
    const skipped = element('div', skippedText);
    skipped.setAttribute('data-ag-localization-skip', '');
    mount(skipped);
    equal(skippedText.nodeValue, 'Push succeeded', '显式保护区被翻译');

    const codeText = text('Push succeeded');
    mount(element('code', codeText));
    equal(codeText.nodeValue, 'Push succeeded', '代码内容被翻译');

    const terminalText = text('Push succeeded');
    const terminal = element('div', terminalText);
    terminal.className = 'terminal';
    mount(terminal);
    equal(terminalText.nodeValue, 'Push succeeded', '终端内容被翻译');

    const shadowHost = element('div');
    shadowHost.setAttribute('data-ag-localization-skip', '');
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    const shadowText = text('Push succeeded');
    const shadowChild = element('span', shadowText);
    shadowRoot.append(shadowChild);
    mount(shadowHost);
    dispatchAdded(shadowChild);
    equal(shadowText.nodeValue, 'Push succeeded', 'Shadow DOM 中的祖先保护边界失效');

    // Dynamic matchers keep runtime values and reject command/diagnostic text.
    reset();
    const singularPush = text('Push 1 commit to origin/main');
    mount(element('div', singularPush));
    equal(singularPush.nodeValue, '将 1 个提交推送到 origin/main', '动态 Git 单数规则失效');

    const pluralPush = text('Push 3 commits to feature/demo');
    mount(element('div', pluralPush));
    equal(pluralPush.nodeValue, '将 3 个提交推送到 feature/demo', '动态 Git 复数规则失效');

    const fileStatus = text('src/index.ts (unstaged)');
    mount(element('div', fileStatus));
    equal(fileStatus.nodeValue, 'src/index.ts (未暂存)', '文件状态规则未保留路径');

    const gitDiagnostic = text('git checkout -b feature/demo (staged)');
    mount(element('div', gitDiagnostic));
    equal(gitDiagnostic.nodeValue, 'git checkout -b feature/demo (staged)', 'Git 命令被当作文件状态翻译');
    equal(gitDiagnostic.writeCount, 0, 'Git 命令发生 DOM 写入');

    // One representative structural rule covers fragmented React output,
    // preserved interactive nodes, repeat processing, updates and isolation.
    reset();
    const splitCommit = makeCommitRow();
    const originalArrow = splitCommit.arrowNode;
    const originalClickHandler = splitCommit.arrowNode.clickHandler;
    mount(splitCommit.row);
    equal(splitCommit.row.textContent, '将 4 个文件的更改提交到 main', '拆分提交摘要未重排');
    equal(splitCommit.branchNode.nodeValue, 'main', '动态分支名被修改');
    same(splitCommit.row.childNodes[5], originalArrow, '交互图标节点被替换');
    same(splitCommit.arrowNode.clickHandler, originalClickHandler, '交互图标事件处理器丢失');

    const writesBeforeRepeat = splitCommit.prefixNode.writeCount +
        splitCommit.countNode.writeCount +
        splitCommit.fileNode.writeCount +
        splitCommit.changesNode.writeCount +
        splitCommit.toNode.writeCount +
        splitCommit.branchNode.writeCount;
    dispatchAdded(splitCommit.row);
    const writesAfterRepeat = splitCommit.prefixNode.writeCount +
        splitCommit.countNode.writeCount +
        splitCommit.fileNode.writeCount +
        splitCommit.changesNode.writeCount +
        splitCommit.toNode.writeCount +
        splitCommit.branchNode.writeCount;
    equal(writesAfterRepeat, writesBeforeRepeat, '重复处理产生同值 DOM 写入');

    splitCommit.countNode.nodeValue = '7';
    dispatchCharacterData(splitCommit.countNode);
    equal(splitCommit.row.textContent, '将 7 个文件的更改提交到 main', 'React 局部数量更新未修复');
    equal(splitCommit.countNode.nodeValue, '', 'React 局部更新遗留数量碎片');

    const siblingA = makeCommitRow({ count: '2', branch: 'main' });
    const siblingB = makeCommitRow({ count: '5', branch: 'dev' });
    mount(element('section', siblingA.row, siblingB.row));
    equal(siblingA.row.textContent, '将 2 个文件的更改提交到 main', '第一个兄弟提交行翻译错误');
    equal(siblingB.row.textContent, '将 5 个文件的更改提交到 dev', '第二个兄弟提交行翻译错误');

    const protectedCommit = makeCommitRow({ branch: 'protected-branch' });
    protectedCommit.row.children.at(-1).setAttribute('data-ag-localization-skip', '');
    mount(protectedCommit.row);
    equal(protectedCommit.branchNode.nodeValue, 'protected-branch', '受保护的分支名被修改');
    equal(
        protectedCommit.row.textContent,
        'Commit 4 file changes to protected-branch',
        '结构规则跨越受保护边界'
    );

    // Context-sensitive labels translate only in confirmed product surfaces.
    reset();
    const recentNode = text('Recent in Test');
    const nowNode = text('now');
    const timestamp = element('span', nowNode);
    timestamp.className = 'text-xs muted';
    const conversationList = element(
        'section',
        element('h3', recentNode),
        element('div', text('Example conversation '), timestamp)
    );
    conversationList.className = 'conversation-list';
    mount(conversationList);
    equal(recentNode.nodeValue, 'Test 中的近期会话', '项目会话标题上下文规则失效');
    equal(nowNode.nodeValue, '刚刚', '会话时间戳上下文规则失效');

    const standaloneNow = text('now');
    mount(element('span', standaloneNow));
    equal(standaloneNow.nodeValue, 'now', '普通正文中的 now 被全局翻译');

    const skillName = text('generative_ui');
    mount(element('div', element('span', skillName), element('span', text(GENERATIVE_UI_DESCRIPTION))));
    equal(skillName.nodeValue, '生成式界面', '技能选择器中的表面名称未翻译');

    const internalSkillName = text('generative_ui');
    mount(element('div', internalSkillName));
    equal(internalSkillName.nodeValue, 'generative_ui', '脱离选择器的技能标识被翻译');

    // Monaco search UI is a narrow exception; code text remains protected.
    reset();
    const searchingWord = text('Searching');
    const searchingDots = text('...');
    const message = element('div', element('span', searchingWord), element('span', searchingDots));
    message.className = 'message';
    const suggestWidget = element('div', message);
    suggestWidget.className = 'editor-widget suggest-widget visible';
    mount(suggestWidget);
    equal(searchingWord.nodeValue, '正在搜索...', '碎片化搜索状态未翻译');
    equal(searchingDots.nodeValue, '', '碎片化搜索状态遗留标点节点');

    const editorCodeText = text('Searching...');
    const editorCodeLine = element('div', element('span', editorCodeText));
    editorCodeLine.className = 'view-line';
    const editor = element('div', editorCodeLine);
    editor.className = 'monaco-editor';
    mount(editor);
    equal(editorCodeText.nodeValue, 'Searching...', 'Monaco 代码正文被翻译');

    // One fragmented settings indicator is enough to lock down ordering and
    // preservation of the runtime project count.
    reset();
    const modifiedPrefix = text('Modified in ');
    const projectCount = text('2');
    const projectUnit = text(' projects');
    const projectButton = element('button', element('span', projectCount, projectUnit), element('svg'));
    projectButton.setAttribute('data-testid', 'security-preset-overrides-trigger');
    const modifiedContainer = element('span', modifiedPrefix, projectButton);
    modifiedContainer.className = 'inline-block';
    mount(modifiedContainer);
    equal(modifiedPrefix.nodeValue, '修改于 ', '设置覆写前缀未翻译');
    equal(projectButton.textContent, '2 个项目', '设置覆写计数碎片未重组');

    // Input disabled notice structure preserves folder name, reorders project link and appends action suffix.
    reset();
    const disabledPrefix = text('Input disabled because ');
    const folderIcon = element('svg');
    folderIcon.clickHandler = () => 'folder-icon';
    const folderNameNode = text('debug_macos_install_script');
    const folderContainer = element('span', folderIcon, folderNameNode);
    const middleNotice = text(' does not exist. Create the folder in this ');
    const projectLinkText = text('project');
    const projectLink = element('a', projectLinkText);
    projectLink.clickHandler = () => 'open-project';
    const noticeBanner = element('div', disabledPrefix, folderContainer, middleNotice, projectLink);
    mount(noticeBanner);
    equal(disabledPrefix.nodeValue, '输入已禁用，因为 ', '输入禁用提示前缀未翻译');
    equal(folderNameNode.nodeValue, 'debug_macos_install_script', '动态文件夹名称被误修改');
    equal(middleNotice.nodeValue, ' 不存在。请在此', '输入禁用中间说明未翻译');
    equal(projectLinkText.nodeValue, '项目', '项目链接文本未翻译');
    equal(projectLink.clickHandler(), 'open-project', '项目链接交互事件丢失');
    equal(noticeBanner.textContent, '输入已禁用，因为 debug_macos_install_script 不存在。请在此项目中创建该文件夹', '输入禁用提示完整结构重组异常');

    // Idempotency: re-processing must not append duplicate suffixes.
    mount(noticeBanner);
    equal(noticeBanner.textContent, '输入已禁用，因为 debug_macos_install_script 不存在。请在此项目中创建该文件夹', '输入禁用提示重复处理产生重复后缀');

    // Skill row path guard protects identifiers next to .agents/skills/... paths,
    // collapsible Thought stream isolates reasoning bodies, and fragmented sidecar
    // empty-search state translates cleanly.
    reset();
    const skillRowTitle = text('Automations');
    const skillRowPath = text(' .agents/skills/automations/SKILL.md');
    mount(element('div', element('span', skillRowTitle), element('span', skillRowPath)));
    equal(skillRowTitle.nodeValue, 'Automations', '带 .agents/skills/ 路径的技能标识符被误翻译');

    const thoughtHeader = element('button', text('Thought for 3s'));
    const thoughtBodyText = text('Push succeeded');
    const thoughtBody = element('div', thoughtBodyText);
    mount(element('div', thoughtHeader, thoughtBody));
    equal(thoughtBodyText.nodeValue, 'Push succeeded', '思考流折叠块正文被误翻译');

    const emptySearchP = element('p', text('No '), text('automations'), text(' match “'), text('daily'), text('”.'));
    mount(emptySearchP);
    equal(emptySearchP.textContent, '没有与“daily”匹配的自动化。', '自动化搜索空状态碎片未重组');

    // v2.30.0 dynamic rules: plan label, back navigation, schedule & voice timeline.
    const planLabel = text('Your Plan: Google AI Pro');
    mount(element('div', planLabel));
    equal(planLabel.nodeValue, '您的计划: Google AI Pro', 'v2.30.0 计划名称动态规则失效');

    const backNav = text('Back to Automations');
    mount(element('button', backNav));
    equal(backNav.nodeValue, '返回自动化', 'v2.30.0 返回导航动态规则失效');

    const voiceTimeline = text('Voice chat · 13:25 · 9s');
    mount(element('span', voiceTimeline));
    equal(voiceTimeline.nodeValue, '语音会话 · 13:25 · 9 秒', '语音会话时间轴动态规则失效');

    // v2.31.0: resources settings subtitle, side pane control banner + prose guard,
    // Automations New button context guard, Swarm skill picker, and Swarm Board subframe isolation.
    reset();
    const manageResources = text('Manage workspace resources and settings.');
    mount(element('p', manageResources));
    equal(manageResources.nodeValue, '管理工作区资源和设置.', 'v2.31.0 工作区资源设置副标题未翻译');

    const sidePaneSpanName = text('Chrome');
    const sidePaneBanner = element(
        'div',
        text('Stream and control '),
        element('span', sidePaneSpanName),
        text(' directly in the side pane.')
    );
    mount(sidePaneBanner);
    equal(sidePaneBanner.textContent, '直接在侧边面板中实时查看并控制 Chrome.', 'v2.31.0 侧边面板控制横幅未重组翻译');
    equal(sidePaneSpanName.nodeValue, 'Chrome', '侧边面板控制目标名称不应被破坏');

    const proseSidePaneText = text('Stream and control Chrome directly in the side pane.');
    const proseSidePaneContainer = element('div', proseSidePaneText);
    proseSidePaneContainer.className = 'prose';
    mount(proseSidePaneContainer);
    equal(proseSidePaneText.nodeValue, 'Stream and control Chrome directly in the side pane.', '散文正文中的侧边面板提示被误翻译');

    const autoNewLabel = text('New');
    const autoNewBtn = element('button', element('span', autoNewLabel));
    const autoPage = element(
        'section',
        element('div', element('h1', text('Automations')), autoNewBtn),
        element('p', text('No automations yet'))
    );
    mount(autoPage);
    equal(autoNewLabel.nodeValue, '新建', 'v2.31.0 自动化页面 New 按钮未翻译');

    const modelBadgeNew = text('New');
    const modelOption = element('button', text('Gemini 3.1 '), element('span', modelBadgeNew));
    modelOption.setAttribute('role', 'option');
    const modelListbox = element('div', element('div', text('Automations No automations yet')), modelOption);
    modelListbox.setAttribute('role', 'listbox');
    mount(modelListbox);
    equal(modelBadgeNew.nodeValue, 'New', '模型选择器中的 New 徽标被误翻译');

    const swarmSkillName = text('swarm');
    mount(element(
        'div',
        element('span', swarmSkillName),
        element('span', text('(Preview & Quota Heavy) Run a swarm: several agents working in parallel on one task'))
    ));
    equal(swarmSkillName.nodeValue, '蜂群协作', 'v2.31.0 swarm 技能选择器显示名未翻译');

    const { generateSubframeJs } = require('../localization_engine');
    const subframeDom = createFakeDomEnvironment(generateSubframeJs(generatedSource), {
        protocol: 'plugin:',
        isSubframe: true
    });
    const swarmBoard = subframeDom.element('div');
    swarmBoard.id = 'board';
    swarmBoard.setAttribute('data-testid', 'swarm-board');

    const untitledSwarmText = subframeDom.text('Untitled swarm');
    const untitledSwarmEl = subframeDom.element('h1', untitledSwarmText);
    untitledSwarmEl.id = 'swarm-title';

    const tabOverviewText = subframeDom.text('Overview');
    const tabOverviewBtn = subframeDom.element('button', tabOverviewText);
    tabOverviewBtn.className = 'tab';
    tabOverviewBtn.setAttribute('role', 'tab');

    const searchPostsInput = subframeDom.element('input');
    searchPostsInput.id = 'f-search';
    searchPostsInput.setAttribute('placeholder', 'Search');
    searchPostsInput.setAttribute('aria-label', 'Search posts');

    const emptyBodyCodeText = subframeDom.text('/swarm');
    const emptyBodyP = subframeDom.element(
        'p',
        subframeDom.text('Swarms started in this conversation appear here automatically, with their board, members and @mention graph. Start one with '),
        subframeDom.element('code', emptyBodyCodeText),
        subframeDom.text('.')
    );
    emptyBodyP.id = 'empty-body';

    const agentMsgText = subframeDom.text('Close Settings Open File New');
    const agentMsgBody = subframeDom.element('div', agentMsgText);
    agentMsgBody.className = 'msg-body';

    const rawJsonText = subframeDom.text('{"status":"Open","action":"Copy"}');
    const rawPre = subframeDom.element('div', rawJsonText);
    rawPre.id = 'raw';

    swarmBoard.append(untitledSwarmEl, tabOverviewBtn, searchPostsInput, emptyBodyP, agentMsgBody, rawPre);
    subframeDom.mount(swarmBoard);

    equal(untitledSwarmText.nodeValue, '未命名蜂群', 'Swarm 默认标题未翻译');
    equal(tabOverviewText.nodeValue, '概览', 'Swarm 视图标签页未翻译');
    equal(searchPostsInput.getAttribute('placeholder'), '搜索', 'Swarm 搜索框占位符未翻译');
    equal(searchPostsInput.getAttribute('aria-label'), '搜索消息', 'Swarm 搜索框无障碍标签未翻译');
    equal(emptyBodyCodeText.nodeValue, '/swarm', 'Swarm 空状态中的 /swarm 命令被破坏');
    equal(
        emptyBodyP.textContent,
        '在此会话中启动的蜂群协作会自动显示在这里，并展示其消息板、成员和 @提及 图谱. 请使用 /swarm 启动.',
        'Swarm 空状态引导文案未重组翻译'
    );
    equal(agentMsgText.nodeValue, 'Close Settings Open File New', 'Swarm 消息板智能体发言被污染');
    equal(agentMsgText.writeCount, 0, 'Swarm 消息板智能体发言产生了 DOM 写入');
    equal(rawJsonText.nodeValue, '{"status":"Open","action":"Copy"}', 'Swarm Raw 原始数据视图被污染');
    equal(rawJsonText.writeCount, 0, 'Swarm Raw 原始数据视图产生了 DOM 写入');

    subframeDom.reset();
    const swarmBoardCustom = subframeDom.element('div');
    swarmBoardCustom.id = 'board';
    swarmBoardCustom.setAttribute('data-testid', 'swarm-board');
    const customSwarmTitleText = subframeDom.text('Settings Refactor');
    const customSwarmTitleEl = subframeDom.element('h1', customSwarmTitleText);
    customSwarmTitleEl.id = 'swarm-title';
    swarmBoardCustom.append(customSwarmTitleEl);
    subframeDom.mount(swarmBoardCustom);
    equal(customSwarmTitleText.nodeValue, 'Settings Refactor', '用户自定义蜂群标题被误翻译');
    equal(customSwarmTitleText.writeCount, 0, '用户自定义蜂群标题产生了 DOM 写入');

    return { assertions };
}

if (require.main === module) {
    const path = require('path');
    const { generateInjection } = require('../scripts/lib/load-engine');
    const rootDir = path.resolve(__dirname, '..');
    const generatedSource = generateInjection(rootDir);
    const result = runRendererRegression(generatedSource);
    console.log(`[通过] 渲染层核心契约通过，共 ${result.assertions} 项断言`);
}

module.exports = {
    runRendererRegression
};
