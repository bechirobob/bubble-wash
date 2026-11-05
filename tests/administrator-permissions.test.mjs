import assert from 'node:assert/strict';
import test from 'node:test';
import { canEnterOperationalWorkspaces, canReadSurveyResults } from '../src/lib/staff-permissions.ts';
for (const role of ['admin', 'vendor', 'driver', 'support']) {
  test(`${role}: independent permissions and temporary access boundaries`, () => {
    for (const temporaryAccess of [false, true]) for (const allStaffAccess of [false, true]) {
      const user = { role, temporaryAccess, allStaffAccess };
      const owner = role === 'admin' && !temporaryAccess && allStaffAccess;
      assert.equal(canEnterOperationalWorkspaces(user), owner);
      assert.equal(canReadSurveyResults(user), owner);
      assert.equal(canEnterOperationalWorkspaces({ ...user, operationalWorkspaceAccess: true }), role === 'admin' && !temporaryAccess);
      assert.equal(canReadSurveyResults({ ...user, operationalWorkspaceAccess: true }), owner);
      assert.equal(canReadSurveyResults({ ...user, surveyResultsAccess: true }), role === 'admin' && !temporaryAccess);
      assert.equal(canEnterOperationalWorkspaces({ ...user, surveyResultsAccess: true }), owner);
    }
  });
}
test('missing identities fail closed', () => {
  for (const user of [null, undefined]) { assert.equal(canEnterOperationalWorkspaces(user), false); assert.equal(canReadSurveyResults(user), false); }
});
