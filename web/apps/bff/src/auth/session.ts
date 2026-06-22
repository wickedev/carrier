// Cookie-backed session using iron-session's sealData/unsealData with Hono's
// cookie helpers. The session payload is encrypted+signed; the browser only
// ever holds an opaque httpOnly cookie. No GitHub/Carrier tokens are stored.

import { sealData, unsealData } from "iron-session";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Config } from "../config.js";

export const SESSION_COOKIE = "carrier_session";
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionData {
  accountId: string;
}

export async function setSession(
  c: Context,
  cfg: Config,
  data: SessionData,
): Promise<void> {
  const sealed = await sealData(data, {
    password: cfg.sessionSecret,
    ttl: TTL_SECONDS,
  });
  setCookie(c, SESSION_COOKIE, sealed, {
    httpOnly: true,
    sameSite: "Lax",
    secure: cfg.secureCookies,
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function readSession(
  c: Context,
  cfg: Config,
): Promise<SessionData | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const data = await unsealData<SessionData>(raw, {
      password: cfg.sessionSecret,
      ttl: TTL_SECONDS,
    });
    if (!data || typeof data.accountId !== "string" || !data.accountId) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearSession(c: Context, cfg: Config): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure: cfg.secureCookies,
  });
}
