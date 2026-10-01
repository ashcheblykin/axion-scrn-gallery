import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Periodic refresh on the designer's machine: SSO sessions and VPN live there, CI cannot log in.
 * macOS → launchd agent, Linux → crontab line. Both call `scrn refresh --commit --push`.
 */

const LABEL = 'ai.axion.scrn.refresh';

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** "m h dom mon dow" → launchd StartCalendarInterval (only fixed values; `*` = every). */
function calendarInterval(cron: string): string {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  const entry = (key: string, v: string | undefined) => (v && v !== '*' && /^\d+$/.test(v) ? `<key>${key}</key><integer>${Number(v)}</integer>` : '');
  const weekdays = weekday && weekday !== '*' ? expandList(weekday) : [undefined];
  return weekdays
    .map((w) => `<dict>${entry('Minute', minute)}${entry('Hour', hour)}${entry('Day', day)}${entry('Month', month)}${entry('Weekday', w)}</dict>`)
    .join('');
}

function expandList(v: string): string[] {
  return v.split(',').flatMap((part) => {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (!m) return [part];
    const out: string[] = [];
    for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(String(i));
    return out;
  });
}

export function refreshCommand(root: string): string[] {
  const cli = path.join(root, 'dist', 'cli', 'index.js');
  return [process.execPath, cli, 'refresh', '--commit', '--push'];
}

export function installSchedule(root: string, cron: string): string {
  const cmd = refreshCommand(root);
  const logDir = path.join(root, '.scrn');
  fs.mkdirSync(logDir, { recursive: true });
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${cmd.map((c) => `<string>${c}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH ?? '/usr/bin:/bin'}</string></dict>
  <key>StartCalendarInterval</key><array>${calendarInterval(cron)}</array>
  <key>StandardOutPath</key><string>${path.join(logDir, 'schedule.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'schedule.log')}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    try {
      execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' });
    } catch {
      /* not loaded yet */
    }
    execFileSync('launchctl', ['load', plistPath()]);
    return `launchd: ${plistPath()} (${cron})`;
  }
  const line = `${cron} cd ${JSON.stringify(root)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')} >> ${JSON.stringify(path.join(logDir, 'schedule.log'))} 2>&1 # ${LABEL}`;
  let current = '';
  try {
    current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    current = '';
  }
  const next = [...current.split('\n').filter((l) => l && !l.includes(LABEL)), line].join('\n') + '\n';
  execFileSync('crontab', ['-'], { input: next });
  return `crontab: ${line}`;
}

export function uninstallSchedule(): string {
  if (process.platform === 'darwin') {
    if (fs.existsSync(plistPath())) {
      try {
        execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
      fs.rmSync(plistPath());
      return `удалён ${plistPath()}`;
    }
    return 'расписание не установлено';
  }
  try {
    const current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const next = current.split('\n').filter((l) => l && !l.includes(LABEL)).join('\n') + '\n';
    execFileSync('crontab', ['-'], { input: next });
    return 'строка удалена из crontab';
  } catch {
    return 'расписание не установлено';
  }
}

/** Best-effort desktop notification (session expired, unsafe screens…). */
export function notify(title: string, message: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execFileSync('notify-send', [title, message], { stdio: 'ignore' });
    }
  } catch {
    // no notification daemon — the log is enough
  }
}
