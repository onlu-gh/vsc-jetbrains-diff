import * as vscode from 'vscode';

import * as cp from 'child_process';
import { createReadStream, existsSync, statSync, unlink, writeFile } from 'fs';
import * as os from 'os';
import { basename, dirname, join } from 'path';
import * as streamEqual from 'stream-equal';
import { commands, window } from 'vscode';

let fillListDone = false;
let filesToRemove: string[] = [];
const filesToRemoveGlobal: string[] = [];
const outputChannel = vscode.window.createOutputChannel(`JetBrainsDiff`);

function addFileToRemove(file: string) {
	filesToRemove.push(file);
	filesToRemoveGlobal.push(file);
}

function showJetBrainsResolver(files: string[]) {
	let diffTool: string;
	const customDiffTool: string = vscode.workspace.getConfiguration('jetbrains-diff').customDiffCheckerTool;

	if (customDiffTool !== "") {
		diffTool = customDiffTool;
		if (diffTool.match(/(?<!\\) /)) {
			// diffTool path includes not escaped spaces so it must be enclosed in quotes
			if (!diffTool.match(/^(["']).*\1$/)) {
				// the diffTool is not enclosed in quotes
				diffTool = '"' + diffTool + '"';
			}
		}
	} else {
		diffTool = vscode.workspace.getConfiguration('jetbrains-diff').diffCheckerTool;
	}

	const diffFiles = files.filter(v => existsSync(v.toString())).slice(0, 3);

	if (diffFiles.length < 2) {
		window.showErrorMessage("JetBrains Diff Error: Minimum two files are needed to diff!");
		return;
	}

	// files should not be compared with directories because this is not possible
	let fileInDiffFiles = false;
	let directoriesInDiffFiles = false;
	diffFiles.forEach(entry => {
		const stat = statSync(entry);
		fileInDiffFiles = fileInDiffFiles || stat.isFile();
		directoriesInDiffFiles = directoriesInDiffFiles || stat.isDirectory();
	});
	if (fileInDiffFiles && directoriesInDiffFiles) {
		window.showErrorMessage("JetBrains Diff Error: JetBrains can't compare files with directories!");
		return;
	}

	// construct cmd
	const operation: string = diffFiles.length === 2 ? 'diff' : 'merge';
	const cmd: string = diffTool + ' ' + operation + " " + diffFiles.join(' ');

	outputChannel.appendLine("Run: " + cmd);

	return cp.exec(
		cmd,
		(error: cp.ExecException | null, stdout: string, stderr: string) => {
			if (error) {
				if (error.message.match(new RegExp(`${diffTool}: not found`))) {
					window.showErrorMessage("JetBrains Diff Error: Diff tool cannot be found!");
				} else {
					window.showErrorMessage("JetBrains Diff Error: Error running diff command! StdErr: " + stderr);
				}
			}
		});
}

function showListAndDiff(current: string, possible_diffs: string[], filesToRemove: string[]) {
	// remove current editor
	const possible = possible_diffs.filter(function (value, index, arr) {
		return value != current;
	});

	const a: any[] | Thenable<any[]> = [];
	possible.forEach(_ => {
		a.push(_);
	});

	window.showQuickPick(a, {
		placeHolder: 'Filename to diff'
	}).then(result => {
		if (existsSync(result)) {
			const process = showJetBrainsResolver([current, result]);
			if (process && filesToRemove.length > 0) {
				const files = [...filesToRemove];
				process.on('exit', () => cleanupTmpFiles(files));
			}
		}
	});
}

// workaround because there is no function to get all open editors from API
function doIt(current: string, possible_diffs: string[], filesToRemove: string[]) {
	if (fillListDone) {
		showListAndDiff(current, possible_diffs, filesToRemove);
	} else {
		if (window.activeTextEditor) {
			possible_diffs.push(window.activeTextEditor.document.fileName);
		}
		commands.executeCommand("workbench.action.nextEditor").then(_ => {
			if (window.activeTextEditor) {
				if (window.activeTextEditor.document.fileName != current) {
					doIt(current, possible_diffs, filesToRemove);
				} else {
					fillListDone = true;
					showListAndDiff(current, possible_diffs, filesToRemove);
				}
			} else {
				// the window is not a text editor, skip it
				doIt(current, possible_diffs, filesToRemove);
			}
		});
	}
}

function rndName() {
	return Math.random().toString(36).substr(2, 10);
}

/**
 * Simple random file creation
 *
 * @see https://github.com/microsoft/vscode/blob/main/extensions/emmet/src/test/testUtils.ts
 */
function createRandomFile({ contents = '', prefix = 'tmp' }: { contents?: string; prefix?: string; } = {}): Thenable<vscode.Uri> {
	return new Promise((resolve, reject) => {
		const tmpFile = join(os.tmpdir(), prefix + rndName());
		writeFile(tmpFile, contents, (error) => {
			if (error) {
				return reject(error);
			}

			resolve(vscode.Uri.file(tmpFile));
		});
	});
}

async function writeTempFileOnDisk(content: string, prefix = "tmp_"): Promise<string> {
	return (await createRandomFile({ contents: content, prefix: prefix })).fsPath;
}

async function areFilesEqual(files: string[]): Promise<boolean> {
	const [path1, path2] = files;
	const readStream1 = createReadStream(path1);
	const readStream2 = createReadStream(path2);

	return await streamEqual(readStream1, readStream2);
}

function cleanupTmpFiles(files: string[]) {
	files.forEach((file) => unlink(file, (err) => {
		if (err) {
			outputChannel.appendLine('Unable to delete tmp file: ' + file);
		}
		// remove entry from global list
		const index = filesToRemoveGlobal.indexOf(file);
		if (index > -1) {
			filesToRemoveGlobal.splice(index);
		}
	}));
}

async function getFileNameOfDocument(document: vscode.TextDocument) {
	if (document.isUntitled) {
		//compare untitled file or changed content of file instead of saved file
		let prefix = "untitled_";
		if (!document.isUntitled) {
			prefix = basename(document.fileName) + "_";
		}
		const documentContent = document.getText();
		const fileName = await writeTempFileOnDisk(documentContent, prefix);
		return { name: fileName, tmp: true };
	} else {
		return { name: document.fileName, tmp: false };
	}
}

interface Callback {
	(tmpFile: string, error: any): void;
}

async function runGit(selectedFile: string, gitCmd: string, prefix: string, callback: Callback) {
	const selectedFileBasename = basename(selectedFile);
	const selectedFileDir = dirname(selectedFile);

	const simpleGit = await import('simple-git');
	let tmpData = "";
	simpleGit(selectedFileDir).outputHandler((cmd: any, stdOut: any) => {
		stdOut.on('data', async (data: any) => {
			tmpData += data.toString('utf8');
		});
		stdOut.on('end', async (data: any) => {
			// write staged content to temp file
			const staged = await writeTempFileOnDisk(tmpData, prefix + "_" + selectedFileBasename + "_");
			addFileToRemove(staged);

			if (!existsSync(staged)) {
				callback("", "JetBrains Diff Error: Can't create temp file!");
			}

			// start jetbrains diff tool
			callback(staged, null);
		});
	}).raw(
		["show", gitCmd + selectedFileBasename]
	).catch((err: any) => {
		callback("", "JetBrains Diff Error: " + err);
	});
}

enum MergeConflictFileType {
	LOCAL,
	REMOTE,
	BASE,
	MERGED,
}

type MergeConflictFiles = Record<MergeConflictFileType, string>;

export function activate(context: vscode.ExtensionContext) {
	const open_files_event: string[] = [];

	vscode.workspace.onDidOpenTextDocument(event => {
		// add file to array on opening
		if (fillListDone && open_files_event.indexOf(event.fileName) === -1) {
			if (existsSync(event.fileName)) {
				open_files_event.push(event.fileName);
			}
		}
	});

	vscode.workspace.onDidCloseTextDocument(event => {
		//remove file from list on closing
		const index = open_files_event.indexOf(event.fileName);
		if (fillListDone && index !== -1) {
			open_files_event.splice(index, 1);
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffVisible', async () => {
		let open_files: string[] = [];
		filesToRemove = [];

		for (const editor of window.visibleTextEditors) {
			const fileName = await getFileNameOfDocument(editor.document);
			open_files.push(fileName.name);
			if (fileName.tmp) {
				addFileToRemove(fileName.name);
			}
		}

		if (open_files.length < 2) {
			let fileCount = "Only one file is";
			if (open_files.length == 0) {
				fileCount = "No files are";
			}
			window.showErrorMessage("JetBrains Diff Error: Can't compare! " + fileCount + " visible in editor!");
			return;
		}

		// sort open files by last modification, newest first
		open_files = open_files.map(function (fileName) {
			return {
				name: fileName,
				time: statSync(fileName).mtime.getTime()
			};
		})
			.sort(function (a, b) {
				return b.time - a.time;
			})
			.map(function (v) {
				return v.name;
			});

		// TODO add areFilesEqual to every step
		const process = showJetBrainsResolver(open_files);
		if (process && filesToRemove.length > 0) {
			const files = [...filesToRemove];
			process.on('exit', () => cleanupTmpFiles(files));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffCurrentToOtherOpen', async () => {
		if (!window.activeTextEditor) {
			window.showErrorMessage("JetBrains Diff Error: Current window is not an editor!");
			return;
		}

		filesToRemove = [];
		const current = await getFileNameOfDocument(window.activeTextEditor.document);
		if (current.tmp) {
			addFileToRemove(current.name);
		}

		doIt(current.name, open_files_event, filesToRemove);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffCurrentToOther', async () => {
		if (!window.activeTextEditor) {
			window.showErrorMessage("JetBrains Diff Error: Current window is not an editor!");
			return;
		}

		filesToRemove = [];
		const current = await getFileNameOfDocument(window.activeTextEditor.document);
		if (current.tmp) {
			addFileToRemove(current.name);
		}

		const options: vscode.OpenDialogOptions = {
			canSelectMany: false,
			openLabel: 'Diff'
		};

		window.showOpenDialog(options).then(_ => {
			if (_) {
				const process = showJetBrainsResolver([current.name, _[0].fsPath]);
				if (process && filesToRemove.length > 0) {
					const files = [...filesToRemove];
					process.on('exit', () => cleanupTmpFiles(files));
				}
			}
		});

	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffWithClipboard', async () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			window.showErrorMessage("JetBrains Diff Error: Current window is not an editor!");
			return;
		}

		filesToRemove = [];
		const clipboardContent = await vscode.env.clipboard.readText();
		const clipboard = await writeTempFileOnDisk(clipboardContent, "clipboard_");
		addFileToRemove(clipboard);

		//by default compare clipboard against current file
		let sameContent;
		let current = editor.document.fileName;
		const selection = editor.selection;
		if (!selection.isEmpty) {
			//compare against current selection
			const editorContent = editor.document.getText(selection);
			current = await writeTempFileOnDisk(editorContent, "selection_");
			addFileToRemove(current);
			sameContent = await areFilesEqual([current, clipboard]);
		} else if (editor.document.isUntitled) {
			//compare against untitled file
			const editorContent = editor.document.getText();
			current = await writeTempFileOnDisk(editorContent, "untitled_");
			addFileToRemove(current);
			sameContent = await areFilesEqual([current, clipboard]);
		} else if (editor.document.isDirty) {
			//compore against dirty content but invoke jetbrains diff tool with current saved file
			const editorContent = editor.document.getText();
			const tmpCheck = await writeTempFileOnDisk(editorContent);
			addFileToRemove(tmpCheck);
			sameContent = await areFilesEqual([tmpCheck, clipboard]);
		} else {
			sameContent = await areFilesEqual([current, clipboard]);
		}

		if (sameContent) {
			window.showInformationMessage('JetBrains Diff: No difference');
			cleanupTmpFiles(filesToRemove);
		} else {
			const process = showJetBrainsResolver([current, clipboard]);
			if (process && filesToRemove.length > 0) {
				const files = [...filesToRemove];
				process.on('exit', () => cleanupTmpFiles(files));
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffSavedVersion', async () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			window.showErrorMessage("JetBrains Diff Error: Current window is not an editor!");
			return;
		}

		if (editor.document.isUntitled) {
			window.showErrorMessage("JetBrains Diff Error: No saved version found to compare with!");
			return;
		}

		if (!editor.document.isDirty) {
			window.showInformationMessage("JetBrains Diff: No difference to saved version of the file.");
			return;
		}

		filesToRemove = [];

		const editorContent = editor.document.getText();
		const currentSaved = editor.document.fileName;
		const current = await writeTempFileOnDisk(editorContent, basename(currentSaved) + "_changed_");
		addFileToRemove(current);
		const sameContent = await areFilesEqual([current, currentSaved]);

		if (sameContent) {
			window.showInformationMessage('JetBrains Diff: No difference to saved version of the file.');
			cleanupTmpFiles(filesToRemove);
		} else {
			const process = showJetBrainsResolver([current, currentSaved]);
			if (process && filesToRemove.length > 0) {
				const files = [...filesToRemove];
				process.on('exit', () => cleanupTmpFiles(files));
			}
		}
	}));

	let selected = "";

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffFromFileListMultiple', (_, selectedFiles) => {
		if (selectedFiles) {
			const files = [];
			console.log(typeof selectedFiles[0]);
			for (let i = 0; i < selectedFiles.length; i++) {
				files.push(selectedFiles[i].fsPath);
			}

			outputChannel.appendLine("Compare multiple files: " + files);
			showJetBrainsResolver(files);
		} else {
			window.showInformationMessage('JetBrains Diff: Command can only be used from file list.');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffFromFileListSelect', (_) => {
		if (!_) {
			if (window.activeTextEditor) {
				if (window.activeTextEditor.document.isUntitled) {
					window.showErrorMessage("JetBrains Diff Error: Unsaved editors can not be selected for jetbrains diff comparison!");
					return;
				}
				selected = window.activeTextEditor.document.fileName;
			} else {
				window.showErrorMessage("JetBrains Diff Error: Current window is not an editor!");
				return;
			}
		} else {
			selected = _.fsPath;
		}
		vscode.commands.executeCommand('setContext', 'jetbrains-diff.FileSelectedForJetBrainsDiff', true);
		outputChannel.appendLine("Select for jetbrains compare: " + selected);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffFromFileList', async (_) => {
		let path = "";
		filesToRemove = [];

		if (!_) {
			if (window.activeTextEditor) {
				const fileName = await getFileNameOfDocument(window.activeTextEditor.document);
				if (fileName.tmp) {
					addFileToRemove(fileName.name);
				}
				path = fileName.name;
			} else {
				window.showErrorMessage("JetBrains Diff Error: Current window is not an editor!");
				return;
			}
		} else {
			path = _.fsPath;
		}
		if (selected.length > 0) {
			const process = showJetBrainsResolver([selected, path]);
			if (process && filesToRemove.length > 0) {
				const files = [...filesToRemove];
				process.on('exit', () => cleanupTmpFiles(files));
			}
		} else {
			window.showErrorMessage("JetBrains Diff Error: First select a file to compare with!");
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('jetbrains-diff.diffScm', async (_) => {
		if (!_) {
			window.showErrorMessage("JetBrains Diff Error: First select a changed file in source control window and use context menu.");
			return;
		}

		const selectedFile = _.resourceUri._fsPath;

		filesToRemove = [];

		switch (_.type) {
			case 5: // unstaged changes
				// get content of staging version of the selected file
				runGit(selectedFile, ":./", "staged", (staged, err) => {
					if (err) {
						return window.showErrorMessage(err);
					}
					// start jetbrains diff tool
					const process = showJetBrainsResolver([staged, selectedFile]);
					if (process && filesToRemove.length > 0) {
						const files = [...filesToRemove];
						process.on('exit', () => cleanupTmpFiles(files));
					}
				});
				break;

			case 0: // staged changes
				// get content of staging version of the selected file
				runGit(selectedFile, ":./", "staged", (staged, err) => {
					if (err) {
						return window.showErrorMessage(err);
					}
					// get content of head version of the selected file
					runGit(selectedFile, "HEAD:./", "head", (head, err) => {
						if (err) {
							return window.showErrorMessage(err);
						}
						// start jetbrains diff tool
						const process = showJetBrainsResolver([head, staged]);
						if (process && filesToRemove.length > 0) {
							const files = [...filesToRemove];
							process.on('exit', () => cleanupTmpFiles(files));
						}
					});
				});
				break;

			case 16: // merge conflicts
				// get content of head version of the selected file
				runGit(selectedFile, ":2:./", "current", (head, err) => {
					if (err) {
						return window.showErrorMessage(err);
					}
					// get content of incoming version of the selected file
					runGit(selectedFile, ":3:./", "incoming", (incoming, err) => {
						if (err) {
							return window.showErrorMessage(err);
						}

						const mergeConflictFiles: MergeConflictFiles = {
							[MergeConflictFileType.LOCAL]: head,
							[MergeConflictFileType.REMOTE]: incoming,
							[MergeConflictFileType.BASE]: selectedFile,
							[MergeConflictFileType.MERGED]: selectedFile,
						};

						if (!vscode.workspace.getConfiguration('jetbrains-diff').resolveAgainstMerged) {
							// get content of common base revision of the selected file for the merge
							runGit(selectedFile, ":1:./", "base", (base, err) => {
								if (err) {
									return window.showErrorMessage(err);
								}
								mergeConflictFiles[MergeConflictFileType.BASE] = base;
							}).then();
						}

						const process = showJetBrainsResolver([
							mergeConflictFiles[MergeConflictFileType.LOCAL],
							mergeConflictFiles[MergeConflictFileType.REMOTE],
							mergeConflictFiles[MergeConflictFileType.BASE],
							mergeConflictFiles[MergeConflictFileType.MERGED],
						]);

						if (process && filesToRemove.length > 0) {
							const files = [...filesToRemove];
							process.on('exit', () => cleanupTmpFiles(files));
						}
					});
				});
				break;

			case 7: // untracked file
				window.showInformationMessage("JetBrains Diff: No diff possible for untracked files!");
				break;

			case 1: // staged new file
				window.showInformationMessage("JetBrains Diff: No diff possible for files not yet commited!");
				break;

			default:
				window.showErrorMessage("JetBrains Diff Error: Scm diff type " + _.type + " not supported.");
				break;
		}
	}));
}

export function deactivate() {
	// delete all tmp files that are not yet deleted because vscode is closed before jetbrains diff tool
	if (vscode.workspace.getConfiguration('jetbrains-diff').cleanUpTempFilesOnCodeClose) {
		filesToRemoveGlobal.forEach((file) => unlink(file, (err) => {
			if (err) {
				outputChannel.appendLine('Unable to delete tmp file: ' + file);
			}
		}));
	}
}
