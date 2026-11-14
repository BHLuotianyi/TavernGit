/**
 * node:test reporter that turns each failing test into a GitHub Actions
 * `::error` annotation, so failures show on the run summary and the PR diff
 * without opening the log. Used next to the spec reporter in CI:
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *       --test-reporter=./tools/gha-reporter.mjs --test-reporter-destination=stdout
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

function relativeFile(file) {
    if (!file) return null;
    const abs = file.startsWith('file:') ? fileURLToPath(file) : file;
    return path.relative(process.cwd(), abs).split(path.sep).join('/');
}

export default async function* githubAnnotations(source) {
    for await (const event of source) {
        if (event.type !== 'test:fail') continue;
        const { name, file, line, details } = event.data;
        const error = details?.error;
        // A suite fails when a child fails; the child carries the annotation.
        if (error?.failureType === 'subtestsFailed') continue;
        const cause = error?.cause ?? error;
        const message = `${name}: ${cause?.stack || cause?.message || String(cause)}`;
        const rel = relativeFile(file);
        const location = rel ? ` file=${escapeProperty(rel)}${line ? `,line=${line}` : ''}` : '';
        yield `::error${location},title=${escapeProperty(`Test failed: ${name}`)}::${escapeData(message)}\n`;
    }
}
