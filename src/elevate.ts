import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import sudoPrompt from '@vscode/sudo-prompt';

export interface ElevatedChild {
  socket: net.Socket;
  done: Promise<void>;
  kill: () => void;
}

function socketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\faraday-fs-${process.pid}`;
  }
  return path.join(os.tmpdir(), `faraday-fs-${process.pid}.sock`);
}

export function launchElevated(): Promise<ElevatedChild> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex');
    const sockPath = socketPath();

    const server = net.createServer({ allowHalfOpen: false });
    server.maxConnections = 1;

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

      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        socket.removeListener('data', onData);
        clearTimeout(connTimeout);
        clearTimeout(totalTimeout);

        try {
          const msg = JSON.parse(line);
          if (msg.auth !== token) {
            socket.destroy();
            server.close();
            reject(new Error('Elevated child sent invalid auth token'));
            return;
          }
        } catch {
          socket.destroy();
          server.close();
          reject(new Error('Elevated child sent malformed auth message'));
          return;
        }

        // Stop accepting new connections but keep existing socket alive
        server.close();

        const done = new Promise<void>((res) => {
          socket.on('close', res);
        });

        resolve({
          socket,
          done,
          kill: () => { socket.destroy(); },
        });
      };
      socket.on('data', onData);
    });

    server.listen(sockPath, () => {
      // Build command to re-launch ourselves with --fs
      const args = ['--fs', '--socket', sockPath, '--token', token];

      let command: string;
      if (app.isPackaged) {
        // Packaged: run the app binary directly
        command = [quote(process.execPath), ...args.map(quote)].join(' ');
      } else {
        // Dev: run electron with the app path
        command = [quote(process.execPath), quote(app.getAppPath()), ...args.map(quote)].join(' ');
      }

      sudoPrompt.exec(command, { name: 'Faraday' }, (error) => {
        if (error) {
          clearTimeout(totalTimeout);
          server.close();
          reject(error);
        }
        // If no error, child has exited — socket 'close' event handles cleanup
      });
    });

    server.on('error', (err) => {
      clearTimeout(totalTimeout);
      reject(err);
    });
  });
}

function quote(s: string): string {
  if (process.platform === 'win32') {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}
