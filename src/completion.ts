import * as vscode from 'vscode';
import { DocEntry, inComment, KEYWORDS, OctaveDocs, qualifiedName, rank, signatures } from './hover';

/** A call form parsed from a help signature line. */
export interface CallForm {
	name: string;
	/** Arguments in order, as written in the help (uppercase). */
	args: string[];
	/** true for command syntax (`syms x y`), false for `f (a, b)`. */
	command: boolean;
	/** The signature line without its " -- Function File: " prefix. */
	signature: string;
}

/** Signature prefix such as "Function File: " or "Method on @sym: ". */
const LABEL_RE = /^([A-Z][A-Za-z -]*?(?: on @\w+)?):\s+/;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits an argument list at top-level commas, respecting brackets and quotes. */
function splitArgs(s: string): string[] {
	const args: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let current = '';
	for (const c of s) {
		if (quote) {
			if (c === quote) { quote = null; }
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if ('([{'.includes(c)) {
			depth++;
		} else if (')]}'.includes(c)) {
			depth--;
		} else if (c === ',' && depth === 0) {
			args.push(current.trim());
			current = '';
			continue;
		}
		current += c;
	}
	if (current.trim() !== '') { args.push(current.trim()); }
	return args;
}

/** Index of the parenthesis closing the one at `open`, or -1. */
function closingParen(s: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === quote) { quote = null; }
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '(') {
			depth++;
		} else if (c === ')') {
			depth--;
			if (depth === 0) { return i; }
		}
	}
	return -1;
}

/**
 * Parses one help signature line (" -- [Y, K] = rlocus (SYS, INCREMENT)")
 * into a call form. Returns undefined for operators and for lines that do
 * not show how to call `name`.
 */
export function parseSignature(name: string, line: string): CallForm | undefined {
	let sig = line.replace(/^\s*--\s*/, '');
	const label = sig.match(LABEL_RE);
	if (label) {
		if (/Operator/.test(label[1])) { return undefined; }
		sig = sig.slice(label[0].length);
	}
	sig = sig.trim();

	const m = new RegExp(`(?:^|[\\s=])${escapeRegExp(name)}(?=\\s*\\(|\\s|$)`).exec(sig);
	if (!m) { return undefined; }
	const rest = sig.slice(m.index + m[0].length).trim();

	if (rest === '') {
		return { name, args: [], command: false, signature: sig };
	}
	if (rest.startsWith('(')) {
		const close = closingParen(rest, 0);
		if (close < 0) { return undefined; }
		return { name, args: splitArgs(rest.slice(1, close)), command: false, signature: sig };
	}
	return { name, args: rest.split(/\s+/), command: true, signature: sig };
}

function escapeSnippet(s: string): string {
	return s.replace(/[\\$}]/g, '\\$&');
}

/** Builds the snippet text: `rlocus(${1:sys}, ${2:increment})`. */
export function snippetText(form: CallForm): string {
	if (form.args.length === 0) { return form.name; }
	// Help prints argument names in uppercase; code uses lowercase
	const holes = form.args.map((a, i) => `\${${i + 1}:${escapeSnippet(a.toLowerCase())}}`);
	return form.command
		? `${form.name} ${holes.join(' ')}`
		: `${form.name}(${holes.join(', ')})`;
}

/** First line of the description that follows the signatures. */
function summary(e: DocEntry): string {
	const lines = e.text.split('\n');
	const firstText = lines.findIndex(l => l.trim() !== '' && !l.startsWith(' -- '));
	return firstText < 0 ? '' : lines[firstText].trim();
}

export class OctaveCompletionProvider implements vscode.CompletionItemProvider {
	/** Snippet items for every documented call form. */
	private snippets: vscode.CompletionItem[] = [];
	/** Bare-name items, used when a "(" already follows the cursor. */
	private plain: vscode.CompletionItem[] = [];

	constructor(docs: OctaveDocs) {
		for (const name of docs.names()) {
			if (KEYWORDS.has(name)) { continue; }
			const seen = new Set<string>();
			const entries = docs.lookup(name);
			entries.forEach((e, entryIdx) => {
				const forms = signatures(e)
					.map(l => parseSignature(name, l))
					.filter((f): f is CallForm => f !== undefined);
				if (forms.length === 0) {
					// No usable signature: still offer the name
					forms.push({ name, args: [], command: false, signature: name });
				}
				forms.forEach((form, formIdx) => {
					const text = snippetText(form);
					if (seen.has(text)) { return; }
					seen.add(text);
					this.snippets.push(this.item(e, form, text, entryIdx, formIdx));
				});
			});

			const main = entries[0];
			const bare = new vscode.CompletionItem(name, kind(main));
			bare.detail = `${qualifiedName(main)} — ${main.package}`;
			bare.documentation = summary(main);
			this.plain.push(bare);
		}
	}

	private item(e: DocEntry, form: CallForm, text: string,
				 entryIdx: number, formIdx: number): vscode.CompletionItem {
		const it = new vscode.CompletionItem(form.name, kind(e));
		it.insertText = new vscode.SnippetString(text);
		it.filterText = form.name;
		it.detail = `${form.signature}   [${e.package}${e.class ? ' @' + e.class : ''}]`;
		it.documentation = new vscode.MarkdownString().appendCodeblock(form.signature, 'octave')
			.appendMarkdown(summary(e));
		// Keep the order of the help: preferred entry first, simplest form first
		const pad = (n: number) => String(n).padStart(3, '0');
		it.sortText = `${form.name}\u0000${rank(e)}${pad(entryIdx)}${pad(formIdx)}`;
		return it;
	}

	provideCompletionItems(document: vscode.TextDocument,
						   position: vscode.Position): vscode.CompletionItem[] {
		const line = document.lineAt(position.line).text;
		if (inComment(line, position.character)) { return []; }
		const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		const after = line.slice(word ? word.end.character : position.character);
		return /^\s*\(/.test(after) ? this.plain : this.snippets;
	}
}

function kind(e: DocEntry): vscode.CompletionItemKind {
	if (e.class === e.name) { return vscode.CompletionItemKind.Constructor; }
	return e.class ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Function;
}
