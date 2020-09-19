import { VSCodeSourceHandler } from "./vscodesourcehandler";
import { FileType, TextDocument, Uri, workspace } from 'vscode';
import COBOLSourceScanner from "./cobolsourcescanner";
import { InMemoryGlobalCachesHelper } from "./imemorycache";

import * as fs from 'fs';
import * as path from 'path';

import { logMessage, logException, logTimedMessage, isDirectory, performance_now, getCurrentContext, logChannelSetPreserveFocus, logChannelHide } from "./extension";
import { FileSourceHandler } from "./filesourcehandler";
import { isValidCopybookExtension, isValidProgramExtension } from "./opencopybook";
import { CacheDirectoryStrategy, VSCOBOLConfiguration } from "./configuration";
import { getWorkspaceFolders } from "./cobolfolders";
import { InMemoryGlobalFileCache, COBOLSymbolTableHelper } from "./cobolglobalcache";
import { ICOBOLSettings } from "./iconfiguration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const InMemoryCache: Map<string, any> = new Map<string, any>();

export function clearCOBOLCache(): void {
    InMemoryCache.clear();
}

class ScanStats {
    directoriesScanned = 0;
    filesScanned = 0;
    filesUptodate = 0;
    programsDefined = 0;
    entryPointsDefined = 0;
    directoriesScannedMap: Map<string, Uri> = new Map<string, Uri>();
}

export default class VSQuickCOBOLParse {

    public static getCachedObject(document: TextDocument): COBOLSourceScanner | undefined {
        const fileName: string = document.fileName;
        const cacheDirectory: string | undefined = VSQuickCOBOLParse.getCacheDirectory();

        /* if the document is edited, drop the in cached object */
        if (document.isDirty) {
            InMemoryCache.delete(fileName);
        }

        /* grab, the file parse it can cache it */
        if (InMemoryCache.has(fileName) === false) {
            try {
                const startTime = performance_now();
                const qcpd = new COBOLSourceScanner(new VSCodeSourceHandler(document, false), fileName, VSCOBOLConfiguration.get(),
                    cacheDirectory === undefined ? "" : cacheDirectory);
                InMemoryCache.set(fileName, qcpd);
                logTimedMessage(performance_now() - startTime, " - Parsing " + fileName);

                if (InMemoryCache.size > 20) {
                    const memKeys = InMemoryCache.keys();
                    let dropKey = memKeys.next().value;
                    if (dropKey === qcpd) {
                        dropKey = memKeys.next().value;
                    }
                    InMemoryCache.delete(dropKey);
                }
                return qcpd;
            }
            catch (e) {
                logException("getCachedObject", e);
            }
        }

        return InMemoryCache.get(fileName);
    }


    public static async processAllFilesInWorkspaces(viaCommand: boolean): Promise<void> {

        if (VSCOBOLConfiguration.isOnDiskCachingEnabled() === false) {
            logMessage("Metadata cache is off, no action taken");
            return;
        }

        if (!viaCommand) {
            logChannelHide();
        } else {
            logChannelSetPreserveFocus(!viaCommand);
        }

        if (getWorkspaceFolders()) {
            const stats = new ScanStats();
            const settings = VSCOBOLConfiguration.get();

            const start = performance_now();
            const cacheDirectory = VSQuickCOBOLParse.getCacheDirectory();
            if (cacheDirectory !== undefined) {
                try {
                    logMessage("");
                    logMessage("Starting to process metadata from workspace folders (" + (viaCommand ? "on demand" : "startup") + ")");

                    const promises: Promise<boolean>[] = [];

                    const ws = getWorkspaceFolders();
                    if (ws !== undefined) {
                        for (const folder of ws) {
                            promises.push(VSQuickCOBOLParse.processAllFilesDirectory(settings, cacheDirectory, folder.uri, viaCommand, stats));
                        }
                    }

                    if (InMemoryGlobalFileCache.copybookFileSymbols.size !== 0) {
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        for (const [i, tag] of InMemoryGlobalFileCache.copybookFileSymbols.entries()) {
                            promises.push(VSQuickCOBOLParse.processFile(settings, cacheDirectory, i, false, stats));
                        }
                    }

                    for (const promise of promises) {
                        await promise;
                    }
                    InMemoryGlobalCachesHelper.saveInMemoryGlobalCaches(cacheDirectory);
                    const end = performance_now() - start;
                    const completedMessage = 'Completed scanning all COBOL files in workspace';
                    if (logTimedMessage(end, completedMessage) === false) {
                        logMessage(completedMessage);
                    }
                    logMessage(` Directories scanned : ${stats.directoriesScanned}`);
                    logMessage(` File scanned        : ${stats.filesScanned}`);
                    logMessage(` File up to date     : ${stats.filesUptodate}`);
                    logMessage(` Program Count       : ${stats.programsDefined}`);
                    logMessage(` Entry-Point Count   : ${stats.entryPointsDefined}`);
                } catch (e) {
                    logException("Aborted", e);
                }

            }
        } else {
            logMessage(" No workspaces folders present, no metadata processed.");
        }

        if (viaCommand) {
            logChannelSetPreserveFocus(true);
        }
    }

    private static ignoreDirectory(partialName: string) {
        // do not traverse into . directories
        if (partialName.startsWith('.')) {
            return true;
        }
        return false;
    }

    private static async processAllFilesDirectory(settings: ICOBOLSettings, cacheDirectory: string, folder: Uri, showMessage: boolean, stats: ScanStats): Promise<boolean> {

        const entries = await workspace.fs.readDirectory(folder);
        stats.directoriesScanned++;
        if (stats.directoriesScannedMap.has(folder.fsPath)) {
            return true;
        }

        // if (showMessage) {
        //     logMessage(` Directory : ${folder.fsPath}`);
        // }

        stats.directoriesScannedMap.set(folder.fsPath, folder);

        for (const [entry, fileType] of entries) {
            if (fileType === FileType.File) {
                const fullFilename = path.join(folder.fsPath, entry);
                await VSQuickCOBOLParse.processFile(settings, cacheDirectory, fullFilename, true, stats);
            }
            else if (fileType === FileType.Directory) {
                if (!VSQuickCOBOLParse.ignoreDirectory(entry)) {
                    const fullFilename = path.join(folder.fsPath, entry);
                    const directoryUri = Uri.parse(fullFilename);
                    if (!VSQuickCOBOLParse.ignoreDirectory(entry)) {
                        await VSQuickCOBOLParse.processAllFilesDirectory(settings, cacheDirectory, directoryUri, true, stats);
                    }
                }
            } else {
                logMessage(` Symbolic link ignored : ${folder.fsPath}`);
            }
        }

        return true;
    }

    private static async processFile(settings: ICOBOLSettings, cacheDirectory: string, filename: string, filterOnExtension: boolean, stats: ScanStats): Promise<boolean> {
        let parseThisFilename = false;

        if (filterOnExtension) {
            if (settings.parse_copybooks_for_references) {
                parseThisFilename = isValidProgramExtension(filename, settings);
            } else {
                parseThisFilename = isValidCopybookExtension(filename, settings);
            }
        }

        if (parseThisFilename) {
            if (COBOLSymbolTableHelper.cacheUpdateRequired(cacheDirectory, filename)) {
                // logMessage(` File: ${filename}`);
                const filefs = new FileSourceHandler(filename, false);
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const qcp = new COBOLSourceScanner(filefs, filename, settings, cacheDirectory);
                if (qcp.callTargets.size > 0) {
                    stats.programsDefined++;
                    stats.entryPointsDefined += (qcp.callTargets.size - 1);
                }
                stats.filesScanned++;
            } else {
                stats.filesUptodate++;
            }
        }
        return true;
    }

    public static getCacheDirectory(): string | undefined {

        const settings = VSCOBOLConfiguration.get();

        // turned off via the strategy
        if (settings.cache_metadata === CacheDirectoryStrategy.Off) {
            return undefined;
        }

        if (getWorkspaceFolders()) {

            if (settings.cache_metadata === CacheDirectoryStrategy.Storage) {
                const storageDirectory: string | undefined = getCurrentContext().storageUri?.fsPath;

                /* no storage directory */
                if (storageDirectory === undefined) {
                    return undefined;
                }

                if (!isDirectory(storageDirectory)) {
                    try {
                        fs.mkdirSync(storageDirectory);
                    }
                    catch {
                        // swallow
                    }
                }

                /* not a directory, so ignore */
                if (!isDirectory(storageDirectory)) {
                    return undefined;
                }

                return storageDirectory;
            }

            let firstCacheDir = "";

            const ws = getWorkspaceFolders();
            if (ws !== undefined) {
                for (const folder of ws) {
                    const cacheDir2: string = path.join(folder.uri.fsPath, ".vscode_cobol");
                    if (isDirectory(cacheDir2)) {
                        return cacheDir2;
                    }
                    if (firstCacheDir === "") {
                        firstCacheDir = cacheDir2;
                    }
                }
            }

            if (firstCacheDir.length === 0) {
                return undefined;
            }

            if (isDirectory(firstCacheDir) === false) {
                try {
                    fs.mkdirSync(firstCacheDir);
                }
                catch {
                    return undefined;
                }
            }

            return firstCacheDir;
        }

        return undefined;
    }
}
