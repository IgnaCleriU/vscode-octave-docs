import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** A function or method documented in docs/octave-docs.json. */
export interface DocEntry {
	name: string;
	/** Class of the method (sym, tf, lti, ...), or "" for a plain function. */
	class: string;
	/** Source package: control, symbolic or octave. */
	package: string;
	/** Help text already rendered to plain text, as `help` prints it. */
	text: string;
	/** Description (without signatures) converted to Markdown. */
	markdown: string;
}

interface DocIndex {
	octaveVersion: string;
	generated: string;
	entries: DocEntry[];
}

export const HELP_SCHEME = 'octave-help';
export const SHOW_HELP_COMMAND = 'octaveDocs.showFullHelp';

/** Lines of the description shown in the hover before truncating. */
const MAX_HOVER_LINES = 40;

/** Signature prefix such as "Function File: " or "Method on @sym: ". */
export const LABEL_RE = /^([A-Z][A-Za-z -]*?(?: on @\w+)?):\s+/;

/** Reserved words: no hover or completion for them, even if they have help. */
export const KEYWORDS = new Set([
	'if', 'elseif', 'else', 'end', 'endif', 'for', 'endfor', 'parfor', 'endparfor',
	'while', 'endwhile', 'do', 'until', 'switch', 'case', 'otherwise', 'endswitch',
	'function', 'endfunction', 'return', 'break', 'continue', 'try', 'catch',
	'end_try_catch', 'unwind_protect', 'unwind_protect_cleanup',
	'end_unwind_protect', 'global', 'persistent', 'classdef', 'endclassdef',
	'methods', 'endmethods', 'properties', 'endproperties', 'events', 'endevents',
	'enumeration', 'endenumeration',
]);

export class OctaveDocs {
	private byName = new Map<string, DocEntry[]>();
	readonly index: DocIndex;

	constructor(extensionPath: string) {
		const file = path.join(extensionPath, 'docs', 'octave-docs.json');
		this.index = JSON.parse(fs.readFileSync(file, 'utf8')) as DocIndex;
		for (const e of this.index.entries) {
			const list = this.byName.get(e.name) ?? [];
			list.push(e);
			this.byName.set(e.name, list);
		}
		for (const list of this.byName.values()) {
			list.sort((a, b) => rank(a) - rank(b));
		}
	}

	/** All entries for a name, most relevant first. */
	lookup(name: string): DocEntry[] {
		return this.byName.get(name) ?? [];
	}

	find(name: string, cls: string): DocEntry | undefined {
		return this.lookup(name).find(e => e.class === cls);
	}

	names(): IterableIterator<string> {
		return this.byName.keys();
	}
}

/**
 * Preference order when a name has several entries: package functions
 * first, then core Octave, and class methods last (they are usually
 * overloads of the former).
 */
export function rank(e: DocEntry): number {
	if (e.class === '' || e.class === e.name) {
		return e.package === 'octave' ? 1 : 0;
	}
	return 2;
}

export function qualifiedName(e: DocEntry): string {
	// A class constructor (@tf/tf) is shown by its plain name
	return e.class && e.class !== e.name ? `@${e.class}/${e.name}` : e.name;
}

/** Signature lines of an entry: the ones starting with " -- ". */
export function signatures(e: DocEntry): string[] {
	return e.text.split('\n').filter(l => l.startsWith(' -- ')).map(l => l.trim());
}

/**
 * Turns a help signature into code: " -- Function File: [Y, K] = rlocus (SYS)"
 * becomes "[y, k] = rlocus(sys)". Help prints arguments in uppercase.
 */
export function formatSignature(name: string, line: string): string {
	let sig = line.replace(/^\s*--\s*/, '').replace(LABEL_RE, '').trim();
	sig = sig.replace(/\b[A-Z][A-Z0-9_]*\b/g, w => (w === name ? w : w.toLowerCase()));
	return sig.split(`${name} (`).join(`${name}(`);
}

/** Signatures of an entry as an Octave code block. */
function signatureBlock(e: DocEntry): string {
	const sigs = signatures(e).map(l => formatSignature(e.name, l));
	return sigs.length > 0 ? sigs.join('\n') : e.name;
}

/** Cuts Markdown after `max` lines without leaving a code fence open. */
function truncateMarkdown(md: string, max: number): { text: string; cut: boolean } {
	const lines = md.split('\n');
	if (lines.length <= max) { return { text: md, cut: false }; }
	const kept = lines.slice(0, max);
	const fences = kept.filter(l => l.trimStart().startsWith('```')).length;
	if (fences % 2 === 1) { kept.push('```'); }
	return { text: kept.join('\n'), cut: true };
}

/** Full help of an entry as a Markdown document. */
function fullMarkdown(e: DocEntry): string {
	return `# ${qualifiedName(e)}\n\n*Package: ${e.package}*\n\n` +
		'```octave\n' + signatureBlock(e) + '\n```\n\n' + e.markdown + '\n';
}

function helpUri(e: DocEntry): vscode.Uri {
	const cls = e.class || '_';
	return vscode.Uri.from({ scheme: HELP_SCHEME, path: `/${cls}/${e.name}.md` });
}

function commandLink(label: string, e: DocEntry): string {
	const args = encodeURIComponent(JSON.stringify([e.name, e.class]));
	return `[${label}](command:${SHOW_HELP_COMMAND}?${args})`;
}

/** True if the given column falls inside a comment (% or #). */
export function inComment(line: string, character: number): boolean {
	let quote: string | null = null;
	for (let i = 0; i < character && i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) { quote = null; }
		} else if (c === '"') {
			quote = c;
		} else if (c === "'") {
			// An apostrophe after an identifier, ) or ] is a transpose, not a string
			const prev = line.slice(0, i).trimEnd().slice(-1);
			if (!/[\w)\]}.']/.test(prev)) { quote = c; }
		} else if (c === '%' || c === '#') {
			return true;
		}
	}
	return false;
}

export class OctaveHoverProvider implements vscode.HoverProvider {
	constructor(private docs: OctaveDocs) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (!range) { return undefined; }
		const word = document.getText(range);
		if (KEYWORDS.has(word)) { return undefined; }
		if (inComment(document.lineAt(position.line).text, range.start.character)) {
			return undefined;
		}

		const entries = this.docs.lookup(word);
		if (entries.length === 0) { return undefined; }

		const [main, ...others] = entries;
		const md = new vscode.MarkdownString();
		md.isTrusted = true;

		// Same layout as other languages' docs: signatures, description, footer
		md.appendCodeblock(signatureBlock(main), 'octave');
		md.appendMarkdown('\n---\n\n');

		const body = truncateMarkdown(main.markdown, MAX_HOVER_LINES);
		md.appendMarkdown(body.text + '\n\n---\n\n');

		const where = main.class && main.class !== main.name
			? `\`${main.package}\` · method of \`@${main.class}\``
			: `\`${main.package}\``;
		const more = body.cut ? 'Show full help (continues)' : 'Show full help';
		md.appendMarkdown(`*${where}* · ${commandLink(more, main)}\n`);

		if (others.length > 0) {
			md.appendMarkdown('\n**Also defined as:**\n\n');
			for (const e of others) {
				const sig = signatures(e)[0];
				md.appendMarkdown(`- ${commandLink(qualifiedName(e), e)} (\`${e.package}\`)`);
				if (sig) {
					md.appendMarkdown(` — \`${formatSignature(e.name, sig).replace(/`/g, "'")}\``);
				}
				md.appendMarkdown('\n');
			}
		}

		return new vscode.Hover(md, range);
	}
}

/** Serves the full help text as a read-only document. */
export class OctaveHelpContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private docs: OctaveDocs) {}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const m = uri.path.match(/^\/([^/]+)\/(.+)\.md$/);
		if (!m) { return ''; }
		const cls = m[1] === '_' ? '' : m[1];
		const e = this.docs.find(m[2], cls);
		if (!e) { return `No help found for ${m[2]}.`; }
		return fullMarkdown(e);
	}
}

/** Opens the full help rendered by VS Code's Markdown preview. */
export async function showFullHelp(name: string, cls: string): Promise<void> {
	const uri = helpUri({ name, class: cls, package: '', text: '', markdown: '' });
	try {
		await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
	} catch {
		// Without the built-in Markdown extension, show the source instead
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
	}
}
