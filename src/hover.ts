import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Una función o método documentado en docs/octave-docs.json. */
interface DocEntry {
	name: string;
	/** Clase del método (sym, tf, lti, ...) o "" si es una función común. */
	class: string;
	/** Paquete de origen: control, symbolic u octave. */
	package: string;
	/** Ayuda ya renderizada a texto plano, tal como la muestra `help`. */
	text: string;
}

interface DocIndex {
	octaveVersion: string;
	generated: string;
	entries: DocEntry[];
}

export const HELP_SCHEME = 'octave-help';
export const SHOW_HELP_COMMAND = 'octaveDocs.showFullHelp';

/** Líneas de la ayuda que se muestran en el hover antes de cortar. */
const MAX_HOVER_LINES = 30;

/** Palabras reservadas: no tienen sentido como hover aunque tengan ayuda. */
const KEYWORDS = new Set([
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

	lookup(name: string): DocEntry[] {
		return this.byName.get(name) ?? [];
	}

	find(name: string, cls: string): DocEntry | undefined {
		return this.lookup(name).find(e => e.class === cls);
	}
}

/**
 * Orden de preferencia cuando un nombre tiene varias entradas: primero las
 * funciones de los paquetes, después las de Octave y al final los métodos
 * de clase (que suelen ser sobrecargas de las anteriores).
 */
function rank(e: DocEntry): number {
	if (e.class === '') {
		return e.package === 'octave' ? 1 : 0;
	}
	return 2;
}

function qualifiedName(e: DocEntry): string {
	// El constructor de una clase (@tf/tf) se muestra solo con su nombre
	return e.class && e.class !== e.name ? `@${e.class}/${e.name}` : e.name;
}

/** Firmas de una entrada: las líneas que empiezan con " -- ". */
function signatures(e: DocEntry): string[] {
	return e.text.split('\n').filter(l => l.startsWith(' -- ')).map(l => l.trim());
}

function helpUri(e: DocEntry): vscode.Uri {
	const cls = e.class || '_';
	return vscode.Uri.from({ scheme: HELP_SCHEME, path: `/${cls}/${e.name}.txt` });
}

function commandLink(label: string, e: DocEntry): string {
	const args = encodeURIComponent(JSON.stringify([e.name, e.class]));
	return `[${label}](command:${SHOW_HELP_COMMAND}?${args})`;
}

/** true si la posición cae dentro de un comentario (% o #). */
function inComment(line: string, character: number): boolean {
	let quote: string | null = null;
	for (let i = 0; i < character && i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) { quote = null; }
		} else if (c === '"') {
			quote = c;
		} else if (c === "'") {
			// Apóstrofo después de identificador, ) o ] es transpuesta, no string
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

		md.appendMarkdown(`**${qualifiedName(main)}** — paquete \`${main.package}\`\n\n`);

		const lines = main.text.split('\n');
		const shown = lines.slice(0, MAX_HOVER_LINES).join('\n');
		md.appendCodeblock(shown, 'text');
		const more = lines.length > MAX_HOVER_LINES ? ' (continúa)' : '';
		md.appendMarkdown(`\n${commandLink('Ver ayuda completa' + more, main)}\n`);

		if (others.length > 0) {
			md.appendMarkdown('\n---\n\n**También definida como:**\n\n');
			for (const e of others) {
				const sig = signatures(e)[0] ?? '';
				md.appendMarkdown(`- ${commandLink(qualifiedName(e), e)} (\`${e.package}\`)`);
				if (sig) { md.appendMarkdown(` — \`${sig.replace(/`/g, "'")}\``); }
				md.appendMarkdown('\n');
			}
		}

		return new vscode.Hover(md, range);
	}
}

/** Sirve la ayuda completa como documento de solo lectura. */
export class OctaveHelpContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private docs: OctaveDocs) {}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const m = uri.path.match(/^\/([^/]+)\/(.+)\.txt$/);
		if (!m) { return ''; }
		const cls = m[1] === '_' ? '' : m[1];
		const e = this.docs.find(m[2], cls);
		if (!e) { return `No hay ayuda para ${m[2]}.`; }
		return `${qualifiedName(e)}  [${e.package}]\n\n${e.text}\n`;
	}
}

export async function showFullHelp(name: string, cls: string): Promise<void> {
	const uri = helpUri({ name, class: cls, package: '', text: '' });
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}
