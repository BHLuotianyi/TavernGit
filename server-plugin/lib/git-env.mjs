/**
 * The sandboxed environment every git process runs in. Together with the
 * command policy this is the hard boundary: git never sees the user's
 * global config, credential helpers, hooks, pagers or editors, and repo
 * config that could run programs is overridden at command scope.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Inherited variables. Only what git needs to start, find its helpers and
 * certificates (APK wrappers set GIT_EXEC_PATH / GIT_SSL_CAINFO), and reach
 * the network through a proxy.
 */
const PASSTHROUGH = [
    'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'LD_LIBRARY_PATH', 'PREFIX', 'ANDROID_ROOT', 'ANDROID_DATA',
    'GIT_EXEC_PATH', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'TZ',
];
const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY']);

/**
 * Copy the passthrough variables from `processEnv`. Windows variable names are
 * case-insensitive (`Path`, `SystemRoot`), POSIX ones are not, except that the
 * proxy variables are conventionally honored in lowercase too.
 * @param {NodeJS.ProcessEnv} processEnv
 * @param {NodeJS.Platform} platform
 * @returns {Record<string,string>}
 */
export function passthroughEnv(processEnv, platform) {
    const env = {};
    const wanted = new Set(PASSTHROUGH);
    for (const [name, value] of Object.entries(processEnv)) {
        if (typeof value !== 'string') continue;
        const upper = name.toUpperCase();
        const allowed = platform === 'win32'
            ? wanted.has(upper)
            : wanted.has(name) || (PROXY_NAMES.has(upper) && name === name.toLowerCase());
        if (allowed) env[name] = value;
    }
    return env;
}

/**
 * Create the private directories git is pointed at: an empty HOME, TMP, an
 * empty template dir (so `init`/`clone` copy no sample hooks) and an empty
 * hooks dir.
 * @param {string} stateDir
 */
export function prepareStateDirs(stateDir) {
    for (const dir of ['home', 'tmp', 'template', 'hooks-empty']) {
        fs.mkdirSync(path.join(stateDir, dir), { recursive: true, mode: 0o700 });
    }
}

/**
 * Command-scope config passed via GIT_CONFIG_COUNT. It has the highest
 * precedence below argv `-c`, so it overrides anything a repo config could
 * set even if the config audit missed it.
 */
function commandScopeConfig(stateDir, platform) {
    const entries = [
        ['core.hooksPath', path.join(stateDir, 'hooks-empty')],
        ['core.fsmonitor', 'false'],
        // Checked-out symlinks could point outside the ST root (CVE-2024-32002).
        ['core.symlinks', 'false'],
        ['core.protectNTFS', 'true'],
        ['core.protectHFS', 'true'],
        ['core.pager', 'cat'],
        ['core.editor', ':'],
        ['core.quotePath', 'false'],
        // An empty value resets the helper list inherited from any config.
        ['credential.helper', ''],
        ['protocol.allow', 'never'],
        ['protocol.https.allow', 'always'],
        ['submodule.recurse', 'false'],
        ['fetch.recurseSubmodules', 'false'],
        ['commit.gpgSign', 'false'],
        ['tag.gpgSign', 'false'],
        ['push.gpgSign', 'false'],
        ['log.showSignature', 'false'],
        // A detached auto-gc would outlive our timeout and process-tree kill.
        ['gc.autoDetach', 'false'],
        ['maintenance.auto', 'false'],
        ['i18n.logOutputEncoding', 'UTF-8'],
    ];
    if (platform === 'win32') entries.push(['core.longpaths', 'true']);
    return entries;
}

/**
 * Full environment for one git process.
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} options.stRoot real ST root
 * @param {{ source?: string, path?: string|null }} [options.gitInfo]
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.processEnv]
 * @param {Array<[string,string]>} [options.extraConfig] credential headers
 * @param {boolean} [options.lazyFetch] let a partial clone fetch missing
 *   objects on demand; only for commands approved as network commands
 * @returns {Record<string,string>}
 */
export function buildGitEnv({
    stateDir, stRoot, gitInfo = {}, platform = process.platform, processEnv = process.env, extraConfig = [], lazyFetch = false,
}) {
    const env = passthroughEnv(processEnv, platform);
    const home = path.join(stateDir, 'home');
    const tmp = path.join(stateDir, 'tmp');
    Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: home,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        // Only the commit identity lives here (identity.mjs).
        GIT_CONFIG_GLOBAL: path.join(stateDir, 'gitconfig'),
        // Never search for repositories above the ST root.
        GIT_CEILING_DIRECTORIES: path.dirname(stRoot),
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: ':',
        GIT_SEQUENCE_EDITOR: ':',
        GIT_MERGE_AUTOEDIT: 'no',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_PROTOCOL_FROM_USER: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TEMPLATE_DIR: path.join(stateDir, 'template'),
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
        LANG: 'C',
    });
    // Git 2.45+: without this, any command in a partial clone may contact the
    // promisor remote on its own.
    if (!lazyFetch) env.GIT_NO_LAZY_FETCH = '1';

    // MinGit ships its CA bundle and TLS backend settings in etc/gitconfig;
    // every other system config is the host's business, not ours.
    const minGitConfig = gitInfo.source === 'mingit' && gitInfo.path
        ? path.join(path.dirname(path.dirname(gitInfo.path)), 'etc', 'gitconfig')
        : null;
    if (minGitConfig && fs.existsSync(minGitConfig)) env.GIT_CONFIG_SYSTEM = minGitConfig;
    else env.GIT_CONFIG_NOSYSTEM = '1';

    const config = [...commandScopeConfig(stateDir, platform), ...extraConfig];
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    return env;
}
