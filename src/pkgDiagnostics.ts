import * as vscode from 'vscode';
import { DocEntry, KEYWORDS, OctaveDocs } from './hover';

const COLLECTION = 'octave-pkg';
const SOURCE = 'octave-docs';
const CODE = 'missing-pkg-load';
const DEBOUNCE_MS = 300;
const SETTING = 'octaveDocs.diagnostics.pkgLoad';

/** Packages whose functions need an explicit `pkg load`. */
const PACKAGES = new Set(['control', 'symbolic']);

/** Lines that may come before `pkg load` at the top of a file. */
const LEADING_COMMAND = /^(?:clear|clc|close all|clear all)\s*;?$/;

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=']);
const TWO_CHAR_OPS = new Set(['==', '~=', '!=', '<=', '>=', '+=', '-=', '*=', '/=']);

/** A name used in a file that needs a package the file does not load. */
export interface MissingPackage {
	name: string;
	pkg: string;
	/** 0-based line of the first occurrence. */
	line: number;
	/** 0-based column of the first occurrence. */
	character: number;
}

interface Token {
	kind: 'ident' | 'string' | 'number' | 'punct';
	value: string;
	line: number;
	col: number;
	/** Source character right before the token ('' at the start of a line). */
	prev: string;
}

/** Finds the functions of control and symbolic used without loading their package. */
export function findMissingPackages(text: string, docs: OctaveDocs): MissingPackage[] {
	return analyse(text, docs).missing;
}

/** Splits a file into tokens, leaving out comments, block comments and continuations. */
function tokenize(lines: string[]): Token[] {
	const tokens: Token[] = [];
	let depth = 0;
	lines.forEach((src, line) => {
		const t = src.trim();
		if (depth === 0 && /^[%#]\{$/.test(t)) { depth = 1; return; }
		if (depth > 0) {
			if (/^[%#]\{$/.test(t)) { depth++; } else if (/^[%#]\}$/.test(t)) { depth--; }
			return;
		}
		lexLine(src, line, tokens);
	});
	return tokens;
}

function lexLine(src: string, line: number, out: Token[]): void {
	const push = (kind: Token['kind'], value: string, col: number) =>
		out.push({ kind, value, line, col, prev: col > 0 ? src[col - 1] : '' });
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '%' || c === '#' || src.startsWith('...', i)) { break; }
		if (/\s/.test(c)) { i++; continue; }
		const prev = i > 0 ? src[i - 1] : '';
		// An apostrophe after an identifier, ), ], }, . or ' is a transpose
		if (c === '"' || (c === "'" && !/[\w)\]}.']/.test(prev))) {
			let j = i + 1;
			let value = '';
			while (j < src.length) {
				const d = src[j];
				if (c === '"' && d === '\\' && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
				if (d === c) {
					if (src[j + 1] === c) { value += c; j += 2; continue; }
					break;
				}
				value += d;
				j++;
			}
			push('string', value, i);
			i = j + 1;
			continue;
		}
		if (c === "'") { push('punct', c, i); i++; continue; }
		if (/[A-Za-z_]/.test(c)) {
			let j = i + 1;
			while (j < src.length && /\w/.test(src[j])) { j++; }
			push('ident', src.slice(i, j), i);
			i = j;
			continue;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			let j = i + 1;
			while (j < src.length && /[\w.]/.test(src[j])) { j++; }
			push('number', src.slice(i, j), i);
			i = j;
			continue;
		}
		const two = src.slice(i, i + 2);
		if (TWO_CHAR_OPS.has(two)) { push('punct', two, i); i += 2; continue; }
		push('punct', c, i);
		i++;
	}
}

/** Index of the token closing the bracket opened at `open`, or -1. */
function closeIndex(tokens: Token[], open: number, o: string, c: string): number {
	let depth = 0;
	for (let j = open; j < tokens.length; j++) {
		const t = tokens[j];
		if (t.kind !== 'punct') { continue; }
		if (t.value === o) {
			depth++;
		} else if (t.value === c && --depth === 0) {
			return j;
		}
	}
	return -1;
}

function isAssign(t: Token | undefined): boolean {
	return t !== undefined && t.kind === 'punct' && ASSIGN_OPS.has(t.value);
}

/**
 * Package a name needs, or undefined. Core Octave names never need one; a
 * name is taken from its plain functions or constructors when it has any,
 * else from all its entries (method-only names such as feedback or laplace).
 */
function packageOf(name: string, entries: DocEntry[]): string | undefined {
	if (entries.length === 0 || entries.some(e => e.package === 'octave')) { return undefined; }
	const top = entries.filter(e => e.class === '' || e.class === name);
	const base = top.length > 0 ? top : entries;
	const pkgs = new Set(base.map(e => e.package));
	if (pkgs.size !== 1) { return undefined; }
	const [pkg] = pkgs;
	return PACKAGES.has(pkg) ? pkg : undefined;
}

/** Packages loaded by the file, the pkg statements and the lines they are on. */
function analyse(text: string, docs: OctaveDocs): { missing: MissingPackage[]; pkgLoadLines: number[] } {
	const tokens = tokenize(text.split(/\r?\n/));
	const skip = new Set<number>();
	const loaded = new Set<string>();
	const pkgLoadLines: number[] = [];

	// pkg load a b   and   pkg('load', 'a', {'b'})
	tokens.forEach((t, i) => {
		if (t.kind !== 'ident' || t.value !== 'pkg') { return; }
		const next = tokens[i + 1];
		if (next && next.kind === 'ident' && next.value === 'load' && next.line === t.line) {
			skip.add(i);
			skip.add(i + 1);
			let j = i + 2;
			while (j < tokens.length && tokens[j].kind === 'ident' && tokens[j].line === t.line) {
				loaded.add(tokens[j].value);
				skip.add(j);
				j++;
			}
			pkgLoadLines.push(t.line);
		} else if (next && next.value === '(' && tokens[i + 2] && tokens[i + 2].kind === 'string' &&
			tokens[i + 2].value === 'load') {
			let j = i + 3;
			for (; j < tokens.length && tokens[j].line === t.line; j++) {
				if (tokens[j].kind === 'punct' && tokens[j].value === ')') { break; }
				if (tokens[j].kind === 'string') { loaded.add(tokens[j].value); }
			}
			for (let k = i; k <= j && k < tokens.length; k++) { skip.add(k); }
			pkgLoadLines.push(t.line);
		}
	});

	const assigned = new Set<string>();
	const seen = new Set<string>();
	const missing: MissingPackage[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (skip.has(i)) { continue; }

		// [a, b] = ...  assigns every name inside the brackets
		if (t.kind === 'punct' && t.value === '[') {
			const close = closeIndex(tokens, i, '[', ']');
			if (close > 0 && isAssign(tokens[close + 1])) {
				for (let j = i + 1; j < close; j++) {
					if (tokens[j].kind === 'ident') { assigned.add(tokens[j].value); }
				}
			}
			continue;
		}
		if (t.kind !== 'ident' || t.prev === '.') { continue; }

		// Names in a function line are its parameters and outputs
		if (t.value === 'function') {
			for (let j = i + 1; j < tokens.length && tokens[j].line === t.line; j++) {
				if (tokens[j].kind === 'ident') { assigned.add(tokens[j].value); }
			}
			continue;
		}
		if (KEYWORDS.has(t.value)) { continue; }

		// x = ...,  x += ...,  x(i) = ...,  x{i} = ...
		const next = tokens[i + 1];
		if (isAssign(next)) { assigned.add(t.value); continue; }
		if (next && next.kind === 'punct' && (next.value === '(' || next.value === '{')) {
			const close = closeIndex(tokens, i + 1, next.value, next.value === '(' ? ')' : '}');
			if (close > 0 && isAssign(tokens[close + 1])) { assigned.add(t.value); continue; }
		}
		if (assigned.has(t.value)) { continue; }

		const pkg = packageOf(t.value, docs.lookup(t.value));
		if (!pkg || loaded.has(pkg) || seen.has(t.value)) { continue; }
		seen.add(t.value);
		missing.push({ name: t.value, pkg, line: t.line, character: t.col });
	}
	return { missing, pkgLoadLines };
}

function messageFor(name: string, pkg: string): string {
	return `\`${name}\` is in the ${pkg} package: add \`pkg load ${pkg}\``;
}

/** Package named in a diagnostic message made by messageFor. */
function pkgOf(d: vscode.Diagnostic): string | undefined {
	const m = /`pkg load (\w+)`$/.exec(d.message);
	return m ? m[1] : undefined;
}

function diagnosticsFor(document: vscode.TextDocument, docs: OctaveDocs): vscode.Diagnostic[] {
	return analyse(document.getText(), docs).missing.map(m => {
		const range = new vscode.Range(m.line, m.character, m.line, m.character + m.name.length);
		const d = new vscode.Diagnostic(range, messageFor(m.name, m.pkg), vscode.DiagnosticSeverity.Warning);
		d.source = SOURCE;
		d.code = CODE;
		return d;
	});
}

/**
 * Line where a new pkg load goes: after the last existing one, else after the
 * initial block of blank lines, comments and clear/clc/close commands.
 */
function insertionLine(lines: string[], pkgLoadLines: number[]): number {
	if (pkgLoadLines.length > 0) { return pkgLoadLines[pkgLoadLines.length - 1] + 1; }
	let i = 0;
	while (i < lines.length) {
		const t = lines[i].trim();
		if (/^[%#]\{$/.test(t)) {
			i++;
			while (i < lines.length && !/^[%#]\}$/.test(lines[i].trim())) { i++; }
			i++;
			continue;
		}
		if (t === '' || t.startsWith('%') || t.startsWith('#') || LEADING_COMMAND.test(t)) {
			i++;
			continue;
		}
		break;
	}
	return Math.min(i, lines.length);
}

function insertPkgLoad(document: vscode.TextDocument, pkgLoadLines: number[], pkgs: string[]): vscode.WorkspaceEdit {
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const body = pkgs.map(p => `pkg load ${p}`).join(eol);
	const line = insertionLine(document.getText().split(/\r?\n/), pkgLoadLines);
	const edit = new vscode.WorkspaceEdit();
	if (line < document.lineCount) {
		edit.insert(document.uri, new vscode.Position(line, 0), body + eol);
	} else {
		edit.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, eol + body);
	}
	return edit;
}

class PkgLoadFixProvider implements vscode.CodeActionProvider {
	constructor(private docs: OctaveDocs) {}

	provideCodeActions(document: vscode.TextDocument, _range: vscode.Range,
					context: vscode.CodeActionContext): vscode.CodeAction[] {
		const ours = context.diagnostics.filter(d => d.code === CODE && d.source === SOURCE);
		if (ours.length === 0) { return []; }

		const analysis = analyse(document.getText(), this.docs);
		const pkgs = [...new Set(analysis.missing.map(m => m.pkg))];
		const actions: vscode.CodeAction[] = [];

		for (const pkg of pkgs) {
			const related = ours.filter(d => pkgOf(d) === pkg);
			if (related.length === 0) { continue; }
			const action = new vscode.CodeAction(`Add \`pkg load ${pkg}\``, vscode.CodeActionKind.QuickFix);
			action.diagnostics = related;
			action.isPreferred = true;
			action.edit = insertPkgLoad(document, analysis.pkgLoadLines, [pkg]);
			actions.push(action);
		}

		if (pkgs.length > 1) {
			const all = new vscode.CodeAction('Add pkg load for all missing packages', vscode.CodeActionKind.QuickFix);
			all.diagnostics = ours;
			all.edit = insertPkgLoad(document, analysis.pkgLoadLines, pkgs);
			actions.push(all);
		}
		return actions;
	}
}

/** Warns about control/symbolic functions used without `pkg load` and offers quick fixes. */
export function registerPkgDiagnostics(context: vscode.ExtensionContext, docs: OctaveDocs): void {
	const collection = vscode.languages.createDiagnosticCollection(COLLECTION);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	const enabled = (): boolean =>
		vscode.workspace.getConfiguration('octaveDocs').get<boolean>('diagnostics.pkgLoad', true);

	const refresh = (document: vscode.TextDocument): void => {
		if (document.languageId !== 'octave') { return; }
		collection.set(document.uri, enabled() ? diagnosticsFor(document, docs) : []);
	};

	const cancel = (key: string): void => {
		const timer = timers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(key);
		}
	};

	const scheduleRefresh = (document: vscode.TextDocument): void => {
		if (document.languageId !== 'octave') { return; }
		const key = document.uri.toString();
		cancel(key);
		timers.set(key, setTimeout(() => {
			timers.delete(key);
			const current = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
			if (current) { refresh(current); }
		}, DEBOUNCE_MS));
	};

	for (const document of vscode.workspace.textDocuments) { refresh(document); }

	context.subscriptions.push(
		collection,
		{ dispose: () => timers.forEach(timer => clearTimeout(timer)) },
		vscode.workspace.onDidOpenTextDocument(refresh),
		vscode.workspace.onDidChangeTextDocument(e => scheduleRefresh(e.document)),
		vscode.workspace.onDidSaveTextDocument(document => {
			cancel(document.uri.toString());
			refresh(document);
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			cancel(document.uri.toString());
			collection.delete(document.uri);
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(SETTING)) { return; }
			for (const document of vscode.workspace.textDocuments) { refresh(document); }
		}),
		vscode.languages.registerCodeActionsProvider({ language: 'octave' }, new PkgLoadFixProvider(docs), {
			providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
		}),
	);
}
