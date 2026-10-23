import { expect } from '@playwright/test';

// Only solid brand-button edges and the live-status dot are colored borders.
// Map strokes, status text/icons, fills and native validation are not decoration.
export async function expectNeutralDecoration(page) {
  const violations = await page.locator('body *').evaluateAll(nodes => {
    const failures = [];
    const neutral = value => {
      const parts = value.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return parts && (parts[3] === 0 || Math.max(...parts.slice(0, 3)) - Math.min(...parts.slice(0, 3)) <= 1);
    };
    for (const node of nodes) for (const pseudo of ['', '::before', '::after']) {
      const style = getComputedStyle(node, pseudo || null);
      const label = `${node.tagName}.${typeof node.className === 'string' ? node.className : ''}${pseudo}`;
      if (style.boxShadow !== 'none' || style.textShadow !== 'none' || style.filter.includes('drop-shadow')) failures.push(`${label}: shadow`);
      if (!node.getClientRects().length || style.display === 'none' || style.visibility === 'hidden' || (pseudo && ['none', 'normal'].includes(style.content))) continue;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (!parseFloat(style[`border${side}Width`]) || ['none', 'hidden'].includes(style[`border${side}Style`])) continue;
        const color = style[`border${side}Color`];
        const solidFunctionalEdge = !pseudo && node.matches('.navCta, .liveShareIndicator.is-on') && color === style.backgroundColor;
        if (!neutral(color) && !solidFunctionalEdge) failures.push(`${label}: ${side} border ${color}`);
      }
      if (parseFloat(style.outlineWidth) && !['none', 'hidden'].includes(style.outlineStyle) && !neutral(style.outlineColor) && !matchMedia('(forced-colors: active)').matches) failures.push(`${label}: outline ${style.outlineColor}`);
    }
    return failures;
  });
  expect(violations, 'Shared neutral decorative edges, neutral focus and no shadows').toEqual([]);
}
