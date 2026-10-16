import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KEYWORDS } from './hover';

/** A function or script defined in the user's own code. */
export interface UserFunction {
	name: string;
	/** Output names in order (empty when there are none). */
	outputs: string[];
	/** Parameter names in order, as written (may include varargin or ~). */
	params: string[];
	uri: vscode.Uri;
	/** 0-based line of the `function` keyword; 0 for scripts. */
	line: number;
	/** Help comment with the comment markers removed. */
	help: string;
	/** True for a script file, which is called by its file name. */
	isScript: boolean;
}

/** A 0-based position inside a document. */
export interface VariablePosition {
	line: number;
	character: number;
}

/** Delay before reparsing an open document after it changes. */
const DEBOUNCE_MS = 300;

/** Keywords after which a quote starts a string, even if a word precedes it. */
const STRING_AFTER = new Set(['case', 'return', 'if', 'elseif', 'while', 'until', 'else', 'otherwise']);

/** Assumption words that may follow names in `syms`; they are not variables. */
const SYM_ASSUMPTIONS = new Set(['real', 'positive', 'negative', 'integer', 'rational', 'nonzero', 'clear']);

const FUNCTION_RE =/^\s*function\s+(?:(\[[^\]]*\]|\w+)\s*=\s*)?([\w.]+)\s*(?:\(([^)]*)\))?/;

/** Keywords that open a block closed by an `end` variant. */
const OPENERS = new Set(['if', 'for', 'parfor', 'while', 'switch', 'try', 'do', 'unwind_protect', 'function']);

/** Keywords that close a block. `until` closes `do`. */
const CLOSERS = new Set([
	'end', 'endif', 'endfor', 'endparfor', 'endwhile', 'endswitch', 'end_try_catch',
	'endfunction', 'end_unwind_protect', 'until',
]);

/** Index of the functions and scripts defined in the workspace. */
export class WorkspaceIndex implements vscode.Disposable {
	private files = new Map<string, UserFunction[]>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private emitter = new vscode.EventEmitter<void>();
	private disposables: vscode.Disposable[] = [];
	/** Fires after the index changes. */
	readonly onDidChange: vscode.Event<void> = this.emitter.event;
	/** Resolves when the first scan of the workspace has finished. */
	readonly ready: Promise<void>;

	constructor() {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.m');
		this.disposables.push(
			watcher,
			watcher.onDidCreate(uri => this.reload(uri)),
			watcher.onDidChange(uri => this.reload(uri)),
			watcher.onDidDelete(uri => this.remove(uri)),
			vscode.workspace.onDidChangeTextDocument(e => this.scheduleDocument(e.document)),
			vscode.workspace.onDidCloseTextDocument(doc => this.reload(doc.uri, false)),
		);
		this.ready = this.scan().catch(err => console.error('Octave workspace scan failed', err));
	}

	/** Functions and scripts with this name, in no particular order. */
	lookup(name: string): UserFunction[] {
		return this.all().filter(f => f.name === name);
	}

	/** Every indexed function and script. */
	all(): UserFunction[] {
		const out: UserFunction[] = [];
		for (const list of this.files.values()) { out.push(...list); }
		return out;
	}

	dispose(): void {
		for (const t of this.timers.values()) { clearTimeout(t); }
		this.timers.clear();
		for (const d of this.disposables) { d.dispose(); }
		this.emitter.dispose();
	}

	private async scan(): Promise<void> {
		const uris = await vscode.workspace.findFiles('**/*.m', '**/{node_modules,.git}/**');
		await Promise.all(uris.map(uri => this.load(uri, false)));
		// Open documents win over the disk, so unsaved edits count
		for (const doc of vscode.workspace.textDocuments) { await this.load(doc.uri, true); }
		this.emitter.fire();
	}

	private async reload(uri: vscode.Uri, preferOpen = true): Promise<void> {
		await this.load(uri, preferOpen);
		this.emitter.fire();
	}

	private async load(uri: vscode.Uri, preferOpen: boolean): Promise<void> {
		if (!isWorkspaceFile(uri)) { return; }
		const key = uri.toString();
		const open = preferOpen
			? vscode.workspace.textDocuments.find(d => d.uri.toString() === key)
			: undefined;
		let text: string | undefined = open ? open.getText() : undefined;
		if (text === undefined) {
			try {
				text = await fs.promises.readFile(uri.fsPath, 'utf8');
			} catch {
				text = undefined;
			}
		}
		if (text === undefined) {
			this.files.delete(key);
		} else {
			this.files.set(key, parseFile(uri, text));
		}
	}

	private remove(uri: vscode.Uri): void {
		this.files.delete(uri.toString());
		this.emitter.fire();
	}

	private scheduleDocument(doc: vscode.TextDocument): void {
		if (!isWorkspaceFile(doc.uri)) { return; }
		const key = doc.uri.toString();
		const old = this.timers.get(key);
		if (old !== undefined) { clearTimeout(old); }
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			this.reload(doc.uri, true);
		}, DEBOUNCE_MS));
	}
}

function isWorkspaceFile(uri: vscode.Uri): boolean {
	return uri.scheme === 'file' && uri.fsPath.endsWith('.m') &&
		!/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(uri.fsPath);
}

/** Parses the functions and the script of one file. */
function parseFile(uri: vscode.Uri, text: string): UserFunction[] {
	const lines = text.split(/\r?\n/);
	const analysis = analyze(lines);
	const result: UserFunction[] = [];

	const first = analysis.code.findIndex(c => c.trim() !== '');
	if (first >= 0 && !/^\s*function\b/.test(lines[first])) {
		result.push({
			name: path.basename(uri.fsPath, '.m'), outputs: [], params: [], uri,
			line: 0, help: leadingHelp(lines), isScript: true,
		});
	}
	for (const f of analysis.frames) {
		if (f.name === '') { continue; }
		result.push({
			name: f.name, outputs: f.outputs, params: f.params, uri,
			line: f.line, help: helpFor(lines, f.line), isScript: false,
		});
	}
	return result;
}

function isComment(line: string): boolean {
	return /^\s*[%#]/.test(line);
}

/** Help of a function: the comment block after its line, or before it. */
function helpFor(lines: string[], line: number): string {
	const after: string[] = [];
	for (let i = line + 1; i < lines.length && isComment(lines[i]); i++) { after.push(lines[i]); }
	if (after.length > 0) { return helpText(after); }
	const before: string[] = [];
	for (let i = line - 1; i >= 0 && isComment(lines[i]); i--) { before.unshift(lines[i]); }
	return helpText(before);
}

/** Help of a script: the first comment block of the file, skipping a shebang. */
function leadingHelp(lines: string[]): string {
	let i = 0;
	while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#!'))) { i++; }
	const block: string[] = [];
	while (i < lines.length && isComment(lines[i])) { block.push(lines[i++]); }
	return helpText(block);
}

/** Removes comment markers and texinfo noise from a comment block. */
function helpText(block: string[]): string {
	return block
		.filter(l => !/-\*-\s*texinfo\s*-\*-/.test(l) && !/^\s*[%#]\s*@/.test(l))
		.map(l => l.replace(/^\s*[%#]+ ?/, ''))
		.join('\n')
		.trim();
}

interface Header {
	name: string;
	outputs: string[];
	params: string[];
}

function parseHeader(line: string): Header | undefined {
	const m = FUNCTION_RE.exec(line);
	if (!m) { return undefined; }
	let outputs: string[] = [];
	if (m[1] !== undefined) {
		outputs = m[1].startsWith('[')
			? m[1].slice(1, -1).split(/[\s,]+/).filter(s => s !== '')
			: [m[1]];
	}
	const params = m[3] === undefined
		? []
		: m[3].split(',').map(s => s.trim()).filter(s => s !== '');
	return { name: m[2], outputs, params };
}

/** A function block found by analyze(). */
interface Frame extends Header {
	/** 0-based line of the `function` keyword. */
	line: number;
	/** 0-based line of its `end`, or of the line before the next function. */
	end: number;
}

interface Analysis {
	frames: Frame[];
	/** Index into `frames` of the function that encloses each line, or -1 for the script. */
	scopeOf: number[];
	/** Each line with strings and comments blanked out. */
	code: string[];
}

/** True if a quote after `before` is a transpose, not the start of a string. */
function isTranspose(before: string): boolean {
	const trimmed = before.replace(/\s+$/, '');
	if (!/[\w)\]}.']/.test(trimmed.slice(-1))) { return false; }
	const word = /(\w+)$/.exec(trimmed);
	return !(word && STRING_AFTER.has(word[1]));
}

/** The line with strings and comments replaced by spaces, so columns stay the same. */
function codeOf(line: string): string {
	let out = '';
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote !== null) {
			if (quote === '"' && c === '\\' && i + 1 < line.length) {
				out += '  ';
				i++;
			} else if (c === quote && line[i + 1] === quote) {
				// A doubled quote is an escaped quote inside the string
				out += '  ';
				i++;
			} else {
				if (c === quote) { quote = null; }
				out += ' ';
			}
			continue;
		}
		if (c === '%' || c === '#') { return out + ' '.repeat(line.length - i); }
		if (c === '"' || (c === "'" && !isTranspose(out))) {
			quote = c;
			out += ' ';
		} else {
			out += c;
		}
	}
	return out;
}

/** Finds the function blocks and the scope of every line. */
function analyze(lines: string[]): Analysis {
	const frames: Frame[] = [];
	const stack: { kind: string; frame: number }[] = [];
	const scopeOf: number[] = [];
	const code: string[] = [];
	let inBlockComment = false;

	lines.forEach((raw, i) => {
		let text: string;
		if (inBlockComment) {
			if (/^\s*[%#]\}\s*$/.test(raw)) { inBlockComment = false; }
			text = '';
		} else if (/^\s*[%#]\{\s*$/.test(raw)) {
			inBlockComment = true;
			text = '';
		} else {
			text = codeOf(raw);
		}
		code.push(text);

		// Keywords inside brackets are indexing (x(end)), not block ends
		let depth = 0;
		const token = /[A-Za-z_]\w*|[()[\]{}]/g;
		let m: RegExpExecArray | null;
		while ((m = token.exec(text)) !== null) {
			const t = m[0];
			if (t === '(' || t === '[' || t === '{') {
				depth++;
			} else if (t === ')' || t === ']' || t === '}') {
				depth = Math.max(0, depth - 1);
			} else if (depth === 0) {
				if (t === 'function') {
					const top = stack[stack.length - 1];
					if (top && top.kind === 'function') {
						// Without an `end`, a function lasts until the next one
						frames[top.frame].end = i - 1;
						stack.pop();
					}
					const header = parseHeader(raw) ?? { name: '', outputs: [], params: [] };
					frames.push({ ...header, line: i, end: lines.length - 1 });
					stack.push({ kind: 'function', frame: frames.length - 1 });
				} else if (OPENERS.has(t)) {
					stack.push({ kind: t, frame: -1 });
				} else if (CLOSERS.has(t)) {
					const top = stack.pop();
					if (top && top.kind === 'function' && t !== 'until') {
						frames[top.frame].end = i;
					}
				}
			}
		}

		let scope = -1;
		for (let k = stack.length - 1; k >= 0; k--) {
			if (stack[k].kind === 'function') { scope = stack[k].frame; break; }
		}
		scopeOf.push(scope);
	});

	return { frames, scopeOf, code };
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a whole identifier, not a field (`s.name`) or a longer name. */
function wordRe(name: string): RegExp {
	return new RegExp(`(?<![\\w.])${escapeRe(name)}(?!\\w)`);
}

/**
 * Column where `code` defines the variable `name`, or undefined.
 * Covers assignments (`x =`, `x(i) =`, `x.f =`), `[a, ~] =`, `for x =`,
 * `global`/`persistent`, `syms` and `catch err`.
 */
function definitionColumn(code: string, name: string): number | undefined {
	const id = `(?<![\\w.])${escapeRe(name)}(?!\\w)`;
	// `=` alone, not `==`, `<=`, `>=`, `~=` or `!=`
	// Index groups may nest one level (x(f(1)) = 2) but never run past their closing parenthesis
	const assign = new RegExp(`${id}(?:\\s*\\.\\s*\\w+|\\s*\\((?:[^()]|\\([^()]*\\))*\\))*\\s*(?<![<>=!~])=(?!=)`);
	const a = assign.exec(code);
	if (a) { return a.index; }

	const brackets = /\[([^\]]*)\]\s*=(?!=)/g;
	let b: RegExpExecArray | null;
	while ((b = brackets.exec(code)) !== null) {
		const inner = wordRe(name).exec(b[1]);
		if (inner) { return b.index + 1 + inner.index; }
	}

	const decl = /\b(?:global|persistent)\s+([^;,]*)/.exec(code);
	if (decl && wordRe(name).test(decl[1])) {
		return decl.index + decl[0].search(wordRe(name));
	}

	const sym = /(?:^|[;,])\s*syms\s+([^;,]*)/.exec(code);
	if (sym && sym[1].split(/\s+/).some(t => t.replace(/\(.*$/, '') === name && !SYM_ASSUMPTIONS.has(name))) {
		return sym.index + sym[0].search(wordRe(name));
	}

	const c = /^\s*catch\s+([A-Za-z_]\w*)\s*$/.exec(code);
	if (c && c[1] === name) { return code.search(wordRe(name)); }

	return undefined;
}

/** First definition of every variable visible at `line`, by name. */
function scopeDefinitions(document: vscode.TextDocument, line: number): Map<string, VariablePosition> {
	const lines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) { lines.push(document.lineAt(i).text); }
	const analysis = analyze(lines);
	const last = Math.min(line, lines.length - 1);
	const scope = last >= 0 ? analysis.scopeOf[last] : -1;
	const defs = new Map<string, VariablePosition>();

	// Parameters and outputs are defined by the header, before the body
	if (scope >= 0) {
		const f = analysis.frames[scope];
		for (const name of [...f.outputs, ...f.params]) {
			const m = wordRe(name).exec(lines[f.line]);
			if (m && !defs.has(name)) { defs.set(name, { line: f.line, character: m.index }); }
		}
	}

	for (let i = 0; i <= last; i++) {
		if (analysis.scopeOf[i] !== scope) { continue; }
		const names = new Set<string>();
		const ident = /[A-Za-z_]\w*/g;
		let m: RegExpExecArray | null;
		while ((m = ident.exec(analysis.code[i])) !== null) {
			if (!KEYWORDS.has(m[0])) { names.add(m[0]); }
		}
		for (const name of names) {
			if (defs.has(name)) { continue; }
			const col = definitionColumn(analysis.code[i], name);
			if (col !== undefined) { defs.set(name, { line: i, character: col }); }
		}
	}
	return defs;
}

/** An identifier in code, classified for semantic highlighting. */
export interface CodeIdentifier {
	line: number;
	character: number;
	name: string;
	/** 'parameter' for function inputs/outputs, 'variable' for other definitions, else undefined. */
	variable?: 'variable' | 'parameter';
	/** True on the `function` line for the function's own name. */
	declaration: boolean;
	/** True for the words after a command-syntax call (`pkg load control`, `hold on`). */
	commandArg: boolean;
}

/**
 * Every identifier outside strings and comments, in one pass over the
 * document, with the same variable rules as findVariable: a name is a
 * variable from its first definition in the scope onwards.
 */
export function codeIdentifiers(document: vscode.TextDocument): CodeIdentifier[] {
	const lines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) { lines.push(document.lineAt(i).text); }
	const analysis = analyze(lines);
	const scopes = new Map<number, Map<string, 'variable' | 'parameter'>>();
	const scopeDefs = (scope: number): Map<string, 'variable' | 'parameter'> => {
		let defs = scopes.get(scope);
		if (!defs) {
			defs = new Map();
			if (scope >= 0) {
				const f = analysis.frames[scope];
				for (const name of [...f.outputs, ...f.params]) { defs.set(name, 'parameter'); }
			}
			scopes.set(scope, defs);
		}
		return defs;
	};

	const out: CodeIdentifier[] = [];
	const ident = /[A-Za-z_]\w*/g;
	for (let i = 0; i < lines.length; i++) {
		const code = analysis.code[i];
		const defs = scopeDefs(analysis.scopeOf[i]);
		const found: { name: string; character: number }[] = [];
		let m: RegExpExecArray | null;
		ident.lastIndex = 0;
		while ((m = ident.exec(code)) !== null) {
			// Skip keywords, field access (s.name) and number suffixes (1e3)
			if (KEYWORDS.has(m[0])) { continue; }
			const before = code.slice(0, m.index).replace(/\s+$/, '');
			if (before.endsWith('.') && !before.endsWith('..')) { continue; }
			if (/[0-9.]$/.test(code.slice(0, m.index))) { continue; }
			found.push({ name: m[0], character: m.index });
		}
		for (const name of new Set(found.map(f => f.name))) {
			if (!defs.has(name) && definitionColumn(code, name) !== undefined) { defs.set(name, 'variable'); }
		}
		const header = /^\s*function\b/.test(code) ? parseHeader(code) : undefined;
		// Command syntax: a word followed by a space and a bare word, e.g. `pkg load control`
		const command = /^\s*([A-Za-z_]\w*)\s+[A-Za-z_'"-]/.exec(code);
		const commandEnd = command && !KEYWORDS.has(command[1]) && !defs.has(command[1])
			? command[0].length - 1 : -1;
		for (const f of found) {
			const declaration = header !== undefined && header.name === f.name;
			out.push({
				line: i, character: f.character, name: f.name,
				variable: declaration ? undefined : defs.get(f.name), declaration,
				commandArg: commandEnd >= 0 && f.character >= commandEnd,
			});
		}
	}
	return out;
}

/**
 * First definition of a variable in the scope of `line` (the enclosing
 * function, or the script outside functions), at or before that line.
 */
export function findVariable(document: vscode.TextDocument, name: string, line: number): VariablePosition | undefined {
	return scopeDefinitions(document, line).get(name);
}

/** True if the column is inside a string or a comment of the line. */
function inStringOrComment(line: string, character: number): boolean {
	// A letter after the prefix is blanked only when the prefix ends in a string or comment
	return codeOf(line.slice(0, character) + 'a').endsWith(' ');
}

/** Signature as shown in hovers: `[a, b] = f(x)`, `y = f(x)` or `f(x)`. */
function signatureOf(fn: UserFunction): string {
	if (fn.isScript) { return fn.name; }
	const call = `${fn.name}(${fn.params.join(', ')})`;
	if (fn.outputs.length === 0) { return call; }
	if (fn.outputs.length === 1) { return `${fn.outputs[0]} = ${call}`; }
	return `[${fn.outputs.join(', ')}] = ${call}`;
}

/** Functions from the same file first, then from the same folder, then the rest. */
function byPreference(list: UserFunction[], from: vscode.Uri): UserFunction[] {
	const rank = (f: UserFunction): number => {
		if (f.uri.toString() === from.toString()) { return 0; }
		return path.dirname(f.uri.fsPath) === path.dirname(from.fsPath) ? 1 : 2;
	};
	return [...list].sort((a, b) => rank(a) - rank(b));
}

/** Escapes Markdown characters in a file name shown inside emphasis. */
function escapeMd(s: string): string {
	return s.replace(/[\\`*_[\]<]/g, '\\$&');
}

/** Appends help text, keeping its line breaks. */
function appendHelp(md: vscode.MarkdownString, text: string): void {
	// appendText would turn every space into &nbsp;, which stops long lines from wrapping
	md.appendMarkdown(text.split('\n').map(escapeMd).join('  \n'));
}

/** Go to definition: a local variable first, then the user's functions. */
export class OctaveDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private index: WorkspaceIndex) {}

	provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
		if (!range) { return []; }
		const word = document.getText(range);
		if (KEYWORDS.has(word) || inStringOrComment(document.lineAt(position.line).text, position.character)) {
			return [];
		}

		const local = findVariable(document, word, position.line);
		if (local) {
			return [new vscode.Location(document.uri, new vscode.Position(local.line, local.character))];
		}
		return byPreference(this.index.lookup(word), document.uri)
			.map(f => new vscode.Location(f.uri, new vscode.Position(f.line, 0)));
	}
}

/** Hover for a user function: signature, help and where it is defined. */
export function userFunctionHover(index: WorkspaceIndex, document: vscode.TextDocument,
	position: vscode.Position, word: string): vscode.Hover | undefined {
	if (KEYWORDS.has(word) || inStringOrComment(document.lineAt(position.line).text, position.character)) {
		return undefined;
	}
	const fns = byPreference(index.lookup(word), document.uri);
	if (fns.length === 0) { return undefined; }

	const [main, ...others] = fns;
	const md = new vscode.MarkdownString();
	md.appendCodeblock(signatureOf(main), 'octave');
	if (main.help !== '') {
		md.appendMarkdown('\n\n');
		appendHelp(md, main.help);
	}
	const where = (f: UserFunction): string =>
		`${escapeMd(vscode.workspace.asRelativePath(f.uri, false))}:${f.line + 1}`;
	md.appendMarkdown(`\n\n*Defined in ${where(main)}*`);
	for (const f of others) {
		md.appendMarkdown(`\n\n*Also defined in ${where(f)}*`);
	}
	const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
	return new vscode.Hover(md, range);
}

/** Hover for a local variable: its name and the line that defines it. */
export function variableHover(document: vscode.TextDocument, position: vscode.Position,
	word: string): vscode.Hover | undefined {
	if (KEYWORDS.has(word) || inStringOrComment(document.lineAt(position.line).text, position.character)) {
		return undefined;
	}
	const def = findVariable(document, word, position.line);
	if (!def) { return undefined; }
	const md = new vscode.MarkdownString();
	md.appendCodeblock(`(variable) ${word}`, 'octave');
	md.appendMarkdown(`\n*Defined at line ${def.line + 1}*`);
	const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
	return new vscode.Hover(md, range);
}

function escapeSnippet(s: string): string {
	return s.replace(/[\\$}]/g, '\\$&');
}

/** Snippet with the parameters as tab stops: `f(${1:a}, ${2:b})`. */
function snippetOf(fn: UserFunction): string {
	if (fn.isScript || fn.params.length === 0) { return fn.name; }
	const holes = fn.params.map((p, i) => `\${${i + 1}:${escapeSnippet(p)}}`);
	return `${fn.name}(${holes.join(', ')})`;
}

/** Completion of the user's functions and of the variables defined earlier in the scope. */
export class UserCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private index: WorkspaceIndex) {}

	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
		if (inStringOrComment(document.lineAt(position.line).text, position.character)) { return []; }
		const items: vscode.CompletionItem[] = [];

		const seen = new Set<string>();
		for (const fn of byPreference(this.index.all(), document.uri)) {
			if (seen.has(fn.name)) { continue; }
			seen.add(fn.name);
			const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
			item.insertText = new vscode.SnippetString(snippetOf(fn));
			item.detail = signatureOf(fn);
			if (fn.help !== '') {
				const doc = new vscode.MarkdownString();
				appendHelp(doc, fn.help);
				item.documentation = doc;
			}
			items.push(item);
		}

		for (const [name, def] of scopeDefinitions(document, position.line)) {
			const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
			item.detail = `variable, defined at line ${def.line + 1}`;
			items.push(item);
		}
		return items;
	}
}
