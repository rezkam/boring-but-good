#!/usr/bin/env node
// Convert Atlassian Document Format JSON (stdin) to GitHub-flavoured Markdown (stdout).
//
// Pipeline:
//   1. Pre-process: ADF taskList + taskItem nodes are not understood by
//      adf-to-md (it emits empty bullets). Convert them into bulletList
//      items prefixed with `[x] ` or `[ ] ` so the downstream renderer
//      produces real GFM checkbox syntax.
//   2. adf-to-md converts the rest (headings, paragraphs, lists, code,
//      links, etc.).
//
// Reads JSON from stdin, writes markdown to stdout.

const path = require('path');
let adfToMd;
try {
    adfToMd = require(path.join(__dirname, 'node_modules', 'adf-to-md'));
} catch (e) {
    process.stderr.write('adf-to-md not installed. Run: cd ' + __dirname + ' && npm install adf-to-md\n');
    process.exit(2);
}

function taskListToBulletList(node) {
    return {
        type: 'bulletList',
        content: (node.content || []).map(taskItem => {
            const state = (taskItem.attrs && taskItem.attrs.state) || 'TODO';
            const prefix = state === 'DONE' ? '[x] ' : '[ ] ';
            const inline = taskItem.content || [];
            const firstText = inline[0];
            let paragraphContent;
            if (firstText && firstText.type === 'text') {
                paragraphContent = [
                    Object.assign({}, firstText, { text: prefix + firstText.text }),
                    ...inline.slice(1)
                ];
            } else {
                paragraphContent = [{ type: 'text', text: prefix }, ...inline];
            }
            return {
                type: 'listItem',
                content: [{ type: 'paragraph', content: paragraphContent }]
            };
        })
    };
}

function walk(container) {
    if (!container || !Array.isArray(container.content)) return;
    const out = [];
    for (const node of container.content) {
        if (node && node.type === 'taskList') {
            out.push(taskListToBulletList(node));
        } else {
            walk(node);
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
        const adf = JSON.parse(input);
        walk(adf);
        const r = adfToMd.convert(adf);
        process.stdout.write(r.result);
    } catch (e) {
        process.stderr.write('adf-to-md conversion failed: ' + e.message + '\n');
        process.exit(3);
    }
});
