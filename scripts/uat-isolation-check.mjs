// Run only inside the exact UAT unit sandbox. No external connection attempted.
import net from 'node:net';
import fs from 'node:fs';
const denied = (operation, codes) => {
  try { operation(); } catch (error) { if (codes.includes(error.code)) return; throw error; }
  throw new Error('Isolation is not enforced');
};
try {
  if (process.getuid() === 0 || process.env.BUBBLEWASH_UAT_ENABLED !== 'true') throw new Error();
  await new Promise((resolve, reject) => {
    const socket = net.connect({host:'127.0.0.1', port:9});
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error()); });
    socket.once('connect', () => { socket.destroy(); reject(new Error()); });
    socket.once('error', error => error.code === 'EPERM' ? resolve() : reject(error));
  });
  const target='/opt/bubblewash-uat/app/SOURCE_REVISION';
  const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n')
    .map(line => line.split(' ')).filter(parts => target===parts[4] || target.startsWith(parts[4].replace(/\/$/,'')+'/'))
    .sort((a,b) => b[4].length-a[4].length);
  if (!mounts[0]?.[5].split(',').includes('ro')) throw new Error('App mount is writable');
  // Opening without truncation cannot alter the installed release, even on failure.
  denied(() => { const fd=fs.openSync('/opt/bubblewash-uat/app/SOURCE_REVISION','r+'); fs.closeSync(fd); }, ['EROFS','EACCES']);
  for (const path of ['/home','/root']) denied(() => fs.readdirSync(path), ['EACCES','EPERM']);
  const probe='/var/lib/bubblewash-uat/.isolation-write-probe';
  const fd=fs.openSync(probe,'wx',0o600); fs.closeSync(fd); fs.unlinkSync(probe);
  process.stdout.write('{"ok":true,"outboundConnect":"EPERM","appReadOnly":true,"homeHidden":true}\n');
} catch { process.stderr.write('UAT isolation probe failed.\n'); process.exitCode=1; }
