import COBOLSourceScanner, { SharedSourceReferences } from "./cobolsourcescanner";
import { COBOLSymbolTableEventHelper } from "./cobolsymboltableeventhelper";
import { COBSCANNER_STATUS, ScanData, ScanDataHelper, ScanStats } from "./cobscannerdata";
import { ConsoleExternalFeatures } from "./consoleexternalfeatures";

import * as crypto from 'crypto';
import * as fs from 'fs';
import { Hash } from "crypto";
import path from "path";

import { COBOLWorkspaceSymbolCacheHelper } from "./cobolworkspacecache";
import { InMemoryGlobalSymbolCache } from "./globalcachehelper";
import { FileSourceHandler } from "./filesourcehandler";
import { COBOLSettings, ICOBOLSettings } from "./iconfiguration";

const args = process.argv.slice(2);
const features = ConsoleExternalFeatures.Default;

class Utils {
    private static msleep(n: number) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
    }

    public static sleep(n: number) {
        Utils.msleep(n * 1000);
    }

    private static isFileT(sdir: string): [boolean, fs.BigIntStats | undefined] {
        try {
            if (fs.existsSync(sdir)) {
                const f = fs.statSync(sdir, { bigint: true });
                if (f && f.isFile()) {
                    return [true, f];
                }
            }
        }
        catch {
            return [false, undefined];
        }
        return [false, undefined];
    }

    public static getHashForFilename(filename: string) {
        const hash: Hash = crypto.createHash('sha256');
        hash.update(filename);
        return hash.digest('hex');
    }

    public static cacheUpdateRequired(cacheDirectory: string, nfilename: string): boolean {
        const filename = path.normalize(nfilename);

        const cachedMtimeWS = InMemoryGlobalSymbolCache.sourceFilenameModified.get(filename);
        const cachedMtime = cachedMtimeWS?.lastModifiedTime;
        // features.logMessage(`cacheUpdateRequired(${nfilename} = ${cachedMtime})`);
        if (cachedMtime !== undefined) {
            const stat4src = fs.statSync(filename, { bigint: true });
            if (cachedMtime < stat4src.mtimeMs) {
                return true;
            }
            return false;
        }

        const fn: string = path.join(cacheDirectory, this.getHashForFilename(filename) + ".sym");
        const fnStat = Utils.isFileT(fn);
        if (fnStat[0]) {
            const stat4cache = fnStat[1];
            const stat4src = fs.statSync(filename, { bigint: true });
            if (stat4cache !== undefined && stat4cache.mtimeMs < stat4src.mtimeMs) {
                return true;
            }
            return false;
        }

        return true;
    }

    public static performance_now(): number {
        if (!process.env.BROWSER) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                return require('performance-now').performance.now;
            }
            catch {
                return Date.now();
            }
        }

        return Date.now();
    }
}

function processFile(scanData: ScanData): void {
    features.setWorkspaceFolders(scanData.workspaceFolders);
    // may need more..
    settings.parse_copybooks_for_references = scanData.parse_copybooks_for_references;
    settings.cache_metadata_show_progress_messages = scanData.cache_metadata_show_progress_messages;

    const aborted = false;
    const stats = new ScanStats();
    stats.start = Utils.performance_now();
    stats.directoriesScanned = scanData.directoriesScanned;
    stats.maxDirectoryDepth = scanData.maxDirectoryDepth;
    stats.fileCount = scanData.fileCount;

    // TODO: add in other metadata items
    COBOLWorkspaceSymbolCacheHelper.loadGlobalCacheFromArray(settings, scanData.md_symbols, true);
    COBOLWorkspaceSymbolCacheHelper.loadGlobalEntryCacheFromArray(settings, scanData.md_entrypoints, true);
    COBOLWorkspaceSymbolCacheHelper.loadGlobalTypesCacheFromArray(settings, scanData.md_types, true);
    COBOLWorkspaceSymbolCacheHelper.loadFileCacheFromArray(settings, features, scanData.md_metadata_files, true);
    COBOLWorkspaceSymbolCacheHelper.loadGlobalKnownCopybooksFromArray(settings, scanData.md_metadata_knowncopybooks, true);

    if (scanData.showStats) {
        if (stats.directoriesScanned !== 0) {
            features.logMessage(` Directories scanned   : ${stats.directoriesScanned}`);
        }
        if (stats.maxDirectoryDepth !== 0) {
            features.logMessage(` Directory Depth       : ${stats.maxDirectoryDepth}`);
        }

        if (stats.fileCount) {
            features.logMessage(` Files found           : ${stats.fileCount}`);
        }
    }

    try {
        let fCount = 0;
        const fSendOn = Math.round(scanData.fileCount * 0.01);
        let fSendCount = 0;
        for (const file of scanData.Files) {
            const cacheDir = scanData.cacheDirectory;

            fCount++; fSendCount++;
            if (fSendCount === fSendOn) {
                if (process.send) {
                    process.send(`${COBSCANNER_STATUS} ${fCount} ${scanData.Files.length}`);
                }
                fSendCount = 0;
            }

            if (Utils.cacheUpdateRequired(cacheDir, file)) {
                const filesHandler = new FileSourceHandler(file, false);
                const config = new COBOLSettings();
                config.parse_copybooks_for_references = scanData.parse_copybooks_for_references;
                const symbolCatcher = new COBOLSymbolTableEventHelper(config);
                const qcp = new COBOLSourceScanner(filesHandler, config, cacheDir, new SharedSourceReferences(config, true), config.parse_copybooks_for_references, symbolCatcher, features);
                if (qcp.callTargets.size > 0) {
                    stats.programsDefined++;
                    if (qcp.callTargets !== undefined) {
                        stats.entryPointsDefined += (qcp.callTargets.size - 1);
                    }
                }

                if (scanData.cache_metadata_show_progress_messages) {
                    features.logMessage(`  Parse completed: ${file}`);
                }
                stats.filesScanned++;
            } else {
                stats.filesUptodate++;
            }
        }
    } finally {
        const end = Utils.performance_now() - stats.start;
        if (scanData.showStats) {
            if (stats.filesScanned !== 0) {
                features.logMessage(` Files scanned         : ${stats.filesScanned}`);
            }

            if (stats.filesUptodate !== 0) {
                features.logMessage(` Files up to date      : ${stats.filesUptodate}`);
            }

            if (stats.programsDefined !== 0) {
                features.logMessage(` Program Count         : ${stats.programsDefined}`);
            }

            if (stats.entryPointsDefined !== 0) {
                features.logMessage(` Entry-Point Count     : ${stats.entryPointsDefined}`);
            }

            const completedMessage = (aborted ? `Scan aborted (elapsed time ${end})` : 'Scan completed');
            if (features.logTimedMessage(end, completedMessage) === false) {
                features.logMessage(completedMessage);
            }
        }
    }
}

let lastJsonFile = "";
const settings: ICOBOLSettings = new COBOLSettings();

for (const arg of args) {
    if (arg.endsWith(".json")) {
        try {
            lastJsonFile = arg;
            const scanData: ScanData = ScanDataHelper.load(arg);
            processFile(scanData);
        }
        catch (e) {
            if (e instanceof SyntaxError) {
                features.logMessage(`Unable to load ${arg}`);
            } else {
                features.logException("cobscanner", e);
            }
        }
    }
    else if (arg.toLowerCase() === 'useenv') {

        try {
            const SCANDATA_ENV = process.env.SCANDATA;
            if (SCANDATA_ENV !== undefined) {
                const scanData: ScanData = ScanDataHelper.parseScanData(SCANDATA_ENV);
                processFile(scanData);
            } else {
                features.logMessage(`SCANDATA not found in environment`);
            }
        }
        catch (e) {
            if (e instanceof SyntaxError) {
                features.logMessage(`Unable to load ${arg}`);
            } else {
                features.logException("cobscanner", e);
            }
        }
    } else {
        features.logMessage(`INFO: arg passed is ${arg}`);
    }
}

if (lastJsonFile.length !== 0) {
    try {
        // delete the json file
        fs.unlinkSync(lastJsonFile);
    }
    catch {
        //continue
    }
}
