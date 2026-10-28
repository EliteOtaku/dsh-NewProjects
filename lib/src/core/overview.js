/**
 * Overview projection.
 *
 * Folds the durable project record into the four buckets the panel shows. Kept as a
 * pure function of the manifest so the panel, the tool result, and any test always
 * agree — there is no second source of truth for "which bucket is this thread in".
 */
import { memoryPrefixFingerprint } from './memory.js';
import { quotaState } from './quota.js';
/** The display order of buckets on the panel. */
export const BUCKET_ORDER = [
    'running',
    'awaiting_review',
    'waiting_for_feedback',
    'completed',
    'failed',
];
/** Bucket titles used by the panel and the tool renderer. */
export const BUCKET_LABELS = {
    running: 'Running / CI fixing',
    awaiting_review: 'Awaiting review',
    waiting_for_feedback: 'Waiting for your input',
    completed: 'Completed',
    failed: 'Failed',
};
/** Statuses that count as "still working" (keeps the thread alive in the panel). */
const ACTIVE_STATUSES = ['queued', 'running', 'ci_fixing'];
/** Map one thread status onto its panel bucket. */
export function bucketOf(status) {
    switch (status) {
        case 'queued':
        case 'running':
        case 'ci_fixing':
            return 'running';
        case 'awaiting_review':
            return 'awaiting_review';
        case 'needs_feedback':
            return 'waiting_for_feedback';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
    }
}
/** Whether a status means the thread still owns live work. */
export function isActiveStatus(status) {
    return ACTIVE_STATUSES.includes(status);
}
/** Sort threads newest-first within a bucket, so the panel shows recent work. */
function byRecency(a, b) {
    return b.updatedAt - a.updatedAt;
}
/** Build the structured overview for one project. */
export function buildOverview(manifest, nowMs, warnings = []) {
    const buckets = {
        running: [],
        awaiting_review: [],
        waiting_for_feedback: [],
        completed: [],
        failed: [],
    };
    const threads = Object.values(manifest.threads);
    for (const thread of threads)
        buckets[bucketOf(thread.status)].push(thread);
    for (const bucket of BUCKET_ORDER)
        buckets[bucket].sort(byRecency);
    return {
        projectId: manifest.projectId,
        name: manifest.name,
        rootDir: manifest.rootDir,
        revision: manifest.revision,
        quota: quotaState(manifest, nowMs),
        buckets,
        memories: Object.values(manifest.memories).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
        prefixFingerprint: memoryPrefixFingerprint(manifest),
        totals: {
            threads: threads.length,
            active: threads.filter((thread) => isActiveStatus(thread.status)).length,
            completed: buckets.completed.length,
            failed: buckets.failed.length,
        },
        warnings,
    };
}
/**
 * Render the overview as compact markdown for the `/project` command.
 *
 * The command bypasses the model, so this string is what the user actually reads.
 */
export function renderOverviewMarkdown(overview) {
    const lines = [];
    lines.push(`# ${overview.name}`, '');
    lines.push(`- project: \`${overview.projectId}\` (r${overview.revision})`);
    lines.push(`- root: \`${overview.rootDir}\``);
    lines.push(`- quota: ${overview.quota.created}/${overview.quota.max} threads from this project on ${overview.quota.day}`);
    if (overview.quota.global !== undefined) {
        lines.push(`- quota (enforced, all projects): ${overview.quota.global.created}/${overview.quota.global.max}`);
    }
    lines.push(`- memory: ${overview.memories.length} decisions, prefix \`${overview.prefixFingerprint}\``);
    lines.push(`- threads: ${overview.totals.threads} total, ${overview.totals.active} active`);
    for (const warning of overview.warnings)
        lines.push(`- WARNING: ${warning}`);
    lines.push('');
    let empty = true;
    for (const bucket of BUCKET_ORDER) {
        const threads = overview.buckets[bucket];
        if (threads.length === 0)
            continue;
        empty = false;
        lines.push(`## ${BUCKET_LABELS[bucket]} (${threads.length})`, '');
        for (const thread of threads) {
            const bits = [`\`${thread.threadId}\``, thread.title, `— ${thread.status}`];
            if (thread.branch !== undefined)
                bits.push(`on \`${thread.branch}\``);
            else if (thread.branchOrScope.length > 0)
                bits.push(`scope \`${thread.branchOrScope}\``);
            if (thread.prOrDeliverableRef !== undefined)
                bits.push(`(${thread.prOrDeliverableRef})`);
            lines.push(`- ${bits.join(' ')}`);
            if (thread.feedbackPrompt !== undefined)
                lines.push(`  - needs: ${thread.feedbackPrompt}`);
            if (thread.lastError !== undefined)
                lines.push(`  - error: ${thread.lastError}`);
            const failing = thread.review?.checks.filter((check) => check.conclusion === 'fail') ?? [];
            if (failing.length > 0)
                lines.push(`  - failing checks: ${failing.map((check) => check.name).join(', ')}`);
        }
        lines.push('');
    }
    if (empty)
        lines.push('_No threads yet. Use `project_coordinate` to start parallel work._', '');
    return lines.join('\n');
}
export { quotaState };
