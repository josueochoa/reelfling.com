"use client";

// The app shell: top bar with the Video / Image / Assets tabs, the account, API keys and
// the assets library (shared by all tabs). Tabs stay mounted, so switching keeps prompts
// and in-flight polling.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ImageModel, VideoModel } from "@/lib/registry";
import type { SavedLook } from "@/lib/registry/looks";
import { rememberModels } from "@/lib/registry/lookup";
import type { ExtendOffer, ToolView } from "@/lib/toolTypes";
import { apiJson, type Me } from "./api";
import { AssetsStudio } from "./AssetsStudio";
import { FalStudio, type FalTabHandle } from "./FalStudio";
import { ImageStudio } from "./ImageStudio";
import { KeysDialog } from "./KeysDialog";
import { useLibrary, type LibraryItem } from "./library";
import { TeamStudio } from "./TeamStudio";
import { UserMenu } from "./UserMenu";
import { VideoStudio, type StudioTabHandle } from "./VideoStudio";

const TABS = ["video", "image", "fal", "assets", "team"] as const;
type Tab = (typeof TABS)[number];

// The tab lives in the URL hash (#image, #assets), so reload and Back keep it.
const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const readTab = (): Tab => TABS.find((t) => window.location.hash === `#${t}`) ?? "video";

export function Studio() {
  const tab = useSyncExternalStore(subscribe, readTab, () => "video" as Tab);
  const [me, setMe] = useState<Me | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<VideoModel[] | null>(null);
  const [catalogImages, setCatalogImages] = useState<ImageModel[] | null>(null);
  const [tools, setTools] = useState<ToolView[]>([]);
  const [extendOffers, setExtendOffers] = useState<ExtendOffer[]>([]);
  const [keysOpen, setKeysOpen] = useState(false);
  const library = useLibrary();
  const video = useRef<StudioTabHandle>(null);
  const image = useRef<StudioTabHandle>(null);
  const fal = useRef<FalTabHandle>(null);

  const loadMe = useCallback(() => apiJson<Me>("/api/me").then(setMe), []);
  useEffect(() => {
    loadMe();
  }, [loadMe]);
  // Slim picker list. The generated catalog stays on the server.
  useEffect(() => {
    apiJson<{ models: VideoModel[]; images?: ImageModel[]; tools?: ToolView[]; extend?: ExtendOffer[] }>(
      "/api/models",
    )
      .then((body) => {
        rememberModels(body.models);
        setOpenRouterModels(body.models);
        setCatalogImages(body.images ?? []);
        setTools(body.tools ?? []);
        setExtendOffers(body.extend ?? []);
      })
      .catch(() => setOpenRouterModels([]));
  }, []);

  const openKeys = () => setKeysOpen(true);
  function setLooks(next: SavedLook[]) {
    setMe((current) => (current ? { ...current, looks: next } : current));
  }
  const savedLooks = me?.looks ?? [];
  function showToolJob() {
    window.location.hash = "fal";
    fal.current?.reload();
  }
  /** From Assets: jump to a tab and attach the asset as a reference there. */
  function sendTo(tab: "video" | "image", item: LibraryItem) {
    window.location.hash = tab;
    (tab === "video" ? video : image).current?.addReference(item);
  }

  return (
    <div className="flex h-dvh flex-col bg-ink text-zinc-100">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/5 bg-panel px-3 sm:gap-6 sm:px-5">
        <div className="flex shrink-0 items-center gap-2">
          <div className="grid size-7 place-items-center rounded-lg bg-accent font-black text-ink">R</div>
          <span className="hidden font-semibold tracking-tight sm:inline">ReelFling</span>
        </div>
        <nav className="flex min-w-0 gap-0.5 overflow-x-auto text-sm [scrollbar-width:none] sm:gap-1">
          {TABS.map((t) => (
            <a
              key={t}
              href={`#${t}`}
              className={`shrink-0 rounded-full px-2.5 py-1.5 capitalize transition sm:px-3.5 ${
                tab === t ? "bg-white text-ink" : "text-zinc-400 hover:text-white"
              }`}
            >
              {t}
            </a>
          ))}
        </nav>
        <div className="ml-auto shrink-0">{me && <UserMenu me={me} onOpen={loadMe} onOpenKeys={openKeys} />}</div>
      </header>

      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${tab === "video" ? "" : "hidden"}`}>
        <VideoStudio
          ref={video}
          me={me}
          library={library}
          onOpenKeys={openKeys}
          openRouterModels={openRouterModels}
          tools={tools}
          extendOffers={extendOffers}
          onToolJob={showToolJob}
          savedLooks={savedLooks}
          onLooks={setLooks}
        />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "image" ? "" : "hidden"}`}>
        <ImageStudio
          ref={image}
          me={me}
          library={library}
          onOpenKeys={openKeys}
          onUseAsStartFrame={(item) => {
            window.location.hash = "video";
            video.current?.setStartFrame(item);
          }}
          tools={tools}
          onToolJob={showToolJob}
          catalogModels={catalogImages}
          savedLooks={savedLooks}
          onLooks={setLooks}
        />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "fal" ? "" : "hidden"}`}>
        <FalStudio ref={fal} me={me} onOpenKeys={openKeys} />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "team" ? "" : "hidden"}`}>
        <TeamStudio me={me} active={tab === "team"} />
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
            void loadMe();
          }}
          tools={tools}
          onToolJob={showToolJob}
          onOpenKeys={openKeys}
        />
      </div>

      {keysOpen && me && <KeysDialog me={me} onClose={() => setKeysOpen(false)} onChanged={loadMe} />}
    </div>
  );
}
