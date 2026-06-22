# Requirements Document — Carrier Web Client

## Introduction

The Carrier Web Client is the primary surface where users do their coding work
with Carrier agents. It is a full-stack TypeScript application — a React web app
plus a Backend-for-Frontend (BFF) / control-plane — delivered as a pnpm
monorepo. It authenticates users with **GitHub SSO**, organizes work as
**Org-or-Personal → Project → Session** (a Project owns a persistent workspace
and optionally binds to one GitHub repository; one Project has many Sessions),
and presents an **IDE split-view** (file tree + editor/diff + agent
trace/chat) over live agent sessions streamed from the Carrier runtime.

This document captures requirements in EARS notation. The agreed architecture
decisions (the answers that shaped it):

- **Scope:** web app **and** a TypeScript BFF/control-plane in the same monorepo.
- **GitHub:** a **GitHub App** (SSO + installation tokens for clone/branch/PR).
- **Session UX:** **IDE split-view**.
- **Project model:** **persistent workspace per Project**, optional repo binding,
  one Project to many Sessions.

The browser talks only to the BFF (single origin); the BFF brokers to the Carrier
runtime (HTTP + SSE), GitHub, and a Postgres database. Streaming is **relayed
through the BFF** (browser ⇄ BFF SSE ⇄ Carrier SSE).

Terminology: **Account** = a GitHub-authenticated user. **Org** = an
organization context (a GitHub org the user belongs to) or the user's **Personal**
context. **Project** = a workspace within an Org, optionally bound to a repo.
**Session** = one Carrier agent run within a Project. **BFF** = the
control-plane/API the web app calls. **Carrier** = the Go agent runtime.

## Requirements

### Requirement 1 — GitHub SSO authentication

**User Story:** As a user, I want to sign in with GitHub, so that I can access my
orgs and projects without a separate password.

#### Acceptance Criteria

1. WHEN a signed-out user starts the GitHub OAuth flow THE SYSTEM SHALL authenticate them via GitHub and establish a session.
2. THE SYSTEM SHALL store the session as an httpOnly, signed, secure cookie and SHALL NOT expose GitHub tokens to the browser.
3. WHEN OAuth completes for a first-time user THE SYSTEM SHALL provision an Account and a Personal Org context for them.
4. WHEN a user signs out THE SYSTEM SHALL invalidate the session cookie.
5. IF a request to a protected route lacks a valid session THEN THE SYSTEM SHALL redirect to sign-in (preserving the intended destination).
6. THE SYSTEM SHALL verify the OAuth `state` parameter to prevent CSRF on the callback.

### Requirement 2 — Orgs and Personal context

**User Story:** As a user, I want to switch between my Personal context and the
GitHub orgs I belong to, so that my work is organized by ownership.

#### Acceptance Criteria

1. THE SYSTEM SHALL list the user's Personal context plus the GitHub organizations they are a member of.
2. THE SYSTEM SHALL let the user select an active Org/Personal context, persisted across sessions.
3. WHEN org membership changes on GitHub THE SYSTEM SHALL reconcile the user's available contexts on next sign-in or on demand.
4. THE SYSTEM SHALL scope all project, session, and workspace access to the active context and the user's membership in it.

### Requirement 3 — Membership and roles

**User Story:** As an org owner, I want role-based access, so that members have
appropriate permissions.

#### Acceptance Criteria

1. THE SYSTEM SHALL support at least the roles owner, admin, and member per Org.
2. THE SYSTEM SHALL enforce that only owner/admin may manage members, repo bindings, and project deletion.
3. IF a user requests a resource outside their membership THEN THE SYSTEM SHALL deny with a 403 and not reveal the resource's existence beyond a 404 where appropriate.

### Requirement 4 — Projects

**User Story:** As a user, I want to create and manage projects within an org, so
that related sessions and files live together.

#### Acceptance Criteria

1. THE SYSTEM SHALL let an authorized user create, list, rename, and archive Projects within an active Org/Personal context.
2. WHEN a Project is created THE SYSTEM SHALL provision a persistent workspace for it.
3. THE SYSTEM SHALL display, per Project, its repo binding (if any), recent sessions, and last activity.
4. WHEN a Project is archived THE SYSTEM SHALL stop new sessions while preserving its workspace and history as read-only.

### Requirement 5 — GitHub App and repo binding (optional)

**User Story:** As a project owner, I want to optionally bind a project to a
GitHub repository, so that the agent can work on real code.

#### Acceptance Criteria

1. THE SYSTEM SHALL support installing a GitHub App on an org/account and listing the repositories the installation grants.
2. THE SYSTEM SHALL let an authorized user bind a Project to at most one repository and choose a default branch, or leave the Project unbound (scratch).
3. WHEN a Project is bound to a repo THE SYSTEM SHALL clone it into the Project workspace using an installation token.
4. THE SYSTEM SHALL keep GitHub installation tokens server-side only and SHALL NOT expose them to the browser.
5. WHERE a Project is unbound THE SYSTEM SHALL still provide a usable empty workspace.

### Requirement 6 — Persistent project workspace

**User Story:** As a user, I want a project's files to persist across sessions, so
that work accumulates rather than resetting each run.

#### Acceptance Criteria

1. THE SYSTEM SHALL maintain one persistent workspace per Project whose files survive across Sessions.
2. WHEN a Session edits files THE SYSTEM SHALL persist those edits to the Project workspace.
3. THE SYSTEM SHALL expose the workspace to Carrier Sessions as their working directory.
4. WHERE the Project is repo-bound THE SYSTEM SHALL track git state (branch, dirty/clean, ahead/behind) for the workspace.
5. THE SYSTEM SHALL provide a way to reset or re-sync a repo-bound workspace to a clean checkout.

### Requirement 7 — Sessions

**User Story:** As a user, I want to start and resume agent sessions within a
project, so that I can drive multiple lines of work.

#### Acceptance Criteria

1. THE SYSTEM SHALL let a user create a Session within a Project, which provisions a corresponding Carrier session bound to the Project workspace.
2. THE SYSTEM SHALL support many Sessions per Project (1:N).
3. THE SYSTEM SHALL list a Project's Sessions with title, status (idle/running/terminated), and last activity, and allow resuming one.
4. WHEN a Session is reopened THE SYSTEM SHALL replay its prior event history before streaming live events.
5. THE SYSTEM SHALL let a user title and archive a Session.

### Requirement 8 — IDE: file tree

**User Story:** As a user, I want to browse the project's files, so that I can see
and navigate the codebase the agent works on.

#### Acceptance Criteria

1. THE SYSTEM SHALL render a navigable file tree of the active Project workspace.
2. WHERE the Project is repo-bound THE SYSTEM SHALL annotate entries with git status (added/modified/deleted/untracked).
3. WHEN the agent creates, edits, or deletes files THE SYSTEM SHALL reflect those changes in the tree in near-real-time.
4. WHEN a user selects a file THE SYSTEM SHALL open it in the editor/diff view.

### Requirement 9 — IDE: editor and diff

**User Story:** As a user, I want to view file contents and the agent's changes,
so that I can follow and review what the agent does.

#### Acceptance Criteria

1. THE SYSTEM SHALL display the contents of a selected file with syntax highlighting.
2. WHEN the agent modifies a file THE SYSTEM SHALL show a diff (before/after) for that change.
3. THE SYSTEM SHALL update the open file/diff view in near-real-time as the agent edits it.
4. THE SYSTEM SHALL handle large files and binary files gracefully (truncation/placeholder), without freezing the UI.

### Requirement 10 — IDE: agent trace and chat

**User Story:** As a user, I want to see the agent's streamed output and send it
instructions, so that I can collaborate with it in real time.

#### Acceptance Criteria

1. THE SYSTEM SHALL stream a Session's events (assistant text, reasoning, tool calls, tool results, errors) into an agent panel as they arrive.
2. THE SYSTEM SHALL render tool calls and results as structured cards (e.g. bash command + output, file edit) rather than raw text.
3. THE SYSTEM SHALL let the user send a message to a running or idle Session, choosing steer (interrupt-and-redirect) or queue (next-cycle) delivery.
4. THE SYSTEM SHALL let the user interrupt a running Session.
5. WHILE a Session is streaming THE SYSTEM SHALL show a running indicator and current activity.

### Requirement 11 — Human-in-the-loop approvals

**User Story:** As a user, I want to approve or deny actions the agent requests,
so that I stay in control of sensitive operations.

#### Acceptance Criteria

1. WHEN Carrier emits a permission/approval request for a Session THE SYSTEM SHALL surface it to the user with the tool, the resource, and a reason.
2. THE SYSTEM SHALL let the user approve or deny a request, correlating the decision to the originating request by ID.
3. WHEN the user responds THE SYSTEM SHALL deliver the decision back to Carrier and resume or block the action accordingly.
4. IF an approval request is not answered within a configured timeout THEN THE SYSTEM SHALL reflect the resulting denial in the UI.

### Requirement 12 — Permissions and plan mode

**User Story:** As a project owner, I want to configure what the agent may do, so
that automation matches my risk tolerance.

#### Acceptance Criteria

1. THE SYSTEM SHALL let an authorized user view and edit per-Project permission rules (allow/deny/ask by action and resource pattern).
2. THE SYSTEM SHALL let a user start a Session in plan mode (read-only tools, no mutations).
3. THE SYSTEM SHALL apply the configured rules to Sessions created in the Project.

### Requirement 13 — Realtime streaming and resilience

**User Story:** As a user, I want the live session view to stay accurate across
network hiccups, so that I don't lose the agent's output.

#### Acceptance Criteria

1. THE SYSTEM SHALL stream Session events to the browser over an SSE connection relayed by the BFF from Carrier.
2. WHEN a streaming connection drops and reconnects THE SYSTEM SHALL replay missed history and de-duplicate already-seen events.
3. THE SYSTEM SHALL support many viewers of the same Session without one viewer blocking another.
4. WHILE disconnected THE SYSTEM SHALL indicate the degraded state and attempt reconnection with backoff.

### Requirement 14 — BFF control-plane API

**User Story:** As the web app, I want one cohesive, typed API, so that the
frontend never talks to GitHub, Carrier, or the database directly.

#### Acceptance Criteria

1. THE SYSTEM SHALL expose REST endpoints for accounts, orgs, projects, repo bindings, workspaces, sessions, and permissions, plus an SSE endpoint for session events.
2. THE SYSTEM SHALL share request/response types between the web app and the BFF via a typed contract package (single source of truth).
3. THE SYSTEM SHALL authenticate every BFF request via the session cookie and authorize it against the user's membership.
4. THE SYSTEM SHALL never require the browser to hold GitHub or Carrier credentials.

### Requirement 15 — GitHub repo operations

**User Story:** As a user, I want the agent's repo work to land on GitHub, so that
I can ship changes.

#### Acceptance Criteria

1. THE SYSTEM SHALL allow a repo-bound Session to create/switch branches, commit, and push using the installation token (server-side).
2. THE SYSTEM SHALL allow opening a pull request for the Session's branch and SHALL surface the PR link in the UI.
3. THE SYSTEM SHALL display the workspace's branch and PR status in the IDE.
4. THE SYSTEM SHALL rotate/scope installation tokens so they are never exposed to the browser or persisted beyond need.

### Requirement 16 — Usage and cost

**User Story:** As an org owner, I want visibility into agent usage and cost, so
that I can manage spend.

#### Acceptance Criteria

1. THE SYSTEM SHALL display per-Session token usage and cost, sourced from Carrier's accounting.
2. THE SYSTEM SHALL aggregate usage and cost per Project and per Org.

### Requirement 17 — Settings and administration

**User Story:** As an org owner, I want to manage members, GitHub connections, and
project settings, so that I can administer my workspace.

#### Acceptance Criteria

1. THE SYSTEM SHALL provide org settings (members/roles, GitHub App installations) and project settings (repo binding, permissions, danger zone) gated by role.
2. THE SYSTEM SHALL let an authorized user manage GitHub App installations and repository access from settings.

### Requirement 18 — Quality: accessibility, theming, and states

**User Story:** As any user, I want a fast, accessible, resilient UI, so that the
workspace is pleasant to live in.

#### Acceptance Criteria

1. THE SYSTEM SHALL provide light and dark themes via the shadcn/ui (Base UI) + Tailwind system.
2. THE SYSTEM SHALL provide keyboard navigation and accessible components (focus management, ARIA) for primary flows.
3. THE SYSTEM SHALL render explicit loading (skeleton), empty, and error states for every primary view, with error boundaries that contain failures.
4. THE SYSTEM SHALL remain responsive (no main-thread freeze) under high-frequency event streams and large diffs.
