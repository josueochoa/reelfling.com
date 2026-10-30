"use client";

// The app shell: top bar with the Video / Image / Assets tabs, the account, API keys and
// the assets library (shared by all tabs). Tabs stay mounted, so switching keeps prompts
// and in-flight polling.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiJson, type Me } from "./api";
import { AssetsStudio } from "./AssetsStudio";
import { ImageStudio } from "./ImageStudio";
import { KeysDialog } from "./KeysDialog";
import { useLibrary, type LibraryItem } from "./library";
import { UserMenu } from "./UserMenu";
import { VideoStudio, type StudioTabHandle } from "./VideoStudio";

const TABS = ["video", "image", "assets"] as const;
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
  const [keysOpen, setKeysOpen] = useState(false);
  const library = useLibrary();
  const video = useRef<StudioTabHandle>(null);
  const image = useRef<StudioTabHandle>(null);

  const loadMe = useCallback(() => apiJson<Me>("/api/me").then(setMe), []);
  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const openKeys = () => setKeysOpen(true);
  /** From Assets: jump to a tab and attach the asset as a reference there. */
  function sendTo(tab: "video" | "image", item: LibraryItem) {
    window.location.hash = tab;
    (tab === "video" ? video : image).current?.addReference(item);
  }

  return (
    <div className="flex h-dvh flex-col bg-ink text-zinc-100">
      <header className="flex h-14 shrink-0 items-center gap-6 border-b border-white/5 bg-panel px-5">
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-lg bg-accent font-black text-ink">R</div>
          <span className="font-semibold tracking-tight">ReelFling</span>
        </div>
        <nav className="flex gap-1 text-sm">
          {TABS.map((t) => (
            <a
              key={t}
              href={`#${t}`}
              className={`rounded-full px-3.5 py-1.5 capitalize transition ${
                tab === t ? "bg-white text-ink" : "text-zinc-400 hover:text-white"
              }`}
            >
              {t}
            </a>
          ))}
        </nav>
        <div className="ml-auto">{me && <UserMenu me={me} onOpen={loadMe} onOpenKeys={openKeys} />}</div>
      </header>

      <div className={`min-h-0 flex-1 ${tab === "video" ? "" : "hidden"}`}>
        <VideoStudio ref={video} me={me} library={library} onOpenKeys={openKeys} />
      </div>
      <div className={`min-h-0 flex-1 ${tab === "image" ? "" : "hidden"}`}>
        <ImageStudio ref={image} me={me} library={library} onOpenKeys={openKeys} />
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
            void loadMe();
          }}
        />
      </div>

      {keysOpen && me && <KeysDialog me={me} onClose={() => setKeysOpen(false)} onChanged={loadMe} />}
    </div>
  );
}
