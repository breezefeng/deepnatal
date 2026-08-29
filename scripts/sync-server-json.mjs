/**
 * Propagate package.json's version into server.json.
 *
 * Run automatically by the `version` npm lifecycle script, i.e. during
 * `npm version <patch|minor|major>`, before the release commit is created.
 *
 * Why this is a script and not a note in the README: the MCP Registry
 * validates that server.json's version corresponds to a real published npm
 * version. Get them out of step and the publish fails — but only at the very
 * end, after a release has already gone out to npm. Cheap to automate, and
 * annoying in an asymmetric way to forget.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

server.version = pkg.version;

if (!Array.isArray(server.packages) || server.packages.length === 0) {
  throw new Error('server.json has no packages[] entry to update.');
}
for (const entry of server.packages) {
  entry.version = pkg.version;
}

// The registry cross-checks this against the tarball; drift means a rejected
// publish, so fail loudly here instead of shipping a mismatch.
if (server.name !== pkg.mcpName) {
  throw new Error(
    `server.json name (${server.name}) does not match package.json mcpName (${pkg.mcpName}).\n` +
      'The MCP Registry compares these directly and will reject the submission.',
  );
}

writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json synced to ${pkg.version}`);
