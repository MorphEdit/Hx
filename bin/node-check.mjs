// The Node version check hx runs before loading any .ts. Plain JS, Node built-ins only: the installer reuses it.
export const NEEDED = '23.6';

// True when `version` ("23.6.0", "v24.1.0") is at least 23.6.
export function nodeOk(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  return major > 23 || (major === 23 && minor >= 6);
}

// How to get a newer Node on `platform` (a process.platform value).
export function nodeFix(platform) {
  if (platform === 'win32') return 'winget install OpenJS.NodeJS';
  if (platform === 'darwin') return 'brew install node';
  return 'download it from https://nodejs.org/';
}

// null when `version` is new enough, else the message to print before exiting 1.
export function nodeCheck(version, platform) {
  if (nodeOk(version)) return null;
  return `hx: Node ${version} is installed; hx needs Node >= ${NEEDED}.\nTo get it: ${nodeFix(platform)}`;
}
