"use client";

// Teams UI: the workspace switcher, pending-invite banner, and the team settings dialog
// (members, roles, invites).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Invite, Member, Role, Workspace } from "@/lib/workspaces";
import { apiJson, type Me } from "./api";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function Avatar({
  person,
  size = "size-7",
}: {
  person: { name: string | null; email: string; avatarUrl: string | null };
  size?: string;
}) {
  const label = person.name ?? person.email;
  return (
    <span
      title={label}
      className={`grid ${size} shrink-0 place-items-center overflow-hidden rounded-full bg-white/15 text-[11px] font-semibold text-white`}
    >
      {person.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={person.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
      ) : (
        label.charAt(0).toUpperCase()
      )}
    </span>
  );
}

// ---------------------------------------------------------------- switcher

export function WorkspaceSwitcher({
  me,
  onSwitch,
  onOpenTeam,
}: {
  me: Me;
  onSwitch: (id: string) => void;
  onOpenTeam: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const ws = me.workspace;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function create() {
    setError(null);
    try {
      const team = await apiJson<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
      setOpen(false);
      setCreating(false);
      setName("");
      onSwitch(team.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-xl bg-white/[0.06] px-3 py-1.5 text-sm hover:bg-white/10"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="grid size-5 place-items-center rounded-md bg-white/15 text-[10px] font-bold">
          {ws.kind === "personal" ? "P" : ws.name.charAt(0).toUpperCase()}
        </span>
        <span className="max-w-40 truncate">{ws.name}</span>
        {ws.kind === "team" && <span className="text-xs text-zinc-500">{ws.memberCount}</span>}
        <span className="text-zinc-500">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 z-40 mt-2 w-72 rounded-xl border border-white/10 bg-panel p-1.5 shadow-2xl shadow-black/60"
        >
          <p className="px-2.5 pt-1 pb-1.5 text-xs text-zinc-500">Workspaces</p>
          {me.workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                if (w.id !== ws.id) onSwitch(w.id);
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${
                w.id === ws.id ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              <span className="grid size-6 place-items-center rounded-md bg-white/15 text-[11px] font-bold">
                {w.kind === "personal" ? "P" : w.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{w.name}</span>
                <span className="block text-xs text-zinc-500">
                  {w.kind === "personal"
                    ? "Just you"
                    : `${ROLE_LABEL[w.role]} · ${w.memberCount} ${w.memberCount === 1 ? "member" : "members"}`}
                </span>
              </span>
              {w.id === ws.id && <span className="text-accent">✓</span>}
            </button>
          ))}
          <div className="my-1 h-px bg-white/5" />
          {ws.kind === "team" && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenTeam();
              }}
              className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-zinc-300 hover:bg-white/5"
            >
              Team members & invites
            </button>
          )}
          {creating ? (
            <form
              className="space-y-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                autoFocus
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                placeholder="Team name"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-accent/60"
              />
              {error && <p className="text-xs text-red-300">{error}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={!name.trim()}
                  className="flex-1 rounded-lg bg-accent py-1.5 text-sm font-semibold text-ink disabled:opacity-40"
                >
                  Create team
                </button>
                <button type="button" onClick={() => setCreating(false)} className="px-2 text-sm text-zinc-400">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              role="menuitem"
              onClick={() => setCreating(true)}
              className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-zinc-300 hover:bg-white/5"
            >
              ＋ Create a team
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- invites for me

export function InvitesBanner({
  invites,
  onJoined,
  onChanged,
}: {
  invites: Invite[];
  onJoined: (workspaceId: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function join(invite: Invite) {
    setBusy(invite.id);
    try {
      await apiJson("/api/invites/accept", { method: "POST", body: JSON.stringify({ inviteId: invite.id }) });
      onJoined(invite.workspaceId);
    } catch (e) {
      alert((e as Error).message);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function decline(invite: Invite) {
    setBusy(invite.id);
    await apiJson(`/api/invites/${invite.id}`, { method: "DELETE" }).catch(() => {});
    setBusy(null);
    onChanged();
  }

  return (
    <div className="shrink-0 space-y-1 border-b border-accent/20 bg-accent/[0.06] px-5 py-2">
      {invites.map((i) => (
        <div key={i.id} className="flex items-center gap-3 text-sm">
          <span className="flex-1">
            {i.invitedBy ?? "Someone"} invited you to <b>{i.workspaceName}</b> as {ROLE_LABEL[i.role].toLowerCase()}.
          </span>
          <button
            onClick={() => void join(i)}
            disabled={busy === i.id}
            className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-ink disabled:opacity-50"
          >
            Join
          </button>
          <button
            onClick={() => void decline(i)}
            disabled={busy === i.id}
            className="px-2 text-xs text-zinc-400 hover:text-white"
          >
            Decline
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- team settings

export function TeamDialog({
  me,
  onClose,
  onChanged,
  onLeft,
}: {
  me: Me;
  onClose: () => void;
  onChanged: () => void;
  /** You left (or were removed from) the team. */
  onLeft: () => void;
}) {
  const ws = me.workspace;
  const admin = ws.role === "owner" || ws.role === "admin";
  const [data, setData] = useState<{ members: Member[]; invites: Invite[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(ws.name);

  const load = useCallback(
    () =>
      apiJson<{ members: Member[]; invites: Invite[] }>(`/api/workspaces/${ws.id}/members`)
        .then(setData)
        .catch((e: Error) => setError(e.message)),
    [ws.id],
  );
  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, onClose]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const invite = (withEmail: boolean) =>
    act(async () => {
      const r = await apiJson<{ link?: string }>(`/api/workspaces/${ws.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: withEmail ? email : undefined, role }),
      });
      if (withEmail) setEmail("");
      setLink(r.link ?? null);
      setCopied(false);
    });

  return (
    <div className="fixed inset-0 z-50 flex bg-black/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Team members"
        className="m-auto max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {ws.role === "owner" ? (
              <input
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onBlur={() =>
                  name.trim() &&
                  name !== ws.name &&
                  act(() => apiJson(`/api/workspaces/${ws.id}`, { method: "PATCH", body: JSON.stringify({ name }) }))
                }
                aria-label="Team name"
                className="w-full rounded-lg border border-transparent bg-transparent px-1 text-lg font-semibold outline-none hover:border-white/10 focus:border-accent/60"
              />
            ) : (
              <h2 className="text-lg font-semibold">{ws.name}</h2>
            )}
            <p className="mt-1 px-1 text-sm text-zinc-400">
              Everyone here shares the team&apos;s videos, images, uploads and API keys.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        {error && <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

        <h3 className="mt-6 mb-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
          Members {data && `· ${data.members.length}`}
        </h3>
        <ul className="divide-y divide-white/5 rounded-xl border border-white/10">
          {data?.members.map((m) => {
            const self = m.userId === me.user.id;
            return (
              <li key={m.userId} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar person={m} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {m.name ?? m.email}
                    {self && <span className="text-zinc-500"> (you)</span>}
                  </p>
                  {m.name && <p className="truncate text-xs text-zinc-500">{m.email}</p>}
                </div>
                {admin && m.role !== "owner" && !self ? (
                  <select
                    value={m.role}
                    aria-label={`Role for ${m.email}`}
                    onChange={(e) =>
                      act(() =>
                        apiJson(`/api/workspaces/${ws.id}/members/${m.userId}`, {
                          method: "PATCH",
                          body: JSON.stringify({ role: e.target.value }),
                        }),
                      )
                    }
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs outline-none"
                  >
                    <option value="member" className="bg-panel">
                      Member
                    </option>
                    <option value="admin" className="bg-panel">
                      Admin
                    </option>
                  </select>
                ) : (
                  <span className="text-xs text-zinc-400">{ROLE_LABEL[m.role]}</span>
                )}
                {m.role !== "owner" && (self || admin) && (
                  <button
                    onClick={() => {
                      const msg = self
                        ? `Leave ${ws.name}? You'll lose access to its videos, images and uploads (they stay with the team).`
                        : `Remove ${m.name ?? m.email} from ${ws.name}? Their work stays with the team.`;
                      if (!confirm(msg)) return;
                      void act(async () => {
                        await apiJson(`/api/workspaces/${ws.id}/members/${m.userId}`, { method: "DELETE" });
                        if (self) onLeft();
                      });
                    }}
                    className="text-xs text-red-300/80 hover:text-red-300"
                  >
                    {self ? "Leave" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {admin && (
          <>
            <h3 className="mt-6 mb-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">Invite</h3>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void invite(true);
              }}
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-accent/60"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                aria-label="Role"
                className="rounded-lg border border-white/10 bg-white/[0.03] px-2 text-sm outline-none"
              >
                <option value="member" className="bg-panel">
                  Member
                </option>
                <option value="admin" className="bg-panel">
                  Admin
                </option>
              </select>
              <button
                type="submit"
                disabled={!email.trim()}
                className="rounded-lg bg-accent px-3.5 text-sm font-semibold text-ink disabled:opacity-40"
              >
                Invite
              </button>
            </form>
            <p className="mt-1.5 text-xs text-zinc-500">
              They&apos;ll see the invite when they sign in with that email.{" "}
              <button onClick={() => void invite(false)} className="text-zinc-300 underline-offset-2 hover:underline">
                Or create an invite link
              </button>{" "}
              anyone can use for 14 days.
            </p>
            {link && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.05] p-2">
                <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(link).then(() => setCopied(true));
                  }}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-xs hover:bg-white/15"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            {data && data.invites.length > 0 && (
              <>
                <h3 className="mt-6 mb-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">Pending invites</h3>
                <ul className="divide-y divide-white/5 rounded-xl border border-white/10">
                  {data.invites.map((i) => (
                    <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{i.email ?? "Invite link"}</span>
                      <span className="text-xs text-zinc-500">
                        {ROLE_LABEL[i.role]} · expires {new Date(i.expiresAt).toLocaleDateString()}
                      </span>
                      <button
                        onClick={() =>
                          act(() => apiJson(`/api/workspaces/${ws.id}/invites/${i.id}`, { method: "DELETE" }))
                        }
                        className="text-xs text-zinc-400 hover:text-white"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
