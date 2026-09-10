// Legacy core tables are preserved by migrations 0000–0003. New training tables
// are mirrored in core/learning/schema.mjs for the standalone SQLite runtime.
import {sqliteTable,text,integer,index,primaryKey} from 'drizzle-orm/sqlite-core';
export const learningSamples=sqliteTable('learning_samples',{
 id:text('id').primaryKey(),tokenId:text('token_id').notNull().unique(),source:text('source').notNull(),walletId:text('wallet_id'),
 anchorAt:integer('anchor_at').notNull(),endAt:integer('end_at').notNull(),state:text('state').notNull(),reason:text('reason'),
 features:text('features').notNull(),trajectory:text('trajectory').notNull(),evidence:text('evidence').notNull(),usedRunId:text('used_run_id'),updatedAt:integer('updated_at').notNull(),
},t=>[index('learning_samples_state').on(t.state,t.usedRunId,t.anchorAt)]);
export const learningRuns=sqliteTable('learning_runs',{
 id:text('id').primaryKey(),createdAt:integer('created_at').notNull(),datasetId:text('dataset_id').notNull().unique(),datasetDigest:text('dataset_digest').notNull(),
 status:text('status').notNull(),versionId:text('version_id'),result:text('result').notNull(),paperRunId:text('paper_run_id').unique(),
},t=>[index('learning_runs_time').on(t.createdAt)]);
export const learningDecisions=sqliteTable('learning_decisions',{
 versionId:text('version_id').notNull(),tokenId:text('token_id').notNull(),snapshotId:integer('snapshot_id').notNull(),decidedAt:integer('decided_at').notNull(),
},t=>[primaryKey({columns:[t.versionId,t.tokenId]})]);
