import * as vscode from 'vscode';
import { formatSignature, inComment, KEYWORDS, OctaveDocs, signatures } from './hover';
import { parseSignature, summary } from './completion';

/** Characters that open the signature popup when typed. */
export const SIGNATURE_TRIGGERS = ['(', ','];
/** Characters that refresh the popup, or hide it, when typed. */
export const SIGNATURE_RETRIGGERS = [')'];

/** An open bracket found while scanning the text before the cursor. */
interface OpenBracket {
	ch: string;
	/** Index of the bracket in the scanned text. */
	pos: number;
	/** Top-level commas seen directly inside this bracket. */
	commas: number;
	/** Index in the scanned text where the current argument starts. */
	argStart: number;
}

/** A call under the cursor: the function name, the active argument and its text so far. */
interface CallSite {
	name: string;
	index: number;
	typed: string;
}

/** A signature shown in the popup, with its argument names for fitting. */
interface Candidate {
	info: vscode.SignatureInformation;
	args: string[];
}

/**
 * Finds the innermost call that is still open at the end of `text`.
 * Returns undefined inside a string or comment, or outside any call.
 */
function callSite(text: string): CallSite | undefined {
	const stack: OpenBracket[] = [];
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\' && quote === '"') {
				i++;	// Escaped character in a double-quoted string
			} else if (c === quote) {
				if (text[i + 1] === quote) { i++; } else { quote = null; }
			}
		} else if (c === '"') {
			quote = c;
		} else if (c === "'") {
			// An apostrophe after an identifier, ), ], }, . or ' is a transpose
			const prev = text.slice(0, i).trimEnd().slice(-1);
			if (!/[\w)\]}.']/.test(prev)) { quote = c; }
		} else if (c === '%' || c === '#') {
			return undefined;
		} else if (c === '(' || c === '[' || c === '{') {
			stack.push({ ch: c, pos: i, commas: 0, argStart: i + 1 });
		} else if (c === ')' || c === ']' || c === '}') {
			stack.pop();
		} else if (c === ',' && stack.length > 0) {
			const top = stack[stack.length - 1];
			top.commas++;
			top.argStart = i + 1;
		}
	}
	if (quote) { return undefined; }

	// Innermost open parenthesis with a name; unnamed ones are grouping
	for (let k = stack.length - 1; k >= 0; k--) {
		const open = stack[k];
		if (open.ch !== '(') { continue; }
		const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, open.pos));
		if (m) { return { name: m[1], index: open.commas, typed: text.slice(open.argStart).trim() }; }
	}
	return undefined;
}

/**
 * The text of the statement up to the cursor. Lines ending in `...`
 * continue the statement, so they are joined in front of the cursor line.
 */
function statementText(document: vscode.TextDocument, position: vscode.Position): string {
	let text = document.lineAt(position.line).text.slice(0, position.character);
	for (let ln = position.line - 1; ln >= 0; ln--) {
		const prev = document.lineAt(ln).text.trimEnd();
		if (!prev.endsWith('...') || inComment(prev, prev.length - 3)) { break; }
		text = prev.slice(0, -3) + ' ' + text;
	}
	return text;
}

/** True if the argument list ends in a variadic `...` argument. */
function hasRest(args: string[]): boolean {
	return args.some(a => a.endsWith('...'));
}

/**
 * Position of `word` in `label` at or after `from`, as a whole word.
 * Returns -1 if it does not occur.
 */
function findWord(label: string, word: string, from: number): number {
	let at = label.indexOf(word, from);
	while (at >= 0) {
		const before = at > 0 ? label[at - 1] : ' ';
		const after = at + word.length < label.length ? label[at + word.length] : ' ';
		if (!/\w/.test(before) && !/\w/.test(after)) { return at; }
		at = label.indexOf(word, at + 1);
	}
	return -1;
}

/** Parameter ranges inside the label, found in order after its opening parenthesis. */
function parameters(label: string, args: string[]): vscode.ParameterInformation[] {
	let from = label.indexOf('(') + 1;
	return args.map(arg => {
		const word = arg.toLowerCase();
		const at = findWord(label, word, from);
		if (at < 0) { return new vscode.ParameterInformation(word); }
		from = at + word.length;
		return new vscode.ParameterInformation([at, from]);
	});
}

/** Signature help for function calls: shows the forms that match the typed arguments. */
export class OctaveSignatureHelpProvider implements vscode.SignatureHelpProvider {
	constructor(private docs: OctaveDocs) {}

	provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position,
						 _token: vscode.CancellationToken,
						 context: vscode.SignatureHelpContext): vscode.SignatureHelp | undefined {
		const site = callSite(statementText(document, position));
		if (!site || KEYWORDS.has(site.name)) { return undefined; }

		const candidates = this.candidates(site.name);
		if (candidates.length === 0) { return undefined; }

		// Forms that take a string literal are skipped when the argument is not one
		const typedQuoted = /^["']/.test(site.typed);
		const fits = (c: Candidate) => c.args.length > site.index || hasRest(c.args);
		const accepts = (c: Candidate) => fits(c) && (site.typed === '' || hasRest(c.args) ||
			/^["']/.test(c.args[site.index]) === typedQuoted);
		const previous = context.activeSignatureHelp?.activeSignature;
		let active = -1;
		if (previous !== undefined && candidates[previous] && accepts(candidates[previous])) {
			active = previous;
		} else {
			active = candidates.findIndex(accepts);
			if (active < 0) { active = candidates.findIndex(fits); }
		}
		if (active < 0) { active = 0; }

		const chosen = candidates[active];
		const last = chosen.args.length - 1;
		const param = hasRest(chosen.args) && site.index > last ? last : site.index;

		const help = new vscode.SignatureHelp();
		help.signatures = candidates.map(c => c.info);
		help.activeSignature = active;
		help.activeParameter = param;
		return help;
	}

	/** One entry per call form of `name` written in command-free syntax. */
	private candidates(name: string): Candidate[] {
		const result: Candidate[] = [];
		for (const e of this.docs.lookup(name)) {
			const doc = new vscode.MarkdownString();
			doc.appendMarkdown(summary(e) + `\n\n*\`${e.package}\`*`);
			for (const line of signatures(e)) {
				const form = parseSignature(name, line);
				if (!form || form.command) { continue; }
				const label = formatSignature(name, line);
				const info = new vscode.SignatureInformation(label, doc);
				info.parameters = parameters(label, form.args);
				result.push({ info, args: form.args });
			}
		}
		return result;
	}
}
