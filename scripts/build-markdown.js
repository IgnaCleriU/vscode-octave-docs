// build-markdown.js: turns build/octave-help.json (written by build-docs.m)
// into docs/octave-docs.json, converting each help's HTML body to Markdown
// so the hover renders it like any other language's docs: prose in the UI
// font, parameters as a list, examples as highlighted code blocks.
//
// Usage, from the repository root:
//   node scripts/build-markdown.js

const fs = require('fs');
const TurndownService = require('turndown');

const td = new TurndownService({
	headingStyle: 'atx',
	bulletListMarker: '-',
	emDelimiter: '*',
	codeBlockStyle: 'fenced',
});

const hasClass = (node, cls) =>
	node.getAttribute && (node.getAttribute('class') || '').split(/\s+/).includes(cls);

td.remove(['style', 'script']);

// @table: one bullet per item, "- `name` — description"
td.addRule('table-term', {
	filter: node => node.nodeName === 'DT',
	replacement: content => `\n- ${content.trim()}`,
});
td.addRule('table-desc', {
	filter: node => node.nodeName === 'DD',
	replacement: content => {
		const body = content.trim().replace(/\n/g, '\n  ');
		return body ? ` — ${body}\n` : '\n';
	},
});
td.addRule('table', {
	filter: node => node.nodeName === 'DL',
	replacement: content => `\n\n${content.trim()}\n\n`,
});

// Variables and inline code: a single code span, even when nested
const inCode = node => {
	for (let p = node.parentNode; p; p = p.parentNode) {
		if (['CODE', 'VAR', 'KBD', 'SAMP', 'PRE'].includes(p.nodeName)) { return true; }
	}
	return false;
};
td.addRule('inline-code', {
	filter: node => ['CODE', 'VAR', 'KBD', 'SAMP'].includes(node.nodeName),
	replacement: (content, node) => {
		if (inCode(node)) { return node.textContent; }
		const text = node.textContent;
		if (!text.trim()) { return text; }
		const fence = text.includes('`') ? '``' : '`';
		return `${fence}${text}${fence}`;
	},
});

// @example: fenced block, highlighted as Octave unless it is a drawing
td.addRule('example', {
	filter: node => node.nodeName === 'PRE',
	replacement: (content, node) => {
		const code = node.textContent.replace(/\n+$/, '');
		const drawing = /[-+|]{3,}/.test(code) && /\|/.test(code);
		return `\n\n\`\`\`${drawing ? 'text' : 'octave'}\n${code}\n\`\`\`\n\n`;
	},
});

// Internal cross references point nowhere outside the manual
td.addRule('links', {
	filter: node => node.nodeName === 'A',
	replacement: (content, node) => {
		const href = node.getAttribute('href') || '';
		return /^https?:/.test(href) ? `[${content}](${href})` : content;
	},
});

td.addRule('abbr', {
	filter: ['abbr', 'acronym', 'span', 'div'],
	replacement: (content, node) =>
		node.nodeName === 'DIV' ? `\n\n${content}\n\n` : content,
});

// Turndown checks the most recently added rule first, so this one goes last.
// The definition block wraps the whole description: keep only its content
td.addRule('def-block', {
	filter: node => (node.nodeName === 'DL' && hasClass(node, 'def-block')) ||
		(node.nodeName === 'DD' && node.parentNode && hasClass(node.parentNode, 'def-block')),
	replacement: content => `\n\n${content}\n\n`,
});

function toMarkdown(entry) {
	if (!entry.html) {
		// Plain-text help: keep its layout as is
		return '```text\n' + entry.text + '\n```';
	}
	const html = entry.html
		// Signatures are rendered separately by the extension
		.replace(/<dt class="[^"]*\bdef-line\b[^"]*"[\s\S]*?<\/dt>/g, '')
		.replace(/<a class="copiable-link"[\s\S]*?<\/a>/g, '');
	return escapeAngles(td.turndown(html))
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Literal text like "<linestyle>" would be taken as an HTML tag and vanish;
// escape "<" everywhere except inside code.
function escapeAngles(md) {
	let fenced = false;
	return md.split('\n').map(line => {
		if (line.trimStart().startsWith('```')) { fenced = !fenced; return line; }
		if (fenced) { return line; }
		return line.split(/(`+[^`]*`+)/).map((part, i) =>
			i % 2 === 1 ? part : part.replace(/</g, '\\<')).join('');
	}).join('\n');
}

const raw = JSON.parse(fs.readFileSync('build/octave-help.json', 'utf8'));
const entries = (Array.isArray(raw.entries) ? raw.entries : [raw.entries]).map(e => ({
	name: e.name,
	class: e.class,
	package: e.package,
	text: e.text,
	markdown: toMarkdown(e),
}));

const out = { ...raw, entries };
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/octave-docs.json', JSON.stringify(out));
console.log(`${entries.length} entries written to docs/octave-docs.json`);
