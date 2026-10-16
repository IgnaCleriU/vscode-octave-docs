import * as vscode from 'vscode';
import {
	HELP_SCHEME, OctaveDocs, OctaveHelpContentProvider, OctaveHoverProvider,
	SHOW_HELP_COMMAND, showFullHelp,
} from './hover';
import { OctaveCompletionProvider } from './completion';
import { OctaveSignatureHelpProvider, SIGNATURE_RETRIGGERS, SIGNATURE_TRIGGERS } from './signatureHelp';
import { registerPkgDiagnostics } from './pkgDiagnostics';
import { registerRunCommands } from './run';
import { registerSyntaxCheck } from './syntaxCheck';
import { LEGEND, OctaveSemanticTokensProvider } from './semanticTokens';
import { OctaveDocumentSymbolProvider, OctaveFoldingRangeProvider } from './symbols';
import {
	OctaveDefinitionProvider, UserCompletionProvider, WorkspaceIndex, userFunctionHover, variableHover,
} from './workspace';

const OCTAVE: vscode.DocumentSelector = { language: 'octave' };

/**
 * Hover in order of precedence: the user's variables hide functions of the
 * same name, and the user's own functions hide built-in ones.
 */
class CombinedHoverProvider implements vscode.HoverProvider {
	constructor(private index: WorkspaceIndex, private builtin: OctaveHoverProvider) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (!range) { return undefined; }
		const word = document.getText(range);
		return variableHover(document, position, word)
			?? userFunctionHover(this.index, document, position, word)
			?? this.builtin.provideHover(document, position);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const docs = new OctaveDocs(context.extensionPath);
	const index = new WorkspaceIndex();

	context.subscriptions.push(
		index,
		vscode.languages.registerDocumentSymbolProvider(OCTAVE, new OctaveDocumentSymbolProvider()),
		vscode.languages.registerFoldingRangeProvider(OCTAVE, new OctaveFoldingRangeProvider()),
		vscode.languages.registerHoverProvider(OCTAVE, new CombinedHoverProvider(index, new OctaveHoverProvider(docs))),
		vscode.workspace.registerTextDocumentContentProvider(HELP_SCHEME, new OctaveHelpContentProvider(docs)),
		vscode.commands.registerCommand(SHOW_HELP_COMMAND, showFullHelp),
		vscode.languages.registerCompletionItemProvider(OCTAVE, new OctaveCompletionProvider(docs)),
		vscode.languages.registerCompletionItemProvider(OCTAVE, new UserCompletionProvider(index)),
		vscode.languages.registerSignatureHelpProvider(OCTAVE, new OctaveSignatureHelpProvider(docs), {
			triggerCharacters: SIGNATURE_TRIGGERS,
			retriggerCharacters: SIGNATURE_RETRIGGERS,
		}),
		vscode.languages.registerDefinitionProvider(OCTAVE, new OctaveDefinitionProvider(index)),
		vscode.languages.registerDocumentSemanticTokensProvider(
			OCTAVE, new OctaveSemanticTokensProvider(docs, index), LEGEND),
	);

	registerPkgDiagnostics(context, docs);
	registerRunCommands(context);
	registerSyntaxCheck(context);
}

export function deactivate() {}
