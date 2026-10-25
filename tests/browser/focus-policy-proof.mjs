import assert from 'node:assert/strict';
import { webkit } from '@playwright/test';

const outline = locator => locator.evaluate(element => ({
  style: getComputedStyle(element).outlineStyle, width: parseFloat(getComputedStyle(element).outlineWidth),
  focused: document.activeElement === element,
}));
async function ring(locator, expected, label) {
  const actual = await outline(locator);
  assert.equal(actual.style !== 'none' && actual.width >= 2, expected, `${label}: ${JSON.stringify(actual)}`);
}
async function tabTo(page, target) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(element => element === document.activeElement)) return;
  }
  throw new Error('Keyboard could not reach target');
}

// Called by the existing Browser workflow, against temporary SQLite and synthetic
// sessions only. No submitted forms, invitations, real accounts or outbound email.
export async function verifyFocusPolicy({ browser, fixture, origin, output }) {
  const safari = await webkit.launch({ headless: true });
  const checks = [];
  try {
    for (const [name, engine, mobile] of [['desktop-chromium', browser, false], ['mobile-webkit', safari, true]]) {
      // Without hydration the global native focus-visible fallback remains usable.
      const nativeContext = await engine.newContext({ javaScriptEnabled: false, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
      try {
        await nativeContext.route('**/*', route => new URL(route.request().url()).origin === origin && ['GET','HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
        const nativePage = await nativeContext.newPage();
        await nativePage.goto(origin + '/survey/consumer');
        assert.equal(await nativePage.locator('html').getAttribute('data-input-modality'), null);
        const nativeButton = nativePage.getByRole('button', { name: 'Yes, I am 18 or older', exact: true });
        await tabTo(nativePage, nativeButton); await ring(nativeButton, true, 'unhydrated native keyboard fallback');
        await nativePage.screenshot({ path: output + `focus-${name}-native-fallback.png`, fullPage: true });
      } finally { await nativeContext.close(); }
      const context = await engine.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      const errors = [];
      try {
        await context.route('**/*', route => {
          const request = route.request();
          // Browser proof is read-only even inside the synthetic environment.
          return new URL(request.url()).origin === origin && ['GET','HEAD'].includes(request.method()) ? route.continue() : route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        const press = async locator => mobile ? locator.tap() : locator.click();
        // Public customer control and editing cue, without attempting sign-in.
        await page.goto(origin + '/manage');
        const input = page.locator('input:not([type=hidden]):not([disabled])').first();
        await press(input); await ring(input, true, 'customer editing cue');
        const customerButton = page.locator('button[type=submit]').first();
        await tabTo(page, customerButton); await ring(customerButton, true, 'customer keyboard button');
        await page.screenshot({ path: output + `focus-${name}-customer-keyboard.png`, fullPage: true });
        // Open survey: pointer-triggered step heading and keyboard navigation.
        await page.goto(origin + '/survey/consumer');
        await press(page.getByRole('button', { name: /18 or older/ }));
        await press(page.getByLabel('Full name', { exact: true })); await ring(page.getByLabel('Full name', { exact: true }), true, 'survey text editing');
        await page.getByLabel('Full name', { exact: true }).fill('Synthetic Focus Test');
        await page.getByLabel('Email address', { exact: true }).fill('focus@example.invalid');
        await page.getByLabel('Phone number', { exact: true }).fill('0200000000');
        await press(page.getByRole('radio', { name: 'Yes, I agree', exact: true }));
        await ring(page.getByRole('radio', { name: 'Yes, I agree', exact: true }), false, 'survey pointer radio');
        await press(page.getByRole('button', { name: 'Continue', exact: true }));
        const heading = page.locator('h1[tabindex="-1"]');
        await heading.evaluate(element => new Promise(resolve => requestAnimationFrame(() => resolve(element === document.activeElement))));
        assert.equal((await outline(heading)).focused, true); await ring(heading, false, 'pointer step heading');
        await page.screenshot({ path: output + `focus-${name}-survey-pointer.png`, fullPage: true });
        await page.keyboard.press('Tab');
        await ring(page.locator(':focus'), true, 'survey switches back to keyboard');
        // Staff workspace uses its real server-rendered navigation with fixture session.
        await context.addCookies([{ name: 'bubblewash_staff_session', value: fixture.sessions.vendor, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', secure: false }]);
        await page.goto(origin + '/vendors');
        const staffNav = page.getByRole('navigation', { name: 'vendor workspace sections', exact: true });
        await staffNav.waitFor(); const staffLink = staffNav.getByRole('link').first();
        await tabTo(page, staffLink); await ring(staffLink, true, 'staff keyboard navigation');
        // Owner Results reproduces both reported bugs with the actual scroll region/dialog.
        await context.addCookies([{ name: 'bubblewash_staff_session', value: fixture.sessions.owner, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', secure: false }]);
        await page.goto(origin + '/admin/surveys');
        await page.getByRole('heading', {name:'Survey results',exact:true}).waitFor();
        const questionnaire = page.getByRole('combobox', { name:'Questionnaire', exact:true });
        await questionnaire.waitFor();
        const restingBorder = await questionnaire.evaluate(element => getComputedStyle(element).borderColor);
        await press(questionnaire);
        assert.equal(await page.locator('html').getAttribute('data-input-modality'), 'pointer');
        await ring(questionnaire, false, 'survey select touch has no additional ring');
        assert.equal(await questionnaire.evaluate(element => getComputedStyle(element).borderColor), restingBorder, 'touch does not change resting select border');
        await page.screenshot({path:output+`survey-${name}-select-pointer.png`,fullPage:true});
        await page.keyboard.press('Escape');
        await tabTo(page, questionnaire); await ring(questionnaire, true, 'survey select reachable with visible keyboard focus');
        await page.screenshot({path:output+`survey-${name}-select-keyboard.png`,fullPage:true});
        if (!mobile) {
          await page.emulateMedia({forcedColors:'active'});
          await press(questionnaire); await ring(questionnaire, true, 'forced-colors select focus remains visible');
          await page.keyboard.press('Escape'); await page.emulateMedia({forcedColors:'none'});
        }
        await press(questionnaire); await ring(questionnaire, false, 'survey select returns to unchanged touch appearance');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        checks.push(`${name}: native survey select pointer border unchanged, keyboard focus and forced-colors policy verified`);
        await press(page.getByRole('tab', { name: 'Responses', exact: true }));
        const list = page.getByRole('region', { name: 'Survey responses', exact: true });
        await list.waitFor();
        await press(list.locator('li').first().locator('strong').first());
        // Some engines do not focus scroll containers on touch; focus is deliberately
        // transferred here to assert the programmatic case without changing modality.
        await list.focus(); await ring(list, false, 'pointer/programmatic response list');
        // Synthetic lifecycle coverage only, not physical browser-chrome testing.
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        assert.equal(await page.locator('html').getAttribute('data-input-modality'), null);
        await page.keyboard.press('ArrowDown'); await ring(list, true, 'keyboard after window lifecycle reset');
        await press(list.locator('li').first().locator('strong').first());
        await list.focus(); await ring(list, false, 'pointer after lifecycle reset');
        await page.screenshot({ path: output + `focus-${name}-responses-pointer.png`, fullPage: true });
        if (!mobile) {
          // A system-colour focus cue must survive high-contrast pointer mode.
          await page.emulateMedia({ forcedColors: 'active' });
          await list.evaluate(element => { element.style.outline = '3px solid CanvasText'; });
          await ring(list, true, 'forced-colors cue is not suppressed');
          await list.evaluate(element => { element.style.removeProperty('outline'); });
          await page.emulateMedia({ forcedColors: 'none' });
          await ring(list, false, 'ordinary pointer policy restored');
        }
        const open = page.getByRole('button', { name: /Open response from/ }).first();
        await press(open);
        const close = page.getByRole('button', { name: 'Close response', exact: true });
        await close.waitFor(); assert.equal((await outline(close)).focused, true);
        await ring(close, false, 'pointer-opened dialog close');
        await page.screenshot({ path: output + `focus-${name}-dialog-pointer.png`, fullPage: true });
        // Native dialogs may visit browser chrome after their final control.
        // Inspect the actual focus path; never require the previous button to
        // retain focus or programmatically move focus to satisfy the assertion.
        await page.keyboard.press('Tab');
        const focusHop = await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          browserBoundary: document.activeElement === document.body,
          insideDialog: Boolean(document.querySelector('dialog[open]')?.contains(document.activeElement)),
        }));
        console.log(`focus-path ${name} ${JSON.stringify(focusHop)}`);
        if (focusHop.browserBoundary) await page.keyboard.press('Tab');
        const activeDialogTarget = page.locator('dialog[open]:focus, dialog[open] :focus');
        assert.equal(await activeDialogTarget.count(), 1, 'Tab returns to modal, never a background control');
        await ring(activeDialogTarget, true, 'actual dialog keyboard focus');
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').isVisible(), false);
        await tabTo(page, list); await ring(list, true, 'keyboard response list');
        await page.screenshot({ path: output + `focus-${name}-responses-keyboard.png`, fullPage: true });
        await tabTo(page, open); await page.keyboard.press('Enter');
        await close.waitFor(); await ring(close, true, 'keyboard-opened dialog close');
        await page.screenshot({ path: output + `focus-${name}-dialog-keyboard.png`, fullPage: true });
        await press(close);
        await press(open); await ring(close, false, 'repeated pointer modal after keyboard');
        await press(close);
        // Scripted activation is not assistive technology and must not reclassify
        // the preceding pointer action. Trusted zero-detail handling has a unit contract.
        await open.evaluate(element => element.click()); await close.waitFor();
        await ring(close, false, 'scripted activation retains pointer modality');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        checks.push(`${name}: customer, survey, staff and Results pointer/keyboard focus, editing cues, repeated modal, scripted click + screenshots (real AT not tested)`);
      } finally { await context.close(); }
    }
  } finally { await safari.close(); }
  return checks;
}
