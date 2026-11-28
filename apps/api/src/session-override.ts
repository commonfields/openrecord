// A session the server has already resolved, for the one place that runs a
// route on someone's behalf without their cookie: the desktop OAuth callback
// (desktop-oauth.ts). The browser that finishes the OAuth flow never holds
// the desktop's session token, and the server stores only its digest, so the
// callback hands over the session row it verified instead of a cookie.
import { Context } from "effect"
import type { Session } from "@openrecord/db"

export class SessionOverride extends Context.Tag("SessionOverride")<SessionOverride, Session>() {}
