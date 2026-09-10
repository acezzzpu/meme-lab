export const learningSchema=`
CREATE TABLE IF NOT EXISTS learning_samples (
 id TEXT PRIMARY KEY,token_id TEXT NOT NULL UNIQUE,source TEXT NOT NULL,wallet_id TEXT,
 anchor_at INTEGER NOT NULL,end_at INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,
 features TEXT NOT NULL,trajectory TEXT NOT NULL,evidence TEXT NOT NULL,
 used_run_id TEXT,updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_samples_state ON learning_samples(state,used_run_id,anchor_at);
CREATE TABLE IF NOT EXISTS learning_runs (
 id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,dataset_id TEXT NOT NULL UNIQUE,
 dataset_digest TEXT NOT NULL,status TEXT NOT NULL,version_id TEXT,
 result TEXT NOT NULL,paper_run_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS learning_runs_time ON learning_runs(created_at);
CREATE TABLE IF NOT EXISTS learning_decisions (
 version_id TEXT NOT NULL,token_id TEXT NOT NULL,snapshot_id INTEGER NOT NULL,
 decided_at INTEGER NOT NULL,PRIMARY KEY(version_id,token_id)
);
`;
export const learningDefaults={training_config:{enabled:true,max_active_tokens:8},training_status:null};
