import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';

interface Server {
    name: string;
    url: string;
    username: string;
    password: string;
}

export function activate(context: vscode.ExtensionContext) {

    const disposable = vscode.commands.registerCommand(
        'tomcat-deployer.deploy',
        async () => {

            try {

                /*
                 * OUTPUT CHANNEL
                 */
                const output =
                    vscode.window.createOutputChannel(
                        'Tomcat Deployer'
                    );

                output.clear();
                output.show(true);

                /*
                 * WORKSPACE
                 */
                const workspace =
                    vscode.workspace.workspaceFolders?.[0];

                if (!workspace) {
                    vscode.window.showErrorMessage(
                        'Workspace not found'
                    );
                    return;
                }

                const rootPath = workspace.uri.fsPath;

                /*
                 * STEP 1
                 * APP IDENTITY
                 */
                const appIdentity =
                    await vscode.window.showInputBox({
                        title: 'Tomcat Deployment',
                        prompt: 'Enter APP_IDENTITY',
                        value: 'APP',
                        ignoreFocusOut: true
                    });

                if (!appIdentity) {
                    return;
                }

                /*
                 * LOAD SERVERS
                 */
                let servers =
                    await loadServers(rootPath);

                let selectedServer: Server | undefined;

                /*
                 * SELECT SERVER
                 */
                const serverItems = servers.map(s => ({
                    label: s.name,
                    detail: s.url
                }));

                serverItems.push({
                    label: '$(add) Add New Server',
                    detail: ''
                });

                const selected =
                    await vscode.window.showQuickPick(
                        serverItems,
                        {
                            title: 'Select Tomcat Server'
                        }
                    );

                if (!selected) {
                    return;
                }

                /*
                 * ADD NEW SERVER
                 */
                if (selected.label.includes('Add New')) {

                    const url =
                        await vscode.window.showInputBox({
                            prompt: 'Tomcat URL',
                            placeHolder: 'http://localhost:8080'
                        });

                    if (!url) return;

                    const username =
                        await vscode.window.showInputBox({
                            prompt: 'Tomcat Username'
                        });

                    if (!username) return;

                    const password =
                        await vscode.window.showInputBox({
                            prompt: 'Tomcat Password',
                            password: true
                        });

                    if (!password) return;

                    selectedServer = {
                        name: extractName(url),
                        url,
                        username,
                        password
                    };

                    const save =
                        await vscode.window.showQuickPick(
                            ['Yes', 'No'],
                            {
                                title: 'Save Server ?'
                            }
                        );

                    if (save === 'Yes') {
                        servers.push(selectedServer);

                        await saveServers(
                            rootPath,
                            servers
                        );

                        vscode.window.showInformationMessage(
                            'Server saved'
                        );
                    }

                } else {

                    selectedServer =
                        servers.find(
                            s => s.name === selected.label
                        );
                }

                if (!selectedServer) {
                    return;
                }

                /*
                 * VERIFY CONNECTION
                 */
                output.appendLine('');
                output.appendLine(
                    '[*] Verifying Tomcat connection...'
                );

                const connected =
                    await checkTomcat(
                        selectedServer
                    );

                if (!connected) {

                    vscode.window.showErrorMessage(
                        'Tomcat connection failed'
                    );

                    return;
                }

                output.appendLine(
                    '[SUCCESS] Connected to Tomcat'
                );

                /*
                 * STEP 2
                 * EXTRACT PROFILE
                 */
                const profiles =
                    extractProfiles(rootPath);

                let selectedProfile: string | undefined;

                if (profiles.length > 0) {

                    selectedProfile =
                        await vscode.window.showQuickPick(
                            profiles,
                            {
                                title:
                                    'Select Maven Profile'
                            }
                        );
                }

                /*
                 * BUILD COMMAND
                 */
                let mvnCommand =
                    'mvn clean install -DskipTests';

                if (selectedProfile) {

                    mvnCommand +=
                        ` -P${selectedProfile}`;
                }

                output.appendLine('');
                output.appendLine(
                    '================================'
                );

                output.appendLine(
                    'BUILDING MAVEN PROJECT'
                );

                output.appendLine(
                    '================================'
                );

                output.appendLine(mvnCommand);
                output.appendLine('');

                /*
                 * PROGRESS
                 */
                await vscode.window.withProgress(
                    {
                        location:
                            vscode.ProgressLocation.Notification,
                        title:
                            'Deploying to Tomcat...',
                        cancellable: false
                    },
                    async (progress) => {

                        progress.report({
                            increment: 0,
                            message: 'Building WAR'
                        });

                        /*
                         * BUILD
                         */
                        const buildSuccess =
                            await runCommand(
                                mvnCommand,
                                rootPath,
                                output,
                                progress
                            );

                        if (!buildSuccess) {

                            vscode.window.showErrorMessage(
                                'Maven Build Failed'
                            );

                            return;
                        }

                        progress.report({
                            increment: 40,
                            message: 'Searching WAR'
                        });

                        /*
                         * FIND WAR
                         */
                        const war =
                            findWar(rootPath);

                        if (!war) {

                            vscode.window.showErrorMessage(
                                'WAR file not found'
                            );

                            return;
                        }

                        output.appendLine('');
                        output.appendLine(
                            `[SUCCESS] WAR Found: ${war}`
                        );

                        /*
                         * DEPLOY
                         */
                        progress.report({
                            increment: 60,
                            message:
                                'Uploading WAR to Tomcat'
                        });

                        const deployResult =
                            await deployWar(
                                selectedServer!,
                                appIdentity,
                                war,
                                output,
                                progress
                            );

                        if (deployResult.success) {

                            progress.report({
                                increment: 100,
                                message:
                                    'Deployment Success'
                            });

                            vscode.window.showInformationMessage(
                                'Tomcat Deployment Success'
                            );

                            output.appendLine('');
                            output.appendLine(
                                '================================'
                            );

                            output.appendLine(
                                'DEPLOY SUCCESS'
                            );

                            output.appendLine(
                                '================================'
                            );

                            output.appendLine(
                                deployResult.message
                            );

                        } else {

                            vscode.window.showErrorMessage(
                                'Deployment Failed'
                            );

                            output.appendLine(
                                deployResult.message
                            );
                        }
                    }
                );

            } catch (err: any) {

                vscode.window.showErrorMessage(
                    err.message
                );
            }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}

/*
|--------------------------------------------------------------------------
| LOAD SERVERS
|--------------------------------------------------------------------------
*/
async function loadServers(
    rootPath: string
): Promise<Server[]> {

    try {

        const dir =
            path.join(rootPath, 'deployment');

        const file =
            path.join(
                dir,
                'secret-tomcat.json'
            );

        if (!fs.existsSync(file)) {
            return [];
        }

        const content =
            fs.readFileSync(file, 'utf-8');

        const json = JSON.parse(content);

        return json.servers || [];

    } catch {

        return [];
    }
}

/*
|--------------------------------------------------------------------------
| SAVE SERVERS
|--------------------------------------------------------------------------
*/
async function saveServers(
    rootPath: string,
    servers: Server[]
) {

    const dir =
        path.join(rootPath, 'deployment');

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }

    const file =
        path.join(
            dir,
            'secret-tomcat.json'
        );

    fs.writeFileSync(
        file,
        JSON.stringify(
            {
                servers
            },
            null,
            4
        )
    );
}

/*
|--------------------------------------------------------------------------
| CHECK TOMCAT
|--------------------------------------------------------------------------
*/
async function checkTomcat(
    server: Server
): Promise<boolean> {

    return new Promise((resolve) => {

        try {

            const url =
                new URL(
                    `${server.url}/manager/text/list`
                );

            const auth =
                Buffer
                    .from(
                        `${server.username}:${server.password}`
                    )
                    .toString('base64');

            const lib =
                url.protocol === 'https:'
                    ? https
                    : http;

            const req = lib.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'GET',
                    headers: {
                        Authorization:
                            `Basic ${auth}`
                    }
                },
                (res) => {

                    resolve(
                        res.statusCode === 200
                    );
                }
            );

            req.on(
                'error',
                () => resolve(false)
            );

            req.end();

        } catch {

            resolve(false);
        }
    });
}

/*
|--------------------------------------------------------------------------
| RUN COMMAND
|--------------------------------------------------------------------------
*/
async function runCommand(
    cmd: string,
    cwd: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{
        message?: string;
        increment?: number;
    }>
): Promise<boolean> {

    return new Promise((resolve) => {

        const isWin =
            os.platform() === 'win32';

        const child = spawn(
            isWin ? 'cmd.exe' : 'bash',
            isWin
                ? ['/c', cmd]
                : ['-c', cmd],
            {
                cwd,
                shell: true
            }
        );

        child.stdout.on('data', (data) => {

            const text = data.toString();

            output.append(text);

            if (
                text.includes('Building war')
            ) {

                progress.report({
                    increment: 20,
                    message: 'Packaging WAR'
                });
            }
        });

        child.stderr.on('data', (data) => {

            output.append(
                data.toString()
            );
        });

        child.on('close', (code) => {

            resolve(code === 0);
        });
    });
}

/*
|--------------------------------------------------------------------------
| EXTRACT PROFILE
|--------------------------------------------------------------------------
*/
function extractProfiles(
    rootPath: string
): string[] {

    try {

        const pom =
            path.join(rootPath, 'pom.xml');

        if (!fs.existsSync(pom)) {
            return [];
        }

        const content =
            fs.readFileSync(
                pom,
                'utf-8'
            );

        const regex =
            /<profile>\s*<id>(.*?)<\/id>/gs;

        const profiles: string[] = [];

        let match;

        while (
            (match = regex.exec(content))
        ) {

            profiles.push(
                match[1].trim()
            );
        }

        return profiles;

    } catch {

        return [];
    }
}

/*
|--------------------------------------------------------------------------
| FIND WAR
|--------------------------------------------------------------------------
*/
function findWar(
    rootPath: string
): string | null {

    const target =
        path.join(rootPath, 'target');

    if (!fs.existsSync(target)) {
        return null;
    }

    const files =
        fs.readdirSync(target);

    const war =
        files.find(
            f => f.endsWith('.war')
        );

    if (!war) {
        return null;
    }

    return path.join(target, war);
}

/*
|--------------------------------------------------------------------------
| DEPLOY WAR
|--------------------------------------------------------------------------
*/
async function deployWar(
    server: Server,
    appId: string,
    warPath: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{
        message?: string;
        increment?: number;
    }>
): Promise<{
    success: boolean;
    message: string;
}> {

    return new Promise((resolve) => {

        const stat =
            fs.statSync(warPath);

        const total =
            stat.size;

        const url =
            new URL(
                `${server.url}/manager/text/deploy?path=/${appId}&update=true`
            );

        const auth =
            Buffer
                .from(
                    `${server.username}:${server.password}`
                )
                .toString('base64');

        const lib =
            url.protocol === 'https:'
                ? https
                : http;

        const req = lib.request(
            {
                hostname: url.hostname,
                port: url.port,
                path:
                    url.pathname +
                    url.search,
                method: 'PUT',
                headers: {
                    Authorization:
                        `Basic ${auth}`,
                    'Content-Type':
                        'application/octet-stream',
                    'Content-Length':
                        total
                }
            },
            (res) => {

                let body = '';

                res.on(
                    'data',
                    chunk => {
                        body += chunk;
                    }
                );

                res.on(
                    'end',
                    () => {

                        resolve({
                            success:
                                res.statusCode === 200,
                            message: body
                        });
                    }
                );
            }
        );

        req.on(
            'error',
            (err) => {

                resolve({
                    success: false,
                    message: err.message
                });
            }
        );

        const stream =
            fs.createReadStream(warPath);

        let uploaded = 0;

        stream.on('data', (chunk) => {

            uploaded += chunk.length;

            const percent =
                Math.floor(
                    (uploaded / total) * 100
                );

            progress.report({
                increment: 1,
                message:
                    `Uploading ${percent}%`
            });

            output.appendLine(
                `Uploading ${percent}%`
            );
        });

        stream.pipe(req);
    });
}

/*
|--------------------------------------------------------------------------
| EXTRACT NAME
|--------------------------------------------------------------------------
*/
function extractName(
    url: string
): string {

    return url
        .replace(/^https?:\/\//, '')
        .replace(/:\d+/, '');
}