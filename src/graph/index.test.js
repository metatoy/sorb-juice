import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBindingGraph,
  usagesOf,
  idsForCssVar,
  aliasGroup,
  blastRadius,
  themeSlice,
  graftPlan,
} from './index.js'

// ─── Fixtures (mirror the real sorb-demo .sorb/ shapes) ──────────────────────

// Subset of sorb-demo/.sorb/resolved.json — the tokens our fixture binds, plus
// the alias chain (#0f65ef across component → semantic → primitive) and a
// dimension token (button.radius) for the type-mismatch graft case.
const RESOLVED = [
  // primitive blue 500 — what the semantic/component blues resolve to
  { id: 'color.blue.500', cssVar: '--color-blue-500', value: '#0f65ef', tier: 'primitive', type: 'color' },
  // semantic alias of blue.500
  { id: 'color.action.primary', cssVar: '--color-action-primary', value: '#0f65ef', tier: 'semantic', type: 'color' },
  // component tokens for Primary (alias of the semantic/primitive blue)
  { id: 'button.primary.bg.default', cssVar: '--button-primary-bg-default', value: '#0f65ef', tier: 'component', type: 'color' },
  { id: 'button.primary.border.default', cssVar: '--button-primary-border-default', value: '#0f65ef', tier: 'component', type: 'color' },
  { id: 'button.primary.text.default', cssVar: '--button-primary-text-default', value: '#ffffff', tier: 'component', type: 'color' },
  // dimension token (radius) — a different type
  { id: 'button.radius', cssVar: '--button-radius', value: '4px', tier: 'component', type: 'dimension' },
  // component tokens for Danger (the graft target)
  { id: 'button.danger.bg.default', cssVar: '--button-danger-bg-default', value: '#ee3322', tier: 'component', type: 'color' },
  { id: 'button.danger.border.default', cssVar: '--button-danger-border-default', value: '#ee3322', tier: 'component', type: 'color' },
  { id: 'button.danger.text.default', cssVar: '--button-danger-text-default', value: '#ffffff', tier: 'component', type: 'color' },
]

// Primary button artifact — exact shape of sorb-demo/.sorb/Button.sorb.json:
// frame binds fill/stroke/cornerRadius; child TEXT binds fill.
const PRIMARY_ARTIFACT = {
  stories: [
    {
      id: 'components-button--primary',
      name: 'Primary',
      component: 'Button',
      root: {
        type: 'FRAME',
        name: 'Button',
        sorb: {
          tokens: {
            fill: 'button.primary.bg.default',
            stroke: 'button.primary.border.default',
            cornerRadius: 'button.radius',
          },
        },
        children: [
          {
            type: 'TEXT',
            name: 'label',
            sorb: { tokens: { fill: 'button.primary.text.default' } },
          },
        ],
      },
    },
  ],
}

// A second fixture component — Danger variant — for graft tests. Note: its TEXT
// node uses role `fontFill` to exercise a "no compatible target role" conflict,
// and the frame deliberately has NO cornerRadius so grafting radius is a conflict.
const DANGER_ARTIFACT = {
  stories: [
    {
      id: 'components-button--danger',
      name: 'Danger',
      component: 'Button',
      root: {
        type: 'FRAME',
        name: 'Button',
        sorb: {
          tokens: {
            fill: 'button.danger.bg.default',
            stroke: 'button.danger.border.default',
          },
        },
        children: [
          {
            type: 'TEXT',
            name: 'label',
            sorb: { tokens: { fill: 'button.danger.text.default' } },
          },
        ],
      },
    },
  ],
}

const makeGraph = () => buildBindingGraph(RESOLVED, [PRIMARY_ARTIFACT, DANGER_ARTIFACT])

// ─── P1: binding graph + usages ──────────────────────────────────────────────

describe('buildBindingGraph + usagesOf (P1)', () => {
  it('indexes every node.sorb.tokens edge across the tree (frame + child TEXT)', () => {
    const g = makeGraph()
    // 4 bindings on Primary: fill, stroke, cornerRadius (frame) + fill (text).
    const story = g.stories.get('components-button--primary')
    assert.equal(story.bindings.length, 4)
    assert.equal(story.component, 'Button')
  })

  it('usagesOf(button.primary.bg.default) → the Primary button + role fill', () => {
    const g = makeGraph()
    const r = usagesOf(g, 'button.primary.bg.default')
    assert.equal(r.id, 'button.primary.bg.default')
    assert.equal(r.cssVar, '--button-primary-bg-default')
    assert.equal(r.count, 1)
    assert.deepEqual(r.components, [{ storyId: 'components-button--primary', role: 'fill' }])
  })

  it('text-role binding is reachable (child TEXT fill)', () => {
    const g = makeGraph()
    const r = usagesOf(g, 'button.primary.text.default')
    assert.equal(r.count, 1)
    assert.deepEqual(r.components, [{ storyId: 'components-button--primary', role: 'fill' }])
  })

  it('unknown token → count 0, components [], not an error', () => {
    const g = makeGraph()
    const r = usagesOf(g, 'does.not.exist')
    assert.equal(r.count, 0)
    assert.deepEqual(r.components, [])
    assert.equal(r.cssVar, null)
  })

  it('idsForCssVar resolves a var → its token id(s)', () => {
    const g = makeGraph()
    assert.deepEqual(idsForCssVar(g, '--button-primary-bg-default'), ['button.primary.bg.default'])
    assert.deepEqual(idsForCssVar(g, '--nope'), [])
  })

  it('cssVar query unions usages across all ids emitting that var', () => {
    const g = makeGraph()
    // --button-primary-bg-default maps to one id, bound once.
    const ids = idsForCssVar(g, '--button-primary-bg-default')
    let count = 0
    for (const id of ids) count += usagesOf(g, id).count
    assert.equal(count, 1)
  })
})

// ─── P2: alias chain + blast radius ──────────────────────────────────────────

describe('aliasGroup + blastRadius (P2)', () => {
  it('aliasGroup expands shared-value/type tokens, ordered by tier rank', () => {
    const g = makeGraph()
    // #0f65ef is shared by primitive blue.500, semantic action.primary,
    // component primary.bg + primary.border.
    const group = aliasGroup(g, 'color.blue.500')
    assert.deepEqual(group.sort(), [
      'button.primary.bg.default',
      'button.primary.border.default',
      'color.action.primary',
      'color.blue.500',
    ].sort())
    // component tokens (rank 0) come before semantic (1) before primitive (2)
    assert.equal(group[group.length - 1], 'color.blue.500')
  })

  it('blastRadius(primitive) includes components bound via the aliasing component tokens', () => {
    const g = makeGraph()
    const r = blastRadius(g, 'color.blue.500')
    // The primitive itself is bound nowhere, but its aliases bind Primary's
    // fill (bg) and stroke (border) → 2 affected (story,role) pairs.
    assert.equal(r.count, 2)
    const pairs = r.components.map((x) => x.storyId + ':' + x.role + ':' + x.via).sort()
    assert.deepEqual(pairs, [
      'components-button--primary:fill:button.primary.bg.default',
      'components-button--primary:stroke:button.primary.border.default',
    ])
  })

  it('blast count == union of /usages over the alias group', () => {
    const g = makeGraph()
    const group = aliasGroup(g, 'color.action.primary')
    const union = new Set()
    for (const id of group) {
      for (const u of usagesOf(g, id).components) union.add(u.storyId + ':' + u.role + ':' + id)
    }
    assert.equal(blastRadius(g, 'color.action.primary').count, union.size)
  })

  it('blastRadius of an unknown token → empty', () => {
    const g = makeGraph()
    const r = blastRadius(g, 'nope')
    assert.equal(r.count, 0)
    assert.deepEqual(r.aliasGroup, ['nope'])
  })
})

// ─── P3: graft plan ──────────────────────────────────────────────────────────

describe('themeSlice + graftPlan (P3)', () => {
  it('themeSlice collects role → tokenId for a story', () => {
    const g = makeGraph()
    const slice = themeSlice(g, 'components-button--primary')
    // `fill` is bound on both the frame (bg) and the child TEXT (text); same
    // tier, so the first-seen (frame/bg, walked as root) wins the slice.
    assert.equal(slice.get('fill'), 'button.primary.bg.default')
    assert.equal(slice.get('stroke'), 'button.primary.border.default')
    assert.equal(slice.get('cornerRadius'), 'button.radius')
  })

  it('graft Primary → Danger pairs shared roles, conflicts the rest', () => {
    const g = makeGraph()
    const plan = graftPlan(g, 'components-button--primary', 'components-button--danger')
    // Shared roles: fill, stroke (both color, both bound on each). cornerRadius
    // exists on source (button.radius / dimension) but NOT on target → conflict.
    const byRole = Object.fromEntries(plan.changeset.map((x) => [x.role, x]))
    assert.ok(byRole.stroke)
    assert.equal(byRole.stroke.sourceTokenId, 'button.primary.border.default')
    assert.equal(byRole.stroke.targetTokenId, 'button.danger.border.default')
    assert.ok(byRole.fill)
    // cornerRadius → conflict no_target_role
    const conflictRoles = plan.conflicts.map((x) => x.role)
    assert.ok(conflictRoles.includes('cornerRadius'))
    const cr = plan.conflicts.find((x) => x.role === 'cornerRadius')
    assert.equal(cr.reason, 'no_target_role')
  })

  it('type mismatch surfaces as a conflict, never silently dropped', () => {
    // Build a target whose `fill` role is bound to a DIMENSION token — grafting
    // Primary's color fill onto it must conflict (type_mismatch).
    const badTarget = {
      stories: [
        {
          id: 'components-bad--target',
          name: 'Bad',
          component: 'Bad',
          root: {
            type: 'FRAME',
            sorb: { tokens: { fill: 'button.radius' } }, // dimension bound to a fill role
          },
        },
      ],
    }
    const g = buildBindingGraph(RESOLVED, [PRIMARY_ARTIFACT, badTarget])
    const plan = graftPlan(g, 'components-button--primary', 'components-bad--target')
    const fillConflict = plan.conflicts.find((x) => x.role === 'fill')
    assert.ok(fillConflict, 'fill should be a conflict')
    assert.equal(fillConflict.reason, 'type_mismatch')
    assert.equal(plan.changeset.find((x) => x.role === 'fill'), undefined)
  })

  it('roles filter restricts which roles are grafted', () => {
    const g = makeGraph()
    const plan = graftPlan(g, 'components-button--primary', 'components-button--danger', ['stroke'])
    assert.equal(plan.changeset.length, 1)
    assert.equal(plan.changeset[0].role, 'stroke')
    // cornerRadius/fill not considered → no conflicts for them
    assert.equal(plan.conflicts.length, 0)
  })
})
