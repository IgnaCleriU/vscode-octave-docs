import * as vscode from 'vscode';
import { OctaveDocs } from './hover';
import { codeIdentifiers, WorkspaceIndex } from './workspace';

/**
 * Token types and modifiers. Themes map them to colors directly, or fall
 * back to the TextMate scopes entity.name.function, variable.other and
 * variable.parameter.
 */
export const LEGEND = new vscode.SemanticTokensLegend(
	['function', 'variable', 'parameter'],
	['declaration', 'defaultLibrary'],
);

const enum Modifier {
	Declaration = 1 << 0,
	DefaultLibrary = 1 << 1,
}

/**
 * Colors what the grammar cannot tell apart: calls to known functions
 * (Octave, control, symbolic and the user's own), variables and parameters.
 */
export class OctaveSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
	private changed = new vscode.EventEmitter<void>();
	readonly onDidChangeSemanticTokens = this.changed.event;

	constructor(private docs: OctaveDocs, private index: WorkspaceIndex) {
		// Functions added to or removed from the workspace change the colors
		index.onDidChange(() => this.changed.fire());
	}

	provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
		const builder = new vscode.SemanticTokensBuilder(LEGEND);
		for (const id of codeIdentifiers(document)) {
			let type: number;
			let modifiers = 0;
			if (id.declaration) {
				type = 0;
				modifiers = Modifier.Declaration;
			} else if (id.variable === 'parameter') {
				type = 2;
			} else if (id.variable === 'variable') {
				type = 1;
			} else if (id.commandArg) {
				continue;
			} else if (this.index.lookup(id.name).length > 0) {
				type = 0;
			} else if (this.docs.lookup(id.name).length > 0) {
				type = 0;
				modifiers = Modifier.DefaultLibrary;
			} else {
				continue;
			}
			builder.push(id.line, id.character, id.name.length, type, modifiers);
		}
		return builder.build();
	}
}
