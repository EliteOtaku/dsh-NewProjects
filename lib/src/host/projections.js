/**
 * The session projection that lets the panel follow a project without polling.
 *
 * The Host folds this definition over every event a session has ever recorded, so the
 * reducer has to stay pure — it never reads the manifest, never runs git, never awaits. All
 * it does is keep the newest snapshot that `ProjectEngine` appended after a write.
 */
import { z } from 'zod';
import { PROJECT_STATE_KEY, applyProjectState, emptyProjectState, } from '../core/projectState.js';
/**
 * One thread row.
 *
 * `.passthrough()` is not used anywhere here: a snapshot written by an older build must
 * still parse, and Zod strips unknown keys by default, which is exactly the behaviour we
 * want for forward compatibility.
 */
const threadRowSchema = z.object({
    threadId: z.string(),
    title: z.string(),
    status: z.string(),
    pr: z.string().optional(),
    note: z.string().optional(),
});
const bucketSchema = z.array(threadRowSchema);
const snapshotSchema = z.object({
    projectId: z.string(),
    name: z.string(),
    revision: z.number(),
    at: z.number(),
    totals: z.object({
        threads: z.number(),
        active: z.number(),
        waitingOnYou: z.number(),
        resolved: z.number(),
        needsAttention: z.boolean(),
    }),
    buckets: z.object({
        ready_for_review: bucketSchema,
        waiting_on_you: bucketSchema,
        working: bucketSchema,
        landing: bucketSchema,
        idle: bucketSchema,
        resolved: bucketSchema,
    }),
    truncated: z.number(),
    quota: z.object({
        day: z.string(),
        used: z.number(),
        max: z.number(),
        globalUsed: z.number().optional(),
        globalMax: z.number().optional(),
    }),
    suggested: z.object({ count: z.number(), expired: z.boolean() }).optional(),
    paused: z.object({ since: z.number(), reason: z.string().optional() }).optional(),
    knowledge: z.object({ docs: z.number(), summary: z.string() }).optional(),
    warnings: z.array(z.string()),
});
const foldSchema = z.object({ snapshot: snapshotSchema.nullable() });
/**
 * Build the projection definition.
 *
 * `wire` makes the snapshot part of the client-side session snapshot, which is what a panel
 * reads. Without it the state would exist on the host and nothing would render.
 */
export function buildProjectStateProjection() {
    return {
        key: PROJECT_STATE_KEY,
        stateSchema: foldSchema,
        // A brand-new session has no project snapshot. `init` must be cheap: it runs for every
        // session that is ever attached, including ones that will never touch a project.
        init: () => emptyProjectState(),
        apply: (state, event) => applyProjectState(state, event),
        wire: {
            viewSchema: snapshotSchema.nullable(),
            // Hand the client the snapshot itself rather than the fold wrapper: the wrapper exists
            // only to make "nothing yet" representable on the host.
            view: (state) => state.snapshot,
        },
        stateVersion: 1,
    };
}
