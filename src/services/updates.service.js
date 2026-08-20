// 2026-08-20 ZYPPAR-STYLE UPDATE SERVICE (verbatim from zypparserver):
// the update check reads version.txt, normalizes client/server versions,
// and returns flexible vs immediate based on the major version.
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
  let currentVersion;
  try {
    currentVersion = (await fs.readFile(versionFilePath, 'utf8')).trim();
  } catch (err) {
    console.error('Failed to read version file:', { error: err.message });

    // Fallback to package.json
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    currentVersion = packageJson.version;

    // Auto-create version.txt with the fallback version
    await fs.writeFile(versionFilePath, currentVersion, 'utf8');
  }

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
