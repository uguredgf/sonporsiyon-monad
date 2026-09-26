import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const batches = sqliteTable("batches", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  provider: text("provider").notNull(),
  title: text("title").notNull(),
  contents: text("contents").notNull().default("İçerik bilgisi güncelleniyor"),
  deadline: text("deadline").notNull(),
  deadlineAt: integer("deadline_at").notNull(),
  preparedAt: text("prepared_at").notNull(),
  storage: text("storage").notNull(),
  allergens: text("allergens").notNull(),
  address: text("address").notNull(),
  latitude: real("latitude"),
  longitude: real("longitude"),
  claimTtlSeconds: integer("claim_ttl_seconds").notNull().default(1800),
  status: text("status", { enum: ["active", "cancelled"] }).notNull().default("active"),
  cancelReason: text("cancel_reason"),
  publishedAt: text("published_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_batches_deadline").on(table.deadlineAt)]);

export const portions = sqliteTable("portions", {
  batchId: text("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  slotIndex: integer("slot_index").notNull(),
  state: text("state", { enum: ["available", "claimed", "redeemed"] }).notNull().default("available"),
  ownerId: text("owner_id"),
  code: text("code"),
  claimExpiresAt: integer("claim_expires_at"),
}, (table) => [
  primaryKey({ columns: [table.batchId, table.slotIndex] }),
  index("idx_portions_batch_state").on(table.batchId, table.state),
  uniqueIndex("idx_portions_one_active_claim").on(table.ownerId).where(sql`${table.state} = 'claimed' AND ${table.ownerId} IS NOT NULL`),
  uniqueIndex("idx_portions_active_code").on(table.code).where(sql`${table.state} = 'claimed' AND ${table.code} IS NOT NULL`),
]);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  text: text("text").notNull(),
  ref: text("ref").notNull(),
  at: text("at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_events_at").on(table.at)]);

export const providerApplications = sqliteTable("provider_applications", {
  wallet: text("wallet").primaryKey(),
  businessName: text("business_name").notNull(),
  registrationNumber: text("registration_number").notNull(),
  businessAddress: text("business_address").notNull(),
  officialQr: integer("official_qr", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["pending", "hackathon_access", "approved", "rejected", "suspended"] }).notNull().default("pending"),
  submittedAt: text("submitted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_provider_applications_status").on(table.status)]);

export const deviceNotices = sqliteTable("device_notices", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  at: text("at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_device_notices_device").on(table.deviceId, table.at)]);
