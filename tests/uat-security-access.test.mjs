import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canManageStaffSecurity } from '../src/lib/staff-security-access.ts';
import { canViewResearchResults } from '../src/lib/research/access.ts';

test('temporary staff have no identity/security administration or owner research capability', () => {
  for (const role of ['admin', 'support', 'vendor', 'driver']) {
    assert.equal(canManageStaffSecurity({ role, temporaryAccess: true }), false);
    assert.equal(canViewResearchResults({ role, temporaryAccess: true, allStaffAccess: true }), false);
  }
  for (const user of [null, undefined, { role: 'support' }, { role: 'vendor' }, { role: 'driver' }]) {
    assert.equal(canManageStaffSecurity(user), false);
    assert.equal(canViewResearchResults(user), false);
  }
  assert.equal(canManageStaffSecurity({ role: 'admin' }), true);
  assert.equal(canManageStaffSecurity({ role: 'admin', allStaffAccess: true }), true);
  assert.equal(canViewResearchResults({ role: 'admin' }), false);
  assert.equal(canViewResearchResults({ role: 'admin', allStaffAccess: true }), true);
});

test('security capability is applied at API boundaries, not merely hidden in UI', () => {
  for (const path of ['staff/accounts', 'admin/operations', 'admin/mfa/enroll', 'ready']) {
    const source = readFileSync(new URL(`../src/app/api/${path}/route.ts`, import.meta.url), 'utf8');
    assert.match(source, /canManageStaffSecurity\(/, path);
  }
  const recovery = readFileSync(new URL('../src/app/api/admin/recover/route.ts', import.meta.url), 'utf8');
  assert.match(recovery, /BUBBLEWASH_UAT_ENABLED === "true"/);
  assert.ok(recovery.indexOf('BUBBLEWASH_UAT_ENABLED') < recovery.indexOf('await request.json()'));
});

test('UAT presentation follows server validation and hides excluded security controls', () => {
  const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const page = read('app/login/page.tsx');
  assert.match(page, /assertUatEnvironment\(\); uat = true/);
  assert.match(page, /<LoginPageClient uat=\{uat\}/);
  const login = read('components/LoginPage.tsx');
  assert.match(login, /uat \? "Test username"/);
  assert.match(login, /!uat && showCredentialCards/);
  assert.match(login, /!uat && \(adminMfaRequired/);
  const workspace = read('components/StaffWorkspaces.tsx');
  assert.match(workspace, /temporaryAccess \? <UatTestAccounts \/> : <StaffAccountPanel/);
  assert.match(workspace, /Privacy administration is excluded from temporary UAT access/);
  assert.match(read('app/admin/page.tsx'), /temporaryAccess=\{user.temporaryAccess\}/);
  const layout = read('app/layout.tsx');
  assert.match(layout, /Synthetic test data only/);
  assert.match(layout, /UAT configuration is incomplete/);
  assert.match(layout, /robots: \{ index: false, follow: false \}/);
});
