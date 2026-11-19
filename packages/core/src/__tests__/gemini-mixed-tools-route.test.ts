import { afterEach, expect, it, vi } from 'vitest';
import Server from '../server';

let server: Server | undefined;
afterEach(async () => {
  try { await server?.app.close(); } finally { vi.unstubAllGlobals(); }
});

it('keeps the client search schema alongside other functions at the Messages gateway', async () => {
  const model = 'gemini-test';
  const tools = ['web_search', 'read_file'].map(name => ({ name, input_schema: { type: 'object', properties: { q: { type: 'string' } } } }));
  const upstream = vi.fn(async (_url: unknown, init: RequestInit) => {
    const wire = JSON.parse(String(init.body));
    if (wire.tools.some((tool: any) => tool.googleSearch)) return Response.json({error:{message:'unexpected builtin tool'}}, {status:400});
    return Response.json({candidates:[{content:{role:'model',parts:[{text:'ok'}]},finishReason:'STOP'}]});
  });
  vi.stubGlobal('fetch', upstream);
  const logs: string[] = [];
  const logger = { level: 'error', stream: { write(line: string) { logs.push(line); } } };
  server = new Server({logger,useJsonFile:false,initialConfig:{providers:[{name:'gemini',api_base_url:'https://example.com/v1beta/models/',api_key:'test-key',models:[model],transformer:{use:['gemini']}}], Router:{enableFallback:false}}});
  await server.ready();
  await server.registerNamespace('/');
  const send = () => server!.app.inject({method:'POST',url:'/v1/messages',payload:{model:'gemini,'+model,max_tokens:32,messages:[{role:'user',content:'hello'}],tools}});
  const response = await send();
  expect(response.statusCode, response.body).toBe(200);
  const [url, init] = upstream.mock.calls[0];
  expect(String(url)).toContain(model + ':generateContent');
  expect(JSON.parse(String(init.body)).tools[0].functionDeclarations.map((f: any) => [f.name, f.parametersJsonSchema])).toEqual(tools.map(t => [t.name, t.input_schema]));
  upstream.mockImplementation(async () => Response.json({error:{message:'fixture rejection'}},{status:400}));
  const rejected = await send();
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().error.message).toBe('fixture rejection');
  expect(logs.join(' ')).toContain('gemini,gemini-test: 400');
});
