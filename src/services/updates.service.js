// 2026-08-20 ZYPPAR-STYLE UPDATE SERVICE (verbatim from zypparserver):
// the update check reads version.txt, normalizes client/server versions,
// and returns flexible vs immediate based on the major version.
// 2026-09-18 BUILD 94 THE VERSION THAT TICKS (founder: "increase the
// digits/integers of update version to properly reflect version state.
// Currently, it abbreviates so that we can appear to be perpetually stuck
// on .31 instead of showing increments like .316"): the server's advertised
// version now COMPOSES from its own package.json build — 0.3.<serverBuild>
// — so the check response ticks with every deploy. The old version.txt
// (stale 0.3.186 from the build-186 era) is no longer the source; the build
// counter is the truth everywhere, client and server alike.
const fs = require('fs/promises');
const path = require('path');

const versionFilePath = path.resolve(process.cwd(), 'version.txt');

const updateService = {
  getUpdateStatus,
};

/**
 * Normalizes a version string by removing any non-numeric prefixes or suffixes.
 * For example, "RolodexAI - version 0.3.1" becomes "0.3.1".
 */
function normalizeVersion(version) {
  if (!version) return undefined;

  const versionMatch = String(version).match(/\d+\.\d+\.\d+/);
  return versionMatch ? versionMatch[0] : undefined;
}

async function getUpdateStatus(clientVersion) {
  let serverBuild = 0;
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    serverBuild = Number(packageJson.build) || 0;
  } catch { /* 0 -> 0.3.0 */ }
  const currentVersion = `0.3.${serverBuild}`;

  const normalizedClientVersion = normalizeVersion(clientVersion);
  const normalizedCurrentVersion = normalizeVersion(currentVersion);

  // Invalid client version -> force an update
  if (!normalizedClientVersion) {
    return {
      version: normalizedCurrentVersion || currentVersion,
      type: 'immediate',
      timestamp: new Date().toISOString(),
    };
  }

  const isMajorUpdate =
    normalizedClientVersion.split('.')[0] !== normalizedCurrentVersion?.split('.')[0];

  return {
    version: normalizedCurrentVersion || currentVersion,
    type: isMajorUpdate ? 'immediate' : 'flexible',
    timestamp: new Date().toISOString(),
  };
}

module.exports = updateService;
