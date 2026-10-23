import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWorklistRefresh } from '../src/lib/staff-worklist-state.ts';

test('refresh keeps removed dirty editors read-only without mutating source state', () => {
 const previous=[{id:'dirty',canManage:true,revision:1},{id:'clean',canManage:true,revision:1}];
 const result=mergeWorklistRefresh([],previous,new Set(['dirty']));
 assert.deepEqual(result,[{id:'dirty',canManage:false,revision:1,outOfView:true}]);
 assert.equal(previous[0].canManage,true);assert.equal(previous[0].outOfView,undefined);
});
test('current server state wins while the mounted editor keeps its independent draft', () => {
 const old={id:'dirty',canManage:true,revision:1};const current={id:'dirty',canManage:false,revision:2};
 assert.deepEqual(mergeWorklistRefresh([current],[old],new Set(['dirty'])),[current]);
});
test('saved or discarded items can leave the filter and returned items are not duplicated', () => {
 assert.deepEqual(mergeWorklistRefresh([],[{id:'saved',canManage:true}],new Set()),[]);
 assert.deepEqual(mergeWorklistRefresh([{id:'same',canManage:true}],[{id:'same',canManage:false,outOfView:true}],new Set(['same'])),[{id:'same',canManage:true}]);
});

test('tab-memory drafts survive a route remount but never cross authenticated actor scopes', async () => {
 const { createWorklistDraftCache } = await import('../src/lib/staff-worklist-state.ts');
 const cache=createWorklistDraftCache();const draft={note:'Unsaved',revision:4,command:{idempotencyKey:'same-key'}};
 cache.set('alice:admin','case:1',draft);
 assert.equal(cache.get('alice:admin','case:1'),draft);
 assert.equal(cache.get('bob:support','case:1'),undefined);
 assert.deepEqual(cache.entries('bob:support'),[]);
 assert.deepEqual(cache.entries('alice:admin'),[['case:1',draft]]);
 cache.delete('alice:admin','case:1');assert.deepEqual(cache.entries('alice:admin'),[]);
});

test('a delayed response cannot clear a newer restored draft', async () => {
 const { createWorklistDraftCache } = await import('../src/lib/staff-worklist-state.ts');
 const cache=createWorklistDraftCache();const submitted={note:'Submitted'};const newer={note:'Revised after Back'};
 cache.set('alice:admin','case:1',submitted);cache.set('alice:admin','case:1',newer);
 assert.equal(cache.deleteIfUnchanged('alice:admin','case:1',submitted),false);
 assert.equal(cache.deleteIfUnchanged('alice:admin','case:1',undefined),false);
 assert.equal(cache.get('alice:admin','case:1'),newer);
 assert.equal(cache.deleteIfUnchanged('alice:admin','case:1',newer),true);
 assert.equal(cache.get('alice:admin','case:1'),undefined);
});

test('draft discard applies only to real same-tab route exits', async () => {
 const { shouldGuardWorklistLink }=await import('../src/lib/staff-worklist-state.ts');
 const link={currentHref:'https://example.invalid/staff/worklist?filter=all',nextHref:'https://example.invalid/admin'};
 assert.equal(shouldGuardWorklistLink(link),true);
 for(const override of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{target:'_blank'},{download:true},{defaultPrevented:true},{nextHref:'mailto:support@example.invalid'},{nextHref:link.currentHref+'#section'}])assert.equal(shouldGuardWorklistLink({...link,...override}),false);
});
