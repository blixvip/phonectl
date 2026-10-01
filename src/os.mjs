// Per-OS bits (opening files/URLs, terminals, install hints) and the optional user config.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const WIN = process.platform === 'win32';
export const MAC = process.platform === 'darwin';

// ~/.phonectl/config.json — optional, e.g. { "projectRoots": ["~/code"], "phoneIp": "192.168.1.42" }
export const CONFIG = (() => {
  try { return JSON.parse(readFileSync(path.join(homedir(), '.phonectl', 'config.json'), 'utf8')); } catch { return {}; }
})();

export const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, homedir());

const detach = (cmd, argv, opts = {}) => spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true, ...opts }).unref();

/** Opens a URL, file or folder with the OS default app. */
export function openPath(target) {
  if (WIN) detach('cmd.exe', ['/c', 'start', '', target]);
  else detach(MAC ? 'open' : 'xdg-open', [target]);
}

/** Runs a command in a new visible terminal window (for interactive CLIs like Expo). */
export function openTerminal(cmd, cwd, title) {
  if (WIN) return detach('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/k', cmd], { cwd, windowsHide: false });
  if (MAC) return detach('osascript', ['-e', `tell application "Terminal" to do script "cd " & quoted form of ${JSON.stringify(cwd)} & " && ${cmd}"`]);
  detach('x-terminal-emulator', ['-e', 'sh', '-c', `cd "${cwd}" && ${cmd}; exec sh`], { cwd });
}

export function installHint(tool) {
  if (WIN) return tool === 'adb' ? 'winget install Google.PlatformTools' : 'winget install Genymobile.scrcpy';
  if (MAC) return tool === 'adb' ? 'brew install android-platform-tools' : 'brew install scrcpy';
  return tool === 'adb' ? 'sudo apt install adb' : 'sudo apt install scrcpy  (or see github.com/Genymobile/scrcpy)';
}
