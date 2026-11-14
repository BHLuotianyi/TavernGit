import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { locateStRoot, resolveDataRoot } from '../../server-plugin/lib/st-root.mjs';
import { createZones, parseVPath, resolveVPath, toVPath } from '../../server-plugin/lib/vfs.mjs';
import { makeFakeSt } from '../helpers/fake-st.mjs';

const st = makeFakeSt();
after(() => st.cleanup());

const caseInsensitive = false;
const ctx = { stRoot: st.root, caseInsensitive };

function zonesFor(dataRoot = st.dataRoot) {
    return createZones({ stRoot: st.root, dataRoot: resolveDataRoot(st.root, { caseInsensitive, dataRoot }), handle: 'default-user' });
}

function code(fn) {
    try {
        fn();
    } catch (error) {
        return error.code;
    }
    return 'no error';
}

describe('st-root', () => {
    it('finds the root for both install layouts', () => {
        assert.equal(locateStRoot(st.serverPluginDir), st.root);
        assert.equal(locateStRoot(path.join(st.serverPluginDir, 'server-plugin')), st.root);
    });

    it('rejects a directory without the sillytavern package', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nost-'));
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'server.js'), '');
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"other"}');
        assert.equal(locateStRoot(path.join(dir, 'a', 'b')), null);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to config.yaml dataRoot when DATA_ROOT is not global (ST 1.12.0-1.12.3)', () => {
        fs.writeFileSync(path.join(st.root, 'config.yaml'), "port: 8000\ndataRoot: './data' # comment\n");
        assert.deepEqual(resolveDataRoot(st.root, { caseInsensitive }), { real: st.dataRoot, inside: true, rel: 'data' });
        fs.rmSync(path.join(st.root, 'config.yaml'));
        assert.equal(resolveDataRoot(st.root, { caseInsensitive }).real, null);
    });
});

describe('vfs', () => {
    const zones = zonesFor();

    it('rejects traversal, unknown zones and backslashes', () => {
        assert.equal(code(() => resolveVPath('@ST/../etc', zones, ctx)), 'TG_INVALID_PATH');
        assert.equal(code(() => resolveVPath('@STfoo/x', zones, ctx)), 'TG_INVALID_PATH');
        assert.equal(code(() => resolveVPath('@ST\\data', zones, ctx)), 'TG_INVALID_PATH');
        assert.equal(code(() => resolveVPath('@ST/a:b', zones, ctx)), 'TG_INVALID_PATH');
        assert.equal(code(() => resolveVPath('~/x', zones, ctx)), 'TG_INVALID_PATH');
    });

    it('drops empty and dot segments', () => {
        assert.deepEqual(parseVPath('@STuser//./chats/'), { zone: 'STuser', segments: ['chats'] });
    });

    it('rejects symlinks that escape the root', { skip: process.platform === 'win32' }, () => {
        fs.symlinkSync(os.tmpdir(), path.join(st.dataRoot, 'out'));
        assert.equal(code(() => resolveVPath('@STdata/out/x', zones, ctx)), 'TG_PATH_OUTSIDE_ROOT');
    });

    it('reports display and the most specific alias', () => {
        const resolved = resolveVPath('@STuser/chats', zones, ctx);
        assert.equal(resolved.display, '@ST/data/default-user/chats');
        assert.equal(resolved.alias, '@STuser/chats');
        assert.equal(resolved.zone, 'STuser');
        assert.equal(resolved.exists, true);
        const viaRoot = resolveVPath('@ST/data/default-user/chats', zones, ctx);
        assert.equal(viaRoot.alias, '@STuser/chats');
        assert.equal(resolveVPath('@ST', zones, ctx).display, '@ST');
        assert.equal(resolveVPath('@ST/new/dir', zones, ctx).exists, false);
    });

    it('marks data zones unavailable when the data root is outside', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-data-'));
        const external = zonesFor(outside);
        assert.equal(code(() => resolveVPath('@STdata/x', external, ctx)), 'TG_ZONE_UNAVAILABLE');
        assert.equal(code(() => resolveVPath('@STuser/x', external, ctx)), 'TG_ZONE_UNAVAILABLE');
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('maps absolute paths back to @ST', () => {
        assert.equal(toVPath(path.join(st.root, 'plugins', 'taverngit', 'mingit'), ctx), '@ST/plugins/taverngit/mingit');
        assert.equal(toVPath(os.tmpdir(), ctx), null);
    });
});
