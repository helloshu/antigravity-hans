'use strict';

const vm = require('vm');

// Purpose-built synchronous harness for renderer safety contracts. It models
// only the DOM APIs used here and is not a browser-compatibility substitute.
function createFakeDomEnvironment(generatedSource, options = {}) {
    const activeObservers = new Set();
    const pendingMutations = [];
    let isFlushing = false;

    const documentListeners = new Map();
    const windowListeners = new Map();

    function addListener(map, type, callback) {
        if (!map.has(type)) {
            map.set(type, new Set());
        }
        map.get(type).add(callback);
    }

    function removeListener(map, type, callback) {
        if (map.has(type)) {
            map.get(type).delete(callback);
        }
    }

    function dispatchEvent(map, type, event) {
        if (map.has(type)) {
            for (const callback of Array.from(map.get(type))) {
                callback(event);
            }
        }
    }

    class FakeNode {
        constructor(nodeType) {
            this.nodeType = nodeType;
            this.parentNode = null;
            this.parentElement = null;
        }

        get previousSibling() {
            if (!this.parentNode?.childNodes) return null;
            const index = this.parentNode.childNodes.indexOf(this);
            return index > 0 ? this.parentNode.childNodes[index - 1] : null;
        }

        get nextSibling() {
            if (!this.parentNode?.childNodes) return null;
            const index = this.parentNode.childNodes.indexOf(this);
            return index >= 0 && index + 1 < this.parentNode.childNodes.length
                ? this.parentNode.childNodes[index + 1]
                : null;
        }

        getRootNode() {
            let current = this;
            while (current.parentNode) current = current.parentNode;
            return current;
        }

        contains(other) {
            if (!other) return false;
            let current = other;
            while (current) {
                if (current === this) return true;
                current = current.parentNode || current.host || null;
            }
            return false;
        }
    }

    FakeNode.ELEMENT_NODE = 1;
    FakeNode.TEXT_NODE = 3;
    FakeNode.DOCUMENT_FRAGMENT_NODE = 11;

    class FakeTextNode extends FakeNode {
        constructor(value) {
            super(FakeNode.TEXT_NODE);
            this._nodeValue = String(value);
            this.writeCount = 0;
        }

        get nodeValue() {
            return this._nodeValue;
        }

        set nodeValue(value) {
            this._nodeValue = String(value);
            this.writeCount++;
        }

        get textContent() {
            return this._nodeValue;
        }

        set textContent(value) {
            this.nodeValue = value;
        }
    }

    class FakeClassList {
        constructor(element) {
            this.element = element;
        }

        contains(value) {
            return this.element.className.split(/\s+/).filter(Boolean).includes(value);
        }

        add(value) {
            const values = new Set(this.element.className.split(/\s+/).filter(Boolean));
            values.add(value);
            this.element.className = Array.from(values).join(' ');
        }
    }

    class FakeElement extends FakeNode {
        constructor(tagName = 'div') {
            super(FakeNode.ELEMENT_NODE);
            this.tagName = String(tagName).toUpperCase();
            this.childNodes = [];
            this.attributes = new Map();
            this.attributeWriteCount = 0;
            this.className = '';
            this.classList = new FakeClassList(this);
            this.shadowRoot = null;
        }

        append(...nodes) {
            for (const node of nodes) {
                node.parentNode = this;
                node.parentElement = this;
                this.childNodes.push(node);
            }
            return this;
        }

        insertBefore(node, referenceNode) {
            const index = this.childNodes.indexOf(referenceNode);
            if (index < 0) return this.append(node);
            node.parentNode = this;
            node.parentElement = this;
            this.childNodes.splice(index, 0, node);
            return node;
        }

        get firstChild() {
            return this.childNodes.length > 0 ? this.childNodes[0] : null;
        }

        get firstElementChild() {
            for (const child of this.childNodes) {
                if (child.nodeType === FakeNode.ELEMENT_NODE) return child;
            }
            return null;
        }

        get previousElementSibling() {
            let prev = this.previousSibling;
            while (prev) {
                if (prev.nodeType === FakeNode.ELEMENT_NODE) return prev;
                prev = prev.previousSibling;
            }
            return null;
        }

        get nextElementSibling() {
            let next = this.nextSibling;
            while (next) {
                if (next.nodeType === FakeNode.ELEMENT_NODE) return next;
                next = next.nextSibling;
            }
            return null;
        }

        get children() {
            return this.childNodes.filter(node => node.nodeType === FakeNode.ELEMENT_NODE);
        }

        get textContent() {
            return this.childNodes.map(node => node.textContent || '').join('');
        }

        set textContent(value) {
            this.childNodes = [];
            this.append(new FakeTextNode(value));
        }

        get id() {
            return this.attributes.get('id') || '';
        }

        set id(value) {
            this.setAttribute('id', value);
        }

        hasAttribute(name) {
            return this.attributes.has(name);
        }

        getAttribute(name) {
            if (name === 'class') return this.className || null;
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        }

        setAttribute(name, value) {
            const stringValue = String(value);
            if (name === 'class') this.className = stringValue;
            this.attributes.set(name, stringValue);
            this.attributeWriteCount++;

            queueMutation({
                type: 'attributes',
                target: this,
                attributeName: name
            });
        }

        matches(selectors) {
            return String(selectors).split(',').some(selector => {
                let rest = selector.trim();
                if (!rest) return false;
                if (rest === '*') return true;
                const tagMatch = rest.match(/^[a-z][a-z0-9-]*/i);
                if (tagMatch) {
                    if (this.tagName !== tagMatch[0].toUpperCase()) return false;
                    rest = rest.slice(tagMatch[0].length);
                }
                while (rest.length > 0) {
                    const idMatch = rest.match(/^#([A-Za-z0-9_-]+)/);
                    if (idMatch) {
                        if (this.id !== idMatch[1]) return false;
                        rest = rest.slice(idMatch[0].length);
                        continue;
                    }
                    const clsMatch = rest.match(/^\.([A-Za-z0-9_-]+)/);
                    if (clsMatch) {
                        if (!this.classList.contains(clsMatch[1])) return false;
                        rest = rest.slice(clsMatch[0].length);
                        continue;
                    }
                    const attrMatch = rest.match(/^\[([A-Za-z0-9_:-]+)(?:=["']?([^"'\]]+)["']?)?\]/);
                    if (attrMatch) {
                        if (attrMatch[2] !== undefined) {
                            if (this.getAttribute(attrMatch[1]) !== attrMatch[2]) return false;
                        } else if (!this.hasAttribute(attrMatch[1])) {
                            return false;
                        }
                        rest = rest.slice(attrMatch[0].length);
                        continue;
                    }
                    return false;
                }
                return true;
            });
        }

        closest(selectors) {
            let current = this;
            while (current && current.nodeType === FakeNode.ELEMENT_NODE) {
                if (current.matches(selectors)) return current;
                current = current.parentElement;
            }
            return null;
        }

        querySelector(selector) {
            const matches = this.querySelectorAll(selector);
            return matches.length > 0 ? matches[0] : null;
        }

        querySelectorAll(selector) {
            const result = [];
            const visit = node => {
                if (node.nodeType !== FakeNode.ELEMENT_NODE) return;
                if (selector === '*' || node.matches(selector)) {
                    result.push(node);
                }
                for (const child of node.childNodes) visit(child);
            };
            for (const child of this.childNodes) visit(child);
            return result;
        }

        attachShadow() {
            const fragment = new FakeDocumentFragment(this);
            this.shadowRoot = fragment;
            return fragment;
        }
    }

    class FakeDocumentFragment extends FakeNode {
        constructor(host) {
            super(FakeNode.DOCUMENT_FRAGMENT_NODE);
            this.host = host;
            this.childNodes = [];
        }

        append(...nodes) {
            for (const node of nodes) {
                node.parentNode = this;
                node.parentElement = null;
                this.childNodes.push(node);
            }
            return this;
        }
    }

    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.observedTargets = new Map();
            activeObservers.add(this);
        }

        observe(target, options = {}) {
            this.observedTargets.set(target, {
                childList: Boolean(options.childList),
                subtree: Boolean(options.subtree),
                attributes: Boolean(options.attributes),
                characterData: Boolean(options.characterData),
                attributeFilter: options.attributeFilter ? Array.from(options.attributeFilter) : null
            });
        }

        disconnect() {
            this.observedTargets.clear();
            activeObservers.delete(this);
        }

        takeRecords() {
            return [];
        }
    }

    function isRecordObservedBy(observer, record) {
        for (const [target, options] of observer.observedTargets) {
            const recordTarget = record.target;
            if (!recordTarget) continue;
            const isTargetOrDescendant = (target === recordTarget) ||
                (Boolean(options.subtree) && target.contains(recordTarget));
            if (!isTargetOrDescendant) continue;

            if (record.type === 'childList') {
                if (options.childList) return true;
            } else if (record.type === 'characterData') {
                if (options.characterData) return true;
            } else if (record.type === 'attributes') {
                if (!options.attributes) return false;
                if (options.attributeFilter && !options.attributeFilter.includes(record.attributeName)) {
                    return false;
                }
                return true;
            }
        }
        return false;
    }

    function queueMutation(record) {
        let anyObserved = false;
        for (const observer of activeObservers) {
            if (isRecordObservedBy(observer, record)) {
                anyObserved = true;
                break;
            }
        }
        if (!anyObserved) return;

        pendingMutations.push(record);
        if (!isFlushing) {
            flushMutations();
        }
    }

    function flushMutations() {
        isFlushing = true;
        try {
            let depth = 0;
            while (pendingMutations.length > 0) {
                depth++;
                if (depth > 10) {
                    pendingMutations.length = 0;
                    throw new Error('Fake DOM mutation cascade exceeded its safety limit');
                }
                const currentBatch = pendingMutations.splice(0, pendingMutations.length);
                for (const observer of activeObservers) {
                    const recordsForObserver = currentBatch.filter(record => isRecordObservedBy(observer, record));
                    if (recordsForObserver.length > 0) {
                        observer.callback(recordsForObserver, observer);
                    }
                }
            }
        } finally {
            isFlushing = false;
        }
    }

    const html = new FakeElement('html');
    const body = new FakeElement('body');
    html.append(body);

    const protocol = options.protocol || 'file:';
    const location = {
        protocol,
        href: `${protocol}//app/`
    };

    const document = {
        readyState: 'loading',
        body,
        documentElement: html,
        getElementById(id) {
            if (!id) return null;
            const targetId = String(id);
            const visit = node => {
                if (!node || node.nodeType !== FakeNode.ELEMENT_NODE) return null;
                if (node.id === targetId) return node;
                for (const child of node.childNodes) {
                    const found = visit(child);
                    if (found) return found;
                }
                return null;
            };
            return visit(html);
        },
        createTextNode(value) {
            return new FakeTextNode(value);
        },
        addEventListener(type, callback) {
            addListener(documentListeners, type, callback);
        },
        removeEventListener(type, callback) {
            removeListener(documentListeners, type, callback);
        }
    };

    const window = {
        location,
        addEventListener(type, callback) {
            addListener(windowListeners, type, callback);
        },
        removeEventListener(type, callback) {
            removeListener(windowListeners, type, callback);
        }
    };

    const sandbox = {
        document,
        window,
        location,
        self: window,
        top: options.isSubframe ? {} : window,
        MutationObserver: FakeMutationObserver,
        Element: FakeElement,
        Node: FakeNode,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        TypeError,
        RangeError,
        Math,
        Date,
        JSON,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        decodeURI,
        decodeURIComponent,
        encodeURI,
        encodeURIComponent
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = document;
    sandbox.window.MutationObserver = FakeMutationObserver;
    sandbox.window.Element = FakeElement;
    sandbox.window.Node = FakeNode;

    const context = vm.createContext(sandbox);
    const script = new vm.Script(generatedSource, { filename: 'generated-localization-injection.js' });
    script.runInContext(context);

    if (activeObservers.size === 0) {
        throw new Error('生成的注入代码没有注册 MutationObserver');
    }

    function triggerDOMContentLoaded() {
        document.readyState = 'interactive';
        dispatchEvent(documentListeners, 'DOMContentLoaded', { type: 'DOMContentLoaded' });
        document.readyState = 'complete';
        dispatchEvent(windowListeners, 'load', { type: 'load' });
    }

    // Trigger DOMContentLoaded immediately after injection to ensure startEngine() registers document.body to the observer
    triggerDOMContentLoaded();

    function dispatchAdded(node) {
        const target = node.parentNode || null;
        queueMutation({
            type: 'childList',
            target,
            addedNodes: [node],
            removedNodes: []
        });
    }

    function dispatchCharacterData(node) {
        queueMutation({
            type: 'characterData',
            target: node
        });
    }

    function mount(node) {
        body.append(node);
        dispatchAdded(node);
        return node;
    }

    function reset() {
        pendingMutations.length = 0;
        for (const child of Array.from(body.childNodes)) {
            child.parentNode = null;
            child.parentElement = null;
        }
        body.childNodes = [];
        body.className = '';
        body.attributes.clear();
        body.attributeWriteCount = 0;
        return api;
    }

    const api = {
        dispatchAdded,
        dispatchCharacterData,
        element(tagName, ...children) {
            return new FakeElement(tagName).append(...children);
        },
        mount,
        reset,
        text(value) {
            return new FakeTextNode(value);
        }
    };

    return api;
}

module.exports = {
    createFakeDomEnvironment
};
