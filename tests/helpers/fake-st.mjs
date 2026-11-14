import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a throwaway SillyTavern-shaped root:
 * `server.js`, `package.json {name: sillytavern}`, `data/default-user/`,
 * `public/`, `plugins/taverngit/`. Returns real paths.
 */
export function makeFakeSt() {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-st-')));
    const root = path.join(base, 'SillyTavern');
    for (const dir of ['data/default-user/chats', 'data/default-user/extensions', 'public/scripts/extensions/third-party', 'plugins/taverngit/state']) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'server.js'), '// fake\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
    return {
        base,
        root,
        dataRoot: path.join(root, 'data'),
        serverPluginDir: path.join(root, 'plugins', 'taverngit'),
        cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    };
}
