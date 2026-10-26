// Operator-only, explicit stdin interface. Never pass passwords as CLI arguments.
// Install/run only inside a cleared synthetic UAT environment; never production.
import { createUatAccount, revokeUatAccount, issueUatCohort } from '../src/lib/uat-accounts.ts';
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';
try {
  assertUatEnvironment();
  if (process.argv.length > 2) throw new Error('Arguments are not accepted; use private standard input.');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 8192) throw new Error('Input too large.');
  }
  const request = JSON.parse(input);
  input = '';
  if (request.action === 'issue') {
    const result = issueUatCohort(request.accounts, request.actor);
    for (const account of request.accounts) account.password = '';
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } else if (request.action === 'create') {
    const result = createUatAccount(request.account, request.actor);
    request.account.password = '';
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } else if (request.action === 'revoke') {
    revokeUatAccount(request.username, request.actor);
    process.stdout.write(JSON.stringify({ ok: true, revoked: true }) + '\n');
  } else throw new Error('Unsupported action.');
} catch {
  // No SQL parameters, identifiers, input or credentials in operator error logs.
  process.stderr.write('UAT account operation refused. Check the approved environment and input.\n');
  process.exitCode = 1;
}
