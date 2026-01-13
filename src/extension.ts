import { join } from 'path';
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync } from 'fs';
import { get } from 'https';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(ctx: vscode.ExtensionContext) {
    const root = ctx.asAbsolutePath(join('out', 'JMCC'));
    mkdirSync(join(root, 'assets'), { recursive: true });
    const outputChannel = vscode.window.createOutputChannel('JustCode Language Server');
    ctx.subscriptions.push(outputChannel);
    
    const paths = {
        main: join(root, 'jmcc.py'),
        server: join(root, 'server.py'),
        prop: join(root, 'jmcc.properties'),
        compEn: join(root, 'assets', 'completions_en_US.json'),
        compRu: join(root, 'assets', 'completions_ru_RU.json'),
        sounds: join(root, 'data', 'sounds.json')
    };

    const getPy = () => vscode.workspace.getConfiguration('jmcc').get<string>('compilerPath') || (process.platform === 'win32' ? 'python' : 'python3');
    const dl = (url: string, dst: string) => new Promise<void>(r => get(url, res => res.pipe(createWriteStream(dst)).on('finish', r)));
    
    let syncing = false;
    const sync = (toFile: boolean) => {
        if (syncing || !existsSync(paths.prop)) return;
        syncing = true;
        try {
            const cfg = vscode.workspace.getConfiguration('jmcc.properties');
            let content = readFileSync(paths.prop, 'utf8');

            if (toFile) {
                ['auto_update', 'check_beta_versions', 'check_updates', 'lang', 'create_world_restart_function', 
                 'create_function_descriptions', 'code_line_limit', 'default_variable_type', 'optimize_code'].forEach(key => {
                    const val = cfg.get(key), pyVal = typeof val === 'boolean' ? (val ? 'True' : 'False') : val;
                    content = content.replace(new RegExp(`^${key}\\s*=.*`, 'm'), `${key} = ${pyVal}`);
                });
                writeFileSync(paths.prop, content);
            } else {
                content.split('\n').forEach(line => {
                    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
                    if (m && !['release_version', 'data_version', 'current_version'].includes(m[1])) {
                        const [_, k, vRaw] = m, v = vRaw.trim();
                        const val = v.toLowerCase() === 'true' ? true : v.toLowerCase() === 'false' ? false : !isNaN(Number(v)) ? Number(v) : v;
                        if (cfg.get(k) !== val) cfg.update(k, val, vscode.ConfigurationTarget.Global);
                    }
                });
            }
        } catch (e) { console.error(e); } finally { syncing = false; }
    };

    if (!existsSync(paths.main)) await dl('https://raw.githubusercontent.com/donzgold/JustMC_compilator/master/jmcc.py', paths.main);
    
    if (!existsSync(paths.prop)) {
        await new Promise<void>(r => exec(`${getPy()} "${paths.main}"`, { cwd: root }, () => r()));
        if (existsSync(paths.prop)) {
            const content = readFileSync(paths.prop, 'utf8').replace(/^auto_update\s*=.*$/m, 'auto_update = True');
            writeFileSync(paths.prop, content);
            sync(false);
        }
    } else {
        sync(false);
    }
    
    const assetsBaseUrl = 'https://raw.githubusercontent.com/donzgold/JustMC_compilator/master/assets/';

    get('https://raw.githubusercontent.com/donzgold/JustMC_compilator/master/jmcc.properties', res => {
        let remote = '';
        res.on('data', d => remote += d).on('end', async () => {
            const rVer = remote.match(/data_version\s*=\s*(\d+)/)?.[1];
            const lVer = existsSync(paths.prop) ? readFileSync(paths.prop, 'utf8').match(/data_version\s*=\s*(\d+)/)?.[1] : null;
            if (rVer && lVer && rVer !== lVer) {
                let localContent = readFileSync(paths.prop, 'utf8');
                localContent = localContent.replace(/data_version\s*=\s*\d+/, `data_version = ${rVer}`);
                writeFileSync(paths.prop, localContent);
                await dl(assetsBaseUrl + 'completions_en_US.json', paths.compEn);
                await dl(assetsBaseUrl + 'completions_ru_RU.json', paths.compRu);
                sync(false);
            }
        });
    });

    if (!existsSync(paths.compEn)) await dl(assetsBaseUrl + 'completions_en_US.json', paths.compEn);
    if (!existsSync(paths.compRu)) await dl(assetsBaseUrl + 'completions_ru_RU.json', paths.compRu);

    if (!existsSync(paths.sounds)) await dl('https://raw.githubusercontent.com/noumenxn/JMCC-helper/main/src/sounds.json', paths.sounds);
    
    const startLS = async () => {
        if (client) await client.stop();
        client = new LanguageClient(
            'jmcc', 
            'JustCode Language Server', 
            { command: getPy(), args: [paths.server], options: { cwd: root } }, 
            { 
                documentSelector: [{ language: 'jmcc' }], 
                initializationOptions: vscode.workspace.getConfiguration('jmcc'),
                outputChannel: outputChannel
            }
        );
        client.start().catch(() => {});
    };
    
    startLS();
    
    const run = (flags: string, target?: string) => {
        const doc = vscode.window.activeTextEditor?.document;
        const path = target || (doc?.languageId === 'jmcc' ? doc.fileName : null);
        if (!path) return;
        if (doc?.isDirty) doc.save();
        const term = vscode.window.terminals.find(t => t.name === 'JMCC') || vscode.window.createTerminal('JMCC');
        term.show(true);
        if (vscode.workspace.getConfiguration('jmcc').get('clearTerminal')) term.sendText(process.platform === 'win32' ? 'cls' : 'clear');
        const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))?.uri.fsPath;
        const finalTarget = flags.includes('PROJECT') ? `"${ws}"` : `"${path}"`;
        const cmdFlags = flags.replace(/PROJECT|OBFUSCATE/g, '').trim(); 
        const outPath = vscode.workspace.getConfiguration('jmcc').get('compilerOutputPath');
        
        term.sendText(`${getPy()} "${paths.main}" compile ${finalTarget} ${cmdFlags} ${outPath ? `-o "${outPath}"` : ''}`);
    };
    
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'jmcc.properties'));
    ctx.subscriptions.push(watcher.onDidChange(() => sync(false)), watcher.onDidCreate(() => sync(false)));

    ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jmcc.properties')) {
                sync(true);
                if (e.affectsConfiguration('jmcc.properties.lang')) {
                    startLS();
                }
            }
            if (['hideCompletion', 'hideHover', 'hideSignatureHelp'].some(k => e.affectsConfiguration(`jmcc.${k}`))) startLS();
        }),
        vscode.commands.registerCommand('jmcc.decompile.json', () => {
            const p = vscode.window.activeTextEditor?.document.fileName;
            if (p?.endsWith('.json')) {
                const t = vscode.window.terminals.find(x => x.name === 'JMCC') || vscode.window.createTerminal('JMCC');
                t.show(true);
                t.sendText(`${getPy()} "${paths.main}" decompile "${p}"`);
            }
        }),
        ...Object.entries({
            'project': 'PROJECT', 'file': '', 'url': '-u', 'both': '-su'
        }).map(([k, v]) => vscode.commands.registerCommand(`jmcc.compile.${k}`, () => run(v)))
    );
}

export function deactivate() { return client?.stop(); }