export function connectionExample(origin: string, service: string, method: string) {
  if (method === "typescript")
    return `import { TraceyardClient } from './traceyard-client';

const traceyard = new TraceyardClient({
  origin: ${JSON.stringify(origin)},
  apiKey: process.env.TRACEYARD_KEY!,
  onTelemetryError: error => console.error(error.message)
});

await traceyard.span('Connection check', async () => {
  return { ready: true };
}, { kind: 'workflow', attributes: { service: ${JSON.stringify(service)} } });`;
  return `// Node.js 22+ — direct HTTP, no SDK required.
const startedAt = new Date().toISOString();
const response = await fetch(${JSON.stringify(origin + "/api/v1/traces")}, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + process.env.TRACEYARD_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ spans: [{
    traceId: crypto.randomUUID().replaceAll('-', ''),
    spanId: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
    name: 'Connection check', kind: 'workflow',
    status: 'SUCCEEDED', startedAt,
    endedAt: new Date().toISOString(),
    attributes: { service: ${JSON.stringify(service)} }
  }] })
});
if (!response.ok) throw new Error(await response.text());
console.log('Trace accepted');`;
}
