/* eslint-disable @typescript-eslint/no-unused-vars */
import * as vscode from "vscode";
import { CancellationToken, Position, TextDocument } from "vscode";
import { COBOLSourceScanner, COBOLVariable, SharedSourceReferences, SourceReference } from "./cobolsourcescanner";
import { VSCOBOLSourceScanner } from "./vscobolscanner";
import { VSCOBOLConfiguration } from "./vsconfiguration";

const wordRegEx = new RegExp("[#0-9a-zA-Z][a-zA-Z0-9-_]*");

export class VSCobolRenameProvider implements vscode.RenameProvider {
    private current?: COBOLSourceScanner;
    private currentVersion?: number;
    private sourceRefs?: SharedSourceReferences;

    // public prepareRename?(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Range | { range: Range, placeholder: string }> {
    //     const wordRange = document.getWordRangeAtPosition(position, wordRegEx);
    //     const word = wordRange ? document.getText(wordRange) : "";
    //     if (word === "") {
    //         return null;
    //     }

    //     return null;
    // }

    provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): vscode.ProviderResult<vscode.WorkspaceEdit> {
        const wordRange = document.getWordRangeAtPosition(position, wordRegEx);
        const word = wordRange ? document.getText(wordRange) : "";
        if (word === "") {
            return Promise.resolve(null);
        }

        const workLower = word.toLowerCase();
        const settings = VSCOBOLConfiguration.get();
        // cache current document, so interactive searches can be faster
        if (this.current === undefined || this.currentVersion !== document.version) {
            const newCurrent = VSCOBOLSourceScanner.getCachedObject(document, settings);
            if (newCurrent !== undefined) {
                this.current = newCurrent;
                this.sourceRefs = this.current.sourceReferences;
                this.currentVersion = document.version;
            }
        }

        if (this.current === undefined || this.sourceRefs === undefined) {
            return Promise.resolve(null);
        }

        const qp: COBOLSourceScanner = this.current;
        // const sourceRefs: SharedSourceReferences = this.sourceRefs;
        const edits = new vscode.WorkspaceEdit()
        const sourceRefs: SharedSourceReferences = this.sourceRefs;

        if (qp.constantsOrVariables.has(workLower)) {
            const paraVariables: COBOLVariable[] | undefined = qp.constantsOrVariables.get(workLower);
            if (paraVariables !== undefined) {
                for (let ptref = 0; ptref < paraVariables.length; ptref++) {
                    const paraToken = paraVariables[ptref].token;
                    const uri: vscode.Uri = vscode.Uri.file(paraToken.filename);

                    const startPos = new vscode.Position(paraToken.startLine, paraToken.startColumn);
                    const endPos = new vscode.Position(paraToken.startLine, paraToken.endColumn);
                    const range = new vscode.Range(startPos, endPos);
                    edits.delete(uri, range);
                    edits.insert(uri, startPos, newName);
                }

                if (sourceRefs.constantsOrVariablesReferences.has(workLower) === true) {
                    const targetRefs: SourceReference[] | undefined = sourceRefs.constantsOrVariablesReferences.get(workLower);
                    if (targetRefs !== undefined) {
                        for (let trpos = 0; trpos < targetRefs.length; trpos++) {
                            const tref = targetRefs[trpos];
                            const uri = vscode.Uri.file(sourceRefs.filenames[tref.fileIdentifer]);
                            const startPos = new vscode.Position(tref.line, tref.column);
                            const endPos = new vscode.Position(tref.line, tref.column + tref.length);
                            const range = new vscode.Range(startPos, endPos);
                            edits.delete(uri, range);
                            edits.insert(uri, startPos, newName);
                        }
                    }
                }
            }
        }

        if (qp.paragraphs.has(workLower) || qp.sections.has(workLower)) {
            if (sourceRefs.targetReferences.has(workLower) === true) {
                const targetRefs: SourceReference[] | undefined = sourceRefs.targetReferences.get(workLower);
                if (targetRefs !== undefined) {
                    for (let trpos = 0; trpos < targetRefs.length; trpos++) {
                        const tref = targetRefs[trpos];
                        const uri = vscode.Uri.file(sourceRefs.filenames[tref.fileIdentifer]);
                        const startPos = new vscode.Position(tref.line, tref.column);
                        const endPos = new vscode.Position(tref.line, tref.column + tref.length);
                        const range = new vscode.Range(startPos, endPos);
                        edits.delete(uri, range);
                        edits.insert(uri, startPos, newName);
                    }
                }
            }

        }

        return edits;
    }

}