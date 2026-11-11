/** @file Regression for socket FIN during body backpressure in the production HTTP client. */
import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute = promisify(execFile);

test("delayed, cancelled and truncated response bodies cannot terminate the Sage process", async () => {
  const source = `
    import {createServer} from 'node:net';
    import {sageFetch} from ${JSON.stringify(new URL("../lib/httpTransport.mjs", import.meta.url).href)};
    import assert from 'node:assert/strict';
    for (const framing of ['length','chunked','eof','truncated','cancel']) {
      const body=Buffer.alloc(65536,97);
      const server=createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>{
        const extra=framing==='eof'?'':framing==='chunked'?'Transfer-Encoding: chunked\\r\\n':'Content-Length: '+(framing==='truncated'?body.length+1:body.length)+'\\r\\n';
        socket.write('HTTP/1.1 200 OK\\r\\n'+extra+'Connection: close\\r\\n\\r\\n');
        if(framing==='chunked')socket.end(body.length.toString(16)+'\\r\\n'+body.toString()+'\\r\\n0\\r\\n\\r\\n');else socket.end(body);
      });});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      const response=await sageFetch('http://127.0.0.1:'+server.address().port);
      await new Promise(r=>setTimeout(r,100));
      if(framing==='cancel') await response.body.cancel();
      else if(framing==='truncated') await assert.rejects(response.arrayBuffer());
      else assert.equal((await response.arrayBuffer()).byteLength,body.length);
      await new Promise(r=>server.close(r));
    }
    console.log('all socket-close cases survived');
  `;
  const result = await execute(process.execPath, ["--input-type=module", "-e", source], {timeout: 15000, windowsHide: true});
  assert.match(result.stdout, /all socket-close cases survived/);
  assert.doesNotMatch(result.stderr, /AssertionError/);
});
