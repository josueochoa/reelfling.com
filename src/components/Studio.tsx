"use client";

// The app shell: top bar with the workspace switcher, the Video / Image / fal / Assets
// tabs and the account. Everything below the banner belongs to one workspace and is
// remounted when it changes. Tabs stay mounted, so switching tabs keeps prompts.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { VideoModel } from "@/lib/registry";
import type { CatalogTool } from "@/lib/registry/availability";
import { rememberModels } from "@/lib/registry/lookup";
import { apiJson, setWorkspace, type Me } from "./api";
import { AssetsStudio } from "./AssetsStudio";
import { FalStudio, type FalTabHandle } from "./FalStudio";
import { ImageStudio } from "./ImageStudio";
import { KeysDialog } from "./KeysDialog";
import { useLibrary, type LibraryItem } from "./library";
import { InvitesBanner, TeamDialog, WorkspaceSwitcher } from "./Teams";
import { UserMenu } from "./UserMenu";
import { VideoStudio, type StudioTabHandle } from "./VideoStudio";

const TABS = ["video", "image", "fal", "assets"] as const;
type Tab = (typeof TABS)[number];

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const readTab = (): Tab => TABS.find((t) => window.location.hash === `#${t}`) ?? "video";

export function Studio() {
  const tab = useSyncExternalStore(subscribe, readTab, () => "video" as Tab);
  const [me, setMe] = useState<Me | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<VideoModel[] | null>(null);
  const [tools, setTools] = useState<CatalogTool[]>([]);
  const [keysOpen, setKeysOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

  // The server falls back to Personal if the remembered workspace is gone; follow it.
  const loadMe = useCallback(
    () =>
      apiJson<Me>("/api/me").then((next) => {
        setWorkspace(next.workspace.id);
        setMe(next);
      }),
    [],
  );
  useEffect(() => {
    void loadMe();
  }, [loadMe]);
  useEffect(() => {
    apiJson<{ models: VideoModel[]; tools?: CatalogTool[] }>("/api/models")
      .then((body) => {
        rememberModels(body.models);
        setOpenRouterModels(body.models);
        setTools(body.tools ?? []);
      })
      .catch(() => setOpenRouterModels([]));
  }, []);

  function switchTo(id: string) {
    setWorkspace(id);
    setTeamOpen(false);
    void loadMe();
  }

  const openKeys = () => setKeysOpen(true);

  return (
    <div className="flex h-dvh flex-col bg-ink text-zinc-100">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-white/5 bg-panel px-3 sm:gap-4 sm:px-5">
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-lg bg-accent font-black text-ink">R</div>
          <span className="font-semibold tracking-tight">ReelFling</span>
        </div>
        {me && <WorkspaceSwitcher me={me} onSwitch={switchTo} onOpenTeam={() => setTeamOpen(true)} />}
        <nav className="flex gap-1 text-sm">
          {TABS.map((t) => (
            <a
              key={t}
              href={`#${t}`}
              className={`rounded-full px-3 py-1.5 capitalize transition sm:px-3.5 ${
                tab === t ? "bg-white text-ink" : "text-zinc-400 hover:text-white"
              }`}
            >
              {t}
            </a>
          ))}
        </nav>
        <div className="ml-auto">{me && <UserMenu me={me} onOpen={loadMe} onOpenKeys={openKeys} />}</div>
      </header>

      {me && me.invites.length > 0 && <InvitesBanner invites={me.invites} onJoined={switchTo} onChanged={() => void loadMe()} />}

      {me && (
        <WorkspaceView
          key={me.workspace.id}
          me={me}
          tab={tab}
          openRouterModels={openRouterModels}
          tools={tools}
          onOpenKeys={openKeys}
          onChanged={loadMe}
        />
      )}

      {keysOpen && me && <KeysDialog me={me} onClose={() => setKeysOpen(false)} onChanged={() => void loadMe()} />}
      {teamOpen && me && me.workspace.kind === "team" && (
        <TeamDialog me={me} onClose={() => setTeamOpen(false)} onChanged={() => void loadMe()} onLeft={() => switchTo(me.user.id)} />
      )}
    </div>
  );
}

function WorkspaceView({
  me,
  tab,
  openRouterModels,
  tools,
  onOpenKeys,
  onChanged,
}: {
  me: Me;
  tab: Tab;
  openRouterModels: VideoModel[] | null;
  tools: readonly CatalogTool[];
  onOpenKeys: () => void;
  onChanged: () => Promise<void>;
}) {
  const library = useLibrary();
  const video = useRef<StudioTabHandle>(null);
  const image = useRef<StudioTabHandle>(null);
  const fal = useRef<FalTabHandle>(null);

  function sendTo(target: "video" | "image", item: LibraryItem) {
    window.location.hash = target;
    (target === "video" ? video : image).current?.addReference(item);
  }

  return (
    <>
      <div className={`min-h-0 flex-1 ${tab === "video" ? "" : "hidden"}`}>
        <VideoStudio
          ref={video}
          me={me}
          library={library}
          onOpenKeys={onOpenKeys}
          openRouterModels={openRouterModels}
          tools={tools}
        />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "image" ? "" : "hidden"}`}>
        <ImageStudio
          ref={image}
          me={me}
          library={library}
          onOpenKeys={onOpenKeys}
          onUseAsStartFrame={(item) => {
            window.location.hash = "video";
            video.current?.setStartFrame(item);
          }}
        />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "fal" ? "" : "hidden"}`}>
        <FalStudio ref={fal} me={me} onOpenKeys={onOpenKeys} />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "assets" ? "" : "hidden"}`}>
        <AssetsStudio
          me={me}
          library={library}
          active={tab === "assets"}
          onUseInImage={(item) => sendTo("image", item)}
          onUseInVideo={(item) => sendTo("video", item)}
          onDeleted={() => {
            video.current?.reload();
            image.current?.reload();
            fal.current?.reload();
            void onChanged();
          }}
        />
      </div>
    </>
  );
}
