---
"@sorb/juice": minor
---

Figma reference artifact endpoints + figma-vs-tokens diff.

Adds `POST /tokens/figma` (store a Figma-exported resolved-map artifact) and
`GET /tokens/figma` (retrieve it), plus `GET /verify/figma` — a
format-insensitive diff between the stored Figma export and the bridge's own
`.sorb/resolved.json` DTCG source, mirroring the existing `/verify/app`
compare loop. DTCG stays the source of truth; the Figma-side artifact is
authoring-drift detection only (never auto-resolved). `POST /verify/app`
behavior is unchanged (regression-tested).
