import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { MSG_AUTH } from './protocol';

export interface ElevatedChild {
  socket: net.Socket;
  done: Promise<void>;
  kill: () => void;
}

function helperPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, `faraday-helper${ext}`);
  }
  return path.join(app.getAppPath(), 'native-zig', 'zig-out', 'bin', `faraday-helper${ext}`);
}

function socketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\faraday-fs-${process.pid}`;
  }
  return path.join(os.tmpdir(), `faraday-fs-${process.pid}.sock`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function spawnElevated(helper: string, args: string[]): ChildProcess {
  if (process.platform === 'darwin') {
    const cmd = [helper, ...args].map(shellQuote).join(' ');
    const asStr = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return spawn('osascript', ['-e', `do shell script "${asStr}" with administrator privileges`]);
  }

  if (process.platform === 'linux') {
    return spawn('pkexec', [helper, ...args]);
  }

  // Windows: PowerShell elevation — pass --ppid so helper can monitor parent
  const psArgs = args.map((a) => `'${a}'`).join(', ');
  return spawn('powershell', ['-Command', `Start-Process -FilePath '${helper}' -ArgumentList ${psArgs} -Verb RunAs -Wait`]);
}

export function launchElevated(): Promise<ElevatedChild> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex');
    const sockPath = socketPath();
    const helper = helperPath();

    const server = net.createServer({ allowHalfOpen: false });
    server.maxConnections = 1;

    let child: ChildProcess;

    const totalTimeout = setTimeout(() => {
      server.close();
      reject(new Error('Elevated child did not connect within 30s'));
    }, 30_000);

    server.once('connection', (socket) => {
      const connTimeout = setTimeout(() => {
        socket.destroy();
        server.close();
        reject(new Error('Elevated child did not authenticate within 5s'));
      }, 5_000);

      let authBuf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        authBuf = Buffer.concat([authBuf, chunk]);
        if (authBuf.length < 4) return;
        const msgLen = authBuf.readUInt32LE(0);
        if (authBuf.length < 4 + msgLen) return;

        socket.removeListener('data', onData);
        clearTimeout(connTimeout);
        clearTimeout(totalTimeout);

        const type = authBuf[4];
        if (type !== MSG_AUTH) {
          socket.destroy();
          server.close();
          reject(new Error('Elevated child sent invalid message type'));
          return;
        }

        const receivedToken = authBuf.subarray(5, 4 + msgLen).toString('ascii');
        if (receivedToken !== token) {
          socket.destroy();
          server.close();
          reject(new Error('Elevated child sent invalid auth token'));
          return;
        }

        server.close();

        const done = new Promise<void>((res) => {
          socket.on('close', res);
        });

        resolve({
          socket,
          done,
          kill: () => {
            socket.destroy();
            child.kill();
          },
        });
      };
      socket.on('data', onData);
    });

    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* best-effort */
      }
      child = spawnElevated(helper, ['--socket', sockPath, '--token', token, '--ppid', String(process.pid)]);

      child.on('exit', (code) => {
        if (code !== 0) {
          clearTimeout(totalTimeout);
          server.close();
          reject(new Error(`Elevated helper exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(totalTimeout);
        server.close();
        reject(err);
      });
    });

    server.on('error', (err) => {
      clearTimeout(totalTimeout);
      reject(err);
    });
  });
}
