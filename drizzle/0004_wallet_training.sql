CREATE TABLE `learning_decisions` (
	`version_id` text NOT NULL,
	`token_id` text NOT NULL,
	`snapshot_id` integer NOT NULL,
	`decided_at` integer NOT NULL,
	PRIMARY KEY(`version_id`, `token_id`)
);
--> statement-breakpoint
CREATE TABLE `learning_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`dataset_id` text NOT NULL,
	`dataset_digest` text NOT NULL,
	`status` text NOT NULL,
	`version_id` text,
	`result` text NOT NULL,
	`paper_run_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_runs_dataset_id_unique` ON `learning_runs` (`dataset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_runs_paper_run_id_unique` ON `learning_runs` (`paper_run_id`);--> statement-breakpoint
CREATE INDEX `learning_runs_time` ON `learning_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `learning_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`source` text NOT NULL,
	`wallet_id` text,
	`anchor_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`features` text NOT NULL,
	`trajectory` text NOT NULL,
	`evidence` text NOT NULL,
	`used_run_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_samples_token_id_unique` ON `learning_samples` (`token_id`);--> statement-breakpoint
CREATE INDEX `learning_samples_state` ON `learning_samples` (`state`,`used_run_id`,`anchor_at`);