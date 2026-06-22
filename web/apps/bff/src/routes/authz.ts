// Membership-based authorization helpers shared by the control-plane routes.
// We return discriminated results so handlers can translate to 403/404 without
// leaking the existence of resources the caller can't see.

import { and, eq } from "drizzle-orm";
import type { Role } from "@carrier/contract";
import type { Db } from "../db/client.js";
import { membership, org, project, session } from "../db/schema.js";
import type { OrgRow, ProjectRow, SessionRow } from "../db/schema.js";

export type { Role };

export async function membershipRole(
  db: Db,
  accountId: string,
  orgId: string,
): Promise<Role | null> {
  const rows = await db
    .select()
    .from(membership)
    .where(
      and(eq(membership.accountId, accountId), eq(membership.orgId, orgId)),
    )
    .limit(1);
  return (rows[0]?.role as Role | undefined) ?? null;
}

/** Resolve an org by id OR slug, returning it only if the account is a member. */
export async function resolveOrg(
  db: Db,
  accountId: string,
  orgIdOrSlug: string,
): Promise<{ org: OrgRow; role: Role } | null> {
  const byId = await db
    .select()
    .from(org)
    .where(eq(org.id, orgIdOrSlug))
    .limit(1);
  let row = byId[0];
  if (!row) {
    const bySlug = await db
      .select()
      .from(org)
      .where(eq(org.slug, orgIdOrSlug))
      .limit(1);
    row = bySlug[0];
  }
  if (!row) return null;
  const role = await membershipRole(db, accountId, row.id);
  if (!role) return null;
  return { org: row, role };
}

export async function resolveProject(
  db: Db,
  accountId: string,
  projectId: string,
): Promise<{ project: ProjectRow; role: Role } | null> {
  const rows = await db
    .select()
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  const p = rows[0];
  if (!p) return null;
  const role = await membershipRole(db, accountId, p.orgId);
  if (!role) return null;
  return { project: p, role };
}

export async function resolveSession(
  db: Db,
  accountId: string,
  sessionId: string,
): Promise<{ session: SessionRow; project: ProjectRow; role: Role } | null> {
  const rows = await db
    .select()
    .from(session)
    .where(eq(session.id, sessionId))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  const proj = await resolveProject(db, accountId, s.projectId);
  if (!proj) return null;
  return { session: s, project: proj.project, role: proj.role };
}

export function isManager(role: Role): boolean {
  return role === "owner" || role === "admin";
}
