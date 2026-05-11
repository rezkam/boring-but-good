#!/usr/bin/env node
// Convert GitHub-flavoured Markdown (stdin) to Atlassian Document Format JSON (stdout).
//
// Pipeline:
//   1. md-to-adf parses the markdown via marked + adf-builder.
//   2. Post-process: GFM task list items (`- [x] foo` / `- [ ] foo`) come out
//      of md-to-adf as regular bulletList items with literal "[x] " / "[ ] "
//      text. Walk the doc and convert any bulletList whose items all start
//      with the checkbox prefix into a proper ADF taskList + taskItem nodes
//      so Jira renders real checkboxes.
//
// Resolves md-to-adf from the skill's local node_modules. If the library is
// missing, exits non-zero with a hint so callers can fall back to plain text.

const path = require('path');
let translate;
try {
    translate = require(path.join(__dirname, 'node_modules', 'md-to-adf'));
} catch (e) {
    process.stderr.write('md-to-adf not installed. Run: cd ' + __dirname + ' && npm install md-to-adf\n');
    process.exit(2);
}

const TASK_PREFIX = /^\[( |x|X)\]\s+/;

function isTaskBulletList(node) {
    if (!node || node.type !== 'bulletList' || !Array.isArray(node.content)) return false;
    if (node.content.length === 0) return false;
    return node.content.every(li => {
        if (!li || li.type !== 'listItem' || !Array.isArray(li.content) || li.content.length === 0) return false;
        const para = li.content[0];
        if (!para || para.type !== 'paragraph' || !Array.isArray(para.content) || para.content.length === 0) return false;
        const t = para.content[0];
        return t && t.type === 'text' && TASK_PREFIX.test(t.text);
    });
}

function bulletListToTaskList(node, idCounter) {
    const items = node.content.map((li, idx) => {
        const para = li.content[0];
        const inline = para.content;
        const firstText = inline[0];
        const m = firstText.text.match(TASK_PREFIX);
        const state = m[1].toLowerCase() === 'x' ? 'DONE' : 'TODO';
        const stripped = firstText.text.slice(m[0].length);
        const newFirst = Object.assign({}, firstText, { text: stripped });
        const taskItemContent = stripped.length > 0
            ? [newFirst, ...inline.slice(1)]
            : inline.slice(1);
        return {
            type: 'taskItem',
            attrs: { localId: 'task-' + idCounter.next(), state },
            content: taskItemContent
        };
    });
    return {
        type: 'taskList',
        attrs: { localId: 'tasklist-' + idCounter.next() },
        content: items
    };
}

function mkIdCounter() {
    let n = 0;
    return { next: () => ++n };
}

function walk(container, idCounter) {
    if (!container || !Array.isArray(container.content)) return;
    const out = [];
    for (const node of container.content) {
        if (isTaskBulletList(node)) {
            out.push(bulletListToTaskList(node, idCounter));
        } else {
            walk(node, idCounter);
            out.push(node);
        }
    }
    container.content = out;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const adf = translate(input);
        walk(adf, mkIdCounter());
        process.stdout.write(JSON.stringify(adf));
    } catch (e) {
        process.stderr.write('md-to-adf conversion failed: ' + e.message + '\n');
        process.exit(3);
    }
});
