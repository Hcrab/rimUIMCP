import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {Bridge} from '../packages/runtime/src/bridge.ts';

test('Chinese controls and names round-trip through the existing character-counting GABP receiver', async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let pending = '';
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      for (;;) {
        const boundary = pending.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const length = Number(pending.slice(0,boundary).match(/Content-Length: (\d+)/i)?.[1]);
        if (pending.length < boundary + 4 + length) return;
        const body = pending.slice(boundary + 4,boundary + 4 + length);
        pending = pending.slice(boundary + 4 + length);
        const request = JSON.parse(body);
        const response = Buffer.from(JSON.stringify({id:request.id,result:request.params}),'utf8');
        socket.write(Buffer.concat([Buffer.from(`Content-Length: ${response.length}\r\n\r\n`),response]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address() as net.AddressInfo;
  const bridge = new Bridge({host:'127.0.0.1',port:address.port,token:'test'});
  try {
    await bridge.connect();
    const parameters = {name:'新建殖民地',nickname:'沈知微',note:'中文、é、🐷、换行\n和\\反斜杠'};
    assert.deepEqual(await bridge.request('tools/call',parameters,1000),parameters);
    assert.deepEqual(await bridge.request('tools/call',{name:'Next'},1000),{name:'Next'});
  } finally {
    bridge.close();
    for(const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
