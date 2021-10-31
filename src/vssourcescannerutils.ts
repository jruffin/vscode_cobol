import path from "path";
import { FileType, Uri, workspace } from "vscode";
import { getVSWorkspaceFolders } from "./cobolfolders";
import { COBOLUtils } from "./cobolutils";
import { VSLogger } from "./vslogger";
import { COBOLFileUtils } from "./fileutils";
import { ICOBOLSettings } from "./iconfiguration";
import { VSCOBOLConfiguration } from "./vsconfiguration";

export class VSCOBOLSourceScannerTools {
    public static async checkWorkspaceForMissingCopybookDirs(): Promise<void> {
        VSLogger.logChannelSetPreserveFocus(false);
        VSLogger.logMessage("Checking workspace for folders that are not present in copybookdirs setting");

        const settings = VSCOBOLConfiguration.get();
        const ws = getVSWorkspaceFolders();
        if (ws !== undefined) {
            for (const folder of ws) {
                try {
                    await VSCOBOLSourceScannerTools.checkWorkspaceForMissingCopybookDir(settings, folder.uri, folder.uri);
                } catch {
                    continue;       // most likely an invalid directory
                }
            }
        }
        VSLogger.logMessage(" -- Analysis complete");
    }

    public static async checkWorkspaceForMissingCopybookDir(settings: ICOBOLSettings, topLevelFolder: Uri, folder: Uri): Promise<void> {
        const entries = await workspace.fs.readDirectory(folder);

        for (const [entry, fileType] of entries) {
            switch (fileType) {
                case FileType.Directory | FileType.SymbolicLink:
                case FileType.Directory:
                    if (!VSCOBOLSourceScannerTools.ignoreDirectory(entry)) {
                        const fullDirectory = path.join(folder.fsPath, entry);
                        if (!VSCOBOLSourceScannerTools.ignoreDirectory(entry)) {
                            const topLevelLength = 1 + topLevelFolder.fsPath.length;
                            const possibleCopydir = fullDirectory.substr(topLevelLength);

                            if (COBOLUtils.inCopybookdirs(settings, possibleCopydir) === false) {
                                const copyBookCount = await VSCOBOLSourceScannerTools.howManyCopyBooksInDirectory(fullDirectory, settings);
                                if (copyBookCount !== 0) {
                                    VSLogger.logMessage(`  Add: ${possibleCopydir} to coboleditor.copybookdirs (possible copybooks ${copyBookCount})`);
                                }
                            }
                            await VSCOBOLSourceScannerTools.checkWorkspaceForMissingCopybookDir(settings, topLevelFolder, Uri.file(fullDirectory));
                        }
                    }
                    break;
            }
        }
        return;
    }

    public static async howManyCopyBooksInDirectory(directory: string, settings: ICOBOLSettings): Promise<number> {
        const folder = Uri.file(directory);
        const entries = await workspace.fs.readDirectory(folder);
        let copyBookCount = 0;
        for (const [entry, fileType] of entries) {
            switch (fileType) {
                case FileType.File | FileType.SymbolicLink:
                case FileType.File:
                    if (COBOLFileUtils.isValidCopybookExtension(entry, settings)) {
                        copyBookCount++;
                    }

            }
        }

        return copyBookCount;
    }

    public static ignoreDirectory(partialName: string): boolean {
        // do not traverse into . directories
        if (partialName.startsWith(".")) {
            return true;
        }
        return false;
    }

    public static getUserStorageDirectory(settings: ICOBOLSettings): string | undefined {
        let str = settings.cache_metadata_user_directory;
        if (str === null || str.length === 0) {
            return undefined;
        }

        // if on Windows replace ${HOME} with ${USERPROFILE}
        if (COBOLFileUtils.isWin32) {
            // eslint-disable-next-line no-template-curly-in-string
            str = str.replace(/\$\{HOME\}/, "${USERPROFILE}");
        }

        const replaced = str.replace(/\$\{([^%]+)\}/g, (_original, matched) => {
            const r = process.env[matched];
            return r ? r : "";
        });

        return replaced;
    }
}
