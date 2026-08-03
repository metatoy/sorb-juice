# Sorb Conformance Evidence Report

_Descriptive conformance evidence: the tokens the running app resolves, checked against the tokens the design system declares._

> **Disclaimer.** This report is descriptive conformance evidence for the WCAG 1.4.3 / 1.4.6 contrast criteria over the token-governed slice of the named application. It is not a full accessibility audit and not a warranty or guarantee of WCAG compliance. Automated checks do not detect all accessibility issues.

**Scope:** WCAG 1.4.3 / 1.4.6 contrast only — not a full-site accessibility audit.

- **Application:** Acme Storefront
- **Environment:** production
- **Generated:** 2026-08-03T00:00:00Z

## Summary

| Category | Count | Meaning (descriptive) |
| --- | --- | --- |
| Drifted | 3 | declared value ≠ value the running app resolves |
| Missing | 1 | declared, but the running app resolves no value |
| Extra | 1 | the running app resolves a value that is not declared |
| Total divergences | 5 | drifted + missing + extra |

## Drifted — declared value differs from resolved

| Token (CSS var) | Tier | Type | Declared | Resolved |
| --- | --- | --- | --- | --- |
| --color-text-primary | semantic | color | #222222 | #111111 |
| --button-primary-bg-default | component | color | #0f65ef | #1a70ff |
| --button-radius | component | dimension | 4px | 6px |

## Missing — declared but not resolved in the running app

| Token (CSS var) | Tier | Declared |
| --- | --- | --- |
| --radius-control | semantic | 4px |

## Extra — resolved in the running app but not declared

| Token (CSS var) | Resolved |
| --- | --- |
| --shadow-elevated | 0 2px 8px rgba(0,0,0,0.15) |
