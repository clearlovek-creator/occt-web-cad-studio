import assert from 'node:assert/strict';
import { createServer } from 'node:http';
function stateToken(value) { if (typeof value === 'string') {
    try {
        return stateToken(JSON.parse(value));
    }
    catch {
        return null;
    }
} if (!value || typeof value !== 'object')
    return null; if (typeof value.stateToken === 'string')
    return value.stateToken; for (const item of Object.values(value)) {
    const found = stateToken(item);
    if (found)
        return found;
} return null; }
/** A local protocol fixture, not a language-model intelligence or availability
 * benchmark. It requires real CAD receipts before issuing the next tool call. */
export async function startCadModelFixture() {
    const requests = [], tools = [], errors = [];
    const server = createServer(async (request, response) => {
        try {
            assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.method, 'POST');
            const parts = [];
            let size = 0;
            for await (const part of request) {
                size += part.length;
                assert.ok(size < 2 * 1024 * 1024);
                parts.push(part);
            }
            const body = JSON.parse(Buffer.concat(parts));
            assert.equal(body.model, requests.length < 3 ? 'sdk-fixture' : 'sdk-fixture-vision');
            requests.push(body);
            const phase = requests.length;
            assert.ok(body.tools.some(tool => tool.function?.name === 'query_model'));
            assert.ok(body.tools.some(tool => tool.function?.name === 'primitive__box'));
            let delta, finish;
            if (phase === 1) {
                delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'sdk-ui-query', type: 'function', function: { name: 'query_model', arguments: JSON.stringify({ kind: 'geometry-tree' }) } }] };
                finish = 'tool_calls';
                tools.push('query_model');
            }
            else if (phase === 2) {
                const observed = stateToken(body.messages.filter(message => message.role === 'tool'));
                assert.match(observed, /^[a-f0-9]{64}$/);
                delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'sdk-ui-box', type: 'function', function: { name: 'primitive__box', arguments: JSON.stringify({ baseStateToken: observed, parameters: { width: 10, depth: 20, height: 30 } }) } }] };
                finish = 'tool_calls';
                tools.push('primitive__box');
            }
            else if (phase === 3) {
                assert.ok(body.messages.filter(message => message.role === 'tool').length >= 2);
                delta = { role: 'assistant', content: 'The CAD tool confirmed one box.' };
                finish = 'stop';
            }
            else {
                assert.equal(phase, 4, 'No repeated model or CAD command');
                const user = body.messages.filter(message => message.role === 'user').at(-1);
                assert.match(JSON.stringify(user.content), /SDK skill instructions marker/);
                assert.ok(user.content.some(part => part.type === 'image_url' && /^data:image\/png;base64,/.test(part.image_url.url)));
                delta = { role: 'assistant', content: 'The image and skill reached the model.' };
                finish = 'stop';
            }
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const chunk = (delta, reason) => ({ id: 'sdk-ui-' + phase, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] });
            response.write('data: ' + JSON.stringify(chunk(delta, null)) + '\n\n');
            response.write('data: ' + JSON.stringify(chunk({}, finish)) + '\n\n');
            response.end('data: [DONE]\n\n');
        }
        catch (error) {
            errors.push(error.message);
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'Local SDK acceptance fixture failed' } }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { requests, tools, errors, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
