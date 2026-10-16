import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const TERMINAL_NAME = 'Octave';
/** MATLAB-style cell delimiter: `%%` followed by a space or end of line (`##` is a plain Octave comment). */
const CELL_RE = /^\s*%%(\s|$)/;

let octaveTerminal: vscode.Terminal | undefined;

/** Registers the commands that run Octave code in a terminal, and the section CodeLens. */
export function registerRunCommands(context: vscode.ExtensionContext): void {
	const lenses = new SectionLensProvider();
	context.subscriptions.push(
		vscode.window.onDidCloseTerminal(t => {
			if (t === octaveTerminal) { octaveTerminal = undefined; }
		}),
		vscode.commands.registerCommand('octaveDocs.runFile', runFile),
		vscode.commands.registerCommand('octaveDocs.runSelection', runSelection),
		vscode.commands.registerCommand('octaveDocs.runSection', runSection),
		vscode.languages.registerCodeLensProvider({ language: 'octave' }, lenses),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('octaveDocs.run.codeLens')) { lenses.refresh(); }
		}),
	);
}

/** Saves the active file if needed and runs it with Octave's run(), which cds to its folder. */
async function runFile(): Promise<void> {
	const doc = vscode.window.activeTextEditor?.document;
	if (!doc) { return; }
	if (doc.isUntitled) {
		vscode.window.showWarningMessage('Save the file before running it.');
		return;
	}
	if (doc.isDirty && !(await doc.save())) { return; }
	sendCommand(`run(${octaveString(doc.uri.fsPath)})`);
}

/** Runs the selected text, or the current line when the selection is empty. */
function runSelection(): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const sel = editor.selection;
	const code = sel.isEmpty
		? editor.document.lineAt(sel.active.line).text
		: editor.document.getText(sel);
	runCode(editor.document, code);
}

/**
 * Runs the cell containing a line. `line` is 0-based and `uri` identifies the
 * document; both come from the CodeLens. Without them, the cursor is used.
 */
async function runSection(line?: number, uri?: vscode.Uri): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
	if (!doc) { return; }
	const cursor = typeof line === 'number' ? line : (editor?.selection.active.line ?? 0);
	runCode(doc, doc.getText(sectionRange(doc, cursor)));
}

/** Range of the cell around `line`: from its delimiter (or file start) to the next one. */
function sectionRange(doc: vscode.TextDocument, line: number): vscode.Range {
	const isDelimiter = (i: number) => CELL_RE.test(doc.lineAt(i).text);
	let start = line;
	while (start > 0 && !isDelimiter(start)) { start--; }
	let end = start + 1;
	while (end < doc.lineCount && !isDelimiter(end)) { end++; }
	return doc.validateRange(new vscode.Range(start, 0, end, 0));
}

/** Writes the code to a temp file and sources it, so multi-line code keeps the workspace. */
function runCode(doc: vscode.TextDocument, code: string): void {
	if (code.trim() === '') { return; }
	const tmp = path.join(os.tmpdir(), 'octave-docs-run.m');
	fs.writeFileSync(tmp, code, 'utf8');
	const cd = doc.isUntitled ? '' : `cd(${octaveString(path.dirname(doc.uri.fsPath))}); `;
	sendCommand(`${cd}source(${octaveString(tmp)})`);
}

/** Shows the reused "Octave" terminal (created on first use) and sends a command to it. */
function sendCommand(command: string): void {
	if (!octaveTerminal || vscode.window.terminals.indexOf(octaveTerminal) < 0) {
		const shellPath = vscode.workspace.getConfiguration('octaveDocs').get<string>('octavePath', 'octave');
		octaveTerminal = vscode.window.createTerminal({
			name: TERMINAL_NAME,
			shellPath,
			shellArgs: ['--no-gui', '--quiet'],
		});
	}
	octaveTerminal.show(true);
	octaveTerminal.sendText(command, true);
}

/** Quotes a string as an Octave double-quoted literal (backslash and quote escaped). */
function octaveString(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** "▶ Run section" lens on each cell delimiter line. */
class SectionLensProvider implements vscode.CodeLensProvider {
	private changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;

	refresh(): void {
		this.changed.fire();
	}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		if (!vscode.workspace.getConfiguration('octaveDocs').get<boolean>('run.codeLens', true)) {
			return [];
		}
		const lenses: vscode.CodeLens[] = [];
		for (let i = 0; i < doc.lineCount; i++) {
			const line = doc.lineAt(i);
			if (!CELL_RE.test(line.text)) { continue; }
			lenses.push(new vscode.CodeLens(line.range, {
				title: '▶ Run section',
				command: 'octaveDocs.runSection',
				arguments: [i, doc.uri],
			}));
		}
		return lenses;
	}
}
