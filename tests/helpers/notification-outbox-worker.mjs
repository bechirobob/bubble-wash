// Deliberately mocked provider, in a separate process sharing only the test DB.
// Never fall through to a real fetch, even if the worker is misconfigured.
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Response.json({ id: `mock-${process.pid}-${calls}` });
};
const { processNotificationOutbox } = await import('../../src/lib/notifications.ts');
process.on('message', async (message) => {
  if (message !== 'start') return;
  try {
    const results = await processNotificationOutbox(10);
    process.send({ results, calls });
  } catch (error) {
    process.send({ error: error.message, calls });
  } finally {
    process.disconnect();
  }
});
process.send({ ready: true });
