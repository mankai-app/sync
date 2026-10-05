CREATE TABLE `accounts` (
	`account` text PRIMARY KEY,
	`revision` integer DEFAULT 0 NOT NULL,
	`progress_clear_datetime` integer,
	`progress_clear_revision` integer
);
--> statement-breakpoint
CREATE TABLE `library` (
	`account` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`datetime` integer NOT NULL,
	`deleted` integer NOT NULL,
	`manga_id` text NOT NULL,
	`updates` integer,
	`latest_chapter` text,
	CONSTRAINT `library_pk` PRIMARY KEY(`account`, `source_id`, `manga_id`)
);
--> statement-breakpoint
CREATE TABLE `plugins` (
	`account` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`datetime` integer NOT NULL,
	`deleted` integer NOT NULL,
	`url` text,
	CONSTRAINT `plugins_pk` PRIMARY KEY(`account`, `source_id`)
);
--> statement-breakpoint
CREATE TABLE `progress` (
	`account` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`datetime` integer NOT NULL,
	`deleted` integer NOT NULL,
	`manga_id` text NOT NULL,
	`chapter_id` text,
	`chapter_title` text,
	`page` integer,
	CONSTRAINT `progress_pk` PRIMARY KEY(`account`, `source_id`, `manga_id`)
);
--> statement-breakpoint
CREATE INDEX `library_sync` ON `library` (`account`,`revision`);--> statement-breakpoint
CREATE INDEX `plugins_sync` ON `plugins` (`account`,`revision`);--> statement-breakpoint
CREATE INDEX `progress_sync` ON `progress` (`account`,`revision`);