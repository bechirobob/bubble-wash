# Bounded lists and clearer wording

This presentation-only change uses the existing compact Bubble Wash layout. It does not change authorization, assignments, payment actions, reference allocation, notification delivery, or the logo.

## Included

- A shared list shows up to ten loaded rows per page, a visible item range, and Previous/Next buttons outside a responsive scrolling region. Rows have separators. The list height is capped at 60% of the viewport, with a desktop/mobile maximum.
- Recent activity, order queues and histories, case queues and histories, vendor/rider/staff rosters, sign-in accounts, route stops, privacy requests, staff worklists, assignment options, payment/message reviews, invoice items/payment history, and customer booking references/history use it.
- Rows remain mounted when paging. Unsaved row drafts and open forms are preserved. Refreshing keeps focus with the same keyed row; if a focused row disappears, focus returns to its list. External filters and customer request forms remain outside their scrolling regions.
- Native keyboard scrolling and Tab navigation are retained. There is no wheel/keyboard interception or scroll containment. Buttons have at least 44px height. Invoice lines retain definition-list semantics.
- The three colored map-marker shadow rings are removed. The decorative fresh-activity edge is neutral. Status text remains available.
- Staff labels use wording such as “Assignment options,” “Payment review,” “Saved order updates,” and “Staff record ID.” Delivery-service acceptance still explicitly does not mean confirmed delivery. Reset-account warnings still explain immediate sign-out on every device.

## Boundaries

The range describes loaded rows, not a count of the whole database. Existing server limits and authorization remain unchanged. “Older records” loads a further server page when available; each loaded set is locally paged. Static short navigation, plan cards, native select options, and security recovery codes are not converted to list widgets.

This is not a redesign of pricing or a normalization of legacy references. It does not enable resending messages, moving money, changing provider settings, or installing native apps.

## Verification

Pure pagination tests cover 0, 3, 50 and 51 rows, clamping and invalid inputs. Actual React static-render tests check mounted hidden rows, range/controls, loading/empty states, header semantics and invoice definitions. The browser job additionally includes desktop and mobile interactions for keyboard paging, preserved drafts, reordered/removed focus, empty filters, customer invoice/history scrolling and shadow scans. Its intercepted data is synthetic presentation data; the original real temporary-database role/command tests remain in the same suite.

Static rendering, source checks and HTTP smoke tests are not graphical acceptance. The browser suite must run successfully before treating layout, touch/keyboard behavior or screenshots as visually verified.

## Neutral decorative edges

Public and staff surfaces share neutral `--line`, `--line-strong`, `--line-active`, and `--focus-ring` tokens. Decorative dividers, card edges, overdue/new-item rails, selected-row rails, form borders and module separators use those tokens. Selection still has its existing line width, background, text and ARIA state. Focus keeps its visible width and offset. Status text/icons, brand fills and map-route/marker meaning are unchanged.

Authored box/text shadows are disabled at the shared base and rejected by regression tests. The only colored-border exceptions are the solid filled navigation CTA edge and active live-location status dot, whose border matches their fill. Forced-colors system outlines remain an accessibility exception; no global border override replaces native controls or validation.

The source check parses every application stylesheet, audits inline style properties and SVG assets, and rejects colored token overrides and new shadow filters. Browser evidence checks every painted border side, pseudo-element, outline and shadow on the existing public pricing, four-role staff, worklist and customer-history journeys. Source coverage includes styles for states not visited in those journeys; browser coverage is representative, not a claim that every possible data/state combination was rendered.

Capacity work identifies vendors by their readable names instead of internal keys. If no readable name is available, it uses a generic capacity title rather than exposing the key. Internal message keys are not displayed. Backend keys, ownership commands, React identity, audit attribution and useful order/case/invoice references remain unchanged.
