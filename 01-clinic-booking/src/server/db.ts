import { Prisma, PrismaClient } from "@prisma/client";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

// Next's dev server re-evaluates modules on every change; reuse one client so connections are not leaked.
if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export type DbClient = Prisma.TransactionClient;

/** Options for transactions that may queue behind row locks held by concurrent requests. */
export const LOCKING_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
