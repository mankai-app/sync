CREATE TABLE `browsableplugins` (
	`account` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`datetime` integer NOT NULL,
	`deleted` integer NOT NULL,
	`url` text,
	`type` text,
	CONSTRAINT `browsableplugins_pk` PRIMARY KEY(`account`, `source_id`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_plugins` (
	`account` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`datetime` integer NOT NULL,
	`deleted` integer NOT NULL,
	`url` text,
	`type` text,
	CONSTRAINT `plugins_pk` PRIMARY KEY(`account`, `source_id`)
);
--> statement-breakpoint
INSERT INTO `__new_plugins`(`account`, `source_id`, `revision`, `datetime`, `deleted`, `url`, `type`) SELECT `account`, `source_id`, `revision`, `datetime`, `deleted`, `url`, `type` FROM `plugins`;--> statement-breakpoint
DROP TABLE `plugins`;--> statement-breakpoint
ALTER TABLE `__new_plugins` RENAME TO `plugins`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `plugins_sync` ON `plugins` (`account`,`revision`);--> statement-breakpoint
CREATE INDEX `browsableplugins_sync` ON `browsableplugins` (`account`,`revision`);