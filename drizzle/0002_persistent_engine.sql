
CREATE TABLE IF NOT EXISTS engine_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,chain TEXT,entity_id TEXT,message TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS engine_events_time ON engine_events(at);
CREATE TABLE IF NOT EXISTS engine_jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,locked_at INTEGER,owner TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
CREATE INDEX IF NOT EXISTS engine_jobs_ready ON engine_jobs(state,available_at);
CREATE TABLE IF NOT EXISTS chain_events(id TEXT PRIMARY KEY,chain TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT,block TEXT,address TEXT,received_at INTEGER NOT NULL,source TEXT NOT NULL,raw TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chain_events_time ON chain_events(received_at);
CREATE TABLE IF NOT EXISTS watched_wallets(wallet_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,head TEXT,catchup_before TEXT,catchup_head TEXT,last_sync INTEGER,last_event INTEGER,error TEXT);
CREATE TABLE IF NOT EXISTS trader_context(flow_id TEXT PRIMARY KEY,token_id TEXT NOT NULL,snapshot_id INTEGER,timing TEXT NOT NULL,captured_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS order_context(order_id TEXT PRIMARY KEY,signal_id TEXT,score REAL,reason TEXT,price REAL,market_cap REAL,slippage_bps REAL,realized_cents INTEGER);
CREATE TABLE IF NOT EXISTS ws_health(chain TEXT PRIMARY KEY,status TEXT NOT NULL,provider TEXT,last_event INTEGER,last_block TEXT,connected_at INTEGER,reconnects INTEGER DEFAULT 0,error TEXT,subscription_count INTEGER DEFAULT 0);

INSERT OR IGNORE INTO settings VALUES ('engine_desired','"STOPPED"',1789004193665);
INSERT OR IGNORE INTO settings VALUES ('engine_started_at','null',1789004193665);
INSERT OR IGNORE INTO settings VALUES ('engine_heartbeat','null',1789004193665);
INSERT OR IGNORE INTO settings VALUES ('entries_paused','false',1789004193665);
INSERT OR IGNORE INTO settings VALUES ('engine_config','{"scan_interval_ms":15000,"wallet_interval_ms":30000,"concurrency":3,"max_tokens":12,"retention_days":7}',1789004193665);
INSERT OR IGNORE INTO settings VALUES ('automation','{"version_id":null,"order_cents":200}',1789004193665);
INSERT OR IGNORE INTO watched_wallets(wallet_id) SELECT id FROM wallets;
