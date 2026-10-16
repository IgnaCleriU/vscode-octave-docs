import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Maximum time for one parse-only run of Octave, in milliseconds. */
const TIMEOUT_MS = 10000;

/**
 * Parses the file named by the OCT_PARSE_FILE environment variable without
 * running it. The path goes through the environment so quotes in file names
 * cannot break the code.
 */
const PARSE_CODE = '__parse_file__(getenv("OCT_PARSE_FILE"))';

/** Argument list that runs Octave quietly and without GUI or rc files. */
const OCTAVE_ARGS = ['--no-gui', '--quiet', '--no-window-system', '--norc', '--eval', PARSE_CODE];

/** A syntax error reported by Octave. Line is 1-based, column 1-based; 0 when unknown. */
export interface ParseError {
	message: string;
	line: number;
	column: number;
}

/** Set when Octave cannot be started; the check stays off for the session. */
let disabledForSession = false;

/** Octave processes still running, by document URI. */
const running = new Map<string, child_process.ChildProcess>();

/**
 * Extracts the syntax error from the output of __parse_file__, e.g.
 * "error: syntax error near line 7, column 3 in file /x/f.m".
 * Returns undefined when there is no syntax error in the output.
 */
export function parseSyntaxError(output: string): ParseError | undefined {
	const match = /(?:syntax|parse) error(?: near line (\d+)(?:, column (\d+))?)?/.exec(output);
	if (!match) { return undefined; }
	const line = match[1] ? parseInt(match[1], 10) : 0;
	const column = match[2] ? parseInt(match[2], 10) : 0;
	const message = output.slice(match.index).split('\n')[0].replace(/\s+in file .*$/, '').trim();
	return { message, line, column };
}

/** Builds the diagnostic for a parse error, clamped to the document's lines. */
function toDiagnostic(document: vscode.TextDocument, error: ParseError): vscode.Diagnostic {
	const index = Math.min(Math.max(error.line - 1, 0), document.lineCount - 1);
	const lineRange = document.lineAt(index).range;
	const length = lineRange.end.character;
	let range = lineRange;
	if (error.column > 0) {
		const start = Math.min(error.column - 1, Math.max(length - 1, 0));
		range = new vscode.Range(index, start, index, Math.max(length, start + 1));
	}
	const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
	diagnostic.source = 'octave';
	return diagnostic;
}

/** Writes an unsaved document to a temp dir under the same basename. */
function writeTemporaryCopy(document: vscode.TextDocument): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octave-syntax-'));
	let base = path.basename(document.fileName);
	if (!base.endsWith('.m')) { base += '.m'; }
	const file = path.join(dir, base);
	fs.writeFileSync(file, document.getText());
	return { dir, file };
}

/** Stops the Octave run of a document, if any. */
function cancel(key: string): void {
	const child = running.get(key);
	if (child) {
		running.delete(key);
		child.kill();
	}
}

/** Runs the parse-only check on a document and publishes its diagnostics. */
function checkDocument(collection: vscode.DiagnosticCollection, document: vscode.TextDocument): void {
	const config = vscode.workspace.getConfiguration('octaveDocs');
	const key = document.uri.toString();
	cancel(key);
	if (disabledForSession || !config.get<boolean>('diagnostics.syntax', true)) {
		collection.delete(document.uri);
		return;
	}
	if (document.languageId !== 'octave' || !(document.isUntitled || document.uri.scheme === 'file')) {
		return;
	}

	const octavePath = config.get<string>('octavePath', 'octave');
	const copy = document.isUntitled || document.isDirty ? writeTemporaryCopy(document) : undefined;
	const file = copy ? copy.file : document.uri.fsPath;
	const env = { ...process.env, OCT_PARSE_FILE: file };

	const child = child_process.execFile(octavePath, OCTAVE_ARGS,
		{ encoding: 'utf8', timeout: TIMEOUT_MS, env },
		(error, stdout, stderr) => {
			if (copy) { fs.rmSync(copy.dir, { recursive: true, force: true }); }
			if (running.get(key) !== child) { return; } // superseded or closed meanwhile
			running.delete(key);

			if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				disabledForSession = true;
				collection.clear();
				vscode.window.showInformationMessage(
					`Octave Docs: Octave was not found ("${octavePath}"). ` +
					'Syntax checking is disabled for this session. Check octaveDocs.octavePath.'
				);
				return;
			}

			const syntax = parseSyntaxError(stdout + stderr);
			if (syntax) {
				collection.set(document.uri, [toDiagnostic(document, syntax)]);
			} else {
				collection.delete(document.uri);
			}
		});
	running.set(key, child);
}

/**
 * Reports Octave syntax errors on open and save of .m files, without
 * executing the code (Octave's __parse_file__ only parses it).
 */
export function registerSyntaxCheck(context: vscode.ExtensionContext): void {
	const collection = vscode.languages.createDiagnosticCollection('octave');
	context.subscriptions.push(
		collection,
		vscode.workspace.onDidOpenTextDocument(doc => checkDocument(collection, doc)),
		vscode.workspace.onDidSaveTextDocument(doc => checkDocument(collection, doc)),
		vscode.workspace.onDidCloseTextDocument(doc => {
			cancel(doc.uri.toString());
			collection.delete(doc.uri);
		}),
		{ dispose: () => running.forEach(child => child.kill()) },
	);
	// Documents already open when the extension activates
	for (const doc of vscode.workspace.textDocuments) {
		checkDocument(collection, doc);
	}
}
