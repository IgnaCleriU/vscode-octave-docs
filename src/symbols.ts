import * as vscode from 'vscode';

/** Keywords that open a block closed by one of CLOSERS. */
const OPENERS = new Set([
	'if', 'for', 'parfor', 'while', 'switch', 'try', 'do', 'unwind_protect',
	'function', 'classdef', 'methods', 'properties', 'events', 'enumeration',
]);

/** Keywords that close a block (`until` closes `do`). */
const CLOSERS = new Set([
	'end', 'endif', 'endfor', 'endparfor', 'endwhile', 'endswitch', 'end_try_catch',
	'end_unwind_protect', 'endfunction', 'endclassdef', 'endmethods', 'endproperties',
	'endevents', 'endenumeration', 'until',
]);

/** Classdef sections: they open a block but are not symbols themselves. */
const SECTIONS = new Set(['methods', 'properties', 'events', 'enumeration']);

/** A block (function, classdef, control structure...) with its first and last line, 0-based. */
interface Block {
	keyword: string;
	start: number;
	end: number;
	/** Trimmed text of the opening line. */
	header: string;
	/** Innermost enclosing function or classdef, if any. */
	parent?: Block;
}

/** A `%%` cell; it lasts until the line before the next cell. */
interface Cell {
	line: number;
	end: number;
	title: string;
}

interface Analysis {
	lines: string[];
	/** Each line with strings and comments blanked out. */
	code: string[];
	blocks: Block[];
	cells: Cell[];
	/** Pairs of first and last line of each %{ %} block comment. */
	blockComments: Array<[number, number]>;
}

interface Token {
	word: string;
	line: number;
	/** Code after the keyword on the same line. */
	rest: string;
}

/** Returns the lines of an open document. */
function readLines(document: vscode.TextDocument): string[] {
	const lines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) {
		lines.push(document.lineAt(i).text);
	}
	return lines;
}

/** Index just after the string literal starting at `start` (runs to end of line if unterminated). */
function stringEnd(text: string, start: number): number {
	const quote = text[start];
	let j = start + 1;
	while (j < text.length) {
		if (quote === '"' && text[j] === '\\') {
			j += 2;
			continue;
		}
		if (text[j] === quote) {
			if (text[j + 1] === quote) {
				j += 2;
				continue;
			}
			return j + 1;
		}
		j++;
	}
	return text.length;
}

/** Returns the code of a line: strings and the comment tail removed. */
function blankLine(text: string): string {
	let out = '';
	let k = 0;
	while (k < text.length) {
		const c = text[k];
		if (c === '%' || c === '#') {
			break;
		}
		// A quote after an identifier, `)`, `]`, `}`, `.` or another quote is a transpose, not a string.
		const transpose = c === '\'' && k > 0 && /[\w)\]}.']/.test(text[k - 1]);
		if (c === '"' || (c === '\'' && !transpose)) {
			k = stringEnd(text, k);
			out += ' ';
			continue;
		}
		out += c;
		k++;
	}
	return out;
}

/** Collects keyword tokens that start a statement (outside brackets) and the block comments. */
function scanCode(lines: string[]): { code: string[]; blockComments: Array<[number, number]> } {
	const code: string[] = [];
	const blockComments: Array<[number, number]> = [];
	let blockStart = -1;
	lines.forEach((text, i) => {
		const trimmed = text.trim();
		if (blockStart >= 0) {
			code.push('');
			if (/^[%#]\}$/.test(trimmed)) {
				blockComments.push([blockStart, i]);
				blockStart = -1;
			}
		} else if (/^[%#]\{$/.test(trimmed)) {
			blockStart = i;
			code.push('');
		} else {
			code.push(blankLine(text));
		}
	});
	return { code, blockComments };
}

/** Keywords that start a statement, at bracket depth 0 (`s.end` and `x(end)` are not keywords). */
function tokenize(code: string[]): Token[] {
	const tokens: Token[] = [];
	let depth = 0;
	let continuing = false;
	code.forEach((s, line) => {
		if (!continuing) {
			depth = 0;
		}
		let prev = '';
		let prevElse = false;
		let k = 0;
		while (k < s.length) {
			const c = s[k];
			if (/\s/.test(c)) {
				k++;
				continue;
			}
			if (/[A-Za-z_]/.test(c)) {
				let e = k;
				while (e < s.length && /\w/.test(s[e])) {
					e++;
				}
				const word = s.slice(k, e);
				// `else if` opens a nested block, so `if` after `else` also starts a statement.
				const atStart = depth === 0 && (prev === '' || prev === ';' || prev === ',' || prevElse);
				if (atStart && (OPENERS.has(word) || CLOSERS.has(word))) {
					tokens.push({ word, line, rest: s.slice(e) });
				}
				prevElse = word === 'else';
				prev = 'a';
				k = e;
				continue;
			}
			if (c === '(' || c === '[' || c === '{') {
				depth++;
			} else if (c === ')' || c === ']' || c === '}') {
				depth = Math.max(0, depth - 1);
			}
			prev = c;
			prevElse = false;
			k++;
		}
		continuing = /\.\.\.\s*$/.test(s);
	});
	return tokens;
}

/** True if an opener token really opens a block (`methods` is also a plain identifier, e.g. `methods = 3`). */
function isBlockOpener(t: Token): boolean {
	if (!OPENERS.has(t.word)) {
		return false;
	}
	if (!SECTIONS.has(t.word)) {
		return true;
	}
	const rest = t.rest.trim();
	return rest === '' || (rest[0] === '(' && !/^\([^)]*\)\s*[=(.]/.test(rest));
}

/** Innermost function or classdef in the stack, skipping control blocks and sections. */
function containerOf(stack: Block[]): Block | undefined {
	for (let i = stack.length - 1; i >= 0; i--) {
		if (stack[i].keyword === 'function' || stack[i].keyword === 'classdef') {
			return stack[i];
		}
	}
	return undefined;
}

/**
 * Matches each opener with its closer. If the file has more openers than closers,
 * some functions have no `end`: such a function lasts until the next `function`.
 */
function parseBlocks(tokens: Token[], lines: string[]): Block[] {
	const valid = tokens.filter(t => CLOSERS.has(t.word) || isBlockOpener(t));
	let openers = 0;
	let closers = 0;
	for (const t of valid) {
		if (CLOSERS.has(t.word)) {
			closers++;
		} else {
			openers++;
		}
	}
	const implicitFunctions = openers > closers;

	const stack: Block[] = [];
	const blocks: Block[] = [];
	for (const t of valid) {
		if (CLOSERS.has(t.word)) {
			const closed = stack.pop();
			if (closed) {
				closed.end = t.line;
			}
			continue;
		}
		const top = stack[stack.length - 1];
		if (t.word === 'function' && implicitFunctions && top && top.keyword === 'function') {
			top.end = Math.max(top.start, t.line - 1);
			stack.pop();
		}
		const block: Block = {
			keyword: t.word,
			start: t.line,
			end: t.line,
			header: lines[t.line].trim(),
			parent: containerOf(stack),
		};
		stack.push(block);
		blocks.push(block);
	}
	// Blocks never closed run to the end of the file.
	for (const b of stack) {
		b.end = lines.length - 1;
	}
	return blocks;
}

/** Scans the document into blocks, cells and block comments. */
function analyze(lines: string[]): Analysis {
	const scanned = scanCode(lines);
	const blocks = parseBlocks(tokenize(scanned.code), lines);

	const cellLines: number[] = [];
	lines.forEach((text, i) => {
		if (/^\s*%%(\s|$)/.test(text) && !isInBlockComment(scanned.blockComments, i)) {
			cellLines.push(i);
		}
	});
	const cells: Cell[] = cellLines.map((line, n) => {
		const next = n + 1 < cellLines.length ? cellLines[n + 1] - 1 : lines.length - 1;
		const title = lines[line].replace(/^\s*%%/, '').trim();
		return { line, end: Math.max(line, next), title: title || `Cell at line ${line + 1}` };
	});

	return { lines, code: scanned.code, blocks, cells, blockComments: scanned.blockComments };
}

function isInBlockComment(blockComments: Array<[number, number]>, line: number): boolean {
	return blockComments.some(([s, e]) => line >= s && line <= e);
}

/** Name of a function from its signature, e.g. `function [a, b] = name(x)`. */
function functionName(header: string): string {
	const m = /^function\b\s*(?:(?:\[[^\]]*\]|[A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)/.exec(header);
	return m ? m[1] : header;
}

/** Name of a classdef from its header, e.g. `classdef (Abstract) Name < handle`. */
function classdefName(header: string): string {
	const m = /^classdef\b\s*(?:\([^)]*\))?\s*([A-Za-z_]\w*)/.exec(header);
	return m ? m[1] : header;
}

/** Range covering whole lines `start` to `end`. */
function linesRange(lines: string[], start: number, end: number): vscode.Range {
	return new vscode.Range(start, 0, end, lines[end].length);
}

/**
 * Document symbols for Octave: functions (nested ones as children), classdef with its
 * methods and properties, and `%%` cells as namespaces.
 */
export class OctaveDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

	/** Returns the symbol tree of the document, sorted by line. */
	public provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
		const a = analyze(readLines(document));
		const topLevel: Array<{ line: number; symbol: vscode.DocumentSymbol }> = [];
		const symbolOf = new Map<Block, vscode.DocumentSymbol>();

		for (const b of a.blocks) {
			const isFunction = b.keyword === 'function';
			if (isFunction || b.keyword === 'classdef') {
				const symbol = new vscode.DocumentSymbol(
					isFunction ? functionName(b.header) : classdefName(b.header),
					b.header,
					isFunction ? vscode.SymbolKind.Function : vscode.SymbolKind.Class,
					linesRange(a.lines, b.start, b.end),
					linesRange(a.lines, b.start, b.start),
				);
				symbolOf.set(b, symbol);
				if (b.parent) {
					symbolOf.get(b.parent)!.children.push(symbol);
				} else {
					topLevel.push({ line: b.start, symbol });
				}
			} else if (b.keyword === 'properties' || b.keyword === 'enumeration') {
				// Members are listed as children of the classdef that holds the section.
				const owner = b.parent ? symbolOf.get(b.parent) : undefined;
				if (!owner) {
					continue;
				}
				const kind = b.keyword === 'properties' ? vscode.SymbolKind.Property : vscode.SymbolKind.EnumMember;
				for (let l = b.start + 1; l < b.end; l++) {
					const m = /^\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(a.code[l]);
					if (m) {
						owner.children.push(new vscode.DocumentSymbol(
							m[1], '', kind, linesRange(a.lines, l, l), linesRange(a.lines, l, l),
						));
					}
				}
			}
		}

		for (const c of a.cells) {
			topLevel.push({
				line: c.line,
				symbol: new vscode.DocumentSymbol(
					c.title, '', vscode.SymbolKind.Namespace,
					linesRange(a.lines, c.line, c.end), linesRange(a.lines, c.line, c.line),
				),
			});
		}

		topLevel.sort((x, y) => x.line - y.line);
		return topLevel.map(entry => entry.symbol);
	}

}

/**
 * Folding ranges for Octave: keyword blocks up to their closing `end`,
 * `%{ %}` block comments and `%%` cells.
 */
export class OctaveFoldingRangeProvider implements vscode.FoldingRangeProvider {

	/** Returns the folding ranges of the document. */
	public provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
		const a = analyze(readLines(document));
		const ranges: vscode.FoldingRange[] = [];
		for (const b of a.blocks) {
			if (b.end > b.start) {
				ranges.push(new vscode.FoldingRange(b.start, b.end));
			}
		}
		for (const [start, end] of a.blockComments) {
			if (end > start) {
				ranges.push(new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Comment));
			}
		}
		for (const c of a.cells) {
			if (c.end > c.line) {
				ranges.push(new vscode.FoldingRange(c.line, c.end, vscode.FoldingRangeKind.Region));
			}
		}
		return ranges;
	}

}
