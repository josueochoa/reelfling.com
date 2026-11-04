"use client";

// A team is a shared read-only view. Creating, inviting, and removing members
// happens here. Generations still run on each person's own key and storage.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Play } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import type { TeamAsset, TeamAuthor, TeamGeneration, TeamMember, TeamSummary } from "@/lib/teamPolicy";
import { teamMediaUrl } from "@/lib/teamPolicy";
import { apiJson, type Me } from "./api";
import { formatBytes } from "./UserMenu";

const STORAGE_KEY = "reelfling.team";

function selectionFor(next: TeamSummary[], prefer: string | null | undefined) {
  const stored = prefer === undefined ? sessionStorage.getItem(STORAGE_KEY) : prefer;
  if (prefer === null) sessionStorage.removeItem(STORAGE_KEY);
  const match = stored ? next.find((team) => team.id === stored) : undefined;
  if (stored && !match) {
    sessionStorage.removeItem(STORAGE_KEY);
    return { denied: true, selected: null };
  }
  const selected = match?.id ?? next[0]?.id ?? null;
  if (selected) sessionStorage.setItem(STORAGE_KEY, selected);
  return { denied: false, selected };
}

interface TeamDetail {
  team: TeamSummary;
  members: TeamMember[];
}

interface TeamFeed {
  generations: TeamGeneration[];
  assets: TeamAsset[];
}

function who(author: TeamAuthor, meId?: string) {
  const label = author.name ? `${author.name} · ${author.email}` : author.email;
  return author.id === meId ? `${label} (you)` : label;
}

export function TeamStudio({ me, active }: { me: Me | null; active: boolean }) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [feed, setFeed] = useState<TeamFeed | null>(null);
  const [name, setName] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  const applyList = useCallback((next: TeamSummary[], prefer: string | null | undefined) => {
    const picked = selectionFor(next, prefer);
    setTeams(next);
    setDenied(picked.denied);
    setSelected(picked.selected);
    if (picked.denied || !picked.selected) {
      setDetail(null);
      setFeed(null);
      setInviteUrl(null);
    }
  }, []);

  const loadList = useCallback(
    async (prefer?: string | null) => {
      applyList(await apiJson<TeamSummary[]>("/api/teams"), prefer);
    },
    [applyList],
  );

  useEffect(() => {
    if (!active) return;
    let cancel = false;
    apiJson<TeamSummary[]>("/api/teams")
      .then((next) => {
        if (!cancel) applyList(next, undefined);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [active, applyList]);

  useEffect(() => {
    if (!active || !selected) return;
    let cancel = false;
    Promise.all([
      apiJson<TeamDetail>(`/api/teams/${selected}`),
      apiJson<TeamFeed>(`/api/teams/${selected}/feed`),
    ])
      .then(([nextDetail, nextFeed]) => {
        if (cancel) return;
        setDetail(nextDetail);
        setFeed(nextFeed);
        setError(null);
        setDenied(false);
      })
      .catch((e: Error) => {
        if (cancel) return;
        setDetail(null);
        setFeed(null);
        setInviteUrl(null);
        setDenied(true);
        setError(e.message === "Not found" ? "You don't have access to this team." : e.message);
      });
    return () => {
      cancel = true;
    };
  }, [active, selected, revision]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const team = await apiJson<TeamSummary>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      await loadList(team.id);
      setRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onInvite() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const invite = await apiJson<{ url: string; expiresAt: number }>(`/api/teams/${selected}/invites`, {
        method: "POST",
        body: "{}",
      });
      setInviteUrl(invite.url);
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(memberId: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/teams/${selected}/members/${memberId}`, { method: "DELETE" });
      setRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onLeave() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/teams/${selected}/leave`, { method: "POST", body: "{}" });
      await loadList(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/teams/${selected}`, { method: "DELETE" });
      setInviteUrl(null);
      await loadList(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const role = detail?.team.role;
  const meId = me?.user.id;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 border-b border-white/5 p-4 md:w-64 md:border-r md:border-b-0">
        <p className="px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">Teams</p>
        <div className="mt-2 space-y-1">
          {teams.map((team) => (
            <button
              key={team.id}
              onClick={() => {
                setDenied(false);
                setSelected(team.id);
                sessionStorage.setItem(STORAGE_KEY, team.id);
              }}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-sm ${
                team.id === selected ? "bg-white text-ink" : "text-zinc-300 hover:bg-white/5"
              }`}
            >
              <span className="block truncate font-medium">{team.name}</span>
              <span className={`text-xs capitalize ${team.id === selected ? "text-zinc-600" : "text-zinc-500"}`}>
                {team.role}
              </span>
            </button>
          ))}
          {teams.length === 0 && <p className="px-1 text-sm text-zinc-500">No teams yet.</p>}
        </div>
        <form onSubmit={onCreate} className="mt-4 space-y-2" data-testid="team-create">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New team name"
            maxLength={60}
            aria-label="New team name"
            data-testid="team-name"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-zinc-600"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink disabled:opacity-40"
          >
            Create team
          </button>
        </form>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && (
          <p className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </p>
        )}
        {denied && (
          <p className="mb-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200" data-testid="team-denied">
            You don&apos;t have access to that team anymore.
          </p>
        )}
        {!detail && !denied && (
          <div className="max-w-md">
            <h1 className="text-lg font-semibold">Team</h1>
            <p className="mt-1 text-sm text-zinc-400">
              A team lets everyone in it see everyone&apos;s generations and assets. Each person still generates with
              their own key, into their own storage.
            </p>
          </div>
        )}
        {detail && feed && (
          <div data-testid="team-feed">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold" data-testid="team-title">
                  {detail.team.name}
                </h1>
                <p className="mt-1 max-w-xl text-sm text-zinc-400">
                  Read-only. You can see what teammates made. A generation still uses the maker&apos;s own key and
                  their own storage. You can&apos;t edit or delete someone else&apos;s work here.
                </p>
              </div>
              <div className="flex gap-2">
                {role === "owner" && (
                  <button
                    onClick={onInvite}
                    disabled={busy}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink disabled:opacity-40"
                  >
                    Invite link
                  </button>
                )}
                {role === "owner" ? (
                  <button
                    onClick={onDelete}
                    disabled={busy}
                    className="rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-300 disabled:opacity-40"
                  >
                    Delete team
                  </button>
                ) : (
                  <button
                    onClick={onLeave}
                    disabled={busy}
                    className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 disabled:opacity-40"
                  >
                    Leave team
                  </button>
                )}
              </div>
            </div>

            {inviteUrl && (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-xs text-zinc-400">Anyone with this link can join once. The previous link no longer works.</p>
                <div className="mt-2 flex gap-2">
                  <input
                    readOnly
                    value={inviteUrl}
                    aria-label="Invite link"
                    data-testid="invite-url"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink px-3 py-2 font-mono text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(inviteUrl).then(
                        () => setCopied(true),
                        () => setCopied(false),
                      );
                    }}
                    className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            <section className="mt-6">
              <h2 className="text-sm font-medium text-zinc-300">Members</h2>
              <ul className="mt-2 divide-y divide-white/5 rounded-xl border border-white/10">
                {detail.members.map((member) => (
                  <li key={member.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="team-member">
                    <div className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-medium">
                      {(member.name ?? member.email).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{who(member, meId)}</p>
                      <p className="text-xs text-zinc-500 capitalize">{member.role}</p>
                    </div>
                    {role === "owner" && member.role === "member" && (
                      <button
                        onClick={() => onRemove(member.id)}
                        disabled={busy}
                        data-testid={`remove-${member.email}`}
                        className="rounded-lg px-2 py-1 text-xs text-red-300 hover:bg-red-400/10 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-6">
              <h2 className="text-sm font-medium text-zinc-300">Generations</h2>
              {feed.generations.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No generations from the people on this team yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {feed.generations.map((gen) => (
                    <li key={`${gen.kind}-${gen.id}`} className="rounded-xl border border-white/10 px-3 py-3" data-testid="team-generation">
                      <p className="text-xs text-zinc-500">
                        {who(gen.author, meId)} · {gen.kind} · {gen.status || "unknown"}
                        {gen.model ? ` · ${gen.model}` : ""}
                      </p>
                      <p className="mt-1 text-sm text-zinc-100">{gen.prompt || "Untitled"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-6">
              <h2 className="text-sm font-medium text-zinc-300">Assets</h2>
              {feed.assets.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No assets from the people on this team yet.</p>
              ) : (
                <ul className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {feed.assets.map((asset) => (
                    <AssetTile key={`${asset.ownerId}:${asset.key}`} teamId={detail.team.id} asset={asset} meId={meId} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function AssetTile({ teamId, asset, meId }: { teamId: string; asset: TeamAsset; meId?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const fileUrl = teamMediaUrl(teamId, asset.ownerId, asset.key);
  // The grid never points a <video> at the file. Same as the Assets grid: a thumbnail
  // image, and the file loads only when the tile is opened.
  const thumbUrl = asset.hasThumb ? teamMediaUrl(teamId, asset.ownerId, asset.key, true) : undefined;
  return (
    <li className="overflow-hidden rounded-xl border border-white/10" data-testid="team-asset">
      <div className="relative grid aspect-video place-items-center bg-white/5">
        {asset.kind === "audio" || (asset.kind === "video" && (!thumbUrl || failed)) ? (
          <span className="text-xs tracking-wide text-zinc-500 uppercase">{asset.kind}</span>
        ) : (
          // Authenticated same-origin bytes. next/image would fetch them without the session.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbUrl ?? fileUrl}
            alt=""
            onError={() => setFailed(true)}
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
          />
        )}
        {asset.kind === "video" && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Play ${asset.name}`}
            data-testid="team-video"
            className="absolute inset-0 grid place-items-center"
          >
            <span className="grid size-9 place-items-center rounded-full bg-black/60 text-white">
              <Play className="size-4" aria-hidden />
            </span>
          </button>
        )}
      </div>
      {open && (
        <Modal size="lg" surface="black" onClose={() => setOpen(false)} label={asset.name}>
          <video
            src={fileUrl}
            controls
            autoPlay
            playsInline
            data-testid="team-video-player"
            className="max-h-[80dvh] w-full bg-black"
          />
        </Modal>
      )}
      <div className="px-2.5 py-2">
        <p className="truncate text-sm">{asset.name}</p>
        <p className="truncate text-xs text-zinc-500">
          {who(asset.author, meId)} · {formatBytes(asset.bytes)}
        </p>
      </div>
    </li>
  );
}
