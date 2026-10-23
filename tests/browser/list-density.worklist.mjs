import { expectNeutralDecoration } from './decoration-checks.mjs';
import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  if (!['/staff/worklist', '/manage'].includes(new URL(page.url()).pathname)) return;
  await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true, animations: 'disabled', timeout: 5000 }).catch(() => {});
});

// These intercepted responses are presentation fixtures only. The unchanged
// staff-worklists suite exercises actual cookie authorization and safe commands.
const tasks=()=>Array.from({length:51},(_,i)=>({id:`case-followup:SYNTHETIC-${i}`,kind:'case-followup',targetId:`SYNTHETIC-${i}`,title:`Synthetic task ${i+1}`,detail:'Synthetic list layout fixture. No customer data.',priority:'normal',dueAt:'',signalVersion:`synthetic-${i}`,ownerEmail:'',note:'',revision:0,updatedAt:'',overdue:false,canManage:true}));
async function prepare(page,testInfo) {
 await page.context().setExtraHTTPHeaders({'x-forwarded-for':`192.0.2.${testInfo.project.name.startsWith('desktop')?81:82}`});
 await page.context().route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
 const response=await page.request.post('/api/login',{headers:{origin:'http://localhost:3195'},data:{email:'admin@example.invalid',password:'synthetic-admin-password-123'}});
 expect(response.status()).toBe(200);
}
async function capture(page,testInfo,label) {
  await expectNeutralDecoration(page);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 // Include the map's status markers and all pseudo elements, not just buttons.
 const shadows=await page.locator('body *').evaluateAll(nodes=>nodes.flatMap(node=>['', '::before', '::after'].map(pseudo=>getComputedStyle(node,pseudo||null)).filter(s=>s.boxShadow!=='none'||s.textShadow!=='none'||s.filter.includes('drop-shadow')).map(s=>({box:s.boxShadow,text:s.textShadow,filter:s.filter}))));
 expect(shadows).toEqual([]);
 await page.screenshot({path:testInfo.outputPath(`${label}.png`),fullPage:true,animations:'disabled'});
}

test('51 tasks page by keyboard, keep drafts, clamp refresh and retain focus',async({page},testInfo)=>{
 await prepare(page,testInfo);
 let items=tasks();let responses=0;
 await page.route('**/api/staff/automation/worklist?**',route=>{responses++;return route.fulfill({json:{ok:true,items,nextOffset:null,scope:'Synthetic loaded records',generatedAt:'2026-10-23T10:00:00Z'}});});
 await page.goto('/staff/worklist?filter=all');
 const region=page.getByRole('region',{name:'Worklist',exact:true});
 const list=region.getByRole('list');
 await expect(list.getByRole('listitem')).toHaveCount(10);
 await expect(region.locator('[data-list-row-key]')).toHaveCount(51);
 await expect(page.getByText('1–10 of 51 tasks loaded',{exact:true})).toBeVisible();
 const first=region.getByRole('listitem').filter({has:page.getByText('Synthetic task 1',{exact:true})});
 await first.getByText('Owner and follow-up deadline',{exact:true}).click();
 await first.getByLabel('Next step').fill('Unsaved draft stays with this task');
 const next=page.getByRole('button',{name:'Next page of Worklist',exact:true});
 await next.focus();await page.keyboard.press('Enter');
 await expect(region).toBeFocused();await expect(page.getByText('11–20 of 51 tasks loaded',{exact:true})).toBeVisible();
 await expect(list.getByRole('listitem')).toHaveCount(10);
 await page.getByRole('button',{name:'Previous page of Worklist',exact:true}).click();
 await expect(first.getByLabel('Next step')).toHaveValue('Unsaved draft stays with this task');
 await expect(first.getByLabel('Next step')).toBeVisible();
 // A refresh reorders a focused row, without moving focus to a different item.
 await first.getByLabel('Next step').focus();items=[...items.slice(1),items[0]];
 const previousResponses=responses;
 await page.getByRole('button',{name:'Refresh',exact:true}).evaluate(button=>button.click());
 await expect.poll(()=>responses).toBeGreaterThan(previousResponses);
 await expect(page.getByText('51–51 of 51 tasks loaded',{exact:true})).toBeVisible();
 await expect(first.getByLabel('Next step')).toBeFocused();
 await expect(first.getByLabel('Next step')).toHaveValue('Unsaved draft stays with this task');
 await expect(next).toBeDisabled();
 await capture(page,testInfo,'long-worklist-last-page');
 // Discard this fixture draft, then refresh to a short list. The page clamps.
 await first.getByLabel('Next step').fill('');items=items.slice(0,3);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await expect(page.getByText('1–3 of 3 tasks loaded',{exact:true})).toBeVisible();
 await expect(next).toHaveCount(0);
 // A background refresh removes the focused clean row. Focus goes to its region,
 // never a hidden row or the body. A filter control remains independently usable.
 const summary=region.getByRole('listitem').first().locator('summary');await summary.focus();
 items=[];await page.getByRole('button',{name:'Refresh',exact:true}).evaluate(button=>button.click());
 await expect(page.getByText('No tasks to show',{exact:true})).toBeVisible();await expect(region).toBeFocused();
 await page.getByRole('link',{name:'Overdue',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(page).toHaveURL(/filter=overdue/);await expect(page.getByRole('link',{name:'Overdue',exact:true})).toBeFocused();
 await capture(page,testInfo,'empty-filtered-worklist');
});

test('customer history, invoice and references are bounded independently of the request form',async({page},testInfo)=>{
 await page.context().route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
 const date='2026-10-23T10:00:00Z';
 await page.route('**/api/customer/order',route=>route.fulfill({json:{order:{orderId:'SYNTHETIC-CUSTOMER',customer:'Synthetic customer',createdAt:date,updatedAt:date,status:'Washing',nextStep:'We will update you when it is ready.',area:'Synthetic area',pickupAddress:'Synthetic pickup address',plan:'Weekly',service:'Wash + fold',pickupDate:'2026-10-23',pickupWindow:'8:00–10:00',invoice:{invoiceId:'SYNTHETIC-INVOICE',lines:Array.from({length:50},(_,i)=>({label:`Synthetic item ${i+1}`,amountMinor:100})),balanceMinor:5000,status:'Open'},timeline:Array.from({length:50},(_,i)=>({createdAt:date,status:`Synthetic update ${i+1}. The team checked the collection, counted each item and recorded the care instructions. The laundry is being prepared for its next scheduled step, and a further update will appear after the next check.`,type:'synthetic'}))},references:Array.from({length:50},(_,i)=>({orderId:`SYNTHETIC-BOOKING-${i+1}`,createdAt:date}))}}));
 await page.goto('/manage');
 const history=page.getByRole('region',{name:'Order history',exact:true});await expect(history.getByRole('listitem')).toHaveCount(10);
 const invoice=page.getByRole('region',{name:'Invoice items',exact:true});await expect(invoice.locator('dl')).toHaveCount(1);await expect(invoice.locator('dl > div:not([hidden])')).toHaveCount(10);await expect(invoice.getByRole('list')).toHaveCount(0);
 await page.getByLabel('Details',{exact:true}).fill('A customer request draft');
 await page.getByRole('button',{name:'Next page of Order history',exact:true}).click();
 await expect(page.getByText('11–20 of 50 updates loaded',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Details',{exact:true})).toHaveValue('A customer request draft');
 await expect.poll(()=>history.evaluate(el=>el.clientHeight<=Math.min(innerHeight*.6,576)+1)).toBe(true);
 await expect.poll(()=>history.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 await history.focus();await page.keyboard.press('End');await expect.poll(()=>history.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 // Tab is not captured. It can leave the scroll region for its page controls.
 await page.keyboard.press('Tab');await expect(history).not.toBeFocused();
 await capture(page,testInfo,'customer-paged-history');
});
